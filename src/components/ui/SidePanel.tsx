"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "@/components/shared/Icon";

// THE canonical drawer (GUIDELINES §7). Every modal in the app is this panel —
// there is no centered modal and no second drawer shell.
//
//   opens from the LEFT (x: -100% → 0), 60% of the screen, blurred overlay,
//   closes on Esc / overlay click / X (all routed through onClose — the OWNER
//   decides, so a dirty-state confirm lives there).
//   header .dw-hd  : full brand bar · 40×40 icon square · 21px/800 title ·
//                    14px subtitle · 36×36 close.
//   body   .dw-bd  : padding 24, internal scroll, sections are `.card`.
//   footer .dw-ft  : border-top, the PRIMARY action hugging the left edge.
//
// z-90: above every calendar layer (sticky headers z-7, tooltip z-60, date
// picker z-80).
const DEFAULT_DURATION = 1.2;
const GROUP_UPDATE_DURATION = 0.3;
const GROUP_UPDATE_EASE = [0.32, 0.72, 0.28, 1] as const;

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
  visualVariant = "default",
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
  // raw chips (e.g. reservation # + status) rendered after the title
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
  // body OVERRIDE (not stack): passing this replaces the default §7 24px body
  // padding — bring your own p-* (a caller passing only a background gets a
  // full-bleed body, e.g. the guest-profile drawer's skeleton blocks)
  bodyClassName?: string;
  // panel width override (default: the §7 60%; full width on mobile)
  widthClassName?: string;
  // A caller-scoped visual treatment. Shared accessibility/portal behavior
  // remains canonical while reference-specific motion/overlay stays isolated.
  visualVariant?: "default" | "group-update";
  children: React.ReactNode;
  // rendered inside the §7 `.dw-ft`. Pass FLAT .btn children with the PRIMARY
  // action FIRST in the DOM — .dw-ft is row-reverse, so the first child hugs
  // the LEFT edge and "ביטול" sits to its right (§7).
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  // Keep the latest onClose in a ref so the effect below can depend on [open]
  // ALONE. Owners pass a fresh onClose closure every render (e.g. requestClose);
  // if it were a dep, every keystroke would re-run the effect and its
  // panelRef.focus() would yank focus off the field being typed in — the input
  // would accept only one character before losing focus.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
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
    const focusTimer = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [open]);

  if (!portalRoot) return null;

  const isGroupUpdate = visualVariant === "group-update";
  const duration = isGroupUpdate ? GROUP_UPDATE_DURATION : DEFAULT_DURATION;
  const ease = isGroupUpdate ? GROUP_UPDATE_EASE : "easeInOut";

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90]" dir="rtl">
          {/* Overlay — blurred, fade only */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration, ease }}
            className={isGroupUpdate
              ? "absolute inset-0 bg-[rgba(16,24,40,.44)] backdrop-blur-[2.5px]"
              : "absolute inset-0 bg-black/65 backdrop-blur-sm"}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Panel — slide from the left + fade. 60% of the screen (§7). */}
          <motion.aside
            ref={panelRef}
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "-100%", opacity: 0 }}
            transition={{ duration, ease }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className={`absolute inset-y-0 left-0 flex h-full ${widthClassName ?? "w-[60%]"} ${isGroupUpdate ? "gu-side-panel" : ""} flex-col overflow-hidden rounded-s-2xl bg-surface shadow-pop outline-none max-sm:w-full`}
          >
            <header className="dw-hd shrink-0">
              {avatar ??
                (icon ? (
                  <span className="dw-icon">
                    <Icon name={icon} size={24} />
                  </span>
                ) : null)}

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="dw-title truncate">{title}</h2>
                  {headerChips}
                  {/* on-brand header chip — the §7 header surface (white at .16, the
                      same value as .dw-icon/.dw-close); design-system.css has no
                      canonical on-brand chip class yet, so it is composed here once */}
                  {badge ? <span className="chip chip-onbrand">{badge}</span> : null}
                </div>
                {subtitle ? <p className="dw-sub truncate">{subtitle}</p> : null}
              </div>

              {/* left header cluster: action toolbar (RTL: right→left) + close X */}
              <div className="ms-auto flex shrink-0 items-center gap-1.5">
                {headerActions}
                <button
                  type="button"
                  onClick={onClose}
                  className="dw-close"
                  title="סגירת החלון"
                >
                  <Icon name="close" size={20} label="סגירה" />
                </button>
              </div>
            </header>

            {band}

            {/* body — bodyClassName OVERRIDES the default 24px padding rather than
                stacking on it: `p-0` cancels `.dw-bd`'s components-layer padding and
                any caller-supplied p-* utility is emitted after p-0, so it wins. */}
            <div className={`dw-bd thin-scroll${bodyClassName ? ` p-0 ${bodyClassName}` : ""}`}>
              {children}
            </div>

            {footer ? <footer className="dw-ft shrink-0">{footer}</footer> : null}

            {/* full-panel overlay (e.g. in-panel message composer) — booking stays
                mounted underneath so closing restores its exact scroll state */}
            {overlay}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    portalRoot,
  );
}
