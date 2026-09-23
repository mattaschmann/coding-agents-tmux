import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCommand } from "../src/runtime.ts";

function setEnv(updates: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function installFakeTmux(script: string): { pathEntry: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "coding-agents-tmux-plugin-tmux-"));
  const tmuxPath = join(dir, "tmux");
  const logPath = join(dir, "tmux.log");
  const resolvedScript = script.replaceAll("__LOG_PATH__", logPath);

  writeFileSync(
    tmuxPath,
    `#!/usr/bin/env bash
set -euo pipefail
${resolvedScript}
`,
    "utf8",
  );
  chmodSync(tmuxPath, 0o755);

  return { pathEntry: dir, logPath };
}

function installFakeNpm(pathEntry: string): void {
  const npmPath = join(pathEntry, "npm");

  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
    "utf8",
  );
  chmodSync(npmPath, 0o755);
}

// Fake `opencode --version` so plugin install picks a deterministic entrypoint
// regardless of the real opencode on the developer's PATH.
function installFakeOpencode(pathEntry: string, version: string): void {
  const opencodePath = join(pathEntry, "opencode");

  writeFileSync(
    opencodePath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
exit 0
`,
    "utf8",
  );
  chmodSync(opencodePath, 0o755);
}

// Fake the standalone install at $HOME/.opencode/bin/opencode, which detection
// prefers over any opencode on PATH.
function installFakeStandaloneOpencode(home: string, version: string): void {
  const binDir = join(home, ".opencode", "bin");
  mkdirSync(binDir, { recursive: true });
  installFakeOpencode(binDir, version);
}

test("coding-agents-tmux.tmux reads renamed tmux options", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-menu-key)
      printf 'N\n'
      ;;
    @coding-agents-tmux-menu-key)
      printf 'O\n'
      ;;
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.match(readFileSync(fakeTmux.logPath, "utf8"), /bind-key N run-shell/);
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux installs renamed plugin integration paths", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  installFakeNpm(fakeTmux.pathEntry);
  installFakeOpencode(fakeTmux.pathEntry, "opencode v2.0.8");
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    // OpenCode v2 → the directory package is installed, not the loose file.
    const pluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux");
    const loosePluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");
    const piExtensionPath = join(piHome, "extensions", "coding-agents-tmux", "index.ts");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.ok(existsSync(pluginPath));
    assert.equal(existsSync(loosePluginPath), false, "v2 must not install the loose V1 file");
    assert.ok(existsSync(piExtensionPath));
    assert.ok(lstatSync(pluginPath).isSymbolicLink());
    assert.ok(lstatSync(piExtensionPath).isSymbolicLink());
    assert.equal(readlinkSync(pluginPath), join(process.cwd(), "plugin", "coding-agents-tmux"));
    assert.equal(readlinkSync(piExtensionPath), join(process.cwd(), "plugin", "pi-tmux.ts"));
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux installs the loose V1 plugin file for OpenCode v1", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  installFakeNpm(fakeTmux.pathEntry);
  installFakeOpencode(fakeTmux.pathEntry, "1.18.31");
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const loosePluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");
    const dirPluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.ok(existsSync(loosePluginPath));
    assert.ok(lstatSync(loosePluginPath).isSymbolicLink());
    assert.equal(
      readlinkSync(loosePluginPath),
      join(process.cwd(), "plugin", "coding-agents-tmux.ts"),
    );
    assert.equal(existsSync(dirPluginPath), false, "v1 must not install the V2 directory");
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux prefers the standalone opencode over a stale PATH v1", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  installFakeNpm(fakeTmux.pathEntry);
  // Stale npm/fnm v1 shadows PATH; the real standalone install is v2. Detection
  // must resolve $HOME/.opencode/bin/opencode and install the V2 package.
  installFakeOpencode(fakeTmux.pathEntry, "1.18.31");
  installFakeStandaloneOpencode(home, "opencode v2.0.8");
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const dirPluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux");
    const loosePluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.ok(existsSync(dirPluginPath), "standalone v2 must install the V2 directory package");
    assert.equal(
      existsSync(loosePluginPath),
      false,
      "a stale PATH v1 must not force the loose V1 file",
    );
    assert.equal(readlinkSync(dirPluginPath), join(process.cwd(), "plugin", "coding-agents-tmux"));
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux migrates a stale loose V1 install to the V2 directory", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  const pluginDir = join(configHome, "opencode", "plugins");
  const loosePluginPath = join(pluginDir, "coding-agents-tmux.ts");
  const dirPluginPath = join(pluginDir, "coding-agents-tmux");
  installFakeNpm(fakeTmux.pathEntry);
  installFakeOpencode(fakeTmux.pathEntry, "opencode v2.0.8");
  // Simulate a machine previously on V1: a stale loose symlink already exists.
  mkdirSync(pluginDir, { recursive: true });
  symlinkSync(join(process.cwd(), "plugin", "coding-agents-tmux.ts"), loosePluginPath);
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);

    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(loosePluginPath), false, "stale loose V1 symlink must be removed");
    assert.ok(existsSync(dirPluginPath), "V2 directory must be installed");
    assert.ok(lstatSync(dirPluginPath).isSymbolicLink());
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux keeps integration hooks when tmux status is disabled", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
    @coding-agents-tmux-notify-command)
      printf 'sketchybar --trigger coding_agents_changed\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({ PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}` });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const log = readFileSync(fakeTmux.logPath, "utf8");

    assert.equal(result.exitCode, 0);
    assert.match(log, /set-hook -g client-attached\[200\].*coding-agents-tmux.*notify/);
    assert.doesNotMatch(log, /set-hook -gu client-attached\[200\]/);
  } finally {
    restoreEnv();
  }
});

