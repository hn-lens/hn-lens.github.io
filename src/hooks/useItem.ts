import { useQuery } from '@tanstack/react-query';
import { getItem } from '../lib/hn/client';
import { fetchItemTree } from '../lib/hn/algolia';
import { fetchUser } from '../lib/hn/firebase';

export function useStory(id: number) {
  return useQuery({
    queryKey: ['item', id],
    queryFn: () => getItem(id),
    enabled: Number.isFinite(id) && id > 0,
  });
}

export function useComments(id: number) {
  return useQuery({
    queryKey: ['comments', id],
    queryFn: () => fetchItemTree(id),
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
