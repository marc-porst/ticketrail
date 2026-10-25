import http, { type IncomingMessage } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../core/store.ts';
import {
  addProject,
  describeProject,
  describeProjects,
  findProject,
  isBoard,
  projectId,
  removeProject,
  shortenPath,
} from '../core/registry.ts';
import { initBoard } from '../core/board-init.ts';
import { chooseFolder } from './folder-dialog.ts';
import { BoardWatcher, type BoardEvent } from '../core/watch.ts';
import { workerPresence } from '../core/presence.ts';
import { createAgent, deleteAgent, listAgents, readAgent, writeAgent } from '../core/agents.ts';
import { createSkill, deleteSkill, deleteSkills, listSkills, readSkill, writeSkill } from '../core/skills.ts';
import { forgetScans, importSkills, scanRepo } from '../core/skill-import.ts';
import { COLUMNS, COLUMN_HINTS, COLUMN_LABELS, isColumn, isTaskType, TASK_TYPES } from '../core/task.ts';
import { displayName, mimeForExtension } from '../core/files.ts';
import { Router, readJsonBody, sendJson, type Ctx, type Handler } from './http.ts';
import { SseHub } from './sse.ts';
import { sendSavedSession, sendSession, streamSession } from './session.ts';
import { streamToFile } from './upload.ts';
import { resolveWebRoot, serveStatic } from './static.ts';

export interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function snapshot(store: Store) {
  return {
    title: store.projectName(),
    project: {
      id: projectId(store.root),
      name: store.projectName(),
      path: store.root,
      shortPath: shortenPath(store.root),
    },
    settings: store.config().notifications,
    keepSessions: store.config().keepSessions,
    columns: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id], hint: COLUMN_HINTS[id] })),
    folders: store.folders(),
    tasks: store.list(),
    workers: workerPresence(store),
  };
}

/** How often the server re-reads worker heartbeats; expiry is time-based, so it has to poll. */
const PRESENCE_POLL_MS = 5_000;

/**
 * Compare against the Host the request actually used, rather than a port
 * guessed up front -- the server may have been asked to pick its own.
 * No Origin at all means a non-browser caller (curl, the CLI), which is fine.
 */
