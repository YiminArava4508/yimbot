// src/claude-sessions.ts
// Per-PR embedded claude sessions for the review overlay. One pty + headless
// terminal per PR, spawned on first review open, surviving overlay close,
// killed on yimbot exit. The spawner is injected so tests never fork a pty.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodePtySpawn } from "node-pty";
import type { Terminal as TerminalType } from "@xterm/headless";
// Node's ESM loader cannot statically detect named exports on this package's
// bundled CJS output, so the value import goes through the default export.
import xtermHeadless from "@xterm/headless";
import { CONTEXT_RELPATH } from "./review-context.ts";

const { Terminal } = xtermHeadless;

export type PtyLike = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: () => void): { dispose(): void };
};

export type ClaudeSession = {
  pr: number;
  cwd: string;
  pty: PtyLike;
  term: TerminalType;
  exited: boolean;
};

export function seedPrompt(pr: number): string {
  return (
    `You are assisting a live review of PR #${pr}. ` +
    `Before answering each message, read ${CONTEXT_RELPATH} in the working directory; ` +
    `it holds the diffs currently under review and is rewritten as the reviewer moves around. ` +
    `Wait for questions; do not start working on anything unprompted.`
  );
}

export function claudeArgs(pr: number): string[] {
  return ["--permission-mode", "auto", seedPrompt(pr)];
}

export function ensureContextScaffold(cwd: string): void {
  const dir = join(cwd, ".yimbot");
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
}

export type SpawnPty = (cwd: string, args: string[], cols: number, rows: number) => PtyLike;

export type SessionRegistry = {
  getOrSpawn(pr: number, cwd: string): ClaudeSession;
  killAll(): void;
};

const COLS = 80;
const ROWS = 24;

export function makeSessionRegistry(
  spawn: SpawnPty,
  scaffold: (cwd: string) => void = ensureContextScaffold,
): SessionRegistry {
  const sessions = new Map<number, ClaudeSession>();
  return {
    getOrSpawn(pr: number, cwd: string): ClaudeSession {
      const existing = sessions.get(pr);
      if (existing && !existing.exited) return existing;
      scaffold(cwd);
      const pty = spawn(cwd, claudeArgs(pr), COLS, ROWS);
      const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
      const session: ClaudeSession = { pr, cwd, pty, term, exited: false };
      pty.onData((d) => term.write(d));
      pty.onExit(() => {
        session.exited = true;
      });
      sessions.set(pr, session);
      return session;
    },
    killAll(): void {
      for (const s of sessions.values()) {
        if (!s.exited) s.pty.kill();
      }
      sessions.clear();
    },
  };
}

export const spawnClaudePty: SpawnPty = (cwd, args, cols, rows) => {
  const p = nodePtySpawn("claude", args, {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    env: process.env as Record<string, string>,
  });
  return {
    write: (data) => p.write(data),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(() => cb()),
  };
};
