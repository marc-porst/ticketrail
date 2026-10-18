import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../web/src/App.tsx';
import { Store } from '../src/core/store.ts';
import { COLUMN_HINTS, COLUMN_LABELS, COLUMNS } from '../src/core/task.ts';
import { StrictMode } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A board built through the real store, then handed to the UI as the server would. */
function buildSnapshot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ui-'));
  const store = Store.init(root);

  store.create({ title: 'Write the onboarding email copy' });

  const building = store.create({ title: 'Extract the auth middleware' });
  store.attach(building.id, { name: 'header-bug.png', mime: 'image/png', data: Buffer.from('fake'), addedBy: 'user' });
  store.move(building.id, 'implement');
  store.claimNext();
  store.activity(building.id, 'moved verifyToken into src/middleware/auth.js', 'file');

  const blocked = store.create({ title: 'Switch the job queue to Redis' });
  store.move(blocked.id, 'implement');
  store.claimNext();
  store.ask(blocked.id, 'Add a Redis service to docker-compose, or point at a managed instance?');

  const finished = store.create({ title: 'Extract the config loader' });
  store.move(finished.id, 'implement');
  store.claimNext();
  store.finish(finished.id, ['## What changed', '', ...Array.from({ length: 60 }, (_, i) => `- step ${i}`)].join('\n'));

  const planned = store.create({ title: 'Paginate the activity feed' });
  store.move(planned.id, 'plan');
  store.claimNext();
  store.savePlan(planned.id, '## Approach\n\nCursor pagination keyed on `(created_at, id)`.');

  store.create({ title: 'Fix the flickering avatar', type: 'bug', labels: ['frontend', 'urgent'] });

  const spike = store.create({ title: 'Should we move to Postgres?', type: 'investigation', labels: ['backend'] });
  store.move(spike.id, 'plan');
  store.claimNext();
  store.savePlan(spike.id, '## Findings\n\nYes, once the write volume doubles.');

  const snapshot = {
    title: 'my-project',
    project: { name: 'my-project', path: '/Users/me/code/my-project', shortPath: '~/code/my-project' },
    columns: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id], hint: COLUMN_HINTS[id] })),
    tasks: store.list(),
  };
  fs.rmSync(root, { recursive: true, force: true });
  return snapshot;
}

let listeners: Record<string, (event: MessageEvent) => void>;
let notifications: { title: string; body: string; tag: string }[];

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

/** Push a board event as the server would when Claude moves a card. */
function move(task: any, column: string) {
  listeners.board?.(
    new MessageEvent('board', {
      data: JSON.stringify({ type: 'updated', id: task.id, task: { ...task, column } }),
    }),
  );
}

