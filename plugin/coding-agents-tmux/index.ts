// Server-side entrypoint for the OpenCode V2 plugin package.
//
// V2 requires a server entry to exist (the loader errors "Plugin entrypoint not
// found" when it is absent), but this plugin's real work — writing per-pane tmux
// state — happens in the TUI process, which is the only place a stable
// `TMUX_PANE` exists. The shared background service (`opencode serve --service`)
// runs one process for all panes with a stale `TMUX_PANE`, so a server-side
// writer would mis-key every pane into one file. See ./tui.ts for the writer.
//
// `Plugin.define` is identity and the loader predicate only checks `{ id, setup }`,
// so this stays dependency-free with a plain object literal.

export default {
  id: "coding-agents-tmux",
  setup() {
    // Intentionally empty: state is produced by the ./tui entrypoint.
  },
};
