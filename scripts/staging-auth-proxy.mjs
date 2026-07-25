// ============================================================
// Staging-only Supabase-URL shim (D97).
//
// WHY: supabase-js hardcodes `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/...`. In the
// full Supabase stack Kong strips that prefix before forwarding to GoTrue. The
// staging stack has no Kong — it runs a bare GoTrue whose routes live at the
// root (/token, /user, /admin/users, /settings). This shim is the missing 40
// lines of Kong: it strips `/auth/v1` and forwards everything to the STAGING
// GoTrue, so the app can point NEXT_PUBLIC_SUPABASE_URL at it unchanged.
//
// It is NOT a production component and must never front production auth: it
// refuses any upstream that is not loopback.
//
// Usage:
//   STAGING_AUTH_UPSTREAM=http://127.0.0.1:9989 STAGING_AUTH_PROXY_PORT=9990 \
//     node scripts/staging-auth-proxy.mjs
// ============================================================
import { createServer, request as httpRequest } from "node:http";

const UPSTREAM = process.env.STAGING_AUTH_UPSTREAM || "http://127.0.0.1:9989";
const PORT = Number(process.env.STAGING_AUTH_PROXY_PORT || 9990);

const up = new URL(UPSTREAM);
if (!["127.0.0.1", "localhost", "::1"].includes(up.hostname)) {
  console.error(`ABORT: upstream must be loopback (staging GoTrue), got ${up.hostname}`);
  process.exit(2);
}

const server = createServer((req, res) => {
  // `/auth/v1/token` -> `/token`; anything else is passed through untouched.
  const path = req.url.startsWith("/auth/v1") ? req.url.slice("/auth/v1".length) || "/" : req.url;
  const proxied = httpRequest(
    { hostname: up.hostname, port: up.port, path, method: req.method, headers: { ...req.headers, host: up.host } },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "staging auth upstream unreachable", detail: err.message }));
  });
  req.pipe(proxied);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`staging-auth-proxy: 127.0.0.1:${PORT}/auth/v1/* -> ${UPSTREAM}/*`);
});
