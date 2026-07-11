"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "@/components/shared/Icon";

// Project modal replacement (DESIGN_SYSTEM §5, /side-panel skill): slides in from
// the left in RTL (x: -100% → 0) with fade, overlay fades only — both 1.2s
// ease-in-out via framer-motion, AnimatePresence animating the exit. Glass body,
// overlay 65%, 55% width desktop / 100% mobile, Primary header, shadow-pop.
// No centered modals. z-90: above every calendar layer (sticky headers z-7,
// tooltip z-60, date picker z-80). Escape / overlay click / X all route
// through onClose — the OWNER decides (dirty-state confirm lives there).
const DURATION = 1.2;

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  icon,
  avatar,
  badge,
  headerChips,
  headerActions,
  overlay,
  band,
  bodyClassName,
  widthClassName,
  v2 = false,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: IconName;
  // identity header (edit-employee reference): custom avatar replaces the icon
  // square, badge is a chip rendered next to the title block
  avatar?: React.ReactNode;
  badge?: React.ReactNode;
  // raw chips (e.g. reservation # + status, .bw-hd-num / .bw-st-badge) rendered after the title
  headerChips?: React.ReactNode;
  // compact icon-buttons in the LEFT header cluster, before the built-in close X
  // (e.g. the booking action toolbar: email / whatsapp / pdf / print). RTL DOM
  // order lays them right→left, with X furthest left.
  headerActions?: React.ReactNode;
  // full-panel overlay layer (absolute, above the body) — e.g. an in-panel
  // message composer that must not navigate away or unmount the booking.
  overlay?: React.ReactNode;
  // full-width strip between the header and the scrolling body (e.g. wizard stepper)
  band?: React.ReactNode;
  // body padding/background override (default p-6 glass)
  bodyClassName?: string;
  // panel width override (default 55% desktop / full mobile; e.g. rooms drawer = 60vw)
  widthClassName?: string;
  /** V2 chrome (edit-booking-modal-V2 reference) — opt-in per panel: 22px/800
   *  title, 26px header/footer padding, 40px header actions + divider,
   *  white-on-red close hover, footer shadow, and the `.bw-v2` CSS scope for
   *  the V2 form-token overrides. Panels that don't opt in keep the original
   *  shell untouched. */
  v2?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  // Keep the latest onClose in a ref so the effect below can depend on [open]
  // ALONE. Owners pass a fresh onClose closure every render (e.g. requestClose);
  // if it were a dep, every keystroke would re-run the effect and its
  // panelRef.focus() would yank focus off the field being typed in — the input
  // would accept only one character before losing focus.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      // minimal focus trap: Tab cycles inside the panel
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90]" dir="rtl">
          {/* Overlay — fade only */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION, ease: "easeInOut" }}
            className="absolute inset-0 bg-black/65"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Panel — slide from the left + fade */}
          <motion.aside
            ref={panelRef}
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "-100%", opacity: 0 }}
            transition={{ duration: DURATION, ease: "easeInOut" }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className={`absolute inset-y-0 left-0 flex h-full ${widthClassName ?? "w-[55%]"} flex-col overflow-hidden rounded-tr-[0.65rem] rounded-br-[0.65rem] bg-white/90 shadow-pop outline-none backdrop-blur-md max-sm:w-full${v2 ? " bw-v2" : ""}`}
          >
            <header
              className={`flex shrink-0 items-center justify-between bg-primary py-4 text-white ${
                v2 ? "gap-4 px-[26px]" : "gap-3 px-6"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                {avatar ??
                  (icon ? (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/15">
                      <Icon name={icon} size={22} />
                    </span>
                  ) : null)}
                <div className="min-w-0">
                  {/* V2 header hierarchy: 22px/800 title, chips inline after it */}
                  <div className={`flex flex-wrap items-center ${v2 ? "gap-2.5" : "gap-2"}`}>
                    <h2
                      className={
                        v2
                          ? "truncate text-[22px] font-extrabold tracking-[-0.3px]"
                          : "truncate text-lg font-bold"
                      }
                    >
                      {title}
                    </h2>
                    {headerChips}
                  </div>
                  {subtitle ? (
                    <p
                      className={
                        v2
                          ? "mt-1 truncate text-sm font-medium text-white/[.82]"
                          : "truncate text-sm text-white/80"
                      }
                    >
                      {subtitle}
                    </p>
                  ) : null}
                </div>
                {badge ? (
                  <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                    {badge}
                  </span>
                ) : null}
              </div>
              {/* left header cluster: action toolbar (RTL: right→left) + close X.
                  V2 only: thin divider before the X, close hovers white-on-red. */}
              <div className="flex shrink-0 items-center gap-1.5">
                {headerActions}
                {v2 && headerActions ? (
                  <span aria-hidden className="mx-[3px] h-[26px] w-px shrink-0 self-center bg-white/[.28]" />
                ) : null}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="סגירה"
                  title="סגירת החלון"
                  className={
                    v2
                      ? "grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-white/[.12] text-white transition-colors hover:bg-white hover:text-[#DC2626] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      : "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white/90 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  }
                >
                  <Icon name="close" size={20} />
                </button>
              </div>
            </header>

            {band}

            <div className={`thin-scroll flex-1 overflow-y-auto ${bodyClassName ?? "p-6"}`}>
              {children}
            </div>

            {footer ? (
              <footer
                className={`shrink-0 border-t border-line bg-surface ${
                  v2 ? "px-[26px] py-3.5 shadow-[0_-4px_16px_rgba(16,24,40,0.04)]" : "p-4"
                }`}
              >
                {footer}
              </footer>
            ) : null}

            {/* full-panel overlay (e.g. in-panel message composer) — booking stays
                mounted underneath so closing restores its exact scroll state */}
            {overlay}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
