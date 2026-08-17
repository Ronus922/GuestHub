// ============================================================
// PM2 definitions for GuestHub: the channel worker (D68) and the web app (D149).
// Both apps live in this checkout and read the same .env.local.
//
// The web app MUST run the `next` binary directly. Running it through a package
// manager (`npm start`) is what produced the 2026-08-17 outage class: PM2 tracks
// the wrapper, not the grandchild, so when the wrapper dies the `next-server`
// survives as an orphan (ppid=1) still holding the port, PM2 respawns and hits
// EADDRINUSE — forever, invisibly, because the orphan keeps serving 200s.
//
// scripts/deploy-production.sh restarts the web app BY NAME (line 69) and does
// not read this file for it — deliberate, not an omission: `pm2 restart <name>`
// reuses the live registration, so a deploy can never rewrite it. This
// declaration is the source of truth for (re-)registering the app from scratch:
//
//   pm2 start ecosystem.config.cjs --only guesthub               (web app)
//   pm2 startOrRestart ecosystem.config.cjs --only guesthub-channel-worker
//
// Unrelated PM2 apps (pms, mail-system, sys-app) are never referenced.
// ============================================================
module.exports = {
  apps: [
    {
      name: "guesthub-channel-worker",
      script: "scripts/channel-worker.cjs",
      cwd: __dirname,
      // node loads the same secrets the web app uses; missing file is not fatal
      // in dev (the script then refuses to start on the DATABASE_URL check).
      interpreter_args: "--env-file-if-exists=.env.local",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // a crash-looping worker must not hammer Beds24 or the database
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,
      // room for the in-flight job to finish before SIGKILL (see channel-worker.cjs)
      kill_timeout: 15000,
      max_memory_restart: "300M",
      // the cumulative pm2 log is useless for diagnosis without per-line
      // timestamps (the MAX_PARAMETERS_EXCEEDED finding could not be dated)
      time: true,
      env: {
        NODE_ENV: "production",
        CHANNEL_WORKER_INTERVAL_MS: "20000",
      },
    },
    {
      name: "guesthub",
      // the binary itself — never `npm start` (see the header)
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3007",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "3007",
      },
      // a `pm2 start` from an interactive terminal bakes that terminal's whole
      // environment into the registration (session tokens included). PM2 6.0.14
      // matches these as substrings of the variable name, not as prefixes.
      filter_env: [
        "CLAUDE_",
        "VSCODE_",
        "SSH_",
        "XDG_",
        "COPILOT_",
        "CODEX_",
        "AI_AGENT",
        "PROD_DEPLOY_OK",
      ],
    },
  ],
};
