// src/review-diff.ts
// Pure parser for `gh pr diff` output (git unified diff format). No fs, no
// subprocess: raw text in, per-file structures out, so tests stay hermetic.
import blessed from "neo-blessed";
import { DEFAULT_THEME, highlight as cliHighlight } from "cli-highlight";
import "./review-diff-langs.ts";

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

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash", json: "json", md: "markdown",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
  css: "css", scss: "scss", html: "xml", xml: "xml", vue: "xml", php: "php",
  graphql: "graphql", gql: "graphql", tf: "terraform", tfvars: "terraform", hcl: "terraform",
};

export function languageFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return null;
  return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? null;
}

// The theme wraps highlight.js tokens in sentinel markers (SOH name STX ...
// SOH /name STX) rather than blessed tags directly: the highlighted string
// still has to pass through escapeTags, which would mangle literal tag
// braces. The sentinels survive escaping and become {name-fg} tags after.
// Blessed's own SGR input parser mishandles bright colors, so tags (which
// the rest of the TUI already uses) are also the safer color channel.
const MARK_OPEN = String.fromCharCode(1);
const MARK_CLOSE = String.fromCharCode(2);
const tokenColor = (name: string) => (s: string) =>
  `${MARK_OPEN}${name}${MARK_CLOSE}${s}${MARK_OPEN}/${name}${MARK_CLOSE}`;
const plainToken = (s: string) => s;
// cli-highlight resolves each token as theme[token] || DEFAULT_THEME[token],
// so any token missing here falls through to its chalk-based default and
// leaks raw ANSI into the pane. Seed every DEFAULT_THEME key as plain first
// so the fallback can never fire, then color the tokens we care about.
const HL_THEME: Record<string, (s: string) => string> = {
  ...Object.fromEntries(Object.keys(DEFAULT_THEME).map((k) => [k, plainToken])),
  keyword: tokenColor("magenta"),
  literal: tokenColor("magenta"),
  built_in: tokenColor("cyan"),
  type: tokenColor("cyan"),
  attr: tokenColor("cyan"),
  attribute: tokenColor("cyan"),
  tag: tokenColor("cyan"),
  link: tokenColor("cyan"),
  number: tokenColor("yellow"),
  symbol: tokenColor("yellow"),
  bullet: tokenColor("yellow"),
  string: tokenColor("green"),
  addition: tokenColor("green"),
  regexp: tokenColor("red"),
  deletion: tokenColor("red"),
  comment: tokenColor("grey"),
  meta: tokenColor("grey"),
  doctag: tokenColor("grey"),
  title: tokenColor("blue"),
  section: tokenColor("blue"),
  name: tokenColor("blue"),
  class: tokenColor("blue"),
  function: tokenColor("blue"),
};
const MARK_RE = new RegExp(`${MARK_OPEN}(/?)([a-z]+)${MARK_CLOSE}`, "g");

// Diff lines are highlighted one at a time, so hljs has no cross-line state:
// the continuation lines of a multi-line string or comment can tokenize as
// plain code. An accepted tradeoff of line-based diff highlighting.
// Returns null when highlight.js rejects the input, so the caller can fall
// back to the same whole-line coloring unrecognized files get.
function highlightCode(code: string, language: string): string | null {
  try {
    const marked = cliHighlight(code, { language, ignoreIllegals: true, theme: HL_THEME });
    return escapeTags(marked).replace(MARK_RE, (_m, slash, name) => `{${slash}${name}-fg}`);
  } catch {
    return null;
  }
}

const kindWrap = (kind: DiffLineKind, esc: string): string => {
  if (kind === "add") return `{green-fg}${esc}{/green-fg}`;
  if (kind === "del") return `{red-fg}${esc}{/red-fg}`;
  return esc;
};

const diffSign = (kind: DiffLineKind): string => {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
};

const signTag = (kind: DiffLineKind): string => kindWrap(kind, diffSign(kind));

const highlightBody = (code: string, lang: string | null): string | null =>
  lang === null || code === "" ? null : highlightCode(code, lang);

// renderFileDiff runs on every paint while highlighting is comparatively
// expensive, so rendered lines are memoized per FileDiff (parse results are
// never mutated after creation).
const renderCache = new WeakMap<FileDiff, string[]>();

export function renderFileDiff(fd: FileDiff): string[] {
  const cached = renderCache.get(fd);
  if (cached) return cached;
  const name = fd.status === "renamed" ? `${escapeTags(fd.oldPath)} -> ${escapeTags(fd.path)}` : escapeTags(fd.path);
  const out = [`{bold}${name}{/bold}  {green-fg}+${fd.additions}{/green-fg} {red-fg}-${fd.deletions}{/red-fg}`];
  const lang = fd.status === "binary" ? null : languageFor(fd.path);
  for (const l of fd.lines) {
    if (l.kind === "meta") continue;
    if (l.kind === "hunk") {
      out.push(`{cyan-fg}${escapeTags(l.text)}{/cyan-fg}`);
      continue;
    }
    const hl = highlightBody(l.text.slice(1), lang);
    out.push(hl === null ? kindWrap(l.kind, escapeTags(l.text)) : `${signTag(l.kind)}${hl}`);
  }
  if (fd.status === "binary") out.push("{grey-fg}binary file, no text diff{/grey-fg}");
  renderCache.set(fd, out);
  return out;
}

