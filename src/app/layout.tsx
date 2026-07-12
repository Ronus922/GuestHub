import type { Metadata } from "next";
import { Assistant } from "next/font/google";
import "./globals.css";

const assistant = Assistant({
  subsets: ["hebrew", "latin"],
  variable: "--font-assistant",
});

export const metadata: Metadata = {
  title: "GuestHub",
  description:
    "Multi-tenant PMS for aparthotels and vacation rentals — reservations, occupancy, rates, guests, housekeeping.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /* The font variable belongs on <html>, not <body> (D2 — Assistant).
       `--font-sans` is declared on :root (base.css) as
       `var(--font-assistant), system-ui, sans-serif`. A custom property's value
       is resolved AT THE ELEMENT THAT DECLARES IT — so while --font-assistant
       lived only on <body>, --font-assistant was undefined at :root, --font-sans
       computed to guaranteed-invalid (empty), `body { font-family:
       var(--font-sans) }` collapsed, and the whole app silently rendered in
       Tailwind's ui-sans-serif fallback instead of Assistant. */
    <html lang="he" dir="rtl" className={assistant.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
