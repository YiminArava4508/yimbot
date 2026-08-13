// src/mode.ts
// The bot's operating mode. Supervised: human review signals flag the PR and
// halt its fix work until a person unflags. Autonomous: no review flags, and
// stuck sessions get nudged instead of waiting on a person.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsLogPath } from "./events.ts";

export type Mode = "autonomous" | "supervised";

// Persisted next to the events log so the TUI toggle, the daemon heartbeat,
// and a headless restart all resolve the same file.
export function modeFilePath(): string {
  return join(dirname(eventsLogPath()), "mode");
}

export function readMode(): Mode {
  try {
    const raw = readFileSync(modeFilePath(), "utf8").trim();
    if (raw === "autonomous" || raw === "supervised") return raw;
  } catch {
    // Missing file: first run.
  }
  return "supervised";
}

export function writeMode(mode: Mode): void {
  try {
    writeFileSync(modeFilePath(), mode + "\n");
  } catch {
    // Best-effort persistence: the in-process reader still sees the default.
  }
}

export function toggleMode(): Mode {
  const next: Mode = readMode() === "supervised" ? "autonomous" : "supervised";
  writeMode(next);
  return next;
}
