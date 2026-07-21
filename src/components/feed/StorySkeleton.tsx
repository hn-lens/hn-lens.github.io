export default function StorySkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex gap-3">
        <div className="skeleton size-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="skeleton h-3 w-32 rounded" />
          <div className="skeleton h-4 w-3/4 rounded" />
          <div className="skeleton h-3 w-1/2 rounded" />
        </div>
      </div>
    </div>
  );
}
