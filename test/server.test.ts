import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.ts';
import { addProject, projectId } from '../src/core/registry.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';
import { startHeartbeat } from '../src/core/presence.ts';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let home: string;
let alpha: string;
let beta: string;
let server: ServerHandle;
let base: string;

const get = async (p: string) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const send = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-home-'));
  process.env.TICKETRAIL_HOME = home;
  alpha = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-a-'));
  beta = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-b-'));

  const a = Store.init(alpha);
  const b = Store.init(beta);
  a.create({ title: 'only in alpha' });
  b.create({ title: 'only in beta' });
  addProject(alpha);
  addProject(beta);

  server = await startServer(a, { port: 0 });
  base = server.url.replace(/:\d+$/, `:${server.port}`);
});

afterEach(async () => {
  await server.close();
  delete process.env.TICKETRAIL_HOME;
  for (const dir of [home, alpha, beta]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('multi-project server', () => {
  it('lists every registered project and flags the one it was started in', async () => {
    const { body } = await get('/api/projects');
    expect(body.projects).toHaveLength(2);
    expect(body.defaultId).toBe(projectId(alpha));
    expect(body.projects.find((p: any) => p.isDefault).path).toBe(path.resolve(alpha));
  });

  it('serves each board separately', async () => {
    const a = await get(`/api/projects/${projectId(alpha)}/board`);
    const b = await get(`/api/projects/${projectId(beta)}/board`);
    expect(a.body.tasks.map((t: any) => t.title)).toEqual(['only in alpha']);
    expect(b.body.tasks.map((t: any) => t.title)).toEqual(['only in beta']);
  });

  it('404s an unknown project instead of falling back to another board', async () => {
    const { status, body } = await get('/api/projects/deadbeef/board');
    expect(status).toBe(404);
    expect(body.error).toMatch(/Unknown project/);
  });

  it('keeps the pre-projects aliases working for the default board', async () => {
    const { body } = await get('/api/board');
    expect(body.tasks.map((t: any) => t.title)).toEqual(['only in alpha']);
  });

  it('reports whether a worker is waiting on the board', async () => {
    const id = projectId(alpha);
    expect((await get(`/api/projects/${id}/board`)).body.workers).toEqual({ waiting: 0, lastSeen: null, workers: [] });
    const stop = startHeartbeat(new Store(alpha));
    try {
      expect((await get(`/api/projects/${id}/board`)).body.workers.waiting).toBe(1);
      expect((await get(`/api/projects/${projectId(beta)}/board`)).body.workers.waiting).toBe(0);
    } finally {
      stop();
    }
  });

  it('writes to the project named in the path, not the default one', async () => {
    const res = await fetch(`${base}/api/projects/${projectId(beta)}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'added to beta' }),
    });
    expect(res.status).toBe(201);
    expect(new Store(beta).list().map((t) => t.title)).toContain('added to beta');
    expect(new Store(alpha).list().map((t) => t.title)).not.toContain('added to beta');
  });

  it('only wakes the subscribers of the project that changed', async () => {
    const received: Record<string, string[]> = { alpha: [], beta: [] };

    const listen = async (name: string, id: string) => {
      const res = await fetch(`${base}/api/projects/${id}/events`);
      const reader = res.body!.getReader();
      void (async () => {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as any);
          if (done) return;
          const text = decoder.decode(value);
          if (text.includes('event: board')) received[name].push(text);
        }
      })();
      return reader;
    };

    const readerA = await listen('alpha', projectId(alpha));
    const readerB = await listen('beta', projectId(beta));
    await new Promise((r) => setTimeout(r, 150));

    new Store(beta).create({ title: 'a change in beta only' });
    await new Promise((r) => setTimeout(r, 900));

    expect(received.beta.length).toBeGreaterThan(0);
    expect(received.alpha).toHaveLength(0);

    await readerA.cancel();
    await readerB.cancel();
  });

  it('rejects a cross-origin write but allows one from the board itself', async () => {
    const url = `${base}/api/projects/${projectId(alpha)}/tasks`;
    const body = JSON.stringify({ title: 'from elsewhere' });

    const evil = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body,
    });
    expect(evil.status).toBe(403);

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://localhost:${server.port}` },
      body,
    });
    expect(ok.status).toBe(201);
  });

  it('adds a space, initialising the folder when it is not a board yet', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-fresh-'));
    try {
      const { status, body } = await send('POST', '/api/projects', { path: fresh });
      expect(status).toBe(201);
      expect(body.created).toBe(true);
      expect(fs.existsSync(path.join(fresh, '.ticketrail', 'config.json'))).toBe(true);

      const listed = await get('/api/projects');
      expect(listed.body.projects.map((p: any) => p.path)).toContain(path.resolve(fresh));
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('registers an existing board without re-seeding it', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-other-'));
    try {
      const store = Store.init(other);
      store.create({ title: 'already here' });

      const { status, body } = await send('POST', '/api/projects', { path: other });
      expect(status).toBe(200);
      expect(body.created).toBe(false);
      expect(new Store(other).list().map((t) => t.title)).toEqual(['already here']);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a path that is missing or is not a folder', async () => {
    const missing = await send('POST', '/api/projects', { path: path.join(os.tmpdir(), 'pk-nope-nowhere') });
    expect(missing.status).toBe(400);

    const file = path.join(alpha, 'a-file.txt');
    fs.writeFileSync(file, 'hi');
    const notADir = await send('POST', '/api/projects', { path: file });
    expect(notADir.status).toBe(400);

    const blank = await send('POST', '/api/projects', { path: '  ' });
    expect(blank.status).toBe(400);
  });

  it('renames a space, writing the name into that board own config', async () => {
    const id = projectId(beta);
    const { status, body } = await send('PATCH', `/api/projects/${id}`, { title: 'Renamed Beta' });
    expect(status).toBe(200);
    expect(body.name).toBe('Renamed Beta');
    expect(new Store(beta).config().title).toBe('Renamed Beta');

    const listed = await get('/api/projects');
    expect(listed.body.projects.find((p: any) => p.id === id).name).toBe('Renamed Beta');
  });

  it('refuses a blank rename and an unknown project', async () => {
    expect((await send('PATCH', `/api/projects/${projectId(beta)}`, { title: '   ' })).status).toBe(400);
    expect((await send('PATCH', '/api/projects/deadbeef', { title: 'x' })).status).toBe(404);
  });

  it('removes a space from the registry but leaves the folder alone', async () => {
    const id = projectId(beta);
    const { status } = await send('DELETE', `/api/projects/${id}`);
    expect(status).toBe(200);

    const listed = await get('/api/projects');
    expect(listed.body.projects.map((p: any) => p.id)).not.toContain(id);
    expect(fs.existsSync(path.join(beta, '.ticketrail', 'config.json'))).toBe(true);
  });

  it('refuses to remove the board the server was started in', async () => {
    const { status } = await send('DELETE', `/api/projects/${projectId(alpha)}`);
    expect(status).toBe(409);
    const listed = await get('/api/projects');
    expect(listed.body.projects.map((p: any) => p.id)).toContain(projectId(alpha));
  });
});

describe('card types and labels over HTTP', () => {
  const alphaTasks = () => `/api/projects/${projectId(alpha)}/tasks`;

  it('persists labels and a type given at creation', async () => {
    const { status, body } = await send('POST', alphaTasks(), {
      title: 'typed',
      type: 'bug',
      labels: ['  API ', 'api', 'ui'],
    });
    expect(status).toBe(201);
    expect(body.type).toBe('bug');
    expect(body.labels).toEqual(['API', 'ui']);
  });

  it('rejects an unknown type on create and on patch', async () => {
    const created = await send('POST', alphaTasks(), { title: 'x', type: 'nonsense' });
    expect(created.body.type).toBeNull(); // unknown values are ignored, not fatal, on create

    const patched = await send('PATCH', `${alphaTasks()}/${created.body.id}`, { type: 'nonsense' });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toMatch(/Unknown type/);
  });

  it('answers 409 when a read-only card is moved to Implement', async () => {
    const created = await send('POST', alphaTasks(), { title: 'look into it', type: 'investigation' });
    const moved = await send('PATCH', `${alphaTasks()}/${created.body.id}`, { column: 'implement' });

    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/never writes code/);
    const board = await get(`/api/projects/${projectId(alpha)}/board`);
    expect(board.body.tasks.find((t: any) => t.id === created.body.id).column).toBe('backlog');
  });

  it('derives an implementation card from a planned investigation', async () => {
    const store = new Store(alpha);
    const source = store.create({ title: 'how do uploads work?', type: 'investigation' });
    store.move(source.id, 'plan');
    store.claimNext();
    store.savePlan(source.id, '# Findings');

    const { status, body } = await send('POST', `${alphaTasks()}/${source.id}/derive`);
    expect(status).toBe(201);
    expect(body.type).toBe('feature');
    expect(body.column).toBe('implement');
    expect(body.plan).toBe('# Findings');
    expect(body.derivedFrom).toBe(source.id);
  });

  // A synchronous handler that throws used to escape the dispatcher's .catch and
  // leave the request hanging. DELETE is sync, so it is the cheapest guard.
  it('answers rather than hanging when a synchronous handler throws', async () => {
    const { status, body } = await send('DELETE', `${alphaTasks()}/t_does_not_exist`);
    expect(status).toBe(404);
    expect(body.error).toMatch(/No task with id/);
  });

  it('refuses to derive from a card with no plan', async () => {
    const created = await send('POST', alphaTasks(), { title: 'unplanned', type: 'investigation' });
    const { status, body } = await send('POST', `${alphaTasks()}/${created.body.id}/derive`);
    expect(status).toBe(409);
    expect(body.error).toMatch(/no plan yet/);
  });

  it('links related cards through PATCH and refuses a non-array', async () => {
    const a = await send('POST', alphaTasks(), { title: 'context' });
    const b = await send('POST', alphaTasks(), { title: 'the work' });

    const linked = await send('PATCH', `${alphaTasks()}/${b.body.id}`, { related: [a.body.id, 't_gone'] });
    expect(linked.status).toBe(200);
    expect(linked.body.related).toEqual([a.body.id]);

    const bad = await send('PATCH', `${alphaTasks()}/${b.body.id}`, { related: a.body.id });
    expect(bad.status).toBe(400);
  });

  it('creates, edits and deletes folders, and validates a card\'s folder', async () => {
    const base = `/api/projects/${projectId(alpha)}`;
    const made = await send('POST', `${base}/folders`, { name: 'Auth' });
    expect(made.status).toBe(201);
    expect((await send('POST', `${base}/folders`, { name: 'auth' })).status).toBe(409);

    const renamed = await send('PATCH', `${base}/folders/${made.body.id}`, { name: 'Auth rework', color: 'rose' });
    expect(renamed.body).toMatchObject({ name: 'Auth rework', color: 'rose' });

    const task = await send('POST', alphaTasks(), { title: 'login' });
    const filed = await send('PATCH', `${alphaTasks()}/${task.body.id}`, { folder: made.body.id });
    expect(filed.body.folder).toBe(made.body.id);
    expect((await send('PATCH', `${alphaTasks()}/${task.body.id}`, { folder: 'd_nope' })).status).toBe(400);
    expect((await send('PATCH', `${alphaTasks()}/${task.body.id}`, { folder: 7 })).status).toBe(400);

    const board = await get(`${base}/board`);
    expect(board.body.folders.map((f: any) => f.name)).toEqual(['Auth rework']);

    expect((await send('DELETE', `${base}/folders/${made.body.id}`)).status).toBe(200);
    const after = await get(`${base}/board`);
    expect(after.body.folders).toEqual([]);
    expect(after.body.tasks.find((t: any) => t.id === task.body.id).folder).toBeNull();
  });
});

describe('skills over HTTP', () => {
  it('lists, creates, saves, guards and deletes a project skill', async () => {
    const skills = `/api/projects/${projectId(alpha)}/skills`;
    expect((await get(skills)).body).toEqual([]);

    const made = await send('POST', skills, { name: 'release-notes', description: 'Write release notes' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'release-notes', frontmatter: { description: 'Write release notes' } });
    expect((await send('POST', skills, { name: 'release-notes', description: 'again' })).status).toBe(409);
    expect((await send('POST', skills, { name: 'Bad Name', description: 'x' })).status).toBe(400);

    const listed = await get(skills);
    expect(listed.body.map((s: any) => s.name)).toEqual(['release-notes']);
    // the other board has its own .claude, and nothing in it
    expect((await get(`/api/projects/${projectId(beta)}/skills`)).body).toEqual([]);

    const saved = await send('PUT', `${skills}/release-notes`, { raw: made.body.raw + '\nMore.\n', version: made.body.version });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(path.join(alpha, '.claude/skills/release-notes/SKILL.md'), 'utf8')).toMatch(/More\.\n$/);
    expect((await send('PUT', `${skills}/release-notes`, { raw: 'stale', version: made.body.version })).status).toBe(409);

    expect((await get(`${skills}/nope`)).status).toBe(404);
    // an encoded slash survives URL normalisation and reaches the handler as a name
    expect((await get(`${skills}/${encodeURIComponent('a/../../..')}`)).status).toBe(400);

    expect((await send('DELETE', `${skills}/release-notes`)).body).toEqual({ removed: 'release-notes' });

    await send('POST', skills, { name: 'a', description: 'x' });
    await send('POST', skills, { name: 'b', description: 'x' });
    const bulk = await send('POST', `${skills}/delete`, { names: ['a', 'b', 'nope'] });
    expect(bulk.body.removed).toEqual(['a', 'b']);
    expect(bulk.body.failed).toEqual([{ name: 'nope', reason: 'No skill named "nope"' }]);
    expect((await get(skills)).body).toEqual([]);
    expect(fs.existsSync(path.join(alpha, '.claude/skills/release-notes'))).toBe(false);
  });
});

describe('agents over HTTP', () => {
  it('creates, saves, guards and deletes a project agent, and assigns it to a card', async () => {
    const agents = `/api/projects/${projectId(alpha)}/agents`;
    expect((await get(agents)).body).toEqual([]);

    const made = await send('POST', agents, { name: 'reviewer', template: 'reviewer' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'reviewer', frontmatter: { name: 'reviewer' } });
    expect((await send('POST', agents, { name: 'reviewer', description: 'again' })).status).toBe(409);
    expect((await get(agents)).body.map((a: any) => a.name)).toEqual(['reviewer']);
    expect((await get(`/api/projects/${projectId(beta)}/agents`)).body).toEqual([]);

    const saved = await send('PUT', `${agents}/reviewer`, { raw: made.body.raw + 'More.\n', version: made.body.version });
    expect(saved.status).toBe(200);
    expect((await send('PUT', `${agents}/reviewer`, { raw: 'stale', version: made.body.version })).status).toBe(409);
    expect((await get(`${agents}/${encodeURIComponent('a/../../..')}`)).status).toBe(400);

    const card = (await get(`/api/projects/${projectId(alpha)}/board`)).body.tasks[0];
    const patched = await send('PATCH', `/api/projects/${projectId(alpha)}/tasks/${card.id}`, { agent: 'reviewer' });
    expect(patched.body.agent).toBe('reviewer');
    expect((await send('PATCH', `/api/projects/${projectId(alpha)}/tasks/${card.id}`, { agent: 3 })).status).toBe(400);

    expect((await send('DELETE', `${agents}/reviewer`)).body).toEqual({ removed: 'reviewer' });
    expect(fs.existsSync(path.join(alpha, '.claude/agents/reviewer.md'))).toBe(false);
  });
});

describe('skill import over HTTP', () => {
  it('scans a repository and imports the skills picked from it', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-http-repo-'));
    fs.mkdirSync(path.join(repo, 'pdf'));
    fs.writeFileSync(path.join(repo, 'pdf/SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'x');

    const skills = `/api/projects/${projectId(alpha)}/skills`;
    expect((await send('POST', `${skills}/import/scan`, { url: '--upload-pack=x' })).status).toBe(400);
    const scan = await send('POST', `${skills}/import/scan`, { url: pathToFileURL(repo).toString() });
    expect(scan.status).toBe(200);
    expect(scan.body.skills).toEqual([expect.objectContaining({ path: 'pdf', name: 'pdf', exists: false })]);

    const done = await send('POST', `${skills}/import`, { scanId: scan.body.id, paths: ['pdf'] });
    expect(done.body).toEqual({ imported: ['pdf'], skipped: [] });
    expect((await get(skills)).body.map((s: any) => s.name)).toEqual(['pdf']);
    expect((await send('POST', `${skills}/import`, { scanId: 'gone', paths: ['pdf'] })).status).toBe(410);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
