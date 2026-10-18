import { isSkillName } from './skill-rules.ts';

export const COLUMNS = [
  'backlog',
  'plan',
  'user-input',
  'implement',
  'in-progress',
  'planned',
  'done',
] as const;

export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: 'Backlog',
  plan: 'Plan',
  'user-input': 'User Input',
  implement: 'Implement',
  'in-progress': 'In Progress',
  planned: 'Planned',
  done: 'Done',
};

export const COLUMN_HINTS: Record<Column, string> = {
  backlog: 'Not touched by Claude. Draft cards here.',
  plan: 'Queued for Claude to plan.',
  'user-input': 'Waiting for your answer.',
  implement: 'Queued for Claude to build. Top card first.',
  'in-progress': 'Claude is working on this right now.',
  planned: 'Plan ready for your review.',
  done: 'Finished.',
};

/** Columns Claude pulls work from, in priority order. */
export const QUEUE_COLUMNS: Column[] = ['implement', 'plan'];

/** What kind of work a card is. Optional — a card may stay untyped. */
export const TASK_TYPES = ['feature', 'bug', 'investigation', 'question'] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TYPE_LABELS: Record<TaskType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  investigation: 'Investigation',
  question: 'Question',
};

/**
 * Types Claude must never write code for. An investigation produces a plan and
 * nothing else; a question produces an answer. Both are kept out of Implement.
 */
export const READ_ONLY_TYPES: readonly TaskType[] = ['investigation', 'question'];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

export function isReadOnlyType(type: TaskType | null): boolean {
  return type !== null && READ_ONLY_TYPES.includes(type);
}

/** Most a card may carry, and the longest a single one may be. */
export const MAX_LABELS = 8;
export const MAX_LABEL_LENGTH = 32;

/**
 * Trim, collapse inner whitespace, drop empties and duplicates. Comparison is
 * case-insensitive but the case the user typed is what gets stored, so "API"
 * stays "API" and never turns into "api" because someone typed it that way once.
 */
export function normalizeLabels(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length === MAX_LABELS) break;
  }
  return out;
}

/** Most cards one card may link as related context. */
export const MAX_RELATED = 12;

/** Keep only distinct card ids, never the card itself, up to the cap. */
export function normalizeRelated(values: unknown, selfId: string): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string' || !raw || raw === selfId || out.includes(raw)) continue;
    out.push(raw);
    if (out.length === MAX_RELATED) break;
  }
  return out;
}

export type Mode = 'plan' | 'implement';
export type ActivityKind = 'info' | 'file' | 'test' | 'status' | 'error';
export type Role = 'claude' | 'user';

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  text: string;
  /** The model behind this entry. Absent on anything the user did. */
  model?: string;
}

export interface Message {
  id: string;
  at: string;
  role: Role;
  text: string;
  /** Set on a Claude message that blocks progress until answered. */
  needsAnswer?: boolean;
  /** Id of the message that answered this one. */
  answeredBy?: string;
}

/** A result that a later run replaced, kept so it can still be read. */
export interface PastResult {
  /** When that run finished. */
  at: string;
  text: string;
}

/** Oldest past results are dropped beyond this many. */
export const MAX_RESULT_HISTORY = 20;

export interface Attachment {
  /** Also the on-disk basename inside .ticketrail/files/ */
  id: string;
  /** The name the file had when it was added. Display only. */
  name: string;
  mime: string;
  size: number;
  addedAt: string;
  addedBy: Role;
}

export interface Task {
  id: string;
  number: number;
  title: string;
  description: string;
  column: Column;
  order: string;
  /** null when the card is untyped, which is allowed and is the default. */
  type: TaskType | null;
  /** Id of the investigation this card was spawned from. */
  derivedFrom: string | null;
  /** Ids of cards whose context Claude should read with this one. */
  related: string[];
  /** Folder id, or null when the card is not in one. Folders are optional. */
  folder: string | null;
  /** Name of the project agent (.claude/agents/<name>.md) that works this card, or null. */
  agent: string | null;
  /** Only the named worker with this name may claim the card; null lets any worker take it. */
  worker: string | null;
  /** Name of the worker that claimed the most recent run, or null for an unnamed one. */
  claimedBy: string | null;
  /** Model of the most recent run on this card, used to notice a change. */
  model: string | null;
  mode: Mode | null;
  returnColumn: Column | null;
  plan: string | null;
  result: string | null;
  /** Earlier results, oldest first. Empty until a card is finished twice. */
  resultHistory: PastResult[];
  labels: string[];
  attachments: Attachment[];
  activity: ActivityEntry[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  archived: boolean;
}

export function isColumn(value: unknown): value is Column {
  return typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);
}