beforeEach(() => {
  listeners = {};
  vi.stubGlobal(
    'EventSource',
    class {
      onerror: (() => void) | null = null;
      addEventListener(type: string, fn: (event: MessageEvent) => void) {
        listeners[type] = fn;
      }
      close() {}
    },
  );
  notifications = [];
  vi.stubGlobal(
    'Notification',
    Object.assign(
      class {
        onclick: (() => void) | null = null;
        constructor(title: string, options: any) {
          notifications.push({ title, body: options?.body, tag: options?.tag });
        }
        close() {}
      },
      { permission: 'granted' },
    ),
  );
  vi.stubGlobal('AudioContext', class { state = 'suspended'; resume() { return Promise.resolve(); } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/projects')) {
        return {
          ok: true,
          json: async () => ({
            defaultId: 'p1',
            projects: [
              {
                id: 'p1',
                name: 'my-project',
                path: '/Users/me/code/my-project',
                shortPath: '~/code/my-project',
                missing: false,
                isDefault: true,
                summary: { queued: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
              },
              {
                id: 'p2',
                name: 'side-quest',
                path: '/Users/me/code/side-quest',
                shortPath: '~/code/side-quest',
                missing: false,
                isDefault: false,
                summary: { queued: 1, inProgress: 1, blocked: 1, done: 0, total: 3 },
                workers: { waiting: 1, lastSeen: new Date().toISOString() },
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function connect(snapshot: unknown) {
  await waitFor(() => expect(listeners.snapshot).toBeDefined());
  listeners.snapshot!(new MessageEvent('snapshot', { data: JSON.stringify(snapshot) }));
}

describe('board UI', () => {
  it('renders every column once the stream connects', async () => {
    const snapshot = buildSnapshot();
    render(<App />);
    expect(screen.getByText('Connecting to the board…')).toBeTruthy();

    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Backlog')).toBeTruthy());
    for (const column of COLUMNS) expect(screen.getByText(COLUMN_LABELS[column])).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
  });

  it('shows whether a worker is on the board, not just the connection', async () => {
    render(<App />);
    await connect({ ...buildSnapshot(), workers: { waiting: 0, lastSeen: null } });
    // a card sits in In Progress but nothing has checked in
    await waitFor(() => expect(screen.getByText('stalled?')).toBeTruthy());

    listeners.workers!(new MessageEvent('workers', { data: JSON.stringify({ waiting: 1, lastSeen: new Date().toISOString() }) }));
    await waitFor(() => expect(screen.getByText('working')).toBeTruthy());
    expect(screen.queryByText('live')).toBeNull();
  });

  it('lists the named workers and what they are on', async () => {
    const snapshot = buildSnapshot();
    const building = snapshot.tasks.find((t) => t.title === 'Extract the auth middleware')!;
    building.claimedBy = 'be';
    render(<App />);
    await connect({
      ...snapshot,
      workers: {
        waiting: 1,
        lastSeen: new Date().toISOString(),
        workers: [{ pid: 42, name: 'fe', filter: 'label:frontend', since: new Date().toISOString() }],
      },
    });

    const button = await waitFor(() => screen.getByRole('button', { name: /^Workers:/ }));
    fireEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Workers on this board' });
    expect(within(panel).getByText('fe')).toBeTruthy();
    expect(within(panel).getByText('label:frontend')).toBeTruthy();
    expect(within(panel).getByText('Extract the auth middleware')).toBeTruthy();
    expect(within(panel).getByText('be')).toBeTruthy();
  });

  it('sends a card to one of the waiting workers from the drawer', async () => {
    const { container } = render(<App />);
    await connect({
      ...buildSnapshot(),
      workers: {
        waiting: 2,
        lastSeen: new Date().toISOString(),
        workers: [
          { pid: 1, name: 'be', filter: 'label:backend', since: new Date().toISOString() },
          { pid: 2, name: 'fe', filter: 'label:frontend', since: new Date().toISOString() },
        ],
      },
    });
    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);
    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    const select = within(drawer).getByLabelText('Worker') as HTMLSelectElement;
    expect(within(select).getByText('fe (label:frontend)')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'fe' } });
    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find(
        ([, init]: any[]) => init?.method === 'PATCH' && init.body?.includes('"worker"'),
      );
      expect(JSON.parse(call[1].body).worker).toBe('fe');
    });
  });

  it('filters every lane by the search box, on title and description only', async () => {
    render(<App />);
    await connect(buildSnapshot());
    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());

    const search = screen.getByLabelText('Search cards by title and description');
    fireEvent.change(search, { target: { value: 'extract' } });
    await waitFor(() => expect(screen.queryByText('Write the onboarding email copy')).toBeNull());
    expect(screen.getByText('Extract the auth middleware')).toBeTruthy();
    expect(screen.getByText('Extract the config loader')).toBeTruthy();
    expect(screen.getByText('2 cards')).toBeTruthy();

    // Esc clears it and every card is back
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(screen.getByText('Write the onboarding email copy')).toBeTruthy());
  });

  it('jumps to the search with "/"', async () => {
    render(<App />);
    await connect(buildSnapshot());
    await waitFor(() => expect(screen.getByText('Backlog')).toBeTruthy());
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByLabelText('Search cards by title and description'));
  });

  it('names the project in the switcher and the browser tab', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    expect(screen.getByText('~/code/my-project')).toBeTruthy();
    expect(document.title).toBe('my-project · Ticketrail');
  });

  it('opens the switcher and lists the registered projects', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-project/ }));

    const menu = await waitFor(() => screen.getByRole('listbox'));
    expect(within(menu).getByRole('option', { name: /my-project/ })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: /configure spaces/i })).toBeTruthy();
  });

  it('shows in the switcher which spaces have a worker, a running card or a question', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-project/ }));
    const menu = await waitFor(() => screen.getByRole('listbox'));

    const idle = within(menu).getByRole('option', { name: /my-project/ });
    expect(within(idle).getByLabelText('no worker')).toBeTruthy();
    expect(within(idle).queryByText(/in progress|waiting for you/)).toBeNull();

    const busy = within(menu).getByRole('option', { name: /side-quest/ });
    expect(within(busy).getByLabelText('worker running')).toBeTruthy();
    expect(within(busy).getByText('1 in progress')).toBeTruthy();
    expect(within(busy).getByText('1 waiting for you')).toBeTruthy();
  });

  it('explains a stale server instead of showing its bare 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: any) => {
        if (String(url).endsWith('/api/projects') && !init?.method) {
          return {
            ok: true,
            json: async () => ({
              defaultId: 'p1',
              projects: [
                {
                  id: 'p1',
                  name: 'my-project',
                  path: '/Users/me/code/my-project',
                  shortPath: '~/code/my-project',
                  missing: false,
                  isDefault: true,
                  summary: { queued: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
                },
                {
                  id: 'p2',
                  name: 'side-quest',
                  path: '/Users/me/code/side-quest',
                  shortPath: '~/code/side-quest',
                  missing: false,
                  isDefault: false,
                  summary: { queued: 0, inProgress: 0, blocked: 0, done: 0, total: 0 },
                },
              ],
            }),
          };
        }
        // what a server that predates these routes answers
        if (init?.method) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
        return { ok: true, json: async () => ({}) };
      }),
    );

    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-project/ }));
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /configure spaces/i })));
    const modal = await waitFor(() => screen.getByRole('dialog', { name: /configure spaces/i }));

    fireEvent.click(within(modal).getByRole('button', { name: /remove side-quest/i }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Remove' }));

    const message = await waitFor(() => within(modal).getByText(/older build/i));
    expect(message.textContent).toMatch(/restart it/i);
    expect(within(modal).queryByText(/^Not found$/)).toBeNull();
  });

  it('opens the spaces modal from the switcher and lists every space', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-project/ }));
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /configure spaces/i })));

    const modal = await waitFor(() => screen.getByRole('dialog', { name: /configure spaces/i }));
    expect(within(modal).getByRole('button', { name: 'my-project' })).toBeTruthy();
    expect(within(modal).getByRole('button', { name: 'side-quest' })).toBeTruthy();

    // the board this server was started in cannot be unregistered from here
    expect(within(modal).queryByRole('button', { name: /remove my-project/i })).toBeNull();
    expect(within(modal).getByRole('button', { name: /remove side-quest/i })).toBeTruthy();
  });

  it('confirms before removing a space, and renames one in place', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: /my-project/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-project/ }));
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /configure spaces/i })));
    const modal = await waitFor(() => screen.getByRole('dialog', { name: /configure spaces/i }));

    fireEvent.click(within(modal).getByRole('button', { name: /remove side-quest/i }));
    expect(within(modal).getByText(/Nothing on disk is touched/)).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(
        (fetch as any).mock.calls.some(
          ([url, init]: [string, any]) => url === '/api/projects/p2' && init?.method === 'DELETE',
        ),
      ).toBe(true),
    );

    fireEvent.click(within(modal).getByRole('button', { name: 'side-quest' }));
    const field = within(modal).getByRole('textbox', { name: /space name/i });
    fireEvent.change(field, { target: { value: 'Side Quest' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(
        (fetch as any).mock.calls.some(
          ([url, init]: [string, any]) =>
            url === '/api/projects/p2' && init?.method === 'PATCH' && init.body.includes('Side Quest'),
        ),
      ).toBe(true),
    );
  });

  it('puts each card in its own column and flags the blocked one', async () => {
    const snapshot = buildSnapshot();
    render(<App />);
    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());

    // the card Claude is working on shows its latest activity line
    expect(screen.getByText('moved verifyToken into src/middleware/auth.js')).toBeTruthy();
    // the blocked card surfaces the question and the header counts it
    expect(screen.getByText(/Add a Redis service to docker-compose/)).toBeTruthy();
    expect(screen.getByText('1 waiting on you')).toBeTruthy();
    // only Backlog offers a composer
    expect(screen.getAllByText('+ Add a card')).toHaveLength(1);
  });

  it('opens a card and shows the plan Claude wrote', async () => {
    const snapshot = buildSnapshot();
    const { container } = render(<App />);
    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => {
      const node = container.querySelector('[role="dialog"]');
      if (!node) throw new Error('drawer did not open');
      return node as HTMLElement;
    });
    expect(within(drawer).getByRole('heading', { name: 'Approach' })).toBeTruthy();
    expect(within(drawer).getByText('Planned')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: '→ Implement' })).toBeTruthy();
  });

  it('shows attachments on the card and in a Files tab', async () => {
    const snapshot = buildSnapshot();
    const { container } = render(<App />);
    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());
    fireEvent.click(screen.getByText('Extract the auth middleware').closest('button')!);

    const drawer = await waitFor(() => {
      const node = container.querySelector('[role="dialog"]');
      if (!node) throw new Error('drawer did not open');
      return node as HTMLElement;
    });

    fireEvent.click(within(drawer).getByRole('button', { name: /Files/ }));
    expect(within(drawer).getByText('header-bug.png')).toBeTruthy();
    // the thumbnail streams from this project's endpoint, not a filesystem path
    const img = drawer.querySelector('img[alt="header-bug.png"]') as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/^\/api\/projects\/p1\/files\/f_/);
  });

  it('renders a board sent by an older server that has no attachments field', async () => {
    const snapshot = buildSnapshot();
    // exactly what a pre-attachments server sends
    const legacy = {
      ...snapshot,
      tasks: snapshot.tasks.map(({ attachments, ...rest }) => rest),
    };

    render(<App />);
    await connect(legacy);

    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());
    expect(screen.getByText('Backlog')).toBeTruthy();
    expect(screen.queryByText('The board failed to render')).toBeNull();
  });

  it('lets a finished card reach every tab, with the result on its own', async () => {
    const snapshot = buildSnapshot();
    const { container } = render(<App />);
    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Extract the config loader')).toBeTruthy());
    fireEvent.click(screen.getByText('Extract the config loader').closest('button')!);

    const drawer = await waitFor(() => {
      const n = container.querySelector('[role="dialog"]');
      if (!n) throw new Error('drawer did not open');
      return n as HTMLElement;
    });

    // a done card opens on what it produced
    expect(within(drawer).getByText('What Claude did')).toBeTruthy();

    // and the long result must not be rendered alongside another tab, which is
    // what used to squeeze every other pane to nothing
    fireEvent.click(within(drawer).getByRole('button', { name: /Files/ }));
    expect(within(drawer).getByText(/Drop files here/)).toBeTruthy();
    expect(within(drawer).queryByText('What Claude did')).toBeNull();

    fireEvent.click(within(drawer).getByRole('button', { name: /Description/ }));
    expect(within(drawer).queryByText('What Claude did')).toBeNull();
  });

  it('notifies when Claude parks a card on User Input, but only in a background tab', async () => {
    const snapshot = buildSnapshot();
    // StrictMode on purpose: it double-invokes state updaters, which is how an
    // alert fired from inside one turns into two sounds and two banners.
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await connect(snapshot);
    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());

    const task = snapshot.tasks.find((t: any) => t.title === 'Extract the auth middleware')!;

    // board on screen: the card moving is visible, a banner would be noise
    setHidden(false);
    move(task, 'user-input');
    await waitFor(() => expect(screen.getByText('1 waiting on you')).toBeTruthy());
    expect(notifications).toHaveLength(0);

    // tab in the background: this is what the feature is for
    setHidden(true);
    move({ ...task, column: 'user-input' }, 'done');
    await waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toMatchObject({ title: 'Finished', body: 'Extract the auth middleware' });
  });

  it('says nothing when you move a card yourself from the card drawer', async () => {
    const snapshot = buildSnapshot();
    const { container } = render(<App />);
    await connect(snapshot);
    setHidden(true);

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);
    const drawer = await waitFor(() => {
      const n = container.querySelector('[role="dialog"]');
      if (!n) throw new Error('no drawer');
      return n as HTMLElement;
    });

    fireEvent.click(within(drawer).getByRole('button', { name: '→ Implement' }));

    // the server echoes the move back; it must not alert us about our own click
    const task = snapshot.tasks.find((t: any) => t.title === 'Paginate the activity feed')!;
    move(task, 'in-progress');
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications).toHaveLength(0);
  });

  it('turns the link question back on from Settings, in this browser only', async () => {
    localStorage.setItem('pk:confirm-link', 'off');
    render(<App />);
    await connect(buildSnapshot());

    fireEvent.click(await waitFor(() => screen.getByLabelText('Settings')));
    const ask = await waitFor(() => screen.getByRole('switch', { name: /Ask before linking cards/ }));
    expect(ask.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(ask);
    await waitFor(() => expect(ask.getAttribute('aria-checked')).toBe('true'));
    expect(localStorage.getItem('pk:confirm-link')).toBeNull();
    expect((globalThis.fetch as any).mock.calls.some((c: any[]) => String(c[0]).endsWith('/settings'))).toBe(false);
  });

  it('offers alert switches that are saved to the board', async () => {
    render(<App />);
    await connect(buildSnapshot());

    fireEvent.click(await waitFor(() => screen.getByLabelText('Settings')));
    const sound = await waitFor(() => screen.getByRole('switch', { name: /Sound/ }));
    expect(sound.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(sound);
    await waitFor(() => expect(sound.getAttribute('aria-checked')).toBe('false'));

    const patched = (globalThis.fetch as any).mock.calls.find(
      (c: any[]) => String(c[0]).endsWith('/settings') && c[1]?.method === 'PATCH',
    );
    expect(JSON.parse(patched[1].body)).toEqual({ notifications: { sound: false } });
  });

  it('shows a card\'s type and labels on its face', async () => {
    render(<App />);
    await connect(buildSnapshot());

    const face = await waitFor(() => screen.getByText('Fix the flickering avatar').closest('button')!);
    expect(within(face).getByText('Bug')).toBeTruthy();
    expect(within(face).getByText('frontend')).toBeTruthy();
    expect(within(face).getByText('urgent')).toBeTruthy();
  });

  it('locks type, agent and worker while Claude works the card, but keeps the chat open', async () => {
    const { container } = render(<App />);
    await connect(buildSnapshot());
    await waitFor(() => expect(screen.getByText('Extract the auth middleware')).toBeTruthy());
    fireEvent.click(screen.getByText('Extract the auth middleware').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    for (const name of ['Type', 'Agent', 'Worker']) {
      expect((within(drawer).getByLabelText(name) as HTMLSelectElement).disabled).toBe(true);
    }
    expect((within(drawer).getByLabelText('Folder') as HTMLSelectElement).disabled).toBe(false);

    // jsdom has no layout, so the chat's scroll-to-latest has nothing to call
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(within(drawer).getByRole('button', { name: /^Chat/ }));
    expect(within(drawer).getByText(/A note you send now reaches it at its next check-in/)).toBeTruthy();
  });

  it('lets you set a type from the card drawer', async () => {
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    const select = within(drawer).getByLabelText('Type') as HTMLSelectElement;
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'bug' } });
    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find(
        ([, init]: any[]) => init?.method === 'PATCH' && init.body?.includes('"type"'),
      );
      expect(JSON.parse(call[1].body).type).toBe('bug');
    });
  });

  it('assigns a project agent from the card drawer', async () => {
    const board = globalThis.fetch as unknown as (url: string, init?: any) => Promise<any>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: any) =>
        String(url).endsWith('/agents')
          ? {
              ok: true,
              json: async () => [{ name: 'reviewer', description: 'Reviews', model: null, readonly: false, updatedAt: '' }],
            }
          : board(url, init),
      ),
    );
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByRole('button', { name: 'Agents · 1' })).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    const select = within(drawer).getByLabelText('Agent') as HTMLSelectElement;
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'reviewer' } });
    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find(
        ([, init]: any[]) => init?.method === 'PATCH' && init.body?.includes('"agent"'),
      );
      expect(JSON.parse(call[1].body).agent).toBe('reviewer');
    });
  });

  it('keeps the agent picker in a project with no agents, and offers to create one', async () => {
    const board = globalThis.fetch as unknown as (url: string, init?: any) => Promise<any>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: any) =>
        String(url).endsWith('/agents') ? { ok: true, json: async () => [] } : board(url, init),
      ),
    );
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);
    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    const select = within(drawer).getByLabelText('Agent') as HTMLSelectElement;
    expect(within(select).getByText('New agent…')).toBeTruthy();

    fireEvent.change(select, { target: { value: '__manage' } });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Agents' })).toBeTruthy());
    expect((globalThis.fetch as any).mock.calls.some(([, init]: any[]) => init?.method === 'PATCH')).toBe(false);
  });

  it('adds a label from the card drawer', async () => {
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    const input = within(drawer).getByLabelText('Add label');
    fireEvent.change(input, { target: { value: 'docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find(
        ([, init]: any[]) => init?.method === 'PATCH' && init.body?.includes('"labels"'),
      );
      expect(JSON.parse(call[1].body).labels).toEqual(['docs']);
    });
  });

  it('offers Create implementation task only on a planned investigation', async () => {
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Should we move to Postgres?')).toBeTruthy());
    fireEvent.click(screen.getByText('Should we move to Postgres?').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    expect(within(drawer).getByRole('button', { name: /create implementation task/i })).toBeTruthy();
    // An investigation never writes code, so Implement is not on offer.
    expect(within(drawer).queryByRole('button', { name: '→ Implement' })).toBeNull();

    fireEvent.click(within(drawer).getByRole('button', { name: /create implementation task/i }));
    await waitFor(() => {
      const call = (globalThis.fetch as any).mock.calls.find(([url]: any[]) => String(url).endsWith('/derive'));
      expect(call[1].method).toBe('POST');
    });
  });

  it('hides the derive button on a plain planned card', async () => {
    const { container } = render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    expect(within(drawer).queryByRole('button', { name: /create implementation task/i })).toBeNull();
  });

  it('filters the board to one label and back', async () => {
    render(<App />);
    await connect(buildSnapshot());

    await waitFor(() => expect(screen.getByText('Fix the flickering avatar')).toBeTruthy());
    expect(screen.getByText('Write the onboarding email copy')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'urgent' }));
    await waitFor(() => expect(screen.queryByText('Write the onboarding email copy')).toBeNull());
    expect(screen.getByText('Fix the flickering avatar')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    await waitFor(() => expect(screen.getByText('Write the onboarding email copy')).toBeTruthy());
  });

  it('attributes a status change to the model behind it', async () => {
    const snapshot: any = buildSnapshot();
    const card = snapshot.tasks.find((t: any) => t.title === 'Paginate the activity feed');
    card.activity = [
      { at: new Date().toISOString(), kind: 'status', text: 'Claude started planning.', model: 'claude-opus-5' },
      { at: new Date().toISOString(), kind: 'info', text: 'read src/core/store.ts' },
      {
        at: new Date().toISOString(),
        kind: 'status',
        text: 'Model changed since the last run: Opus 5 → Sonnet 5.',
        model: 'claude-sonnet-5',
      },
    ];

    const { container } = render(<App />);
    await connect(snapshot);

    await waitFor(() => expect(screen.getByText('Paginate the activity feed')).toBeTruthy());
    fireEvent.click(screen.getByText('Paginate the activity feed').closest('button')!);

    const drawer = await waitFor(() => container.querySelector('[role="dialog"]') as HTMLElement);
    fireEvent.click(within(drawer).getByRole('button', { name: /Activity/ }));

    await waitFor(() => expect(within(drawer).getByText('Claude started planning.')).toBeTruthy());
    expect(within(drawer).getByText(/· Opus 5/)).toBeTruthy();
    expect(within(drawer).getByText(/Model changed since the last run/)).toBeTruthy();
    expect(within(drawer).getByText(/· Sonnet 5/)).toBeTruthy();

    // A log line Claude wrote carries no model, so it shows only a time.
    const plain = within(drawer).getByText('read src/core/store.ts').parentElement!;
    expect(plain.textContent).not.toMatch(/·/);
  });

  it('applies a live update pushed from the file watcher', async () => {
    const snapshot = buildSnapshot();
    render(<App />);
    await connect(snapshot);
    await waitFor(() => expect(screen.getByText('Write the onboarding email copy')).toBeTruthy());

    const task = snapshot.tasks.find((t) => t.title === 'Write the onboarding email copy')!;
    listeners.board?.(
      new MessageEvent('board', {
        data: JSON.stringify({ type: 'updated', id: task.id, task: { ...task, title: 'Renamed by Claude' } }),
      }),
    );

    await waitFor(() => expect(screen.getByText('Renamed by Claude')).toBeTruthy());
  });
});

