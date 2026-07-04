// Route-level loading state — skeleton of the calendar shell.
export default function CalendarLoading() {
  return (
    <div className="space-y-4 p-6" aria-busy="true" aria-label="טוען יומן">
      <div className="flex items-center justify-between">
        <div className="h-9 w-44 animate-pulse rounded-xl bg-hover" />
        <div className="h-11 w-72 animate-pulse rounded-xl bg-hover" />
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-2xl border border-line bg-surface" />
        ))}
      </div>
      <div className="h-[60vh] animate-pulse rounded-2xl border border-line bg-surface" />
    </div>
  );
}
