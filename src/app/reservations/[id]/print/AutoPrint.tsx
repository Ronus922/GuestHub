"use client";

import { useEffect } from "react";

// Fires the browser print dialog once, after a short delay so the web font and
// layout settle first. Rendered by the print page; no visual output.
export function AutoPrint() {
  useEffect(() => {
    const t = window.setTimeout(() => {
      window.print();
    }, 350);
    return () => window.clearTimeout(t);
  }, []);

  return null;
}
