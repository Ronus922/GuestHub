// ============================================================
// The ONE visible reservation number (מס׳ הזמנה).
//
// Presentation rule, decided once here for every surface (desktop, mobile,
// export): a reservation shows exactly ONE number —
//   1. the OTA reservation code when the channel supplied one
//      (e.g. the Booking.com number the guest knows), otherwise
//   2. the internal GuestHub number, "#"-prefixed.
//
// This is display-only. The internal id/number remains the identity for
// React keys, routes, actions, audit and every DB lookup — a row that shows
// a Booking.com number still opens by its internal id.
// ============================================================

export function getVisibleReservationNumber(r: {
  reservation_number: string;
  ota_reservation_code: string | null;
}): string {
  const ota = r.ota_reservation_code?.trim();
  return ota ? ota : `#${r.reservation_number}`;
}
