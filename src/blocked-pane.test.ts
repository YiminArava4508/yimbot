import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaneActivity, readPaneActivity } from "./blocked-pane.ts";

const NOW = 1_000_000_000;
const secs = (agoMs: number) => String((NOW - agoMs) / 1000);

test("a claude pane showing the interrupt hint is working", () => {
  const a = parsePaneActivity(`claude\t${secs(5000)}`, "...\n✻ Thinking (esc to interrupt)\n", NOW);
  assert.deepEqual(a, { working: true, quietMs: 5000 });
});

test("a claude pane at the prompt is idle with its quiet time", () => {
  const a = parsePaneActivity(`2.1.327\t${secs(300_000)}`, "> \n  ? for shortcuts\n", NOW);
  assert.deepEqual(a, { working: false, quietMs: 300_000 });
});

test("an interrupt hint far up the scrollback does not count", () => {
  const screen = ["esc to interrupt", ...Array.from({ length: 20 }, () => "done")].join("\n");
  assert.equal(parsePaneActivity(`claude\t${secs(1000)}`, screen, NOW)?.working, false);
});

test("a shell-only window is never working", () => {
  assert.equal(parsePaneActivity(`bash\t${secs(1000)}`, "esc to interrupt", NOW)?.working, false);
});

test("no panes means unreadable", () => {
  assert.equal(parsePaneActivity("", "", NOW), null);
});

test("readPaneActivity falls back to the standalone session and then to null", () => {
  const calls: string[] = [];
  const exec = (_f: string, args: string[]) => {
    calls.push(args[2]);
    if (args[2] === "=eng-1-x:pr-1-blocked") throw new Error("no window");
    return args[0] === "list-panes" ? `claude\t${secs(1000)}` : "";
  };
  assert.equal(readPaneActivity("pr-1-blocked", "eng-1-x", () => NOW, exec)?.quietMs, 1000);
  assert.ok(calls.includes("=pr-1-blocked"));
  const dead = () => {
    throw new Error("gone");
  };
  assert.equal(readPaneActivity("pr-1-blocked", "eng-1-x", () => NOW, dead), null);
});
