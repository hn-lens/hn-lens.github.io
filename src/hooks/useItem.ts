import { useQuery } from '@tanstack/react-query';
import { getItem } from '../lib/hn/client';
import { fetchItemTree } from '../lib/hn/algolia';
import { fetchUser } from '../lib/hn/firebase';

export function useStory(id: number) {
  return useQuery({
    // strict: getItem returns null on a failed/timed-out fetch. As a plain success(null) that would
    // render the story-outage branch with no Retry AND be skipped by the reconnect refetch (which
    // only re-runs errored queries). Throwing makes it an error state that shows Retry and
    // auto-recovers on reconnect — the same contract as useComments.
    queryKey: ['item', id],
    queryFn: async () => {
      const item = await getItem(id);
      if (!item) throw new Error(`HN item ${id} unavailable`);
      return item;
    },
    enabled: Number.isFinite(id) && id > 0,
    retry: 1,
  });
}

export function useComments(id: number) {
  return useQuery({
    // strict: a network failure throws (isError) so the discussion view can show an outage/Retry
    // instead of a misleading "No comments yet." (the outage-vs-empty rule).
    queryKey: ['comments', id],
    queryFn: () => fetchItemTree(id, { strict: true }),
    enabled: Number.isFinite(id) && id > 0,
    staleTime: 120000,
  });
}

export function useUser(id: string | undefined) {
  return useQuery({
    queryKey: ['user', id],
    queryFn: () => fetchUser(id as string),
    enabled: !!id,
    // One quick retry, then surface the outage as an error state (with Retry) rather than spinning.
    retry: 1,
  });
}
