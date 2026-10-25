import fs from 'node:fs';
import path from 'node:path';
import { pathsFor, type Paths } from './paths.ts';
import { withLock } from './lock.ts';
import { orderBetween, orderFirst, orderLast } from './order.ts';
import { displayName, safeExtension } from './files.ts';
import { claudeHome, modelLabel } from './model.ts';
import { SessionReader, isTranscriptPath, lastEntries, type SessionEntry } from './transcript.ts';
import { isSkillName } from './skill-rules.ts';
import {
  type Folder,
  type FolderColor,
  FOLDER_COLORS,
  cleanFolderName,
  isFolderColor,
  laneOrder,
  normalizeFolders,
} from './folder.ts';
import {
  type Attachment,
  COLUMN_LABELS,
  COLUMNS,
  MAX_RESULT_HISTORY,
  MAX_SESSION_HISTORY,
  RUN_ID,
  QUEUE_COLUMNS,
  isReadOnlyType,
  makeId,
  normalizeLabels,
  normalizeRelated,
  isWorkerName,
  normalizeTask,
  now,
  pendingQuestion,
  type ActivityEntry,
  type ActivityKind,
  type Column,
  type Message,
  type Mode,
  type PastSession,
  type Task,
  type TaskType,
  TYPE_LABELS,
} from './task.ts';

/** Board-wide alert settings, shared by everyone who opens this board. */
export interface NotificationSettings {
  sound: boolean;
  desktop: boolean;
  /** Also alert when Claude picks a card up, not just when it needs you. */
  onStart: boolean;
}

export interface BoardConfig {
  version: number;
  port: number;
  title: string;
  notifications: NotificationSettings;
  /** Note which model Claude was running on each status change. */
  recordModel: boolean;
  /** Record where in the worker's Claude Code transcript each run lives, for the Session tab. */
  liveSession: boolean;
  /** Save a copy of each run's session in .ticketrail/sessions/ when it ends. */
  keepSessions: boolean;
}

export const DEFAULT_CONFIG: BoardConfig = {
  version: 1,
  port: 4321,
  title: 'Ticketrail',
  notifications: { sound: true, desktop: true, onStart: false },
  recordModel: true,
  liveSession: true,
  keepSessions: true,
};

/**
 * An error the caller asked for rather than a fault: the HTTP layer turns the
 * `status` into a real status code instead of a blanket 500.
 */
