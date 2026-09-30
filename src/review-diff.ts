// src/review-diff.ts
// Pure parser for `gh pr diff` output (git unified diff format). No fs, no
// subprocess: raw text in, per-file structures out, so tests stay hermetic.
import blessed from "neo-blessed";
import { createHighlighterCoreSync, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import darkPlus from "shiki/themes/dark-plus.mjs";
import { GRAMMARS, languageFor } from "./review-diff-langs.ts";

export { languageFor };

// blessed builds its 8-color fallback table at load by running every xterm
// palette hex through colors.match against a truncated palette, and never
// clears the match cache afterwards. Any hex that lands exactly on a palette
// entry (the tint and gutter colors below do) would resolve to that stale
// 8-color answer, so the cache is dropped before the first real lookup.
blessed.colors._cache = {};

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";
export type DiffLine = { kind: DiffLineKind; text: string };
export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export type FileDiff = {
  path: string;
  oldPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  lines: DiffLine[];
};

const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  // Header lines and hunk-body lines share prefixes ("---" vs "-"), so the
  // classifier tracks whether it is inside a hunk: before the first @@ of a
  // file everything is metadata, after it every line is content.
  let inHunk = false;
  const rawLines = text.split("\n");
  // split leaves one trailing "" after the final newline; drop only that.
  if (rawLines.at(-1) === "") rawLines.pop();
  for (const line of rawLines) {
    const m = DIFF_HEADER.exec(line);
    if (m) {
      cur = { path: m[2], oldPath: m[1], status: "modified", additions: 0, deletions: 0, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      cur.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ") || line.startsWith("rename to ")) cur.status = "renamed";
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.status = "binary";
      cur.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      cur.additions++;
      cur.lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      cur.deletions++;
      cur.lines.push({ kind: "del", text: line });
    } else {
      cur.lines.push({ kind: "ctx", text: line });
    }
  }
  return files;
}

// Blessed parses {word} sequences as style tags, so literal braces in code
// must become the {open}/{close} escapes before any tag wrapping.
export function escapeTags(s: string): string {
  return s.replaceAll("{", "\u0000").replaceAll("}", "{close}").replaceAll("\u0000", "{open}");
}


// One Dark+ (the VSCode default dark theme) highlighter, created on first use
// with the pure-JS regex engine so tokenizing stays synchronous and needs no
// WASM. Grammars compile lazily inside shiki, so the first paint of each
// language pays its compile cost once.
const THEME = "dark-plus";
let highlighter: HighlighterCore | null = null;
function getHighlighter(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [darkPlus],
    langs: GRAMMARS,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}
// Grammar compilation is lazy per language and costs a few hundred ms the
// first time one is used. Warming TypeScript while the PR diff is still
// downloading keeps the first file pick instant for the common case.
export function warmHighlighter(): void {
  try {
    const hl = getHighlighter();
    for (const lang of ["typescript", "tsx"]) hl.codeToTokensBase("const a = 1;", { lang, theme: THEME });
  } catch {
    // A grammar that fails to compile falls back to plain text at render time.
  }
}

const THEME_FG = (darkPlus.fg ?? "#d4d4d4").toLowerCase();

const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

// A run of text in one style. color is null for the theme's default
// foreground, which is left untagged so it follows the terminal's own text
// color instead of forcing Dark+'s light grey onto every line.
export type Tok = { text: string; color: string | null; bold: boolean; underline: boolean };

const plainTok = (text: string): Tok => ({ text, color: null, bold: false, underline: false });

function themedTok(t: ThemedToken): Tok {
  const color = t.color?.toLowerCase() ?? null;
  const style = t.fontStyle ?? 0;
  return {
    text: t.content,
    color: color === THEME_FG ? null : color,
    bold: (style & FONT_BOLD) !== 0,
    underline: (style & FONT_UNDERLINE) !== 0,
  };
}

const sameStyle = (a: Tok, b: Tok) => a.color === b.color && a.bold === b.bold && a.underline === b.underline;

function mergeToks(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const t of toks) {
    const last = out.at(-1);
    if (last && sameStyle(last, t)) last.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

const isBody = (l: DiffLine) => l.kind === "add" || l.kind === "del" || l.kind === "ctx";
// "\ No newline at end of file" is a marker about the line above, not code.
const isMarker = (l: DiffLine) => l.kind === "ctx" && l.text.startsWith("\\");
const bodyText = (l: DiffLine) => l.text.slice(1);

// Tokenizes one side of a hunk (the old side is ctx+del, the new side is
// ctx+add) as a single document, so grammar state carries across lines and
// multi-line strings, template literals, and block comments come out right.
// Deletions are read from the old side, additions and context from the new.
// Nothing carries between hunks: the code skipped between them is unknown, so
// each hunk starts from a clean grammar state.
function tokenizeSide(hl: HighlighterCore, lang: string, lines: DiffLine[]): Tok[][] | null {
  if (lines.length === 0) return [];
  const code = lines.map(bodyText).join("\n");
  try {
    const themed = hl.codeToTokensBase(code, { lang, theme: THEME, includeExplanation: false });
    if (themed.length !== lines.length) return null;
    return themed.map((line) => mergeToks(line.map(themedTok)));
  } catch {
    return null;
  }
}

function tokenizeHunk(hl: HighlighterCore, lang: string, hunk: DiffLine[], out: Map<DiffLine, Tok[]>): void {
  const oldSide = hunk.filter((l) => l.kind !== "add");
  const newSide = hunk.filter((l) => l.kind !== "del");
  const oldToks = tokenizeSide(hl, lang, oldSide);
  const newToks = tokenizeSide(hl, lang, newSide);
  if (oldToks === null || newToks === null) {
    for (const l of hunk) out.set(l, [plainTok(bodyText(l))]);
    return;
  }
  oldSide.forEach((l, i) => { if (l.kind === "del") out.set(l, oldToks[i]); });
  newSide.forEach((l, i) => out.set(l, newToks[i]));
}

// Tokens per body line, memoized per FileDiff (parse results are never
// mutated after creation). Files with no grammar get one plain token a line.
const tokenCache = new WeakMap<FileDiff, Map<DiffLine, Tok[]>>();

export function fileTokens(fd: FileDiff): Map<DiffLine, Tok[]> {
  const cached = tokenCache.get(fd);
  if (cached) return cached;
  const out = new Map<DiffLine, Tok[]>();
  const lang = fd.status === "binary" ? null : languageFor(fd.path);
  const body = fd.lines.filter((l) => isBody(l) && !isMarker(l));
  if (lang === null) {
    for (const l of body) out.set(l, [plainTok(bodyText(l))]);
  } else {
    const hl = getHighlighter();
    let hunk: DiffLine[] = [];
    for (const l of fd.lines) {
      if (l.kind === "hunk") {
        tokenizeHunk(hl, lang, hunk, out);
        hunk = [];
      } else if (isBody(l) && !isMarker(l)) {
        hunk.push(l);
      }
    }
    tokenizeHunk(hl, lang, hunk, out);
  }
  tokenCache.set(fd, out);
  return out;
}

const TAB = "    ";
const ASCII_ONLY = /^[\x20-\x7e]*$/;

// Display width of a string: under fullUnicode a CJK character is two cells
// and a combining mark zero, so String.length would misalign the columns.
// ASCII takes the cheap path.
const strWidth = (s: string): number => (ASCII_ONLY.test(s) ? s.length : blessed.unicode.strWidth(s));

// Cuts text to at most `width` display columns; returns the kept text and
// its width.
function clipCols(text: string, width: number): [string, number] {
  if (ASCII_ONLY.test(text)) {
    const kept = text.slice(0, width);
    return [kept, kept.length];
  }
  let out = "";
  let cols = 0;
  for (const ch of text) {
    const w = blessed.unicode.strWidth(ch);
    if (cols + w > width) break;
    out += ch;
    cols += w;
  }
  return [out, cols];
}

function tagTok(t: Tok, esc: string): string {
  let s = esc;
  if (t.color !== null) s = `{${t.color}-fg}${s}{/${t.color}-fg}`;
  if (t.bold) s = `{bold}${s}{/bold}`;
  if (t.underline) s = `{underline}${s}{/underline}`;
  return s;
}

const cleanText = (text: string) => text.replace(/\r$/, "").replaceAll("\t", TAB);

// Renders tokens as tagged text fitted to exactly `width` display columns:
// truncated when longer, space-padded when shorter. Fitting runs on the raw
// text before tagging and escaping, neither of which changes visible width.
export function renderToks(toks: Tok[], width: number): string {
  let out = "";
  let cols = 0;
  for (const t of toks) {
    if (cols >= width) break;
    const [kept, w] = clipCols(cleanText(t.text), width - cols);
    if (kept === "") continue;
    out += tagTok(t, escapeTags(kept));
    cols += w;
  }
  return out + " ".repeat(Math.max(0, width - cols));
}

const GUTTER_FG = "#858585";
const ADD_BG = "#005f00";
const DEL_BG = "#5f0000";

const dim = (s: string) => `{${GUTTER_FG}-fg}${s}{/${GUTTER_FG}-fg}`;

const diffSign = (kind: DiffLineKind): string => {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
};

const signTag = (kind: DiffLineKind): string => {
  if (kind === "add") return "{green-fg}+{/green-fg}";
  if (kind === "del") return "{red-fg}-{/red-fg}";
  return " ";
};

const rowBg = (kind: DiffLineKind): string | null => {
  if (kind === "add") return ADD_BG;
  if (kind === "del") return DEL_BG;
  return null;
};

const tint = (kind: DiffLineKind, row: string): string => {
  const bg = rowBg(kind);
  return bg === null ? row : `{${bg}-bg}${row}{/${bg}-bg}`;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type LineNo = { oldNo: number | null; newNo: number | null };

// Old and new line numbers per body line, counted from each hunk header.
function lineNumbers(fd: FileDiff): Map<DiffLine, LineNo> {
  const out = new Map<DiffLine, LineNo>();
  let oldNo = 0;
  let newNo = 0;
  for (const l of fd.lines) {
    if (l.kind === "hunk") {
      const m = HUNK_HEADER.exec(l.text);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
    } else if (l.kind === "del") {
      out.set(l, { oldNo: oldNo++, newNo: null });
    } else if (l.kind === "add") {
      out.set(l, { oldNo: null, newNo: newNo++ });
    } else if (l.kind === "ctx" && !isMarker(l)) {
      out.set(l, { oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

const numCell = (no: number | null, width: number) => (no === null ? "" : String(no)).padStart(width);

const fileHeader = (fd: FileDiff): string => {
  const name = fd.status === "renamed" ? `${escapeTags(fd.oldPath)} -> ${escapeTags(fd.path)}` : escapeTags(fd.path);
  return `{bold}${name}{/bold}  {green-fg}+${fd.additions}{/green-fg} {red-fg}-${fd.deletions}{/red-fg}`;
};

const numWidthFor = (nos: Iterable<LineNo>): number => {
  let max = 0;
  for (const n of nos) max = Math.max(max, n.oldNo ?? 0, n.newNo ?? 0);
  return Math.max(3, String(max).length);
};

// One rendered width per file: paint asks for the current pane width on
// every call, and a terminal drag would otherwise pile up a copy per column.
const renderCache = new WeakMap<FileDiff, { width: number; lines: string[] }>();

// Unified view, laid out like an IDE inline diff: a dim gutter with the old
// and new line numbers, a colored sign, then the tokenized code, with added
// and deleted rows tinted across the full width.
export function renderFileDiff(fd: FileDiff, width: number): string[] {
  const cached = renderCache.get(fd);
  if (cached && cached.width === width) return cached.lines;
  const out = [fileHeader(fd)];
  const toks = fileTokens(fd);
  const nos = lineNumbers(fd);
  const numWidth = numWidthFor(nos.values());
  const gutterWidth = numWidth * 2 + 4;
  const codeWidth = Math.max(1, width - gutterWidth);
  for (const l of fd.lines) {
    if (l.kind === "meta") continue;
    if (l.kind === "hunk") {
      out.push(`{cyan-fg}${escapeTags(l.text)}{/cyan-fg}`);
      continue;
    }
    if (isMarker(l)) {
      out.push(dim(renderToks([plainTok(l.text)], width)));
      continue;
    }
    const n = nos.get(l) ?? { oldNo: null, newNo: null };
    const gutter = dim(`${numCell(n.oldNo, numWidth)} ${numCell(n.newNo, numWidth)} `);
    const code = renderToks(toks.get(l) ?? [plainTok(bodyText(l))], codeWidth);
    out.push(tint(l.kind, `${gutter}${signTag(l.kind)} ${code}`));
  }
  if (fd.status === "binary") out.push("{grey-fg}binary file, no text diff{/grey-fg}");
  renderCache.set(fd, { width, lines: out });
  return out;
}

export type SideCell = { no: number; kind: "add" | "del" | "ctx"; text: string; line: DiffLine };
export type SideRow =
  | { kind: "hunk"; text: string }
  | { kind: "row"; left: SideCell | null; right: SideCell | null };

// GitHub-style pairing: a run of deletions lines up with the run of additions
// that immediately follows it, row by row; whichever run is longer spills
// into rows with an empty other side. Context lines sit on both sides.
export function sideBySideRows(fd: FileDiff): SideRow[] {
  const rows: SideRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let dels: SideCell[] = [];
  let adds: SideCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ kind: "row", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const l of fd.lines) {
    // "\ No newline at end of file" is a marker about the line above, not a
    // line of its own; counting it would split a pair and shift the numbers.
    if (l.kind === "meta" || l.text.startsWith("\\")) continue;
    if (l.kind === "hunk") {
      flush();
      const m = HUNK_HEADER.exec(l.text);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      rows.push({ kind: "hunk", text: l.text });
      continue;
    }
    const text = l.text.slice(1);
    if (l.kind === "del") {
      if (adds.length > 0) flush();
      dels.push({ no: oldNo++, kind: "del", text, line: l });
    } else if (l.kind === "add") {
      adds.push({ no: newNo++, kind: "add", text, line: l });
    } else {
      flush();
      rows.push({
        kind: "row",
        left: { no: oldNo++, kind: "ctx", text, line: l },
        right: { no: newNo++, kind: "ctx", text, line: l },
      });
    }
  }
  flush();
  return rows;
}

const COLUMN_SEP = " │ ";

function renderGutter(cell: SideCell, numWidth: number): string {
  return `${dim(String(cell.no).padStart(numWidth))} ${signTag(cell.kind)}`;
}

const sideCache = new WeakMap<FileDiff, { width: number; lines: string[] }>();

// Two equal columns, each `no sign text`, joined by COLUMN_SEP; an odd
// leftover column pads the row end. Each side is tinted by its own change
// kind, and an empty side stays blank.
export function renderSideBySide(fd: FileDiff, width: number): string[] {
  const cached = sideCache.get(fd);
  if (cached && cached.width === width) return cached.lines;
  const out = [fileHeader(fd)];
  const rows = sideBySideRows(fd);
  const toks = fileTokens(fd);
  const maxNo = rows.reduce((m, r) => (r.kind === "row" ? Math.max(m, r.left?.no ?? 0, r.right?.no ?? 0) : m), 0);
  const numWidth = Math.max(3, String(maxNo).length);
  const body = width - COLUMN_SEP.length - 2 * (numWidth + 2);
  const colWidth = Math.max(1, Math.floor(body / 2));
  const tail = " ".repeat(Math.max(0, body - 2 * colWidth));
  const blank = " ".repeat(numWidth + 2 + colWidth);
  const cell = (c: SideCell) => {
    const code = renderToks(toks.get(c.line) ?? [plainTok(c.text)], colWidth);
    return tint(c.kind, `${renderGutter(c, numWidth)}${code}`);
  };
  for (const r of rows) {
    if (r.kind === "hunk") {
      out.push(`{cyan-fg}${renderToks([plainTok(r.text)], width)}{/cyan-fg}`);
      continue;
    }
    const left = r.left ? cell(r.left) : blank;
    const right = r.right ? cell(r.right) : blank;
    out.push(`${left}${COLUMN_SEP}${right}${tail}`);
  }
  if (fd.status === "binary") out.push("{grey-fg}binary file, no text diff{/grey-fg}");
  sideCache.set(fd, { width, lines: out });
  return out;
}
