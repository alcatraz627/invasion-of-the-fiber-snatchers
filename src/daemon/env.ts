/** Both halves of the project's single env handshake (see
 *  .claude/conventions/env-access.md): lifecycle writes the target cwd into
 *  the spawned daemon's environment; the daemon entry reads it once. */
export function spawnCwd(): string | undefined {
  return process.env.FS_CONFIG_CWD;
}

export function daemonSpawnEnv(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, FS_CONFIG_CWD: cwd };
}
