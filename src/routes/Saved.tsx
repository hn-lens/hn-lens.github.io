import { Bookmark } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSavedItems, useSeenMap } from '../hooks/useLocalData';
import StoryCard from '../components/feed/StoryCard';

export default function Saved() {
  const items = useSavedItems();
  const seen = useSeenMap();

  return (
    <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
      <h1 className="mb-4 flex items-center gap-2 text-lg font-semibold">
        <Bookmark className="size-5 text-accent" /> Saved
      </h1>
      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <Bookmark className="mx-auto size-8 text-subtle" />
          <p className="mt-3 text-sm text-muted">No saved stories yet.</p>
          <p className="mt-0.5 text-xs text-subtle">
            Bookmark any story to keep it here.
          </p>
          <Link
            to="/"
            className="mt-4 inline-block rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Browse the feed
          </Link>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <StoryCard
              key={item.id}
              item={item}
              reasons={[]}
              seen={seen.has(item.id)}
              saved
              allowHide={false}
            />
          ))}
        </div>
      )}
    </main>
  );
}