export function refuse(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function requireWorkerName(name: string): string {
  if (!isWorkerName(name)) throw refuse(400, `"${name}" is not a usable worker name`);
  return name;
}

/** An agent name as a card stores it. Whether the file exists is checked when the card is claimed. */
function requireAgentName(name: string): string {
  if (!isSkillName(name)) throw refuse(400, `"${name}" is not a valid agent name`);
  return name;
}

function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Bytes in a file right now, or null when it cannot be read. */
function sizeOf(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** A run's session as saved when it ended: everything the Session tab needs, without the transcript. */
export interface SavedSession {
  run: string;
  startedAt: string | null;
  endedAt: string;
  mode: Mode | null;
  model: string | null;
  /** The run was longer than what was kept; its start is missing. */
  clipped: boolean;
  entries: SessionEntry[];
}

/** The most entries a saved run keeps: the last ones. Output in each is already cut short. */
export const MAX_SAVED_ENTRIES = 2000;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class Store {
  readonly root: string;
  readonly paths: Paths;

  /**
   * The model driving this process, stamped onto the status changes Claude
   * makes. The store never works this out for itself: the CLI sets it, the
   * server leaves it null, so moves you make in the browser are never
   * attributed to a model.
   */
  model: string | null;

  /**
   * The Claude Code session this process runs in, so a claim can note where
   * in its transcript the run begins. Set by the CLI, like `model`.
   */
  session: { id: string; transcript: string } | null;

  constructor(
    root: string,
    options: { model?: string | null; session?: { id: string; transcript: string } | null } = {},
  ) {
    this.root = root;
    this.paths = pathsFor(root);
    this.model = options.model ?? null;
    this.session = options.session ?? null;
  }

  /**
   * Close the running slice of the transcript, and copy its entries into
   * .ticketrail/sessions/ so the run can still be read once Claude Code has
   * cleaned the transcript up. Saving is best effort: a run that could not be
   * saved is still readable from the transcript while that exists.
   */
  private endSession(task: Task): void {
    const session = task.session;
    if (!session) return;
    if (session.to === null) {
      const size = sizeOf(session.transcript);
      session.to = size === null ? session.from : Math.max(session.from, size);
    }
    if (session.saved || this.config().keepSessions === false) return;
    // the path comes from a task file anyone can edit, so it is checked like the server checks it
    if (!isTranscriptPath(session.transcript, claudeHome())) return;
    try {
      const reader = new SessionReader(session.transcript, session.from, this.root);
      const kept = lastEntries(reader.read(session.to), MAX_SAVED_ENTRIES);
      const saved: SavedSession = {
        run: session.run,
        startedAt: session.startedAt,
        endedAt: now(),
        mode: task.mode,
        model: task.model,
        clipped: reader.clipped || kept.cut,
        entries: kept.entries,
      };
      const file = this.sessionFile(task.id, session.run);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, saved);
      session.saved = true;
    } catch {
      /* the transcript is still there to read from */
    }
  }

  /** Where a run's saved session lives. */
  sessionFile(taskId: string, run: string): string {
    if (!RUN_ID.test(run) || !/^[A-Za-z0-9_-]+$/.test(taskId)) throw refuse(400, `"${run}" is not a run id`);
    return path.join(this.paths.sessions, taskId, `${run}.json`);
  }

  /** A run's saved session, or null when it was never saved or has been removed. */
  savedSession(taskId: string, run: string): SavedSession | null {
    const saved = readJson<SavedSession>(this.sessionFile(taskId, run));
    return saved && Array.isArray(saved.entries) ? saved : null;
  }

  /**
   * Forget a card's sessions: the current one, its history, and every saved
   * copy. The transcripts themselves are Claude Code's and stay where they are.
   * A run still being written is refused -- it would only come back.
   */
  clearSession(id: string): Task {
    const task = this.update(id, (t) => {
      if (t.session && t.session.to === null && (t.column === 'in-progress' || t.column === 'user-input')) {
        throw refuse(409, 'Claude is still working on this card. Clear its session once the run has finished.');
      }
      if (!t.session && !t.sessionHistory.length) return false;
      t.session = null;
      t.sessionHistory = [];
      t.activity.push({ at: now(), kind: 'info', text: 'Session cleared.' });
    });
    fs.rmSync(path.join(this.paths.sessions, task.id), { recursive: true, force: true });
    return task;
  }

  /**
   * A new run begins: the session so far becomes history, saved if it was
   * not already, and the oldest saved copies beyond the cap are deleted.
   */
  private retireSession(task: Task): void {
    const session = task.session;
    if (!session) return;
    this.endSession(task);
    if (session.saved) {
      const past: PastSession = {
        run: session.run,
        startedAt: session.startedAt,
        // finishedAt is cleared when a card is queued again; the saved copy knows when the run ended
        endedAt: this.savedSession(task.id, session.run)?.endedAt ?? task.finishedAt ?? now(),
        mode: task.mode,
      };
      const history = [...task.sessionHistory.filter((h) => h.run !== session.run), past];
      for (const dropped of history.slice(0, Math.max(0, history.length - MAX_SESSION_HISTORY))) {
        fs.rmSync(this.sessionFile(task.id, dropped.run), { force: true });
      }
      task.sessionHistory = history.slice(-MAX_SESSION_HISTORY);
    }
    task.session = null;
  }

  /** A status entry, carrying the model when one is known. */
  private status(text: string, kind: ActivityKind = 'status'): ActivityEntry {
    return { at: now(), kind, text, ...(this.model ? { model: this.model } : {}) };
  }

  // ---------------------------------------------------------------- setup

  static init(root: string, overrides: Partial<BoardConfig> = {}): Store {
    const store = new Store(root);
    fs.mkdirSync(store.paths.tasks, { recursive: true });
    fs.mkdirSync(store.paths.files, { recursive: true });
    fs.mkdirSync(store.paths.locks, { recursive: true });
    fs.mkdirSync(store.paths.runtime, { recursive: true });
    if (!fs.existsSync(store.paths.config)) {
      writeJsonAtomic(store.paths.config, { ...DEFAULT_CONFIG, ...overrides });
    } else if (Object.keys(overrides).length) {
      store.saveConfig({ ...store.config(), ...overrides });
    }
    return store;
  }

  /**
   * What to call this board. An explicit title in config.json wins; otherwise
   * fall back to the package name and then to the directory, so a board always
   * identifies the project it belongs to without being configured.
   */
  projectName(): string {
    const configured = this.config().title.trim();
    if (configured && configured !== DEFAULT_CONFIG.title) return configured;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
      if (typeof pkg?.name === 'string' && pkg.name.trim()) return pkg.name.trim();
    } catch {
      /* not a node project */
    }
    return path.basename(this.root);
  }

  config(): BoardConfig {
    const stored = readJson<Partial<BoardConfig>>(this.paths.config) ?? {};
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      // merged rather than replaced, so a config written before this setting
      // existed still gets every field
      notifications: { ...DEFAULT_CONFIG.notifications, ...(stored.notifications ?? {}) },
    };
  }

  /** Apply a partial settings change and return the whole config. */
  updateSettings(
    changes: Partial<Pick<BoardConfig, 'title' | 'keepSessions'>> & { notifications?: Partial<NotificationSettings> },
  ): BoardConfig {
    return withLock(this.paths.boardLock, () => {
      const current = this.config();
      const next: BoardConfig = {
        ...current,
        ...(typeof changes.title === 'string' && changes.title.trim() ? { title: changes.title.trim() } : {}),
        ...(typeof changes.keepSessions === 'boolean' ? { keepSessions: changes.keepSessions } : {}),
        notifications: { ...current.notifications, ...(changes.notifications ?? {}) },
      };
      this.saveConfig(next);
      return next;
    });
  }

  saveConfig(config: BoardConfig): void {
    writeJsonAtomic(this.paths.config, config);
  }

  // ---------------------------------------------------------------- reads

  taskFile(id: string): string {
    return path.join(this.paths.tasks, `${id}.json`);
  }

  /** All tasks, board order: column order first, then the fractional key. */
  list(options: { includeArchived?: boolean } = {}): Task[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.tasks);
    } catch {
      return [];
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const raw = readJson<unknown>(path.join(this.paths.tasks, name));
      if (!raw) continue;
      const task = normalizeTask(raw, name.slice(0, -5));
      if (task.archived && !options.includeArchived) continue;
      tasks.push(task);
    }
    return tasks.sort((a, b) => {
      const ca = COLUMNS.indexOf(a.column);
      const cb = COLUMNS.indexOf(b.column);
      if (ca !== cb) return ca - cb;
      if (a.order !== b.order) return a.order < b.order ? -1 : 1;
      return a.number - b.number;
    });
  }

  get(id: string): Task | null {
    const raw = readJson<unknown>(this.taskFile(id));
    return raw ? normalizeTask(raw, id) : null;
  }

  column(column: Column): Task[] {
    return this.list().filter((t) => t.column === column);
  }

  /** The board's folders, in display order. None at all is the normal case. */
  folders(): Folder[] {
    return normalizeFolders(readJson<unknown>(this.paths.folders));
  }

  /** A folder by id or by name (case-insensitive). */
  findFolder(ref: string): Folder | null {
    const folders = this.folders();
    const name = ref.trim().toLowerCase();
    return folders.find((f) => f.id === ref) ?? folders.find((f) => f.name.toLowerCase() === name) ?? null;
  }

  /** A card by id or by number ("12" or "#12"), archived ones included. */
  find(ref: string): Task | null {
    const direct = this.get(ref);
    if (direct) return direct;
    const number = ref.replace(/^#/, '');
    return this.list({ includeArchived: true }).find((t) => String(t.number) === number) ?? null;
  }

  /**
   * The cards Claude should read alongside this one: its own links, then the
   * investigation it was derived from. Cards that no longer exist are skipped.
   */
  relatedOf(task: Task): Task[] {
    const ids = [...task.related];
    if (task.derivedFrom && !ids.includes(task.derivedFrom)) ids.push(task.derivedFrom);
    return ids.map((id) => this.get(id)).filter((t): t is Task => t !== null);
  }

  /** Cards that link this one. Shown to the user, never pushed to Claude. */
  referencedBy(id: string): Task[] {
    return this.list({ includeArchived: true }).filter((t) => t.related.includes(id));
  }

  // --------------------------------------------------------------- writes

  private save(task: Task): Task {
    task.updatedAt = now();
    writeJsonAtomic(this.taskFile(task.id), task);
    return task;
  }

  /** Run a mutation with the board lock held. Return false from `fn` to abort. */
  update(id: string, fn: (task: Task) => void | false): Task {
    return withLock(this.paths.boardLock, () => {
      const task = this.get(id);
      if (!task) throw new Error(`No task with id "${id}"`);
      if (fn(task) === false) return task;
      return this.save(task);
    });
  }

  create(input: {
    title: string;
    description?: string;
    column?: Column;
    position?: 'top' | 'bottom';
    labels?: string[];
    type?: TaskType | null;
    plan?: string | null;
    derivedFrom?: string | null;
    related?: string[];
    folder?: string | null;
    agent?: string | null;
    worker?: string | null;
  }): Task {
    return withLock(this.paths.boardLock, () => {
      const folder = input.folder ? this.requireFolder(input.folder).id : null;
      const column = input.column ?? 'backlog';
      const existing = this.list({ includeArchived: true });
      const keys = existing.filter((t) => t.column === column).map((t) => t.order);
      const number = existing.reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const timestamp = now();
      const id = makeId();
      const known = new Set(existing.map((t) => t.id));
      const task: Task = {
        id,
        number,
        title: input.title.trim() || 'Untitled',
        description: input.description ?? '',
        column,
        order: input.position === 'bottom' ? orderLast(keys) : orderFirst(keys),
        type: input.type ?? null,
        derivedFrom: input.derivedFrom ?? null,
        related: normalizeRelated(input.related, id).filter((r) => known.has(r)),
        folder,
        agent: input.agent ? requireAgentName(input.agent) : null,
        worker: input.worker ? requireWorkerName(input.worker) : null,
        claimedBy: null,
        model: null,
        session: null,
        sessionHistory: [],
        mode: null,
        returnColumn: null,
        plan: input.plan ?? null,
        result: null,
        resultHistory: [],
        labels: normalizeLabels(input.labels),
        attachments: [],
        activity: [],
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
        archived: false,
      };
      return this.save(task);
    });
  }

  /**
   * Apply an edit from the UI. `before`/`after` are the order keys of the
   * neighbours the card was dropped between; omit both to drop it on top.
   */
  patch(
    id: string,
    changes: {
      title?: string;
      description?: string;
      plan?: string | null;
      result?: string | null;
      labels?: string[];
      type?: TaskType | null;
      related?: string[];
      folder?: string | null;
      agent?: string | null;
      worker?: string | null;
      column?: Column;
      before?: string | null;
      after?: string | null;
    },
  ): Task {
    return this.update(id, (task) => {
      // Claude decided how to work this card when it claimed it; changing who
      // works it or what kind of card it is mid-run would not reach it anyway.
      if (task.column === 'in-progress') {
        const locked = (['type', 'agent', 'worker'] as const).filter(
          (key) => changes[key] !== undefined && changes[key] !== task[key],
        );
        if (locked.length) {
          throw refuse(
            409,
            `Claude is working on this card, so its ${locked.join(', ')} cannot change now. ` +
              'Leave a chat message or add a file instead; Claude reads them at its next check-in.',
          );
        }
      }
      if (typeof changes.title === 'string') task.title = changes.title;
      if (typeof changes.description === 'string') task.description = changes.description;
      if (changes.plan !== undefined) task.plan = changes.plan;
      if (changes.result !== undefined) task.result = changes.result;
      if (Array.isArray(changes.labels)) task.labels = normalizeLabels(changes.labels);
      if (changes.type !== undefined) task.type = changes.type;
      if (Array.isArray(changes.related)) this.relink(task, changes.related);
      if (changes.folder !== undefined) this.refile(task, changes.folder);
      if (changes.agent !== undefined) this.assign(task, changes.agent);
      if (changes.worker !== undefined) this.route(task, changes.worker);

      const reordering = changes.before !== undefined || changes.after !== undefined;
      const target = changes.column ?? (reordering ? task.column : null);
      if (!target) return;

      // The single choke point for every move -- the drag, the detail buttons and
      // `ticketrail move` all land here -- so one guard covers all three.
      if (target === 'implement' && isReadOnlyType(task.type)) {
        throw refuse(
          409,
          `${task.type === 'investigation' ? 'An' : 'A'} ${TYPE_LABELS[task.type!]} card never writes code, ` +
            'so it cannot go to Implement. ' +
            (task.type === 'investigation'
              ? 'Use "Create implementation task" under its plan instead.'
              : 'Move it to Plan and Claude will answer it there.'),
        );
      }

      const leaving = task.column;
      const siblings = this.column(target).filter((t) => t.id !== id).map((t) => t.order);
      task.column = target;
      task.order = reordering ? orderBetween(changes.before, changes.after) : orderFirst(siblings);

      if (leaving === target) return;
      if (leaving === 'in-progress') task.cancelRequested = true;
      // dragged off the run altogether: whatever the session does next is not this card's
      if (target !== 'in-progress' && target !== 'user-input') this.endSession(task);
      if (target !== 'user-input') task.returnColumn = null;
      if (target === 'plan' || target === 'implement') {
        task.cancelRequested = false;
        task.finishedAt = null;
      }
      task.activity.push({ at: now(), kind: 'status', text: `Moved to ${COLUMN_LABELS[target]}.` });
    });
  }

  private requireFolder(id: string): Folder {
    const folder = this.folders().find((f) => f.id === id);
    if (!folder) throw refuse(400, `No folder with id "${id}"`);
    return folder;
  }

  /** Put a card in a folder, or take it out with null. */
  private assign(task: Task, agent: string | null): void {
    const next = agent ? requireAgentName(agent) : null;
    if (next === task.agent) return;
    task.agent = next;
    task.activity.push({
      at: now(),
      kind: 'info',
      text: next ? `Assigned to agent ${next}.` : 'No longer assigned to an agent.',
    });
  }

  private route(task: Task, worker: string | null): void {
    const next = worker ? requireWorkerName(worker) : null;
    if (next === task.worker) return;
    task.worker = next;
    task.activity.push({
      at: now(),
      kind: 'info',
      text: next ? `Sent to worker ${next}.` : 'Any worker may take it.',
    });
  }

  private refile(task: Task, folderId: string | null): void {
    const next = folderId ? this.requireFolder(folderId) : null;
    if ((next?.id ?? null) === task.folder) return;
    task.folder = next?.id ?? null;
    task.activity.push({
      at: now(),
      kind: 'info',
      text: next ? `Moved to folder ${next.name}.` : 'Removed from its folder.',
    });
  }

  // -------------------------------------------------------------- folders

  private saveFolders(folders: Folder[]): void {
    writeJsonAtomic(this.paths.folders, { version: 1, folders });
  }

  createFolder(input: { name: string; color?: FolderColor }): Folder {
    return withLock(this.paths.boardLock, () => {
      const name = cleanFolderName(input.name);
      if (!name) throw refuse(400, 'A folder needs a name.');
      const folders = this.folders();
      if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        throw refuse(409, `There is already a folder called "${name}".`);
      }
      const folder: Folder = {
        id: makeId('d'),
        name,
        // a new folder gets the next colour round, so neighbours rarely match
        color: input.color && isFolderColor(input.color) ? input.color : FOLDER_COLORS[(folders.length + 1) % FOLDER_COLORS.length],
        order: orderLast(folders.map((f) => f.order)),
        createdAt: now(),
      };
      this.saveFolders([...folders, folder]);
      return folder;
    });
  }

  /** Rename, recolour, or reorder (between the `before`/`after` keys) a folder. */
  updateFolder(
    id: string,
    changes: { name?: string; color?: FolderColor; before?: string | null; after?: string | null },
  ): Folder {
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      const folder = folders.find((f) => f.id === id);
      if (!folder) throw refuse(404, `No folder with id "${id}"`);
      if (changes.name !== undefined) {
        const name = cleanFolderName(changes.name);
        if (!name) throw refuse(400, 'A folder needs a name.');
        if (folders.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
          throw refuse(409, `There is already a folder called "${name}".`);
        }
        folder.name = name;
      }
      if (changes.color !== undefined) {
        if (!isFolderColor(changes.color)) throw refuse(400, `Unknown colour "${changes.color}".`);
        folder.color = changes.color;
      }
      if (changes.before !== undefined || changes.after !== undefined) {
        folder.order = orderBetween(changes.before, changes.after);
      }
      this.saveFolders(folders);
      return folder;
    });
  }

  /**
   * Remove a folder. Its cards are kept and become unfiled, in the same lock
   * (withLock is not reentrant, so the cards are saved directly).
   */
  deleteFolder(id: string): Folder[] {
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      const folder = folders.find((f) => f.id === id);
      if (!folder) throw refuse(404, `No folder with id "${id}"`);
      for (const task of this.list({ includeArchived: true })) {
        if (task.folder !== id) continue;
        task.folder = null;
        task.activity.push({ at: now(), kind: 'info', text: `Folder ${folder.name} was deleted.` });
        this.save(task);
      }
      const rest = folders.filter((f) => f.id !== id);
      this.saveFolders(rest);
      return rest;
    });
  }

  /** Replace a card's related links, noting what was linked and unlinked. */
  private relink(task: Task, ids: string[]): void {
    const next = normalizeRelated(ids, task.id).filter((r) => this.get(r) !== null);
    const label = (r: string) => `#${this.get(r)?.number ?? '?'}`;
    const added = next.filter((r) => !task.related.includes(r));
    const removed = task.related.filter((r) => !next.includes(r));
    task.related = next;
    if (added.length) task.activity.push({ at: now(), kind: 'info', text: `Linked ${added.map(label).join(', ')}.` });
    if (removed.length) task.activity.push({ at: now(), kind: 'info', text: `Unlinked ${removed.map(label).join(', ')}.` });
  }

  move(id: string, column: Column, before?: string | null, after?: string | null): Task {
    return this.patch(id, { column, before, after });
  }

  archive(id: string): Task {
    return this.update(id, (task) => {
      task.archived = true;
    });
  }

  activity(id: string, text: string, kind: ActivityKind = 'info'): Task {
    return this.update(id, (task) => {
      task.activity.push({ at: now(), kind, text });
    });
  }

  message(id: string, text: string, role: 'claude' | 'user', needsAnswer = false): { task: Task; message: Message } {
    let created!: Message;
    const task = this.update(id, (t) => {
      created = { id: makeId('m'), at: now(), role, text, ...(needsAnswer ? { needsAnswer: true } : {}) };
      t.messages.push(created);
      if (role === 'user') {
        const question = pendingQuestion(t);
        if (question) {
          question.answeredBy = created.id;
          if (t.column === 'user-input') {
            t.column = t.returnColumn ?? 'in-progress';
            t.returnColumn = null;
            t.activity.push({ at: now(), kind: 'status', text: 'Answer received, back to Claude.' });
          }
        }
      }
    });
    return { task, message: created };
  }

  /** Park a task on "User Input" with a blocking question. */
  ask(id: string, question: string): { task: Task; message: Message } {
    let created!: Message;
    const task = this.update(id, (t) => {
      created = { id: makeId('m'), at: now(), role: 'claude', text: question, needsAnswer: true };
      t.messages.push(created);
      if (t.column !== 'user-input') {
        t.returnColumn = t.column === 'in-progress' ? 'in-progress' : t.column;
        t.column = 'user-input';
      }
      t.activity.push(this.status('Waiting for your input.'));
    });
    return { task, message: created };
  }

  /**
   * Claim the top card of Implement, else Plan. A named worker passes its name,
   * which the card records, and may pass `match` to take only the cards meant
   * for it; the lock means two workers never get the same card.
   */
  claimNext(options: { worker?: string | null; match?: (task: Task) => boolean } = {}): Task | null {
    const filter = options.match ?? (() => true);
    const worker = options.worker || null;
    // a card sent to a worker waits for exactly that worker, whatever its filter says
    const match = (t: Task) => (t.worker ? t.worker === worker : filter(t));
    return withLock(this.paths.boardLock, () => {
      const folders = this.folders();
      for (const column of QUEUE_COLUMNS) {
        // the same order the lane shows, so "top card first" is the top card you see
        const candidates = laneOrder(this.list().filter((t) => t.column === column && match(t)), folders);
        const task = candidates[0];
        if (!task) continue;
        // before mode changes: the past run is filed under the mode it ran in
        this.retireSession(task);
        task.mode = column === 'plan' ? 'plan' : 'implement';
        task.column = 'in-progress';
        task.order = orderFirst(this.column('in-progress').map((t) => t.order));
        task.startedAt = now();
        task.finishedAt = null;
        task.cancelRequested = false;
        task.claimedBy = worker;
        // Only this run's part of the transcript: one session works many cards.
        const from = this.session ? sizeOf(this.session.transcript) : null;
        if (this.session && from !== null) {
          task.session = { ...this.session, from, to: null, run: makeId('r'), startedAt: task.startedAt, saved: false };
        }

        // A claim is where a run begins, so it is the one place that can see
        // the model change between planning and implementing the same card.
        const previous = task.model;
        if (this.model) task.model = this.model;
        if (previous && this.model && previous !== this.model) {
          task.activity.push(
            this.status(`Model changed since the last run: ${modelLabel(previous)} → ${modelLabel(this.model)}.`),
          );
        }

        const who = task.claimedBy ? ` (worker ${task.claimedBy})` : '';
        task.activity.push(
          this.status(task.mode === 'plan' ? `Claude started planning${who}.` : `Claude started implementing${who}.`),
        );
        return this.save(task);
      }
      return null;
    });
  }

  /** Finish a planning run: store the plan and park the card for review. */
  savePlan(id: string, plan: string): Task {
    return this.update(id, (task) => {
      task.plan = plan;
      task.mode = 'plan';
      task.column = 'planned';
      task.order = orderFirst(this.column('planned').filter((t) => t.id !== id).map((t) => t.order));
      task.finishedAt = now();
      this.endSession(task);
      task.activity.push(this.status('Plan ready for review.'));
    });
  }

  finish(id: string, result: string): Task {
    return this.update(id, (task) => {
      // A card sent back to Implement finishes again; keep what the last run said.
      if (task.result?.trim()) {
        // finishedAt is cleared when the card is queued again, so date it by its "Done." entry.
        const done = task.activity.findLast((a) => a.kind === 'status' && a.text === 'Done.');
        task.resultHistory = [...task.resultHistory, { at: done?.at ?? task.updatedAt, text: task.result }].slice(
          -MAX_RESULT_HISTORY,
        );
      }
      task.result = result;
      task.column = 'done';
      task.order = orderFirst(this.column('done').filter((t) => t.id !== id).map((t) => t.order));
      task.finishedAt = now();
      this.endSession(task);
      task.activity.push(this.status('Done.'));
    });
  }

  /**
   * Spawn a Feature card from a finished investigation. The plan is copied
   * across rather than referenced: the worker contract already treats a stored
   * plan as an approved spec, so the new card is actionable immediately.
   *
   * Two locked writes rather than one -- withLock is not reentrant -- which is
   * safe here because the worst interleaving loses only the source card's
   * activity note.
   */
  deriveImplementation(id: string): Task {
    const source = this.get(id);
    if (!source) throw new Error(`No task with id "${id}"`);
    if (source.type !== 'investigation') {
      throw refuse(409, 'Only an Investigation card can spawn an implementation task.');
    }
    if (!source.plan) {
      throw refuse(409, 'This investigation has no plan yet, so there is nothing to implement.');
    }

    const created = this.create({
      title: source.title,
      description: `Implements the findings of #${source.number}.`,
      plan: source.plan,
      labels: source.labels,
      type: 'feature',
      derivedFrom: source.id,
      column: 'implement',
    });

    this.activity(source.id, `Spawned #${created.number} to implement this.`, 'status');
    return this.update(created.id, (task) => {
      task.activity.push({ at: now(), kind: 'status', text: `Derived from #${source.number}.` });
    });
  }

  fail(id: string, reason: string): Task {
    const { task } = this.message(id, `I hit a problem and stopped:\n\n${reason}`, 'claude', true);
    return this.update(task.id, (t) => {
      t.returnColumn = t.mode === 'plan' ? 'plan' : 'implement';
      t.column = 'user-input';
      this.endSession(t);
      t.activity.push(this.status(reason, 'error'));
    });
  }

  // ------------------------------------------------------------ attachments

  filePath(attachment: Attachment | string): string {
    return path.join(this.paths.files, typeof attachment === 'string' ? attachment : attachment.id);
  }

  /**
   * Record a file that has already been written into .ticketrail/files/.
   * The bytes land on disk first so a large upload never holds the board lock.
   */
  private record(taskId: string, attachment: Attachment): Task {
    return this.update(taskId, (task) => {
      task.attachments.push(attachment);
      task.activity.push({
        at: now(),
        kind: 'file',
        text: `${attachment.addedBy === 'claude' ? 'Claude attached' : 'Attached'} ${attachment.name}`,
      });
    });
  }

  /** Allocate the on-disk name for a new attachment, extension included. */
  newAttachmentId(name: string, mime: string): string {
    const ext = safeExtension(name, mime);
    return makeId('f') + (ext ? `.${ext}` : '');
  }

  /** Attach bytes already in memory (the CLI reading a file from disk). */
  attach(
    taskId: string,
    input: { name: string; mime: string; data: Buffer; addedBy?: 'user' | 'claude' },
  ): { task: Task; attachment: Attachment } {
    if (!this.get(taskId)) throw new Error(`No task with id "${taskId}"`);
    const id = this.newAttachmentId(input.name, input.mime);
    fs.mkdirSync(this.paths.files, { recursive: true });
    fs.writeFileSync(path.join(this.paths.files, id), input.data);
    return this.finishAttachment(taskId, {
      id,
      name: displayName(input.name, id),
      mime: input.mime,
      size: input.data.length,
      addedAt: now(),
      addedBy: input.addedBy ?? 'claude',
    });
  }

  /**
   * Register a file the server streamed straight to disk. If recording it
   * fails the orphaned bytes are removed, so files/ never accumulates junk.
   */
  finishAttachment(taskId: string, attachment: Attachment): { task: Task; attachment: Attachment } {
    try {
      return { task: this.record(taskId, attachment), attachment };
    } catch (err) {
      try {
        fs.rmSync(this.filePath(attachment), { force: true });
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  detach(taskId: string, attachmentId: string): Task {
    const task = this.update(taskId, (t) => {
      const found = t.attachments.find((a) => a.id === attachmentId);
      if (!found) return false;
      t.attachments = t.attachments.filter((a) => a.id !== attachmentId);
      t.activity.push({ at: now(), kind: 'file', text: `Removed ${found.name}` });
    });
    try {
      fs.rmSync(path.join(this.paths.files, attachmentId), { force: true });
    } catch {
      /* best effort */
    }
    return task;
  }

  setMode(id: string, mode: Mode): Task {
    return this.update(id, (task) => {
      task.mode = mode;
    });
  }
}
