import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// A lazy route's JS chunk failing to load (offline, or a stale deploy) surfaces as a raw
// "Failed to fetch dynamically imported module" Error. Detect it so the boundary can show a human
// message instead of that string, and tailor it when the reader is offline.
function isChunkLoadError(e: Error): boolean {
  return /dynamically imported module|Failed to fetch|Importing a module script failed|ChunkLoadError/i.test(
    e.message || ''
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught UI error:', error, info.componentStack);
  }

  // Clear the error when the reader navigates, so a boundary tripped on ONE route (most often a lazy
  // chunk that couldn't be fetched offline) does not persist across the whole app. This boundary sits
  // ABOVE the Router, so it can't read router context; HashRouter navigation is a hashchange/popstate,
  // which is enough to reset it (e.g. the browser Back button recovers to an already-cached route).
  private reset = () => this.setState((s) => (s.error ? { error: null } : s));
  componentDidMount() {
    window.addEventListener('hashchange', this.reset);
    window.addEventListener('popstate', this.reset);
  }
  componentWillUnmount() {
    window.removeEventListener('hashchange', this.reset);
    window.removeEventListener('popstate', this.reset);
  }

  // The feed is the eager entry route, so it always loads even when a lazy chunk can't be fetched —
  // this is the reliable recovery from a chunk-load error. Setting the hash also fires `reset` via the
  // hashchange listener; call it directly too in case we're already at '#/'.
  private goToFeed = () => {
    window.location.hash = '#/';
    this.reset();
  };

  render() {
    const { error } = this.state;
    if (error) {
      const chunk = isChunkLoadError(error);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      return (
        <div className="mx-auto max-w-lg px-4 py-16 text-center">
          <h1 className="text-lg font-semibold">
            {chunk ? "Couldn't load this part of the app" : 'Something went wrong.'}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {chunk
              ? offline
                ? 'You appear to be offline, so a part of the app that loads on demand is unavailable. Reconnect, then try again.'
                : 'A part of the app failed to load. Check your connection and try again.'
              : error.message}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={this.goToFeed}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
            >
              Go to feed
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => location.reload()}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
