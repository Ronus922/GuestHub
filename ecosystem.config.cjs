// ============================================================
// PM2 definition for the GuestHub channel worker (D68).
//
// Deliberately declares ONLY the worker. The `guesthub` web app is an existing,
// separately-registered PM2 process (npm start, cwd /var/www/guesthub-production)
// and is restarted by name in scripts/deploy-production.sh — re-declaring it here
// would silently rewrite its registration. Unrelated PM2 apps (pms, mail-system,
// sys-app) are never referenced.
//
//   pm2 startOrRestart ecosystem.config.cjs --only guesthub-channel-worker
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
      // a crash-looping worker must not hammer Channex or the database
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,
      // room for the in-flight job to finish before SIGKILL (see channel-worker.cjs)
      kill_timeout: 15000,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        CHANNEL_WORKER_INTERVAL_MS: "20000",
      },
    },
  ],
};
