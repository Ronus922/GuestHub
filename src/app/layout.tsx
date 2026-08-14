import type { Metadata, Viewport } from "next";
import { Assistant } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const assistant = Assistant({
  subsets: ["hebrew", "latin"],
  variable: "--font-assistant",
});

// GUIDELINES §10 — the ONE icon font: Material Symbols Outlined (OFL), vendored
// and self-hosted, so icons never depend on a Google request at runtime or at
// build time. next/font/google has no entry for the symbols family.
const materialSymbols = localFont({
  src: "./fonts/MaterialSymbolsOutlined.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-icons",
  display: "block",
});

export const metadata: Metadata = {
  title: "GuestHub",
  description:
    "Multi-tenant PMS for aparthotels and vacation rentals — reservations, occupancy, rates, guests, housekeeping.",
  // Icon assets live in public/ (public/favicon.ico + public/icons/*) — the
  // old src/app/favicon.ico convention file was removed so the two never fight
  // over the /favicon.ico route. All variants are declared here explicitly.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icons/favicon-16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
};

// Until this existed, Next emitted only its default `width=device-width,
// initial-scale=1` — no `viewport-fit`, so every `env(safe-area-inset-*)` in the
// app resolved to 0 and content sat under the notch / home indicator.
// `viewportFit: "cover"` is what makes those insets real; app/styles/responsive.css
// then spends them.
//
// Deliberately NO `maximumScale` / `userScalable: false`: pinch-zoom is an
// accessibility affordance and must never be disabled. The iOS zoom-on-focus
// problem is solved at the source instead — .field-input carries a 17px font on
// touch viewports (§2's closed set), so Safari has no reason to zoom.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Browser-chrome tint behind the PWA — the app icon's navy, a spec value from
  // the icon set (variation 1a), deliberately NOT the UI brand #2540C8.
  // ds-allow: theme-color must match the installed-icon navy
  themeColor: "#041E48",
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
    <html lang="he" dir="rtl" className={`${assistant.variable} ${materialSymbols.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