export type SideCell = { no: number; kind: "add" | "del" | "ctx"; text: string };
export type SideRow =
  | { kind: "hunk"; text: string }
  | { kind: "row"; left: SideCell | null; right: SideCell | null };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
      dels.push({ no: oldNo++, kind: "del", text });
    } else if (l.kind === "add") {
      adds.push({ no: newNo++, kind: "add", text });
    } else {
      flush();
      rows.push({
        kind: "row",
        left: { no: oldNo++, kind: "ctx", text },
        right: { no: newNo++, kind: "ctx", text },
      });
    }
  }
  flush();
  return rows;
}

const COLUMN_SEP = " │ ";
const TAB = "    ";
const ASCII_ONLY = /^[\x20-\x7e]*$/;

// Truncate and pad to display columns: under fullUnicode a CJK character is
// two cells and a combining mark zero, so String.length would misalign the
// separator. ASCII lines take the cheap path.
function fitCell(text: string, width: number): string {
  const clean = text.replace(/\r$/, "").replaceAll("\t", TAB);
  if (ASCII_ONLY.test(clean)) return clean.slice(0, width).padEnd(width);
  let out = "";
  let cols = 0;
  for (const ch of clean) {
    const w = blessed.unicode.strWidth(ch);
    if (cols + w > width) break;
    out += ch;
    cols += w;
  }
  return out + " ".repeat(width - cols);
}

const cellKindColor = (kind: SideCell["kind"]): string | null => {
  if (kind === "add") return "green";
  if (kind === "del") return "red";
  return null;
};

function renderGutter(cell: SideCell, numWidth: number): string {
  const no = `${String(cell.no).padStart(numWidth)} ${diffSign(cell.kind)}`;
  const color = cellKindColor(cell.kind);
  return color === null ? no : `{${color}-fg}${no}{/${color}-fg}`;
}

// One rendered width per file: paint asks for the current pane width on
// every call, and a terminal drag would otherwise pile up a copy per column.
const sideCache = new WeakMap<FileDiff, { width: number; lines: string[] }>();

// Two equal columns, each `no sign text`, joined by COLUMN_SEP; an odd
// leftover column pads the row end. Truncation and padding run on the raw
// text before highlighting: the escapes and tags added afterwards do not
// change the visible width, so the columns stay put. A context row is
// highlighted once and the body shared between its two sides.
export function renderSideBySide(fd: FileDiff, width: number): string[] {
  const cached = sideCache.get(fd);
  if (cached && cached.width === width) return cached.lines;
  const name = fd.status === "renamed" ? `${escapeTags(fd.oldPath)} -> ${escapeTags(fd.path)}` : escapeTags(fd.path);
  const out = [`{bold}${name}{/bold}  {green-fg}+${fd.additions}{/green-fg} {red-fg}-${fd.deletions}{/red-fg}`];
  const rows = sideBySideRows(fd);
  const maxNo = rows.reduce((m, r) => (r.kind === "row" ? Math.max(m, r.left?.no ?? 0, r.right?.no ?? 0) : m), 0);
  const numWidth = Math.max(3, String(maxNo).length);
  const body = width - COLUMN_SEP.length - 2 * (numWidth + 2);
  const colWidth = Math.max(1, Math.floor(body / 2));
  const tail = " ".repeat(Math.max(0, body - 2 * colWidth));
  const blank = " ".repeat(numWidth + 2 + colWidth);
  const lang = fd.status === "binary" ? null : languageFor(fd.path);
  const cellBody = (cell: SideCell) => {
    const fitted = fitCell(cell.text, colWidth);
    return highlightBody(fitted, lang) ?? kindWrap(cell.kind, escapeTags(fitted));
  };
  for (const r of rows) {
    if (r.kind === "hunk") {
      out.push(`{cyan-fg}${escapeTags(fitCell(r.text, width))}{/cyan-fg}`);
      continue;
    }
    const leftBody = r.left ? cellBody(r.left) : null;
    const sameText = r.left !== null && r.right !== null && r.left.kind === "ctx" && r.right.kind === "ctx";
    const rightBody = sameText ? leftBody : r.right ? cellBody(r.right) : null;
    const left = r.left && leftBody !== null ? `${renderGutter(r.left, numWidth)}${leftBody}` : blank;
    const right = r.right && rightBody !== null ? `${renderGutter(r.right, numWidth)}${rightBody}` : blank;
    out.push(`${left}${COLUMN_SEP}${right}${tail}`);
  }
  if (fd.status === "binary") out.push("{grey-fg}binary file, no text diff{/grey-fg}");
  sideCache.set(fd, { width, lines: out });
  return out;
}