describe('skills view', () => {
  const raw = '---\nname: release-notes\ndescription: Write release notes from git\nmodel: claude-opus-5-5\n---\n\n# Release Notes\n\nUse `git log`.\n';
  let calls: { method: string; url: string; body: any }[];
  /** List three skills instead of one, for the bulk delete view. */
  let bulkMode = false;

  beforeEach(() => {
    calls = [];
    bulkMode = false;
    const board = globalThis.fetch as unknown as (url: string, init?: any) => Promise<any>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: any) => {
        const u = String(url);
        if (!u.includes('/skills')) return board(url, init);
        const method = init?.method ?? 'GET';
        calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined });
        const others = [
          { name: 'pdf', description: 'PDFs', managed: false, readonly: false, files: [], updatedAt: '' },
          { name: 'shared', description: 'Linked in', managed: false, readonly: true, files: [], updatedAt: '' },
          { name: 'ticketrail', description: 'The board', managed: true, readonly: false, files: [], updatedAt: '' },
        ];
        const summary = { name: 'release-notes', description: 'Write release notes from git', managed: false, readonly: false, files: ['reference.md'], updatedAt: '' };
        const skill = { ...summary, raw, frontmatter: {}, frontmatterValid: true, body: '', version: 'v1', path: '/p/.claude/skills/release-notes/SKILL.md' };
        const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
        if (method === 'GET' && u.endsWith('/skills')) return json(bulkMode ? [summary, ...others] : [summary]);
        if (u.endsWith('/skills/delete')) return json({ removed: calls.at(-1)!.body.names, failed: [] });
        if (method === 'GET') return json(skill);
        if (method === 'PUT') return json({ ...skill, raw: calls.at(-1)!.body.raw, version: 'v2' });
        if (method === 'DELETE') return json({ removed: 'release-notes' });
        if (u.endsWith('/import/scan')) {
          return json({
            id: 'scan1',
            repo: 'https://github.com/acme/skills.git',
            ref: null,
            subdir: null,
            skills: [
              { path: 'pdf', name: 'pdf', description: 'PDFs', files: 0, exists: false, duplicateOf: null },
              { path: 'docx', name: 'docx', description: 'Word', files: 2, exists: false, duplicateOf: null },
              { path: 'release-notes', name: 'release-notes', description: 'Notes', files: 0, exists: true, duplicateOf: null },
              { path: '.factory/skills/pdf', name: 'pdf', description: 'PDFs', files: 0, exists: false, duplicateOf: 'pdf' },
            ],
          });
        }
        if (u.endsWith('/import')) return json({ imported: calls.at(-1)!.body.paths, skipped: [] });
        return json({ error: 'nope' }, 400);
      }),
    );
  });

  async function openSkills() {
    render(<App />);
    await connect(buildSnapshot());
    const button = await waitFor(() => screen.getByRole('button', { name: /^Skills · \d+$/ }));
    fireEvent.click(button);
    // the modal is loaded lazily, so it appears a tick later
    return await waitFor(() => screen.getByRole('dialog', { name: 'Skills' }));
  }

  it('lists the project skills and renders the chosen one as a document', async () => {
    const dialog = await openSkills();
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Release Notes' })).toBeTruthy());
    expect(within(dialog).getByText('model')).toBeTruthy();
    expect(within(dialog).getByText('reference.md')).toBeTruthy();
    expect(within(dialog).getAllByText('Write release notes from git').length).toBeGreaterThan(0);
  });

  it('edits the whole file and saves it with the version it loaded', async () => {
    const dialog = await openSkills();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));

    const editor = within(dialog).getByLabelText('Contents of release-notes') as HTMLTextAreaElement;
    expect(editor.value).toBe(raw);
    fireEvent.change(editor, { target: { value: raw + '\nMore.\n' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ raw: raw + '\nMore.\n', version: 'v1' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeTruthy());
  });

  it('checks a new skill name before it can be created', async () => {
    const dialog = await openSkills();
    fireEvent.click(within(dialog).getByRole('button', { name: /New skill/ }));
    fireEvent.change(within(dialog).getByPlaceholderText('release-notes'), { target: { value: 'Bad_Name' } });
    expect(within(dialog).getByText(/Lowercase letters, digits/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Create skill' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks before deleting', async () => {
    const dialog = await openSkills();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete skill' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('imports skills picked from a git repository, with select all', async () => {
    const dialog = await openSkills();
    fireEvent.click(within(dialog).getByRole('button', { name: /Import from git/ }));
    fireEvent.change(within(dialog).getByLabelText('Repository URL'), { target: { value: 'https://github.com/acme/skills' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load skills' }));

    const list = await waitFor(() => within(dialog).getByRole('list', { name: 'Skills in the repository' }));
    // new ones start ticked; one that would replace a project skill does not
    const [pdf, mirror] = within(list).getAllByLabelText('Import pdf') as HTMLInputElement[];
    expect(pdf.checked).toBe(true);
    // a mirrored copy of the same skill is shown but never ticked for you
    expect(mirror.checked).toBe(false);
    expect(within(list).getByText('duplicate of pdf')).toBeTruthy();
    expect((within(list).getByLabelText('Import release-notes') as HTMLInputElement).checked).toBe(false);
    expect(within(list).getByText('already in project')).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText('Select all'));
    expect((within(list).getByLabelText('Import release-notes') as HTMLInputElement).checked).toBe(true);
    expect(mirror.checked).toBe(false);
    fireEvent.click(within(dialog).getByLabelText('Deselect all'));
    expect(pdf.checked).toBe(false);

    fireEvent.click(within(list).getByLabelText('Import docx'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 skill' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/import'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/import'))!.body).toEqual({ scanId: 'scan1', paths: ['docx'], overwrite: false });
    await waitFor(() => expect(within(dialog).getByText(/Imported 1 skill: docx/)).toBeTruthy());
    // the summary scrolls on its own instead of pushing the list out of the dialog
    expect(within(dialog).getByRole('status').className).toMatch(/overflow-y-auto/);
  });

  it('deletes several skills at once after a confirm, never a linked or Ticketrail one', async () => {
    bulkMode = true;
    const dialog = await openSkills();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Select & delete/ })).toBeTruthy());
    await waitFor(() => expect((within(dialog).getByRole('button', { name: /Select & delete/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: /Select & delete/ }));

    const list = within(dialog).getByRole('list', { name: 'Skills to delete' });
    expect((within(list).getByLabelText('Select shared') as HTMLInputElement).disabled).toBe(true);
    expect((within(list).getByLabelText('Select ticketrail') as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByLabelText('Select all'));
    expect((within(list).getByLabelText('Select pdf') as HTMLInputElement).checked).toBe(true);
    expect((within(list).getByLabelText('Select shared') as HTMLInputElement).checked).toBe(false);
    expect((within(list).getByLabelText('Select ticketrail') as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText('2 of 4 selected', { exact: false })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 skills' }));
    expect(calls.some((c) => c.url.endsWith('/skills/delete'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete 2' }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/skills/delete'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/skills/delete'))!.body).toEqual({ names: ['release-notes', 'pdf'] });
    await waitFor(() => expect(within(dialog).getByText(/Deleted 2 skills/)).toBeTruthy());
  });
});
