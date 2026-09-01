// src/claude-pane.ts
// The embedded claude pane: pure xterm-buffer -> blessed-tags rendering plus
// the key-routing guard, and a thin attach shell that subscribes a blessed box
// to a session's pty output. The pty/session lifecycle lives in
// claude-sessions.ts; this module never spawns anything.
import type { Terminal } from "@xterm/headless";
import { escapeTags } from "./review-diff.ts";

// C-\ (FS, 0x1c) is the single reserved key while the claude pane is focused;
// tab and everything else forward so claude's own bindings keep working.
export function claudeKeyAction(key: { sequence?: string }): "unfocus" | "forward" {
  return key.sequence === "\u001c" ? "unfocus" : "forward";
}

const BASE16 = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");

export function paletteColor(i: number): string {
  if (i < 8) return BASE16[i];
  if (i < 16) return `light-${BASE16[i - 8]}`;
  if (i < 232) {
    const v = i - 16;
    return hex(CUBE[Math.floor(v / 36)], CUBE[Math.floor(v / 6) % 6], CUBE[v % 6]);
  }
  const g = 8 + (i - 232) * 10;
  return hex(g, g, g);
}

const rgbHex = (n: number) => hex((n >> 16) & 255, (n >> 8) & 255, n & 255);

// Subset of @xterm/headless's IBufferCell we read; typed locally because the
// package does not export the interface directly.
type Cell = {
  getChars(): string;
  getWidth(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  getFgColor(): number;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  getBgColor(): number;
  isBold(): number;
  isUnderline(): number;
  isInverse(): number;
};

type CellStyle = { fg: string | null; bg: string | null; bold: boolean; underline: boolean; inverse: boolean };

function cellStyle(c: Cell, forceInverse: boolean): CellStyle {
  let fg: string | null = null;
  if (!c.isFgDefault()) fg = c.isFgPalette() ? paletteColor(c.getFgColor()) : rgbHex(c.getFgColor());
  let bg: string | null = null;
  if (!c.isBgDefault()) bg = c.isBgPalette() ? paletteColor(c.getBgColor()) : rgbHex(c.getBgColor());
  return {
    fg,
    bg,
    bold: c.isBold() !== 0,
    underline: c.isUnderline() !== 0,
    inverse: c.isInverse() !== 0 || forceInverse,
  };
}

const sameStyle = (a: CellStyle, b: CellStyle) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline && a.inverse === b.inverse;

const PLAIN: CellStyle = { fg: null, bg: null, bold: false, underline: false, inverse: false };

function openTags(s: CellStyle): string {
  let out = "";
  if (s.bold) out += "{bold}";
  if (s.underline) out += "{underline}";
  if (s.inverse) out += "{inverse}";
  if (s.fg) out += `{${s.fg}-fg}`;
  if (s.bg) out += `{${s.bg}-bg}`;
  return out;
}

function closeTags(s: CellStyle): string {
  let out = "";
  if (s.bg) out += `{/${s.bg}-bg}`;
  if (s.fg) out += `{/${s.fg}-fg}`;
  if (s.inverse) out += "{/inverse}";
  if (s.underline) out += "{/underline}";
  if (s.bold) out += "{/bold}";
  return out;
}

function lineToTags(line: { getCell(x: number): Cell | undefined }, cols: number, cursorX: number | null): string {
  let out = "";
  let cur = PLAIN;
  // Unstyled trailing spaces are dropped so blessed does not repaint a full
  // row of blanks per line; a styled blank (cursor, bg) still renders.
  let pendingPlainSpaces = "";
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const style = cellStyle(cell, x === cursorX);
    const chars = cell.getChars() === "" ? " " : cell.getChars();
    if (sameStyle(style, PLAIN) && chars === " ") {
      pendingPlainSpaces += " ";
      continue;
    }
    if (!sameStyle(style, cur)) {
      out += closeTags(cur);
      if (pendingPlainSpaces) {
        out += pendingPlainSpaces;
        pendingPlainSpaces = "";
      }
      out += openTags(style);
      cur = style;
    } else if (pendingPlainSpaces) {
      out += closeTags(cur) + pendingPlainSpaces + openTags(cur);
      pendingPlainSpaces = "";
    }
    out += escapeTags(chars);
  }
  return out + closeTags(cur);
}

// The visible screen following output (baseY), not the scroll viewport: the
// pane always shows claude's latest lines, like a terminal without scrollback.
export function termToLines(term: Terminal, showCursor: boolean): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    let cursorX: number | null = null;
    if (showCursor && y === buf.cursorY) cursorX = buf.cursorX;
    out.push(line ? lineToTags(line, term.cols, cursorX) : "");
  }
  return out;
}

type SessionLike = {
  term: Terminal;
  pty: {
    onData(cb: (d: string) => void): { dispose(): void };
    resize(cols: number, rows: number): void;
  };
};

const REPAINT_MS = 33;

export function attachClaudeOutput(
  box: { setContent(c: string): void },
  session: SessionLike,
  isFocused: () => boolean,
  render: () => void,
): { repaint(): void; resize(cols: number, rows: number): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    box.setContent(termToLines(session.term, isFocused()).join("\n"));
    render();
  };
  // pty output arrives in bursts; coalesce repaints so a streaming response
  // does not render per chunk.
  const sub = session.pty.onData(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      repaint();
    }, REPAINT_MS);
  });
  return {
    repaint,
    resize: (cols: number, rows: number) => {
      if (cols < 2 || rows < 2) return;
      if (session.term.cols === cols && session.term.rows === rows) return;
      session.term.resize(cols, rows);
      session.pty.resize(cols, rows);
      repaint();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      sub.dispose();
    },
  };
}
