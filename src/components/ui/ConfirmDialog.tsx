"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/shared/Icon";

// THE app-wide confirmation modal (GUIDELINES §8) — the one centered dialog
// beside the canonical drawer (SidePanel). It was born inside /channels, where
// it replaced four hand-rolled copies; it now lives in components/ui because
// the calendar's restriction gate asks the same question ("this is blocked —
// proceed anyway?") and a second copy would be the same drift all over again.
// One structure: blue header bar (21px/800 white title + 36×36 close), body,
// footer whose PRIMARY action hugs the left edge (.md-ft) — exactly like the
// drawer. Escape and a backdrop click both close it.
//
// Accessibility is the drawer's, not a lighter version of it (mirrors
// SidePanel.tsx): rendered through a PORTAL on document.body so no ancestor's
// overflow/transform/z-index can clip or trap it, body scroll locked while open,
// focus moved into the dialog, Tab cycled INSIDE it, and focus returned to
// whatever opened it on close. A confirmation the keyboard can tab out of is not
// a confirmation.
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  // Keep the latest onClose in a ref so the effect below runs ONCE per mount.
  // Owners pass a fresh closure every render; as a dependency it would re-run
  // the effect (and its focus() ) on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    if (!portalRoot) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      // focus trap: Tab cycles inside the dialog
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [portalRoot]);

  if (!portalRoot) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      dir="rtl"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="modal max-h-[90vh] outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
    </div>,
    portalRoot,
  );
}
