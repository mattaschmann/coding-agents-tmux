import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_SLUG = "coding-agents-tmux";
export const PRIMARY_CLI_NAME = "coding-agents-tmux";

export function getEnvValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function getStateHome(): string {
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

export function getPreferredStateDir(input: { env: string; subdirectory: string }): string {
  return getEnvValue(input.env) ?? join(getStateHome(), PRODUCT_SLUG, input.subdirectory);
}

export function getStateDirCandidates(input: { env: string; subdirectory: string }): string[] {
  const explicitDir = getEnvValue(input.env);

  if (explicitDir) {
    return [explicitDir];
  }

  return [join(getStateHome(), PRODUCT_SLUG, input.subdirectory)];
}

export const STATUS_CACHE_SUBDIR = "status-cache";

// Every env var that relocates an agent state directory away from the state
// root. The status cache watches these too, since files there bypass the root.
export const STATE_DIR_ENVS = [
  "CODING_AGENTS_TMUX_STATE_DIR",
  "CODING_AGENTS_TMUX_CLAUDE_STATE_DIR",
  "CODING_AGENTS_TMUX_CODEX_STATE_DIR",
  "CODING_AGENTS_TMUX_PI_STATE_DIR",
  "CODING_AGENTS_TMUX_CYCLE_STATE_DIR",
] as const;

export function getStateRoot(): string {
  return join(getStateHome(), PRODUCT_SLUG);
}

export function getStatusCacheDir(): string {
  return (
    getEnvValue("CODING_AGENTS_TMUX_STATUS_CACHE_DIR") ?? join(getStateRoot(), STATUS_CACHE_SUBDIR)
  );
}