export function now(): string {
  return new Date().toISOString();
}

export function makeId(prefix = 't'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** What `--worker <name>` accepts, and so what a card can be sent to. */
export const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function isWorkerName(value: unknown): value is string {
  return typeof value === 'string' && WORKER_NAME.test(value);
}

/** Tolerant reader: hand-edited or older task files still load. */
export function normalizeTask(raw: any, fallbackId: string): Task {
  const created = typeof raw?.createdAt === 'string' ? raw.createdAt : now();
  const id = typeof raw?.id === 'string' ? raw.id : fallbackId;
  return {
    id,
    number: Number.isFinite(raw?.number) ? Number(raw.number) : 0,
    title: typeof raw?.title === 'string' ? raw.title : 'Untitled',
    description: typeof raw?.description === 'string' ? raw.description : '',
    column: isColumn(raw?.column) ? raw.column : 'backlog',
    order: typeof raw?.order === 'string' && raw.order ? raw.order : 'n',
    type: isTaskType(raw?.type) ? raw.type : null,
    derivedFrom: typeof raw?.derivedFrom === 'string' ? raw.derivedFrom : null,
    related: normalizeRelated(raw?.related, id),
    folder: typeof raw?.folder === 'string' && raw.folder ? raw.folder : null,
    agent: isSkillName(raw?.agent) ? raw.agent : null,
    worker: isWorkerName(raw?.worker) ? raw.worker : null,
    claimedBy: typeof raw?.claimedBy === 'string' && raw.claimedBy ? raw.claimedBy : null,
    model: typeof raw?.model === 'string' && raw.model ? raw.model : null,
    mode: raw?.mode === 'plan' || raw?.mode === 'implement' ? raw.mode : null,
    returnColumn: isColumn(raw?.returnColumn) ? raw.returnColumn : null,
    plan: typeof raw?.plan === 'string' ? raw.plan : null,
    result: typeof raw?.result === 'string' ? raw.result : null,
    resultHistory: Array.isArray(raw?.resultHistory)
      ? raw.resultHistory
          .filter((r: any) => typeof r?.text === 'string')
          .map((r: any) => ({ at: typeof r?.at === 'string' ? r.at : created, text: r.text }))
          .slice(-MAX_RESULT_HISTORY)
      : [],
    labels: normalizeLabels(raw?.labels),
    attachments: Array.isArray(raw?.attachments)
      ? raw.attachments
          .filter((a: any) => typeof a?.id === 'string')
          .map((a: any) => ({
            id: a.id,
            name: typeof a?.name === 'string' ? a.name : a.id,
            mime: typeof a?.mime === 'string' ? a.mime : 'application/octet-stream',
            size: Number.isFinite(a?.size) ? Number(a.size) : 0,
            addedAt: typeof a?.addedAt === 'string' ? a.addedAt : created,
            addedBy: a?.addedBy === 'claude' ? 'claude' : 'user',
          }))
      : [],
    activity: Array.isArray(raw?.activity)
      ? raw.activity.map((a: any) => ({
          at: typeof a?.at === 'string' ? a.at : created,
          kind: (['info', 'file', 'test', 'status', 'error'].includes(a?.kind) ? a.kind : 'info') as ActivityKind,
          text: String(a?.text ?? ''),
          ...(typeof a?.model === 'string' && a.model ? { model: a.model } : {}),
        }))
      : [],
    messages: Array.isArray(raw?.messages)
      ? raw.messages.map((m: any, i: number) => ({
          id: typeof m?.id === 'string' ? m.id : `m${i}`,
          at: typeof m?.at === 'string' ? m.at : created,
          role: m?.role === 'user' ? 'user' : 'claude',
          text: String(m?.text ?? ''),
          ...(m?.needsAnswer ? { needsAnswer: true } : {}),
          ...(typeof m?.answeredBy === 'string' ? { answeredBy: m.answeredBy } : {}),
        }))
      : [],
    createdAt: created,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : created,
    startedAt: typeof raw?.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw?.finishedAt === 'string' ? raw.finishedAt : null,
    cancelRequested: raw?.cancelRequested === true,
    archived: raw?.archived === true,
  };
}

/** The open question blocking a task, if any. */
export function pendingQuestion(task: Task): Message | null {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const m = task.messages[i];
    if (m.role === 'claude' && m.needsAnswer && !m.answeredBy) return m;
  }
  return null;
}
