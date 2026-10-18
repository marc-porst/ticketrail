import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkConfirm } from '../web/src/components/LinkConfirm.tsx';
import { setConfirmLink, shouldConfirmLink } from '../web/src/lib/confirmLink.ts';
import { normalizeTask } from '../src/core/task.ts';

const dragged = normalizeTask({ id: 't_a', number: 3, title: 'Original feature' }, 't_a');
const target = normalizeTask({ id: 't_b', number: 7, title: 'Follow-up bug' }, 't_b');

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('link confirmation', () => {
  it('says which card becomes context of which', () => {
    render(<LinkConfirm dragged={dragged} target={target} onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Link cards' });
    expect(dialog.textContent).toMatch(/Original feature.*becomes related context of.*Follow-up bug/);
    expect(dialog.textContent).toMatch(/Neither card moves/);
  });

  it('confirms with the checkbox state, and cancels on the button or Escape', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<LinkConfirm dragged={dragged} target={target} onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Don't show this again"));
    fireEvent.click(screen.getByRole('button', { name: 'OK, link them' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('focuses OK so Enter links straight away', () => {
    render(<LinkConfirm dragged={dragged} target={target} onConfirm={() => {}} onCancel={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK, link them' }));
  });

  it('remembers "do not ask" in this browser, and can turn it back on', () => {
    expect(shouldConfirmLink()).toBe(true);
    setConfirmLink(false);
    expect(shouldConfirmLink()).toBe(false);
    setConfirmLink(true);
    expect(shouldConfirmLink()).toBe(true);
  });
});
