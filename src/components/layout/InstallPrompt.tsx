"use client";

// The ONE PWA install controller — mounted once from the root layout so it
// covers login and dashboard alike and survives client-side navigation without
// duplicating listeners. Renders null until eligibility is proven client-side,
// so the server HTML never changes and there is no hydration mismatch.
//
// Eligibility (all must hold): not already running standalone, not previously
// installed, not shown this session, past the 7-day dismiss cooldown, and a
// phone — the md drawer breakpoint AND a coarse pointer (D148 §5: width alone
// is not mobile).

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { BELOW_MD_QUERY } from "@/lib/breakpoints";

// Chromium's install event — not in lib.dom yet.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    /** stashed by the pre-hydration capture script in app/layout.tsx */
    __ghPwaInstall?: BeforeInstallPromptEvent;
  }
  interface Navigator {
    /** iOS Safari only — true when launched from the Home Screen */
    standalone?: boolean;
  }
}

const DISMISSED_AT_KEY = "gh:pwa-install:dismissed-at";
const INSTALLED_KEY = "gh:pwa-install:installed";
const SESSION_SHOWN_KEY = "gh:pwa-install:shown";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// small delay so the banner never fights hydration or the initial paint
const SHOW_DELAY_MS = 3000;

// storage can be unavailable (privacy modes, disabled cookies) — degrade to
// "no memory" rather than crashing the whole layout.
function readStorage(store: "local" | "session", key: string): string | null {
  try {
    return (store === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(store: "local" | "session", key: string, value: string): void {
  try {
    (store === "local" ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    /* storage unavailable — the prompt just loses its memory */
  }
}

export function InstallPrompt() {
  const [view, setView] = useState<"hidden" | "banner" | "steps">("hidden");
  const [isIOS, setIsIOS] = useState(false);
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // already the installed app → never promote, never reserve space
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) return;

    if (readStorage("local", INSTALLED_KEY)) return;
    if (readStorage("session", SESSION_SHOWN_KEY)) return;

    const dismissedAt = Number(readStorage("local", DISMISSED_AT_KEY));
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;

    const isPhone =
      window.matchMedia(BELOW_MD_QUERY).matches &&
      window.matchMedia("(pointer: coarse)").matches;
    if (!isPhone) return;

    setIsIOS(/iphone|ipad|ipod/i.test(window.navigator.userAgent));

    // the capture script may have stashed the event before hydration
    if (window.__ghPwaInstall) deferredRef.current = window.__ghPwaInstall;
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      deferredRef.current = e as BeforeInstallPromptEvent;
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    const onInstalled = () => {
      writeStorage("local", INSTALLED_KEY, "1");
      setView("hidden");
    };
    window.addEventListener("appinstalled", onInstalled);

    const timer = window.setTimeout(() => {
      writeStorage("session", SESSION_SHOWN_KEY, "1");
      setView("banner");
    }, SHOW_DELAY_MS);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      window.clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    writeStorage("local", DISMISSED_AT_KEY, String(Date.now()));
    setView("hidden");
  };

  const onInstallClick = async () => {
    const deferred = deferredRef.current;
    // no native install event (iOS, or Chromium that never fired one) —
    // the CTA must still do something real: show the manual steps.
    if (!deferred) {
      setView("steps");
      return;
    }
    // a retained event is single-use — drop it before prompting
    deferredRef.current = null;
    window.__ghPwaInstall = undefined;
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") {
        writeStorage("local", INSTALLED_KEY, "1");
        setView("hidden");
      } else {
        dismiss();
      }
    } catch {
      // event already consumed or the browser refused — manual steps instead
      setView("steps");
    }
  };

  if (view === "hidden") return null;

  return (
    <section className="pwa-install" aria-label="התקנת האפליקציה" aria-live="polite">
      <div className="pwa-install-card">
        <div className="pwa-install-row">
          <Image
            src="/icons/icon-192.png"
            alt=""
            width={48}
            height={48}
            className="pwa-install-appicon"
          />
          <div className="pwa-install-text">
            <p className="pwa-install-title">
              {view === "banner" ? "התקנת GuestHub" : "הוספה למסך הבית"}
            </p>
            {view === "banner" ? (
              <p className="pwa-install-sub">הוסיפו את המערכת למסך הבית — פתיחה מהירה, במסך מלא.</p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn pwa-install-close"
            onClick={dismiss}
            aria-label="סגירת ההצעה"
          >
            <Icon name="close" />
          </button>
        </div>

        {view === "steps" ? (
          <ol className="pwa-install-steps">
            {isIOS ? (
              <>
                <li>
                  <Icon name="ios-share" />
                  פתחו את תפריט השיתוף בסרגל הדפדפן
                </li>
                <li>
                  <Icon name="plus" />
                  בחרו ״הוספה למסך הבית״
                </li>
                <li>
                  <Icon name="check" />
                  אשרו בלחיצה על ״הוסף״
                </li>
              </>
            ) : (
              <>
                <li>
                  <Icon name="more" />
                  פתחו את תפריט הדפדפן
                </li>
                <li>
                  <Icon name="plus" />
                  בחרו ״הוספה למסך הבית״ או ״התקנת אפליקציה״
                </li>
                <li>
                  <Icon name="check" />
                  אשרו את ההוספה
                </li>
              </>
            )}
          </ol>
        ) : null}

        {view === "banner" ? (
          <button
            type="button"
            className="btn btn-primary pwa-install-cta"
            onClick={() => {
              void onInstallClick();
            }}
          >
            התקנה
          </button>
        ) : (
          <button type="button" className="btn btn-secondary pwa-install-cta" onClick={dismiss}>
            הבנתי
          </button>
        )}
      </div>
    </section>
  );
}
