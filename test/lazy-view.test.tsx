import { Suspense } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyView } from '../web/src/lib/lazyView.tsx';

afterEach(cleanup);

describe('lazyView', () => {
  it('renders the view once its file has loaded', async () => {
    const View = lazyView(async () => ({ name }: { name: string }) => <p>hello {name}</p>);
    render(
      <Suspense fallback={null}>
        <View name="board" />
      </Suspense>,
    );
    expect(await screen.findByText('hello board')).toBeTruthy();
  });

  it('shows a reload notice instead of crashing when the file is gone after a rebuild', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onClose = vi.fn();
    const View = lazyView<{ onClose: () => void }>(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/RelationsModal-old.js')),
    );
    render(
      <div>
        <p>the rest of the board</p>
        <Suspense fallback={null}>
          <View onClose={onClose} />
        </Suspense>
      </div>,
    );
    expect(await screen.findByText('Ticketrail was updated while this page was open')).toBeTruthy();
    expect(screen.getByText('the rest of the board')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
