"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "@/components/shared/Icon";

// Project modal replacement (DESIGN_SYSTEM §5, /side-panel skill): slides in from
// the left in RTL (x: -100% → 0) with fade, overlay fades only — both 1.2s
// ease-in-out via framer-motion, AnimatePresence animating the exit. Glass body,
// overlay 65%, 55% width desktop / 100% mobile, Primary header, shadow-pop.
// No centered modals.
const DURATION = 1.2;

export function SidePanel({
  open,
  onClose,
  title,
  subtitle,
  icon,
  avatar,
  badge,
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
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" dir="rtl">
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
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "-100%", opacity: 0 }}
            transition={{ duration: DURATION, ease: "easeInOut" }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="absolute inset-y-0 left-0 flex h-full w-[55%] flex-col overflow-hidden rounded-tr-[0.65rem] rounded-br-[0.65rem] bg-white/90 shadow-pop backdrop-blur-md max-sm:w-full"
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
                  <h2 className="truncate text-lg font-bold">{title}</h2>
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

            <div className="thin-scroll flex-1 overflow-y-auto p-6">{children}</div>

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
