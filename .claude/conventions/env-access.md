# Env access convention

This project has exactly ONE environment variable: `FS_CONFIG_CWD`, the
spawn-time handshake that tells a detached daemon which project directory it
serves (set by `lifecycle.ensureDaemon`, read once at the daemon entry).

Rules:
- All other configuration flows through `.fiber-snatcher/config.json`
  (`src/core/config.ts`). Never add feature flags or tunables as env vars.
- The one read goes through `spawnCwd()` in `src/daemon/env.ts` — no raw
  `process.env` elsewhere. Adding a second env var requires updating this doc
  with the reason it cannot live in config.json.
