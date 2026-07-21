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
    },
  },
});
