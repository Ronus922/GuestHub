"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import type { DomainEvent } from "@/lib/realtime/events";

// ============================================================
// RealtimeProvider (D77 §6) — ONE EventSource per tab, mounted in the Shell.
//
// Default behavior: any committed domain event → debounced router.refresh().
// Every dashboard page is a force-dynamic server component, so a refresh IS
// the targeted refetch — calendar, reservations, guests, KPIs all re-render
// from the DB with no page reload and no per-page plumbing.
//
// Components that need finer reactions (e.g. the open reservation panel)
// subscribe via useRealtimeEvent and decide themselves (a dirty editor must
// not be clobbered). Multiple tabs each hold their own stream — the server
// hub fans out to all of them.
// ============================================================

const REFRESH_DEBOUNCE_MS = 400;

type Handler = (event: DomainEvent) => void;

const RealtimeContext = createContext<{ subscribe: (fn: Handler) => () => void }>({
  subscribe: () => () => {},
});

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const handlersRef = useRef<Set<Handler>>(new Set());

  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    source.onmessage = (message) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.data) as DomainEvent;
      } catch {
        return;
      }
      for (const fn of handlersRef.current) {
        try {
          fn(event);
        } catch {
          // a broken subscriber must not stop the refresh
        }
      }
      // coalesce bursts (an import commits reservation + inventory events)
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };
    // EventSource reconnects by itself (server sent retry: 3000) — no handler needed.

    return () => {
      clearTimeout(refreshTimer);
      source.close();
    };
  }, [router]);

  const subscribe = useCallback((fn: Handler) => {
    handlersRef.current.add(fn);
    return () => {
      handlersRef.current.delete(fn);
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ subscribe }}>
      {children}
    </RealtimeContext.Provider>
  );
}

/** React to committed domain events (handler identity may change freely). */
export function useRealtimeEvent(handler: Handler): void {
  const { subscribe } = useContext(RealtimeContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribe((e) => handlerRef.current(e)), [subscribe]);
}