function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The folder dialog opens a window on the machine running the server, so it is
 * only ever meaningful to a browser on that same machine.
 */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export async function startServer(store: Store, options: { port?: number; host?: string } = {}): Promise<ServerHandle> {
  const config = store.config();
  const port = options.port ?? config.port;
  const host = options.host ?? '127.0.0.1';
  const hub = new SseHub();
  const webRoot = resolveWebRoot();

  const defaultId = projectId(store.root);
  const stores = new Map<string, Store>([[defaultId, store]]);
  const watchers = new Map<string, BoardWatcher>();
  const presencePolls = new Map<string, NodeJS.Timeout>();

  /** Resolve a project id to a board, or nothing if it is unknown or gone. */
  const storeFor = (id: string): Store | null => {
    const cached = stores.get(id);
    if (cached) return cached;
    const record = findProject(id);
    if (!record || !isBoard(record.path)) return null;
    const resolved = new Store(record.path);
    stores.set(id, resolved);
    return resolved;
  };

  /** A watcher per project, started the first time somebody subscribes to it. */
  const watch = (id: string, target: Store): void => {
    if (watchers.has(id)) return;
    const watcher = new BoardWatcher(target).start();
    watcher.on('board', (event: BoardEvent) => hub.broadcast(id, event));
    watchers.set(id, watcher);

    // .runtime/ is a dot-dir the watcher skips, and a heartbeat expires without
    // any write at all, so presence is polled and pushed only when it changes.
    let last = JSON.stringify(workerPresence(target));
    const poll = setInterval(() => {
      if (!hub.watching(id)) return;
      const presence = workerPresence(target);
      const next = JSON.stringify(presence);
      if (next === last) return;
      last = next;
      hub.broadcastWorkers(id, presence);
    }, PRESENCE_POLL_MS);
    poll.unref?.();
    presencePolls.set(id, poll);
  };

  const router = new Router();

  /** Wrap a handler so it always receives a real board, or answers 404. */
  const board = (handler: (store: Store, ctx: Ctx) => void | Promise<void>): Handler => {
    return (ctx) => {
      const resolved = storeFor(ctx.params.pid ?? defaultId);
      if (!resolved) {
        return sendJson(ctx.res, 404, {
          error: `Unknown project "${ctx.params.pid}". Register it with: ticketrail projects add <path>`,
        });
      }
      return handler(resolved, ctx);
    };
  };

  router.get('/api/projects', ({ res }) =>
    sendJson(res, 200, {
      defaultId,
      projects: describeProjects().map((p) => ({ ...p, isDefault: p.id === defaultId })),
    }),
  );

  // Registered before the :pid routes below: the router matches in insertion
  // order and "browse" would otherwise be read as a project id.
  router.post('/api/projects/browse', async ({ req, res }) => {
    if (!isLoopback(req)) {
      return sendJson(res, 403, {
        error: 'The folder picker opens on the machine running the board. Type the path instead.',
      });
    }
    const picked = await chooseFolder();
    sendJson(res, 200, picked ? { path: picked } : { cancelled: true });
  });

  /** Add a space: initialise the folder as a board if it is not one yet. */
  router.post('/api/projects', async ({ req, res }) => {
    const body = await readJsonBody(req);
    const raw = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!raw) return sendJson(res, 400, { error: 'A folder path is required' });

    const root = path.resolve(raw.startsWith('~') ? raw.replace(/^~/, os.homedir()) : raw);
    if (!fs.existsSync(root)) return sendJson(res, 400, { error: `No such folder: ${root}` });
    if (!fs.statSync(root).isDirectory()) return sendJson(res, 400, { error: `Not a folder: ${root}` });

    const created = !isBoard(root);
    if (created) initBoard(root);
    const record = addProject(root);
    const id = projectId(root);
    stores.delete(id);

    sendJson(res, created ? 201 : 200, {
      created,
      project: { ...describeProject(record), isDefault: id === defaultId },
    });
  });

  /** Rename a space. The name lives in that board's own config.json. */
  router.patch('/api/projects/:pid', async ({ req, res, params }) => {
    const record = findProject(params.pid);
    if (!record) return sendJson(res, 404, { error: `Unknown project "${params.pid}"` });
    if (!isBoard(record.path)) {
      return sendJson(res, 404, { error: 'That folder no longer holds a board, so it cannot be renamed.' });
    }
    const body = await readJsonBody(req);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return sendJson(res, 400, { error: 'A name is required' });

    new Store(record.path).updateSettings({ title });
    sendJson(res, 200, { ...describeProject(record), isDefault: record.id === defaultId });
  });

  /** Unregister a space. Nothing on disk is touched. */
  router.delete('/api/projects/:pid', async ({ res, params }) => {
    const record = findProject(params.pid);
    if (!record) return sendJson(res, 404, { error: `Unknown project "${params.pid}"` });
    if (record.id === defaultId) {
      return sendJson(res, 409, {
        error: 'This is the board the server was started in — it re-registers itself on every start.',
      });
    }
    removeProject(record.id);
    stores.delete(record.id);
    const watcher = watchers.get(record.id);
    if (watcher) {
      await watcher.stop();
      watchers.delete(record.id);
    }
    sendJson(res, 200, { removed: { id: record.id, path: record.path } });
  });

  router.get('/api/projects/:pid/board', board((s, { res }) => sendJson(res, 200, snapshot(s))));

  router.get(
    '/api/projects/:pid/settings',
    board((s, { res }) => {
      const config = s.config();
      sendJson(res, 200, { title: config.title, notifications: config.notifications, keepSessions: config.keepSessions });
    }),
  );

  router.patch(
    '/api/projects/:pid/settings',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      const flags = ['sound', 'desktop', 'onStart'] as const;
      const notifications: Record<string, boolean> = {};
      for (const flag of flags) {
        if (typeof body?.notifications?.[flag] === 'boolean') notifications[flag] = body.notifications[flag];
      }
      const keepSessions = typeof body?.keepSessions === 'boolean' ? body.keepSessions : undefined;
      const config = s.updateSettings({ title: body.title, notifications, keepSessions });
      sendJson(res, 200, { title: config.title, notifications: config.notifications, keepSessions: config.keepSessions });
    }),
  );

  router.get(
    '/api/projects/:pid/events',
    board((s, { res, params }) => {
      const id = params.pid ?? defaultId;
      watch(id, s);
      hub.attach(id, res, snapshot(s));
    }),
  );

  router.post(
    '/api/projects/:pid/tasks',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return sendJson(res, 400, { error: 'A title is required' });
      }
      sendJson(
        res,
        201,
        s.create({
          title: body.title,
          description: typeof body.description === 'string' ? body.description : '',
          column: isColumn(body.column) ? body.column : 'backlog',
          position: body.position === 'bottom' ? 'bottom' : 'top',
          type: isTaskType(body.type) ? body.type : null,
          labels: Array.isArray(body.labels) ? body.labels : [],
        }),
      );
    }),
  );

  router.patch(
    '/api/projects/:pid/tasks/:id',
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      if (body.column !== undefined && !isColumn(body.column)) {
        return sendJson(res, 400, { error: `Unknown column "${body.column}"` });
      }
      if (body.type !== undefined && body.type !== null && !isTaskType(body.type)) {
        return sendJson(res, 400, { error: `Unknown type "${body.type}". One of: ${TASK_TYPES.join(', ')}` });
      }
      if (body.related !== undefined && !Array.isArray(body.related)) {
        return sendJson(res, 400, { error: '"related" must be an array of card ids' });
      }
      if (body.folder !== undefined && body.folder !== null && typeof body.folder !== 'string') {
        return sendJson(res, 400, { error: '"folder" must be a folder id or null' });
      }
      if (body.agent !== undefined && body.agent !== null && typeof body.agent !== 'string') {
        return sendJson(res, 400, { error: '"agent" must be an agent name or null' });
      }
      if (body.worker !== undefined && body.worker !== null && typeof body.worker !== 'string') {
        return sendJson(res, 400, { error: '"worker" must be a worker name or null' });
      }
      sendJson(res, 200, s.patch(params.id, body));
    }),
  );

  // The worker's terminal for this card, read from its Claude Code transcript.
  router.get('/api/projects/:pid/tasks/:id/session', board((s, { res, params }) => sendSession(s, params.id, res)));
  router.get(
    '/api/projects/:pid/tasks/:id/session/events',
    board((s, { res, params }) => streamSession(s, params.id, res)),
  );
  router.delete(
    '/api/projects/:pid/tasks/:id/session',
    board((s, { res, params }) => sendJson(res, 200, s.clearSession(params.id))),
  );
  router.get(
    '/api/projects/:pid/tasks/:id/sessions/:run',
    board((s, { res, params }) => sendSavedSession(s, params.id, params.run, res)),
  );

  // Folders: optional groups that span every lane. The watcher broadcasts the
  // new list to every open tab once folders.json is written.
  router.get('/api/projects/:pid/folders', board((s, { res }) => sendJson(res, 200, s.folders())));

  router.post(
    '/api/projects/:pid/folders',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, s.createFolder({ name: body.name, color: body.color }));
    }),
  );

  router.patch(
    '/api/projects/:pid/folders/:fid',
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, s.updateFolder(params.fid, body));
    }),
  );

  router.delete(
    '/api/projects/:pid/folders/:fid',
    board((s, { res, params }) => sendJson(res, 200, s.deleteFolder(params.fid))),
  );

  // Skills: the project's .claude/skills/<name>/SKILL.md. Not watched; the
  // skills view reloads on open, after each change and on focus.
  router.get('/api/projects/:pid/skills', board((s, { res }) => sendJson(res, 200, listSkills(s.root))));

  // Import from git: clone and list first, then copy the skills picked.
  router.post(
    '/api/projects/:pid/skills/import/scan',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, await scanRepo(s.root, body.url));
    }),
  );

  router.post(
    '/api/projects/:pid/skills/import',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, importSkills(s.root, body));
    }),
  );

  router.post(
    '/api/projects/:pid/skills/delete',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, deleteSkills(s.root, body.names));
    }),
  );

  router.get(
    '/api/projects/:pid/skills/:name',
    board((s, { res, params }) => sendJson(res, 200, readSkill(s.root, params.name))),
  );

  router.post(
    '/api/projects/:pid/skills',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, createSkill(s.root, body));
    }),
  );

  router.put(
    '/api/projects/:pid/skills/:name',
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, writeSkill(s.root, params.name, body.raw, body.version, body.force === true));
    }),
  );

  router.delete(
    '/api/projects/:pid/skills/:name',
    board((s, { res, params }) => sendJson(res, 200, deleteSkill(s.root, params.name))),
  );

  // Agents: the project's .claude/agents/<name>.md. Like skills, not watched;
  // the agents view reloads on open, after each change and on focus.
  router.get('/api/projects/:pid/agents', board((s, { res }) => sendJson(res, 200, listAgents(s.root))));

  router.get(
    '/api/projects/:pid/agents/:name',
    board((s, { res, params }) => sendJson(res, 200, readAgent(s.root, params.name))),
  );

  router.post(
    '/api/projects/:pid/agents',
    board(async (s, { req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, createAgent(s.root, body));
    }),
  );

  router.put(
    '/api/projects/:pid/agents/:name',
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, writeAgent(s.root, params.name, body.raw, body.version, body.force === true));
    }),
  );

  router.delete(
    '/api/projects/:pid/agents/:name',
    board((s, { res, params }) => sendJson(res, 200, deleteAgent(s.root, params.name))),
  );

  router.delete(
    '/api/projects/:pid/tasks/:id',
    board((s, { res, params }) => sendJson(res, 200, s.archive(params.id))),
  );

  /** Spawn a Feature card from a finished investigation. */
  router.post(
    '/api/projects/:pid/tasks/:id/derive',
    board((s, { res, params }) => sendJson(res, 201, s.deriveImplementation(params.id))),
  );

  router.post(
    '/api/projects/:pid/tasks/:id/messages',
    board(async (s, { req, res, params }) => {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return sendJson(res, 400, { error: 'A message needs text' });
      }
      const { task } = s.message(params.id, body.text.trim(), body.role === 'claude' ? 'claude' : 'user');
      sendJson(res, 201, task);
    }),
  );

  router.post(
    '/api/projects/:pid/tasks/:id/attachments',
    board(async (s, { req, res, params }) => {
      if (!s.get(params.id)) return sendJson(res, 404, { error: `No task with id "${params.id}"` });

      const header = req.headers['x-filename'];
      const rawName = typeof header === 'string' ? decodeURIComponent(header) : '';
      const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
      const name = displayName(rawName, 'upload');

      const id = s.newAttachmentId(name, mime);
      const size = await streamToFile(req, s.filePath(id));
      const { attachment } = s.finishAttachment(params.id, {
        id,
        name,
        mime,
        size,
        addedAt: new Date().toISOString(),
        addedBy: 'user',
      });
      sendJson(res, 201, attachment);
    }),
  );

  router.delete(
    '/api/projects/:pid/tasks/:id/attachments/:fileId',
    board((s, { res, params }) => sendJson(res, 200, s.detach(params.id, params.fileId))),
  );

  router.get(
    '/api/projects/:pid/files/:fileId',
    board((s, { res, url, params }) => {
      // fileId is a single path segment so it cannot traverse, but resolve and
      // check against the project's own files directory before opening it.
      const dir = path.resolve(s.paths.files);
      const file = path.resolve(dir, params.fileId);
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        return sendJson(res, 404, { error: 'No such file' });
      }
      const known = s
        .list()
        .flatMap((t) => t.attachments)
        .find((a) => a.id === params.fileId);

      res.writeHead(200, {
        'content-type': known?.mime ?? mimeForExtension(path.extname(file)),
        'content-length': fs.statSync(file).size,
        'cache-control': 'private, max-age=31536000, immutable',
        ...(url.searchParams.has('download') && known
          ? { 'content-disposition': `attachment; filename="${known.name.replace(/"/g, '')}"` }
          : {}),
      });
      fs.createReadStream(file).pipe(res);
    }),
  );

  // Aliases for the project this server was started in, so a page left open
  // from before projects existed keeps working.
  router.get('/api/board', board((s, { res }) => sendJson(res, 200, snapshot(s))));
  router.get(
    '/api/events',
    board((s, { res }) => {
      watch(defaultId, s);
      hub.attach(defaultId, res, snapshot(s));
    }),
  );

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    // One server now reaches every board on the machine, so a page you happen
    // to be visiting must not be able to drive it. Same-origin only for writes;
    // a missing Origin (curl, the CLI) is fine.
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req.headers.origin, req.headers.host)) {
      return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
    }

    const route = router.match(method, url.pathname);

    if (route) {
      const fail = (err: Error) => {
        if (res.headersSent) return res.end();
        // Stores tag a deliberate refusal with a status; anything else is a fault.
        const tagged = (err as Error & { status?: number }).status;
        const missing = /No task with id/.test(err.message);
        sendJson(res, tagged ?? (missing ? 404 : 500), { error: err.message });
      };
      // A synchronous handler that throws never reaches .catch, so without this
      // try the request hangs until the client gives up rather than answering.
      try {
        Promise.resolve(route.handler({ req, res, url, params: route.params })).catch(fail);
      } catch (err) {
        fail(err as Error);
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

    if (webRoot && method === 'GET' && serveStatic(webRoot, url.pathname, res)) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      webRoot
        ? 'Not found'
        : 'The Ticketrail UI has not been built. Run "npm run build:web" in the ticketrail package.',
    );
  });

  addProject(store.root);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = (server.address() as { port: number }).port;
  const url = `http://localhost:${actualPort}`;

  fs.mkdirSync(store.paths.runtime, { recursive: true });
  fs.writeFileSync(store.paths.serverInfo, JSON.stringify({ pid: process.pid, port: actualPort, url }, null, 2));

  const close = async () => {
    for (const watcher of watchers.values()) await watcher.stop();
    watchers.clear();
    for (const poll of presencePolls.values()) clearInterval(poll);
    forgetScans();
    presencePolls.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // only clear the record if it is still ours: a newer server may own it
      const current = JSON.parse(fs.readFileSync(store.paths.serverInfo, 'utf8')) as { pid: number };
      if (current.pid === process.pid) fs.rmSync(store.paths.serverInfo, { force: true });
    } catch {
      /* nothing to clean up */
    }
  };

  return { port: actualPort, url, close };
}
