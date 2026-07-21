"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BookingPanel } from "./BookingPanel";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";

// D48 — the ONE global new-reservation entry point. Every place that starts a
// booking (sidebar button, calendar drag / context menu / double-click) calls
// openNewReservation() so they all share the single BookingPanel mounted here,
// as an overlay over the current page — no navigation, no route/filter/scroll
// reset. `source` labels the origin (telemetry-ready; not consumed yet).
export type NewReservationSource =
  | "global_sidebar"
  | "calendar_drag"
  | "calendar_context"
  | "calendar_double_click"
  | "calendar_mobile";

export type NewReservationPrefill = {
  roomId?: string;
  checkIn?: string;
  checkOut?: string;
  source: NewReservationSource;
};

type Ctx = {
  openNewReservation: (prefill: NewReservationPrefill) => void;
  closeNewReservation: () => void;
  canCreate: boolean;
  /** reservation_id of a just-created booking — the calendar pulses its bar ~3s */
  flashId: string | null;
};

const NewReservationContext = createContext<Ctx | null>(null);

export function useNewReservation(): Ctx {
  const ctx = useContext(NewReservationContext);
  if (!ctx) throw new Error("useNewReservation must be used within NewReservationProvider");
  return ctx;
}

export function NewReservationProvider({
  children,
  bookingSources,
  paymentMethods,
  workflowStatuses,
  ratePlans,
  vatRate,
  canSaveCard,
  canPriceOverride,
  canCreate,
}: {
  children: React.ReactNode;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  workflowStatuses: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  vatRate: number;
  canSaveCard: boolean;
  canPriceOverride: boolean;
  canCreate: boolean;
}) {
  const [prefill, setPrefill] = useState<NewReservationPrefill | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNewReservation = useCallback(
    (p: NewReservationPrefill) => {
      if (canCreate) setPrefill(p);
    },
    [canCreate],
  );
  const closeNewReservation = useCallback(() => setPrefill(null), []);

  // mark a just-created reservation so the calendar bar pulses; auto-clears
  // after the ~3s animation (kept a little longer to survive the refetch delay).
  const flashReservation = useCallback((id: string) => {
    setFlashId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 5000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  return (
    <NewReservationContext.Provider value={{ openNewReservation, closeNewReservation, canCreate, flashId }}>
      {children}
      <BookingPanel
        open={prefill !== null}
        onClose={closeNewReservation}
        onCreated={flashReservation}
        prefill={prefill ?? {}}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
        workflowStatuses={workflowStatuses}
        ratePlans={ratePlans}
        vatRate={vatRate}
        canSaveCard={canSaveCard}
        canPriceOverride={canPriceOverride}
      />
    </NewReservationContext.Provider>
  );
}
