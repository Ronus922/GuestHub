"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "@/components/shared/Icon";

// Full-screen window over the calendar (reference booking-window /
// edit-booking-modal): brand header bar, optional band (stepper), scrolling
// gray body, sticky white footer. Replaces the side-panel presentation for
// the booking + edit flows only — the calendar stays mounted underneath, so
// closing restores the exact scroll/range state.
export function FullWindow({
  open,
  onClose,
  title,
  subtitle,
  headerChips,
  band,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  headerChips?: React.ReactNode;
  band?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    rootRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={rootRef}
          className="bw-window"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          <header className="bw-hd">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="bw-hd-title">{title}</h2>
                {headerChips}
              </div>
              {subtitle ? <p className="bw-hd-sub">{subtitle}</p> : null}
            </div>
            <button
              type="button"
              className="bw-icbtn close"
              onClick={onClose}
              aria-label="סגירה"
            >
              <Icon name="close" size={20} />
            </button>
          </header>

          {band}

          <div className="bw-scroll thin-scroll">{children}</div>

          {footer ? <footer className="bw-ft">{footer}</footer> : null}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
