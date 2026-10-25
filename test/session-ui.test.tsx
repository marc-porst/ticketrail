import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTask } from '../src/core/task.ts';
import type { SessionEntry } from '../src/core/transcript.ts';
import { CardDetail } from '../web/src/components/CardDetail.tsx';
import { pairRows } from '../web/src/components/SessionFeed.tsx';

// the latest run is read from its saved copy; an empty one is enough here
beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ recorded: true, live: false, entries: [], clipped: false })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function detail(raw: object) {
  const task = normalizeTask({ id: 't_a', number: 1, title: 'card', ...raw }, 't_a');
  return render(
    <CardDetail
      task={task}
      projectId="p"
      onClose={noop}
      onPatch={noop}
      onReply={noop}
      onDelete={noop}
      onUpload={async () => {}}
      onRemoveAttachment={noop}
      onDerive={noop}
      labelSuggestions={[]}
      allTasks={[task]}
      onOpenCard={noop}
    />,
  );
}

const session = { id: 's', transcript: '/x/projects/p/s.jsonl', from: 0, to: null };

describe('Session tab', () => {
  it('is only there when the run recorded a session', () => {
    detail({ column: 'in-progress' });
    expect(screen.queryByRole('button', { name: /^Session/ })).toBeNull();
    cleanup();
    detail({ column: 'done', session: { ...session, to: 10 } });
    expect(screen.getByRole('button', { name: /^Session/ })).toBeTruthy();
  });

  it('opens on the session while the card is running', () => {
    detail({ column: 'in-progress', plan: 'a plan', session });
    expect(screen.getByRole('button', { name: /^Session/ }).className).toContain('border-sky-400');
  });

  it('keeps every tab on one line, so a dot or count never wraps under its label', () => {
    detail({ column: 'done', plan: 'p', result: 'r', session: { ...session, to: 10 } });
    for (const name of ['Description', 'Plan', 'Result', 'Session', 'Related', 'Files', 'Activity', 'Chat']) {
      const tab = screen.getByRole('button', { name: new RegExp(`^${name}`) });
      expect(tab.className).toContain('whitespace-nowrap');
      expect(tab.className).toContain('shrink-0');
    }
  });

  it('always shows the latest run and lists earlier ones collapsed, newest first', async () => {
    detail({
      column: 'done',
      mode: 'implement',
      session: { ...session, to: 10, run: 'r3', saved: true },
      sessionHistory: [
        { run: 'r1', startedAt: null, endedAt: '2026-10-25T07:00:00.000Z', mode: 'plan' },
        { run: 'r2', startedAt: null, endedAt: '2026-10-25T08:00:00.000Z', mode: 'implement' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /^Session/ }));
    expect(await screen.findByText('Earlier sessions (2)')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /^Run 3 · Implement/.test(el.textContent ?? ''))).toBeTruthy();
    const summaries = [...document.querySelectorAll('details summary')].map((el) => el.textContent);
    expect(summaries[0]).toMatch(/^Run 2 · Implement/);
    expect(summaries[1]).toMatch(/^Run 1 · Plan/);
    expect([...document.querySelectorAll('details')].every((d) => !d.open)).toBe(true);
  });

  it('nests subagent steps under the Agent call that started them', () => {
    const rows = pairRows([
      { id: '1', at: '', kind: 'tool', tool: 'Agent', toolId: 'a1' },
      { id: 's1', at: '', kind: 'tool', tool: 'Bash', toolId: 'b1', parent: 'a1', subagent: true },
      { id: 's2', at: '', kind: 'result', toolId: 'b1', parent: 'a1', subagent: true },
      { id: '2', at: '', kind: 'result', toolId: 'a1' },
      { id: 'x', at: '', kind: 'text', parent: 'gone', subagent: true },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'text']);
    const agent = rows[0].kind === 'tool' ? rows[0] : null;
    expect(agent?.result?.id).toBe('2');
    expect(agent?.steps.map((r) => r.kind)).toEqual(['tool']);
    expect(agent?.steps[0].kind === 'tool' && agent.steps[0].result?.id).toBe('s2');
  });

  it('clears the session after asking once, and not while the run is live', async () => {
    const calls: [string, string][] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url]);
      return new Response(JSON.stringify({ recorded: true, live: false, entries: [], clipped: false }));
    });
    detail({ column: 'in-progress', session });
    fireEvent.click(screen.getByRole('button', { name: /^Session/ }));
    expect(((await screen.findByText('Clear session')) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    detail({ column: 'done', session: { ...session, to: 10 } });
    fireEvent.click(screen.getByRole('button', { name: /^Session/ }));
    fireEvent.click(await screen.findByText('Clear session'));
    expect(calls.some(([m]) => m === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await vi.waitFor(() => expect(calls).toContainEqual(['DELETE', '/api/projects/p/tasks/t_a/session']));
  });

  it('pairs each result with its call, keeping orphans', () => {
    const e = (id: string, kind: SessionEntry['kind'], toolId?: string): SessionEntry => ({ id, at: '', kind, toolId });
    const rows = pairRows([e('0', 'result', 'old'), e('1', 'tool', 'a'), e('2', 'text'), e('3', 'result', 'a')]);
    expect(rows.map((r) => r.kind)).toEqual(['result', 'tool', 'text']);
    expect(rows[1].kind === 'tool' && rows[1].result?.id).toBe('3');
  });
});
