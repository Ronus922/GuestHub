export default function StaffLoading() {
  return (
    <div className="p-6 lg:p-8">
      <div className="skeleton mb-6 h-8 w-40" />
      <div className="skeleton mb-4 h-11 w-full max-w-md rounded-xl" />
      <div className="card">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-4 last:border-0">
            <div className="skeleton h-9 w-9 shrink-0" />
            <div className="skeleton h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
