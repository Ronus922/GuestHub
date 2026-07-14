export default function CommunicationsLoading() {
  return (
    <main className="gc-page" dir="rtl" aria-busy="true">
      <header className="gc-head">
        <div>
          <h1 className="h1">תקשורת אורחים</h1>
          <p className="gc-sub">טוען נתונים…</p>
        </div>
      </header>
      <div className="gc-sums">
        {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ flex: "1 1 170px", height: 92 }} />)}
      </div>
      <div className="skeleton" style={{ height: 420 }} />
    </main>
  );
}
