import { Component, type ReactNode } from 'react';

/**
 * A crash used to unmount the whole tree and leave a black page, which tells
 * the user nothing. Show what broke and how to recover instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ticketrail] the board failed to render', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-xl border border-red-900/60 bg-red-950/30 p-6">
          <h1 className="text-[15px] font-semibold text-red-200">The board failed to render</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-red-200/80">
            This usually means the page and the server are running different versions — restart{' '}
            <code className="rounded bg-black/40 px-1">ticketrail serve</code> so it picks up the current build,
            then reload.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] text-red-300">
            {error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-md bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-100 hover:bg-red-500/30"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
