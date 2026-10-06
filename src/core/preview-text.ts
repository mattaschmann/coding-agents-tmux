// Shared helpers for reading an agent's tmux pane preview text.
// Owns the single definition of choice-line counting used by every agent's
// preview classifier.

// Count lines that look like a selectable choice: numbered (`1. foo`) or
// bulleted (`- foo` / `* foo`), optionally preceded by a selection arrow
// (`›`/`>`) that TUIs render on the highlighted option. Used to tell a live
// multiple-choice prompt apart from ordinary prose.
export function countChoiceLines(message: string): number {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[›>]\s*)?\d+\.\s+\S/.test(line) || /^(?:[›>]\s*)?[-*]\s+\S/.test(line))
    .length;
}
