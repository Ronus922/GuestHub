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
  band,
  bodyClassName,
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
  // raw chips (e.g. reservation # + status, .bw-hd-chip) rendered after the title
  headerChips?: React.ReactNode;
  // full-width strip between the header and the scrolling body (e.g. wizard stepper)
  band?: React.ReactNode;
  // body padding/background override (default p-6 glass)
  bodyClassName?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
  }, [open, onClose]);

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
            className="absolute inset-y-0 left-0 flex h-full w-[55%] flex-col overflow-hidden rounded-tr-[0.65rem] rounded-br-[0.65rem] bg-white/90 shadow-pop outline-none backdrop-blur-md max-sm:w-full"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 bg-primary px-6 py-4 text-white">
              <div className="flex min-w-0 items-center gap-3">
                {avatar ??
                  (icon ? (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/15">
                      <Icon name={icon} size={22} />
                    </span>
                  ) : null)}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-bold">{title}</h2>
                    {headerChips}
                  </div>
                  {subtitle ? (
                    <p className="truncate text-sm text-white/80">{subtitle}</p>
                  ) : null}
                </div>
                {badge ? (
                  <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                    {badge}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="סגירה"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white/90 transition-colors hover:bg-white/15"
              >
                <Icon name="close" size={20} />
              </button>
            </header>

            {band}

            <div className={`thin-scroll flex-1 overflow-y-auto ${bodyClassName ?? "p-6"}`}>
              {children}
            </div>

            {footer ? (
              <footer className="shrink-0 border-t border-line bg-surface p-4">
                {footer}
              </footer>
            ) : null}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
