// Shared helpers for agents that register hooks inside a merged settings JSON
// document (Claude's ~/.claude/settings.json, Codex's hooks.json). A managed
// hook group is tagged with a statusMessage so re-installs replace only our
// groups and leave the user's own hooks intact.

import { isRecord } from "./hook-state.ts";

export interface ManagedHookCommand {
  command: string;
  statusMessage?: string;
  type: "command";
}

export interface ManagedHookMatcherGroup {
  hooks: ManagedHookCommand[];
  matcher?: string;
}

export interface ManagedHooksDocument {
  hooks?: Record<string, ManagedHookMatcherGroup[]>;
}

export function buildManagedHookCommand(
  command: string,
  statusMessage: string,
): ManagedHookCommand {
  return { type: "command", command, statusMessage };
}

export function isManagedHookGroup(group: ManagedHookMatcherGroup, statusMessage: string): boolean {
  return group.hooks.some(
    (hook) => hook.type === "command" && hook.statusMessage === statusMessage,
  );
}

// Merge our managed hook groups into an existing settings document, replacing
// any previously-managed groups (same statusMessage) while preserving the
// user's other hooks. Returns pretty-printed JSON with a trailing newline.
export function mergeManagedHooks(
  existing: string,
  managed: ManagedHooksDocument,
  statusMessage: string,
): string {
  const parsed = existing.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  const parsedHooks = isRecord(parsed.hooks)
    ? (parsed.hooks as Record<string, ManagedHookMatcherGroup[]>)
    : {};
  const nextHooks = { ...parsedHooks };
  const managedHooks = managed.hooks ?? {};

  for (const [eventName, managedGroups] of Object.entries(managedHooks)) {
    const groups = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : [];
    nextHooks[eventName] = [
      ...groups.filter((group) => !isManagedHookGroup(group, statusMessage)),
      ...managedGroups,
    ];
  }

  return `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n`;
}
