"use client";

import { useEffect } from "react";
import { Icon } from "@/components/shared/Icon";

// THE confirmation modal of the /channels subsystem (GUIDELINES §8).
// It used to be copy-pasted into four sections, each with its own header, radius
// and button sizes. One structure now: blue header bar (21px/800 white title +
// 36×36 close), body, footer whose PRIMARY action hugs the left edge (.md-ft) —
// exactly like the drawer. Escape and a backdrop click both close it.
export function ConfirmDialog({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  /** the actions; put the primary <button className="btn btn-primary"> FIRST (§7) */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="modal max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="md-hd">
          <h3 className="md-title">{title}</h3>
          <button type="button" onClick={onClose} className="md-close" aria-label="סגור">
            <Icon name="close" size={20} label="סגור" />
          </button>
        </div>
        <div className="md-bd flex min-h-0 flex-col gap-4 overflow-y-auto">{children}</div>
        {footer && <div className="md-ft">{footer}</div>}
      </div>
    </div>
  );
}
