import { QueryClient } from '@tanstack/react-query';

// Single shared client so non-component code (e.g. the background auto-trainer)
// can invalidate queries — like refreshing the feed after a retrain.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      // 'always', not the default 'online': offline, the default PAUSES a query (never fetches, so
      // `isError` never fires) and the profile/search fall through to their "not found"/"no results"
      // branches — an outage read as empty. With 'always' the fetch runs, fails fast offline, and the
      // error surfaces as the outage state (+ Retry), matching how a 5xx is already handled. All HN
      // fetches are timeout-bounded, so a real offline attempt fails quickly.
      networkMode: 'always',
    },
  },
});
