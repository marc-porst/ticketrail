import { describe, expect, it } from 'vitest';
import { describeChange } from '../web/src/lib/changes.ts';
import type { Column, Task } from '../src/core/task.ts';

const card = (column: Column): Task => ({ id: 't1', title: 'a card', column }) as Task;

describe('deciding what is worth interrupting someone for', () => {
  it('alerts on the moves Claude makes', () => {
    expect(describeChange(card('in-progress'), card('user-input'))).toBe('needs-you');
    expect(describeChange(card('in-progress'), card('planned'))).toBe('planned');
    expect(describeChange(card('in-progress'), card('done'))).toBe('done');
    expect(describeChange(card('implement'), card('in-progress'))).toBe('started');
  });

  it('stays quiet for the moves you make yourself', () => {
    expect(describeChange(card('backlog'), card('plan'))).toBeNull();
    expect(describeChange(card('backlog'), card('implement'))).toBeNull();
    expect(describeChange(card('planned'), card('implement'))).toBeNull();
    expect(describeChange(card('done'), card('backlog'))).toBeNull();
  });

  it('ignores an edit that does not move the card', () => {
    const before = { ...card('implement'), title: 'old' } as Task;
    const after = { ...card('implement'), title: 'new' } as Task;
    expect(describeChange(before, after)).toBeNull();
  });

  it('says nothing about a card it is seeing for the first time', () => {
    // otherwise every reload fires a volley for moves that happened while away
    expect(describeChange(undefined, card('user-input'))).toBeNull();
    expect(describeChange(undefined, card('done'))).toBeNull();
  });
});