test("coding-agents-tmux.tmux honors @coding-agents-tmux-auto-install lists including claude", async () => {
  const fakeTmux = installFakeTmux(`
log_path='__LOG_PATH__'
option="\${!#}"

case "$1" in
show-option)
  case "$option" in
    @coding-agents-tmux-status)
      printf 'off\n'
      ;;
    @coding-agents-tmux-auto-install)
      printf 'pi,claude\n'
      ;;
  esac
  exit 0
  ;;
bind-key|set-option|set-hook|refresh-client|display-message|unbind-key)
  printf '%s\n' "$*" >> "$log_path"
  exit 0
  ;;
esac

printf 'unexpected args: %s\n' "$*" >&2
exit 1
`);
  const home = mkdtempSync(join(tmpdir(), "coding-agents-tmux-home-"));
  const configHome = join(home, ".config-home");
  const piHome = join(home, ".pi-home");
  const codexHome = join(home, ".codex-home");
  const claudeHome = join(home, ".claude-home");
  installFakeNpm(fakeTmux.pathEntry);
  const restoreEnv = setEnv({
    HOME: home,
    PATH: `${fakeTmux.pathEntry}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    PI_CODING_AGENT_DIR: piHome,
    CODEX_HOME: codexHome,
    CLAUDE_HOME: claudeHome,
  });

  try {
    const result = await runCommand([join(process.cwd(), "coding-agents-tmux.tmux")]);
    const newPluginPath = join(configHome, "opencode", "plugins", "coding-agents-tmux.ts");
    const newPiExtensionPath = join(piHome, "extensions", "coding-agents-tmux", "index.ts");
    const claudeSettingsPath = join(claudeHome, "settings.json");
    const codexHooksPath = join(codexHome, "hooks.json");

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderrText.trim(), "");
    assert.equal(existsSync(newPluginPath), false);
    assert.ok(existsSync(newPiExtensionPath));
    assert.ok(existsSync(claudeSettingsPath));
    assert.equal(existsSync(codexHooksPath), false);
    assert.match(readFileSync(claudeSettingsPath, "utf8"), /claude-hook-state/);
  } finally {
    restoreEnv();
  }
});
