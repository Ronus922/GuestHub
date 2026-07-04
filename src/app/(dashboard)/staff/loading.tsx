export default function StaffLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6 h-8 w-40 animate-pulse rounded-lg bg-line" />
      <div className="mb-4 h-11 w-full max-w-md animate-pulse rounded-xl bg-line" />
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-4 last:border-0">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-line" />
            <div className="h-4 flex-1 animate-pulse rounded bg-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
