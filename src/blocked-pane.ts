// src/blocked-pane.ts
// Reads what a blocked fixer's tmux window is doing, so the review step can tell
// an idle window (safe to close) from one mid-turn (never touched).
import { execFileSync } from "node:child_process";
import { SHELL_COMMANDS } from "./stuck-sessions.ts";

export type PaneActivity = { working: boolean; quietMs: number };

// Claude Code shows this in its status line for as long as a turn is running.
const WORKING_RE = /esc to interrupt/i;
const TAIL_LINES = 15;

// `listPanes` is tmux list-panes output ("#{pane_current_command}\t#{window_activity}"
// per pane) and `screen` the capture of the window's pane. The newest pane output
// sets quietMs; a pane whose claude exited (a shell is foreground) is not working.
export function parsePaneActivity(listPanes: string, screen: string, nowMs: number): PaneActivity | null {
  let newest = 0;
  let found = false;
  let shellOnly = true;
  for (const line of listPanes.split("\n")) {
    const [cmd, activity] = line.split("\t");
    if (!cmd || !activity) continue;
    found = true;
    if (!SHELL_COMMANDS.has(cmd)) shellOnly = false;
    newest = Math.max(newest, Number(activity) * 1000);
  }
  if (!found || !Number.isFinite(newest)) return null;
  const tail = screen.split("\n").slice(-TAIL_LINES).join("\n");
  return { working: !shellOnly && WORKING_RE.test(tail), quietMs: Math.max(0, nowMs - newest) };
}

type Exec = (file: string, args: string[]) => string;
const runExec: Exec = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// The window (or standalone session) named `name`, looked up inside the branch's
// ticket session first. Null when it is gone or tmux cannot be read.
export function readPaneActivity(name: string, ticketSession: string, now: () => number = Date.now, exec: Exec = runExec): PaneActivity | null {
  for (const target of [`=${ticketSession}:${name}`, `=${name}`]) {
    try {
      const list = exec("tmux", ["list-panes", "-t", target, "-F", "#{pane_current_command}\t#{window_activity}"]);
      const pane = exec("tmux", ["capture-pane", "-p", "-t", target]);
      return parsePaneActivity(list, pane, now());
    } catch {
      continue;
    }
  }
  return null;
}
