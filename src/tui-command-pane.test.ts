// src/tui-command-pane.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PtyLike } from "./claude-sessions.ts";
import { commandPaneKeyAction, openCommandPane } from "./tui-command-pane.ts";

function fakePty() {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let kills = 0;
  let exitCb: (code: number | undefined) => void = () => {};
  let dataCb: (d: string) => void = () => {};
  const pty: PtyLike = {
    write: (d) => void writes.push(d),
    resize: (c, r) => void resizes.push([c, r]),
    kill: () => void kills++,
    onData: (cb) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose() {} };
    },
  };
  return { pty, writes, resizes, kills: () => kills, exit: (c?: number) => exitCb(c), data: (d: string) => dataCb(d) };
}

function setup() {
  const f = fakePty();
  const spawned: Array<{ cwd: string; args: string[]; cols: number; rows: number }> = [];
  const exits: Array<number | undefined> = [];
  const content: string[] = [];
  const pane = openCommandPane({
    box: { setContent: (c: string) => void content.push(c) },
    argv: ["gh", "auth", "login"],
    cwd: "/tmp/x",
    cols: 40,
    rows: 10,
    spawn: (cwd, args, cols, rows) => {
      spawned.push({ cwd, args, cols, rows });
      return f.pty;
    },
    render: () => {},
    onExit: (code) => void exits.push(code),
  });
  return { f, pane, spawned, exits, content };
}

test("commandPaneKeyAction leaves only on C-]", () => {
  assert.equal(commandPaneKeyAction({ sequence: "\u001d" }), "leave");
  assert.equal(commandPaneKeyAction({ ch: "\u001d" }), "leave");
  assert.equal(commandPaneKeyAction({ sequence: "\u001c" }), "forward");
  assert.equal(commandPaneKeyAction({ sequence: "\b" }), "forward");
  assert.equal(commandPaneKeyAction({}), "forward");
});

test("spawns the command with its cwd and size", () => {
  const { spawned } = setup();
  assert.deepEqual(spawned, [{ cwd: "/tmp/x", args: ["gh", "auth", "login"], cols: 40, rows: 10 }]);
});

test("sendKey forwards non-leave keys to the pty", () => {
  const { f, pane } = setup();
  assert.equal(pane.sendKey({ sequence: "a" }), "forwarded");
  assert.equal(pane.sendKey({ ch: "b" }), "forwarded");
  assert.equal(pane.sendKey({ sequence: "\u001d" }), "leave");
  assert.deepEqual(f.writes, ["a", "b"]);
});

test("onExit fires with the pty exit code", () => {
  const { f, exits } = setup();
  f.exit(3);
  assert.deepEqual(exits, [3]);
});

test("kill kills the pty once and is safe after exit", () => {
  const a = setup();
  a.pane.kill();
  a.pane.kill();
  assert.equal(a.f.kills(), 1);
  const b = setup();
  b.f.exit(0);
  b.pane.kill();
  assert.equal(b.f.kills(), 0);
});

test("dispose kills a running child but not an exited one", () => {
  const a = setup();
  a.pane.dispose();
  assert.equal(a.f.kills(), 1);
  const b = setup();
  b.f.exit(0);
  b.pane.dispose();
  assert.equal(b.f.kills(), 0);
});

test("resize ignores tiny sizes and resizes the pty otherwise", () => {
  const { f, pane } = setup();
  pane.resize(1, 10);
  pane.resize(40, 1);
  assert.deepEqual(f.resizes, []);
  pane.resize(60, 20);
  assert.deepEqual(f.resizes, [[60, 20]]);
});
