import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import CommentsView from '../components/comments/CommentsView';

export default function Item() {
  const { id } = useParams();
  const numId = Number(id);

  return (
    <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" /> Back to feed
      </Link>
      {Number.isFinite(numId) && numId > 0 ? (
        <CommentsView id={numId} />
      ) : (
        <p className="text-muted">Invalid item.</p>
      )}
    </main>
  );
}
