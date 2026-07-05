"use client";

import { createContext, useCallback, useContext, useState } from "react";
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
  | "calendar_double_click";

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
  vatRate,
  canSaveCard,
  canCreate,
}: {
  children: React.ReactNode;
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  vatRate: number;
  canSaveCard: boolean;
  canCreate: boolean;
}) {
  const [prefill, setPrefill] = useState<NewReservationPrefill | null>(null);

  const openNewReservation = useCallback(
    (p: NewReservationPrefill) => {
      if (canCreate) setPrefill(p);
    },
    [canCreate],
  );
  const closeNewReservation = useCallback(() => setPrefill(null), []);

  return (
    <NewReservationContext.Provider value={{ openNewReservation, closeNewReservation, canCreate }}>
      {children}
      <BookingPanel
        open={prefill !== null}
        onClose={closeNewReservation}
        prefill={prefill ?? {}}
        bookingSources={bookingSources}
        paymentMethods={paymentMethods}
        vatRate={vatRate}
        canSaveCard={canSaveCard}
      />
    </NewReservationContext.Provider>
  );
}
