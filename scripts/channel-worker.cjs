#!/usr/bin/env node
// ============================================================
// PM2 entry point for the GuestHub channel worker (D68).
//
//   pm2 start ecosystem.config.cjs --only guesthub-channel-worker
//
// Requires `npm run build` to have produced dist/worker (npm postbuild →
// tsconfig.worker.json). Env comes from .env.local exactly like the web app —
// DATABASE_URL and CHANNEL_SECRETS_KEY — loaded by node's own --env-file-if-exists.
//
// This process sends ARI to Channex ONLY for connections whose operator has
// already completed the initial Full Sync (state='active', outbound_sync_enabled,
// full_sync_required=false). It exposes no port and accepts no input.
// ============================================================
"use strict";

const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "worker");
const STUB = path.join(__dirname, "server-only-stub.cjs");

// tsc keeps `@/…` specifiers verbatim; map them onto the compiled tree.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return STUB;
  if (request.startsWith("@/")) return origResolve.call(this, path.join(OUT, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

let worker;
try {
  worker = require(path.join(OUT, "lib/channel/worker.js"));
} catch (e) {
  console.error("[channel-worker] dist/worker missing — run `npm run build` first");
  console.error(e && e.message);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[channel-worker] DATABASE_URL is not set — refusing to start");
  process.exit(1);
}

const { runChannelWorker, resolveIntervalMs } = worker;
const { sql } = require(path.join(OUT, "lib/db.js"));

const workerId = `${require("node:os").hostname()}:${process.pid}`;
const controller = new AbortController();
const log = (m) => console.log(`[channel-worker] ${m}`);

// ---- graceful shutdown: stop claiming, finish the in-flight job, close the pool ----
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — finishing current job, then exiting`);
    controller.abort();
  });
}

runChannelWorker({
  workerId,
  intervalMs: resolveIntervalMs(process.env.CHANNEL_WORKER_INTERVAL_MS),
  signal: controller.signal,
  log,
})
  .catch((e) => {
    // PM2 restarts us; an unfinished job's lease expires and is reclaimed.
    console.error("[channel-worker] fatal:", e && e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* pool already closed */
    }
    log("database pool closed — exit");
  });
