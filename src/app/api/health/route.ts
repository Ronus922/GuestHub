import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

// GET /api/health  (D170)
// Unauthenticated probe for uptime monitors and the deploy script. Exempted
// from the login redirect in src/middleware.ts (isHealth) — the same mechanism
// as the provider webhooks and the public booking API.
//   200 {"ok":true,"db":true,"build":"<BUILD_ID>"}  — SELECT 1 answered within 2s
//   503 {"ok":false,"db":false}                      — timeout or any DB error
// Reads no cookies, carries no tenant context, returns no PII and no env. Never
// throws: a failing probe is a 503, not a 500 with a stack trace.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 2000;
const NO_STORE = { "Cache-Control": "no-store" } as const;

// .next/BUILD_ID is written once per build and the process is restarted on every
// deploy, so a successful read is cached for the life of the process. A failed
// read (no build yet, e.g. in dev) is reported as "unknown" and retried next time.
let cachedBuildId: string | undefined;
function readBuildId(): string {
  if (cachedBuildId !== undefined) return cachedBuildId;
  try {
    const id = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    if (id) cachedBuildId = id;
    return id || "unknown";
  } catch {
    return "unknown";
  }
}

// The existing pooled client, raced against a 2s timer. On timeout the query is
// not cancelled (porsager has no cancel); it simply resolves later into nothing.
async function dbReachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SELECT 1 exceeded ${DB_TIMEOUT_MS}ms`)),
      DB_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([sql`SELECT 1`, timeout]);
    return true;
  } catch (e) {
    console.error("[health] db probe failed:", e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<NextResponse> {
  const db = await dbReachable();
  if (!db) {
    return NextResponse.json({ ok: false, db: false }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, db: true, build: readBuildId() },
    { status: 200, headers: NO_STORE },
  );
}
