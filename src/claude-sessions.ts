// src/claude-sessions.ts
// Per-PR embedded claude sessions for the review overlay. Claude itself runs
// in a detached tmux session (yimbot-review-<pr>) so it survives a yimbot
// restart; the pty here is only a tmux client attached to it, plus a headless
// terminal per PR. Clients survive overlay close; detachAll drops clients only,
// killAll also kills the tmux sessions. The spawner is injected so tests never
// fork a pty.
// Claude runs in a .yimbot subdir of the worktree, not the worktree itself:
// claude keys transcripts by cwd, and a review session that shared the
// worktree's cwd was what `claude --continue` resumed when the daemon
// re-coupled the work session.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodePtySpawn } from "node-pty";
import type { Terminal as TerminalType } from "@xterm/headless";
// Node's ESM loader cannot statically detect named exports on this package's
// bundled CJS output, so the value import goes through the default export.
import xtermHeadless from "@xterm/headless";
import { contextFilePath } from "./review-context.ts";

const { Terminal } = xtermHeadless;

export type PtyLike = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (code: number | undefined) => void): { dispose(): void };
};

export type ClaudeSession = {
  pr: number;
  cwd: string;
  pty: PtyLike;
  term: TerminalType;
  exited: boolean;
};

export function sessionCwd(worktree: string): string {
  return join(worktree, ".yimbot", "review");
}

export function seedPrompt(pr: number, worktree: string): string {
  return (
    `You are assisting a live review of PR #${pr}, checked out in ${worktree}. ` +
    `Before answering each message, read ${contextFilePath(worktree)}; ` +
    `it holds the diffs currently under review and is rewritten as the reviewer moves around. ` +
    `Wait for questions; do not start working on anything unprompted.`
  );
}

export function claudeArgs(pr: number, worktree: string): string[] {
  return ["--permission-mode", "auto", seedPrompt(pr, worktree)];
}

const REVIEW_SESSION_PREFIX = "yimbot-review-";

export function reviewSessionName(pr: number): string {
  return `${REVIEW_SESSION_PREFIX}${pr}`;
}

// -A attaches when the session already exists, so a restarted yimbot rejoins
// the same conversation. The ";" is tmux's command separator, passed as its
// own argv element since no shell is involved.
export function reviewTmuxArgv(pr: number, worktree: string): string[] {
  const name = reviewSessionName(pr);
  return [
    "new-session",
    "-A",
    "-s",
    name,
    "-c",
    sessionCwd(worktree),
    "claude",
    ...claudeArgs(pr, worktree),
    ";",
    "set-option",
    "-t",
    name,
    "status",
    "off",
  ];
}

export function ensureContextScaffold(cwd: string): void {
  const dir = join(cwd, ".yimbot");
  mkdirSync(sessionCwd(cwd), { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
}

export type SpawnPty = (cwd: string, args: string[], cols: number, rows: number) => PtyLike;

export type SessionRegistry = {
  getOrSpawn(pr: number, cwd: string): ClaudeSession;
  detachAll(): void;
  killAll(): void;
};

export type TmuxDeps = {
  listSessions(): string[];
  killSession(name: string): void;
};

const realTmux: TmuxDeps = {
  listSessions() {
    try {
      const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },
  killSession(name) {
    try {
      execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  },
};

const COLS = 80;
const ROWS = 24;

export function makeSessionRegistry(
  spawn: SpawnPty,
  scaffold: (cwd: string) => void = ensureContextScaffold,
  tmux: TmuxDeps = realTmux,
): SessionRegistry {
  const sessions = new Map<number, ClaudeSession>();
  function detachAll(): void {
    for (const s of sessions.values()) {
      if (!s.exited) s.pty.kill();
    }
    sessions.clear();
  }
  return {
    getOrSpawn(pr: number, cwd: string): ClaudeSession {
      const existing = sessions.get(pr);
      if (existing && !existing.exited) return existing;
      scaffold(cwd);
      const pty = spawn(sessionCwd(cwd), reviewTmuxArgv(pr, cwd), COLS, ROWS);
      const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
      const session: ClaudeSession = { pr, cwd, pty, term, exited: false };
      pty.onData((d) => term.write(d));
      pty.onExit(() => {
        session.exited = true;
      });
      sessions.set(pr, session);
      return session;
    },
    detachAll,
    killAll(): void {
      detachAll();
      for (const name of tmux.listSessions()) {
        if (name.startsWith(REVIEW_SESSION_PREFIX)) tmux.killSession(name);
      }
    },
  };
}

// The tmux client runs inside yimbot's own tmux pane; with TMUX set it would
// refuse to nest.
export function tmuxClientEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "TMUX" || k === "TMUX_PANE") continue;
    out[k] = v;
  }
  return out;
}

export function spawnPty(
  command: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string> = process.env as Record<string, string>,
): PtyLike {
  const p = nodePtySpawn(command, args, { name: "xterm-256color", cwd, cols, rows, env });
  return {
    write: (data) => p.write(data),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit((e) => cb(e.exitCode)),
  };
}

export const spawnClaudePty: SpawnPty = (cwd, args, cols, rows) =>
  spawnPty("tmux", args, cwd, cols, rows, tmuxClientEnv());
