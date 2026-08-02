// ============================================================
// <DashboardWindow> — the card every dashboard window is (audit §B.2).
//
// Eleven call sites. DeshbordMain.md §8's trap list is almost entirely about
// window registration and window chrome going out of step between cards, so the
// chrome exists once: the header IS the drag handle (§3 — "הכותרת בלבד היא
// ידית"), the ✕ is always in the same place, and the counter always sits
// between the title and the actions.
//
// It composes the canonical primitives — .card / .card-hd — rather than
// re-declaring them (audit §B.1). The reference's .card-h/.card-t/.card-n
// vocabulary is dropped in favour of the app's -hd/-bd suffixes.
//
// Presentational only: it owns no drag state. The screen owns the sortable
// context and hands the header its listeners, because "which column may accept
// this card" is a layout decision, not a card decision.
// ============================================================
import { Icon, type IconName } from "./Icon";

export function DashboardWindow({
  icon,
  title,
  subtitle,
  children,
  onHide,
  headerProps,
  containerRef,
  style,
  dragging,
  dropzone,
}: {
  icon: IconName;
  title: string;
  /** counter or status line, e.g. "3 מתוך 8 הושלמו" */
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  onHide?: () => void;
  /** dnd-kit's attributes + listeners, applied to the header (the only handle) */
  headerProps?: Record<string, unknown>;
  containerRef?: (node: HTMLElement | null) => void;
  style?: React.CSSProperties;
  dragging?: boolean;
  dropzone?: boolean;
}) {
  return (
    <section
      ref={containerRef}
      style={style}
      className={`card dash-win${dragging ? " dragging" : ""}${dropzone ? " dropzone" : ""}`}
      aria-label={title}
    >
      <header
        className="card-hd dash-win-hd"
        {...(headerProps as React.HTMLAttributes<HTMLElement> | undefined)}
      >
        <Icon name={icon} size={20} className="dash-win-icon" />
        <span className="dash-win-title">{title}</span>
        {subtitle && <span className="dash-win-count">{subtitle}</span>}
        <span className="dash-win-actions">
          <span className="icon-btn dash-win-grip" aria-hidden title="גרירה לשינוי סדר">
            <Icon name="drag" size={20} />
          </span>
          {onHide && (
            <button
              type="button"
              className="icon-btn"
              title="הסתרת החלון"
              aria-label={`הסתרת החלון ${title}`}
              // the ✕ lives INSIDE the drag handle — without this the pointer
              // sensor claims the press and the click never fires
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={onHide}
            >
              <Icon name="close" size={20} />
            </button>
          )}
        </span>
      </header>
      <div className="dash-win-bd">{children}</div>
    </section>
  );
}
