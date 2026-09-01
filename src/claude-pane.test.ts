// src/claude-pane.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's ESM loader cannot statically detect named exports on this package's
// bundled CJS output, so the value import goes through the default export.
import xtermHeadless from "@xterm/headless";
import { claudeKeyAction, paletteColor, termToLines } from "./claude-pane.ts";

const { Terminal } = xtermHeadless;
type TerminalInstance = InstanceType<typeof Terminal>;

function write(term: TerminalInstance, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

test("claudeKeyAction reserves only C-backslash, forwards everything else", () => {
  assert.equal(claudeKeyAction({ sequence: "\u001c" }), "unfocus");
  assert.equal(claudeKeyAction({ sequence: "a" }), "forward");
  assert.equal(claudeKeyAction({ sequence: "\r" }), "forward");
  assert.equal(claudeKeyAction({ sequence: "\t" }), "forward");
  assert.equal(claudeKeyAction({}), "forward");
});

test("paletteColor maps the 16 base colors to names and the cube to hex", () => {
  assert.equal(paletteColor(1), "red");
  assert.equal(paletteColor(9), "light-red");
  assert.equal(paletteColor(16), "#000000");
  assert.equal(paletteColor(196), "#ff0000");
  assert.equal(paletteColor(232), "#080808");
});

test("termToLines emits tagged runs for colored text and plain text as-is", async () => {
  const term = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
  await write(term, "hi \u001b[31mred\u001b[0m!");
  const lines = termToLines(term, false);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "hi {red-fg}red{/red-fg}!");
  assert.equal(lines[1], "");
});

test("termToLines tags bold and escapes literal braces", async () => {
  const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  await write(term, "\u001b[1m{b}\u001b[0m");
  assert.equal(termToLines(term, false)[0], "{bold}{open}b{close}{/bold}");
});

test("termToLines inverts the cursor cell when focused", async () => {
  const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
  await write(term, "ab");
  const lines = termToLines(term, true);
  assert.equal(lines[0], "ab{inverse} {/inverse}");
});

test("termToLines follows output past the first screenful", async () => {
  const term = new Terminal({ cols: 10, rows: 2, scrollback: 100, allowProposedApi: true });
  await write(term, "one\r\ntwo\r\nthree");
  const lines = termToLines(term, false);
  assert.equal(lines[0], "two");
  assert.equal(lines[1], "three");
});
