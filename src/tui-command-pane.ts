// src/tui-command-pane.ts
// A reusable embedded terminal: runs one command in a pty, renders it into a
// blessed box through the claude pane's xterm output path, and forwards keys.
// C-] is the only reserved key, so the caller can leave the pane.
import xtermHeadless from "@xterm/headless";
import { attachClaudeOutput } from "./claude-pane.ts";
import { spawnPty, type SpawnPty } from "./claude-sessions.ts";

const { Terminal } = xtermHeadless;

type Key = { sequence?: string; ch?: string };

export function commandPaneKeyAction(key: Key): "leave" | "forward" {
  return (key.sequence ?? key.ch) === "\u001d" ? "leave" : "forward";
}

const defaultSpawn: SpawnPty = (cwd, argv, cols, rows) => spawnPty(argv[0], argv.slice(1), cwd, cols, rows);

export type CommandPane = {
  sendKey(key: Key): "leave" | "forwarded";
  resize(cols: number, rows: number): void;
  kill(): void;
  dispose(): void;
};

export function openCommandPane(opts: {
  box: { setContent(c: string): void };
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  spawn?: SpawnPty;
  render: () => void;
  onExit: (code: number | undefined) => void;
}): CommandPane {
  const spawn = opts.spawn ?? defaultSpawn;
  const pty = spawn(opts.cwd, opts.argv, opts.cols, opts.rows);
  const term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: 2000, allowProposedApi: true });
  pty.onData((d) => term.write(d));
  let exited = false;
  let disposed = false;
  const out = attachClaudeOutput(opts.box, { term, pty }, () => true, opts.render);
  const exitSub = pty.onExit((code) => {
    exited = true;
    out.repaint();
    opts.onExit(code);
  });
  const kill = () => {
    if (exited) return;
    exited = true;
    pty.kill();
  };
  return {
    sendKey(key) {
      if (commandPaneKeyAction(key) === "leave") return "leave";
      pty.write(key.sequence ?? key.ch ?? "");
      return "forwarded";
    },
    resize: out.resize,
    kill,
    dispose() {
      if (disposed) return;
      disposed = true;
      kill();
      out.dispose();
      exitSub.dispose();
    },
  };
}
