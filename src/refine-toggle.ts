// src/refine-toggle.ts
// Live on/off switch for the refine step. Like the mode file, it is persisted
// next to the events log so the TUI's R key and the daemon heartbeat resolve
// the same state without a restart; AUTO_REFINE stays the default when the
// file is absent.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";
import { isOff } from "./settings-model.ts";

export function refineToggleFilePath(): string {
  return join(dirname(eventsLogPath()), "refine");
}

export function readRefineEnabled(defaultOn: boolean): boolean {
  try {
    const raw = readFileSync(refineToggleFilePath(), "utf8").trim();
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // Missing file: never toggled.
  }
  return defaultOn;
}

export function writeRefineEnabled(on: boolean): void {
  try {
    writeFileSync(refineToggleFilePath(), (on ? "on" : "off") + "\n");
  } catch {
    // Best-effort persistence: the in-process reader still sees the default.
  }
}

export function toggleRefine(defaultOn: boolean): boolean {
  const next = !readRefineEnabled(defaultOn);
  writeRefineEnabled(next);
  return next;
}

export function refineEnvDefault(env: Record<string, string | undefined>): boolean {
  return !isOff(env.AUTO_REFINE ?? "true");
}
