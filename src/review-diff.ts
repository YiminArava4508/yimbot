// src/review-diff.ts
// Pure parser for `gh pr diff` output (git unified diff format). No fs, no
// subprocess: raw text in, per-file structures out, so tests stay hermetic.
import { DEFAULT_THEME, highlight as cliHighlight } from "cli-highlight";

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
    const code = lang === null || l.text === "" ? null : highlightCode(l.text.slice(1), lang);
    if (code === null) {
      const esc = escapeTags(l.text);
      if (l.kind === "add") out.push(`{green-fg}${esc}{/green-fg}`);
      else if (l.kind === "del") out.push(`{red-fg}${esc}{/red-fg}`);
      else out.push(esc);
      continue;
    }
    if (l.kind === "add") out.push(`{green-fg}+{/green-fg}${code}`);
    else if (l.kind === "del") out.push(`{red-fg}-{/red-fg}${code}`);
    else out.push(`${l.text[0]}${code}`);
  }
  if (fd.status === "binary") out.push("{grey-fg}binary file, no text diff{/grey-fg}");
  renderCache.set(fd, out);
  return out;
}
