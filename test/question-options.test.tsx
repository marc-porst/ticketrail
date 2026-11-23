import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionOptions } from '../web/src/components/QuestionOptions.tsx';
import { CardFace } from '../web/src/components/Card.tsx';
import { normalizeTask, type Message } from '../src/core/task.ts';

afterEach(cleanup);

const question = (extra: Partial<Message> = {}): Message => ({
  id: 'm1',
  at: '2026-11-23T10:00:00.000Z',
  role: 'claude',
  text: 'Which database?',
  needsAnswer: true,
  options: [{ label: 'Postgres', description: 'Needs a server' }, { label: 'SQLite' }, { label: 'DuckDB' }],
  ...extra,
});

describe('question options', () => {
  it('answers a single-choice question with one click', () => {
    const onAnswer = vi.fn();
    render(<QuestionOptions question={question()} onAnswer={onAnswer} />);
    expect(screen.getByText('Needs a server')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /SQLite/ }));
    expect(onAnswer).toHaveBeenCalledWith('SQLite', ['SQLite']);
  });

  it('collects picks for a multiple-choice question and sends them in the offered order', () => {
    const onAnswer = vi.fn();
    render(<QuestionOptions question={question({ multiSelect: true })} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /DuckDB/ }));
    fireEvent.click(screen.getByRole('button', { name: /Postgres/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 choices' }));
    expect(onAnswer).toHaveBeenCalledWith('Postgres, DuckDB', ['Postgres', 'DuckDB']);
  });

  it('shows what was picked once answered, and nothing is clickable', () => {
    const onAnswer = vi.fn();
    const answer: Message = { id: 'm2', at: '2026-11-23T10:01:00.000Z', role: 'user', text: 'SQLite', choices: ['SQLite'] };
    render(<QuestionOptions question={question({ answeredBy: 'm2' })} answer={answer} onAnswer={onAnswer} />);
    const sqlite = screen.getByRole('button', { name: /SQLite/ }) as HTMLButtonElement;
    expect(sqlite.disabled).toBe(true);
    expect(sqlite.className).toMatch(/amber-400\/20/);
    fireEvent.click(sqlite);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('card face', () => {
  it('says when Claude is waiting in the terminal', () => {
    const task = normalizeTask(
      { id: 't1', number: 4, title: 'Build it', column: 'user-input', waiting: { kind: 'permission', text: 'Claude needs your permission to use Bash' } },
      't1',
    );
    render(<CardFace task={task} />);
    expect(screen.getByText('Needs your permission in the terminal')).toBeTruthy();
    expect(screen.getByText('Claude needs your permission to use Bash')).toBeTruthy();
  });
});
