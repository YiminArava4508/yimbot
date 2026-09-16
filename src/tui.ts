// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import { basename } from "node:path";
import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";
import { envOr } from "./env.ts";
import { AWAITING_SLICES_STATUS, TRACKING_STATUS, bus, filterToLiveRows, isFlagged, readEvents, reduceRows, type BoardRow, type YimbotEvent } from "./events.ts";
import { QUEUE_PANE_WIDTH, queueRows, readQueueState } from "./heavy-queue.ts";
import type { Mode } from "./mode.ts";
import { unreachable, type Service } from "./reach.ts";
import { makeOrderFetcher, type OrderEntry, type OrderSourceDeps } from "./review-order.ts";
import { openReview, type ReviewDeps } from "./tui-review.ts";
import { configFromEnv } from "./settings-model.ts";
import { openSettings, type SettingsDeps } from "./tui-settings.ts";

// How often the board repaints on its own, independent of daemon events. Without
// it the TUI freezes on its last paint between events: time-based row pruning
// never advances, and after the machine sleeps the whole board stays stale until
// the next event fires (which can be a full heartbeat away). A wall-clock timer
// also catches up on wake, so the board refreshes within seconds of resuming.
function refreshMs(): number {
  const n = Number(envOr("TUI_REFRESH_MS", "5000"));
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export function returnKey(): string {
  return envOr("TUI_RETURN_KEY", "Y");
}

// blessed cannot parse tmux's terminfo entry on this ncurses generation and
// silently falls back to 8 colors, which flattens the review diff's 256-color
// line tints to black and grey comments to invisible. For a TERM that itself
// claims 256 colors, the xterm-256color entry parses fine and is what tmux
// emulates anyway, so borrow it; a bare "tmux" means the outer terminal was
// not judged 256-capable, so it, like every other TERM, is left alone.
export function screenTerm(term: string | undefined): string | undefined {
  if (term === undefined) return undefined;
  const multiplexer = term.startsWith("tmux") || term.startsWith("screen");
  if (multiplexer && term.includes("256color")) return "xterm-256color";
  return undefined;
}

// A lean legend: the full keybind list lives under ?, the footer only names
// help, quit, and r/R. Both act on any pane -- placement is label-driven now,
// so the row that most needs r (green, unlabeled, therefore in tasks) is
// exactly the one a pane-gated r could not reach.
export function footerHint(_pane: Pane): string {
  return "r ready   R review   ? help   q quit";
}

// The help overlay's body: every keybind, one per line, aligned.
export function helpLines(key: string): string[] {
  const binds: [string, string][] = [
    ["j/k", "move selection"],
    ["^j/^k", "switch pane (tab cycles)"],
    ["enter", "open the row's tmux session"],
    ["f", "flag/unflag the selected row"],
    ["r", "queue the selected row's PR to merge (also inside R)"],
    ["R", "review the selected row's PR"],
    ["m", "toggle supervised/autonomous"],
    ["s", "settings"],
    [`prefix+${key}`, "return here from a session"],
    ["?", "toggle this help"],
    ["q", "quit"],
  ];
  const pad = Math.max(...binds.map(([k]) => k.length));
  return binds.map(([k, desc]) => `{bold}${k.padEnd(pad)}{/bold}  ${desc}`);
}

// ? opens the help overlay, gated like s: a second ? while any overlay is
// open would stack widgets.
export function bindHelpKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  open: () => void,
): void {
  screen.key(["?"], () => {
    if (!isOverlayOpen()) open();
  });
}

// A split parent's row: it has no work of its own, only slices to wait on.
// A parent whose status is a hold (needs decision, review findings) is not
// one of these; it owes a human an answer and stays with the tasks.
const PARENT_STATUSES = new Set([TRACKING_STATUS, AWAITING_SLICES_STATUS]);

export function isParentRow(row: Pick<BoardRow, "status">): boolean {
  return PARENT_STATUSES.has(row.status);
}

// Placement reads the row's section, never its status. The daemon reports the
// section each heartbeat from the facts that actually decide it (the ready
// label, the draft flag), so a queued PR stays in the merge pane while its
// status walks through a CI fix, a conflict fix or a review round -- the status
// column is where that shows. A row only moves when the label does. The one
// exception is the split parents: the daemon only ever gives that status to a
// split's tracking ticket, and it outranks whatever section the key's own PR
// left behind before the split, so they leave the work panes for their own.
export function partitionRows(rows: BoardRow[]): Record<Pane, BoardRow[]> {
  const review: BoardRow[] = [];
  const merge: BoardRow[] = [];
  const tasks: BoardRow[] = [];
  const parents: BoardRow[] = [];
  for (const r of rows) {
    if (isParentRow(r)) parents.push(r);
    else if (r.section === "review") review.push(r);
    else if (r.section === "merge") merge.push(r);
    else tasks.push(r);
  }
  return { review, merge, tasks, parents };
}

export type ReviewEntry = { row: BoardRow; reason: string };

// Sort the review rows by the fetched order, reasons attached. A null order
// (still fetching) and any row the order missed keep board order with a "…"
// placeholder, so the section is usable before the AI order lands.
export function applyOrder(review: BoardRow[], order: OrderEntry[] | null): ReviewEntry[] {
  const reasonByPr = new Map((order ?? []).map((e) => [e.pr, e.reason]));
  const rank = new Map((order ?? []).map((e, i) => [e.pr, i]));
  const ordered: ReviewEntry[] = [];
  const unranked: ReviewEntry[] = [];
  for (const row of review) {
    const r = row.pr != null ? rank.get(row.pr) : undefined;
    const entry = { row, reason: row.pr != null ? (reasonByPr.get(row.pr) ?? "…") : "…" };
    if (r !== undefined) ordered.push(entry);
    else unranked.push(entry);
  }
  ordered.sort((a, b) => rank.get(a.row.pr!)! - rank.get(b.row.pr!)!);
  return [...ordered, ...unranked];
}

// The board's geometry: three full-width bordered panes stacked top to
// bottom -- tasks, ready to review, ready to merge. Each keeps an equal third
// of the body (tasks takes the remainder) whether or not it has rows, so the
// panes never jump around as PRs move between them. The floor of 4 keeps one
// data row visible (header + 2 border rows) on a tiny screen.
//
// Below this the board's nine columns no longer fit beside the queue, so the
// queue gives way rather than squeezing the rows it exists to annotate. The
// queue holds the left edge and the board panes inset past it.
//
// The parent tickets box shares the queue's column, stacked under it at the
// queue's width. It takes only what its rows need, capped at half the body so
// the queue keeps the rest, and is gone entirely while empty or whenever the
// queue is: those rows are context, and the board's width is the work's.
const QUEUE_MIN_SCREEN_WIDTH = 80;

// Header row plus the two border rows; a pane needs one more to show a row.
const PANE_CHROME_ROWS = 3;
const PANE_MIN_HEIGHT = PANE_CHROME_ROWS + 1;

export type ParentsBox = { left: number; width: number; bottom: number; height: number };

function parentsBoxHeight(body: number, parentRows: number): number {
  if (parentRows === 0) return 0;
  const cap = Math.min(Math.floor(body / 2), body - PANE_MIN_HEIGHT);
  if (cap < PANE_MIN_HEIGHT) return 0;
  return Math.min(parentRows + PANE_CHROME_ROWS, cap);
}

export function boardLayout(
  screenHeight: number,
  screenWidth: number,
  parentRows = 0,
): {
  tasks: { top: number; left: number; right: number; bottom: number };
  review: { left: number; right: number; bottom: number; height: number };
  merge: { left: number; right: number; bottom: number; height: number };
  parents: ParentsBox | null;
  queue: { top: number; left: number; width: number; bottom: number } | null;
} {
  const footerRows = 1;
  const titleRows = 1;
  const body = screenHeight - titleRows - footerRows;
  const third = Math.max(PANE_MIN_HEIGHT, Math.floor(body / 3));
  const showQueue = screenWidth >= QUEUE_MIN_SCREEN_WIDTH;
  const inset = showQueue ? QUEUE_PANE_WIDTH : 0;
  const parentsHeight = showQueue ? parentsBoxHeight(body, parentRows) : 0;
  return {
    tasks: { top: titleRows, left: inset, right: 0, bottom: footerRows + 2 * third },
    review: { left: inset, right: 0, bottom: footerRows + third, height: third },
    merge: { left: inset, right: 0, bottom: footerRows, height: third },
    parents:
      parentsHeight > 0 ? { left: 0, width: QUEUE_PANE_WIDTH, bottom: footerRows, height: parentsHeight } : null,
    queue: showQueue ? { top: titleRows, left: 0, width: QUEUE_PANE_WIDTH, bottom: footerRows + parentsHeight } : null,
  };
}

export type Pane = "tasks" | "review" | "merge" | "parents";
export type PaneCounts = Record<Pane, number>;

// Top to bottom on screen; the focus keys walk this order.
export const PANE_ORDER: readonly Pane[] = ["tasks", "review", "merge", "parents"];

// Each pane's resting outline; the focused pane takes the focus hue so the
// operator can see where their keys land.
export const PANE_BORDER: Record<Pane, string> = { tasks: "grey", review: "yellow", merge: "green", parents: "grey" };

export function paneBorderColor(pane: Pane, focused: boolean): string {
  return focused ? FOCUS_BORDER : PANE_BORDER[pane];
}

// Outline plus row highlight in one pass. Only the focused pane inverses its
// selected row: keys act on that pane alone, so a second inversed row on an
// unfocused pane reads as a cursor that does nothing. neo-blessed aliases
// style.selected to style.cell.selected on a listtable and resolves it at
// paint time, so mutating it here is enough.
export function applyPaneFocusStyle(
  widgets: Record<Pane, { style: { border: { fg: string }; label: { fg: string }; selected: { inverse: boolean } } }>,
  focused: Pane,
): void {
  for (const p of PANE_ORDER) {
    const fg = paneBorderColor(p, p === focused);
    widgets[p].style.border.fg = fg;
    widgets[p].style.label.fg = fg;
    widgets[p].style.selected.inverse = p === focused;
  }
}

// The pane keypresses should act on. An empty pane can never hold the focus:
// with every row a ready draft the tasks pane can be empty, and without this
// the operator's f/r/R/enter would silently no-op against it.
export function resolvePane(current: Pane, counts: PaneCounts): Pane {
  if (counts[current] > 0) return current;
  for (const p of PANE_ORDER) if (counts[p] > 0) return p;
  return "tasks";
}

// Directional focus down and up the stacked panes, skipping empty ones (an
// empty pane is hidden, so landing on it would focus nothing visible). No
// non-empty pane in that direction stays put.
export function movePane(current: Pane, dir: "up" | "down", counts: PaneCounts): Pane {
  const step = dir === "down" ? 1 : -1;
  for (let i = PANE_ORDER.indexOf(current) + step; i >= 0 && i < PANE_ORDER.length; i += step) {
    if (counts[PANE_ORDER[i]] > 0) return PANE_ORDER[i];
  }
  return current;
}

// Tab's fallback cycle through the panes, skipping empty ones.
export function nextPane(current: Pane, counts: PaneCounts): Pane {
  const i = PANE_ORDER.indexOf(current);
  for (let step = 1; step <= PANE_ORDER.length; step++) {
    const p = PANE_ORDER[(i + step) % PANE_ORDER.length];
    if (counts[p] > 0) return p;
  }
  return current;
}

// Keep focusedPane honest against blessed's own focus: a mouse click on a list
// item calls focus() on that list (neo-blessed list.js), which the key bindings
// alone would not see, leaving keypresses acting on another pane's selection.
export function bindPaneFocusSync(
  widgets: Record<Pane, { on: (ev: string, fn: () => void) => void }>,
  set: (pane: Pane) => void,
): void {
  for (const pane of Object.keys(widgets) as Pane[]) {
    widgets[pane].on("focus", () => set(pane));
  }
}

// The setter for that sync. A click reaches blessed first: list.js focuses the
// clicked list and repaints, but the pane highlight and footer are only fitted
// by render(), so without this the board waits for the refresh timer to catch
// up. The repaint is deferred past blessed's own click handler and dropped if
// the focus moved on before the tick (hidePanesKeepingFocus's rewind).
export function onPaneFocusChange(
  get: () => Pane,
  set: (pane: Pane) => void,
  render: () => void,
  defer: (fn: () => void) => void = (fn) => setImmediate(fn),
): (pane: Pane) => void {
  return (pane) => {
    if (pane === get()) return;
    set(pane);
    defer(() => {
      if (get() === pane) render();
    });
  };
}

// Hiding the focused pane makes blessed rewind focus onto the last visible
// pane in its history (screen.js rewindFocus), which the sync above would
// record as a pane switch; the overlay's close then puts the highlight and the
// keys on that other pane. Hide, then put the pane the operator was on back.
export function hidePanesKeepingFocus(
  widgets: Record<Pane, { hide: () => void }>,
  get: () => Pane,
  set: (pane: Pane) => void,
): void {
  const focused = get();
  for (const pane of Object.keys(widgets) as Pane[]) widgets[pane].hide();
  set(focused);
}

// The row the operator's keypress should act on: each pane keeps its own blessed
// selection (1-based, row 0 is the column header), and the focused pane wins.
export function selectedBoardRow(
  pane: Pane,
  panes: {
    tasks: { rows: BoardRow[]; selected: number };
    review: { entries: ReviewEntry[]; selected: number };
    merge: { rows: BoardRow[]; selected: number };
    parents: { rows: BoardRow[]; selected: number };
  },
): BoardRow | undefined {
  if (pane === "review") return panes.review.entries[panes.review.selected - 1]?.row;
  return panes[pane].rows[panes[pane].selected - 1];
}

// Tab cycles focus through the panes, gated like every other board key: an
// open overlay owns the keyboard.
export function bindPaneToggle(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["tab"], () => {
    if (!isOverlayOpen()) toggle();
  });
}

// Ctrl+J reaches blessed as its control character (0x0a), named "linefeed",
// so that alias is bound alongside the C- name some terminals send instead.
export function bindPaneNavKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  move: (dir: "up" | "down") => void,
): void {
  const bind = (keys: string[], dir: "up" | "down") =>
    screen.key(keys, () => {
      if (!isOverlayOpen()) move(dir);
    });
  bind(["C-j", "linefeed"], "down");
  bind(["C-k"], "up");
}

// The status bar's mode chip. Inverse-video blocks so the operating mode is
// legible at a glance: supervised (human gates flagged PRs) in yellow,
// autonomous (the bot self-resolves everything) in green.
export function modeContent(mode: Mode): string {
  return mode === "supervised"
    ? "{black-fg}{yellow-bg} SUPERVISED {/yellow-bg}{/black-fg}"
    : "{black-fg}{green-bg} AUTONOMOUS {/green-bg}{/black-fg}";
}

// The header row above the tasks pane. The panes below are bordered at column 0
// and the last column, so "yimbot" and the status chips are inset past that
// border plus one column of margin: the header then reads as sitting inside the
// pane below instead of hanging off the screen edges. Exported so the layout
// tests exercise these exact objects, not copies.
export const headerInset = 2;

export function titleLayout(): Record<string, unknown> {
  return { top: 0, left: headerInset };
}

export function statusLayout(): Record<string, unknown> {
  return { top: 0, right: headerInset, tags: true };
}

// height: 1 + wrap: false so a hint too long for the terminal clips instead of
// wrapping. blessed.text defaults to shrink: true, which would otherwise grow
// the element upward from bottom: 0 into the table's last row (bottom: 1).
// Exported so the layout test below exercises this exact object, not a copy.
export function footerLayout(): Record<string, unknown> {
  return {
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    wrap: false,
    // The initial focused pane; render() re-fits the legend to the pane.
    content: footerHint("tasks"),
    style: { fg: "white" },
  };
}

// A transient acknowledgment in the status bar. The ready keypress used to be
// silent: success only mattered if the row's status string changed (emitStatus
// dedupes), and failure went to console.error, which a blessed screen swallows.
// The notice is the immediate, unconditional feedback channel for it.
export type Notice = { text: string; until: number };

export const NOTICE_TTL_MS = 5_000;
export const NOTICE_ERROR_TTL_MS = 15_000;

// The only thing the board says about the outside services: a red name per
// service that is currently failing, nothing at all while they all answer.
// Absence is the healthy state, so a quiet status bar means a quiet network.
export function reachWarnings(down: Service[]): string {
  return down.map((s) => `{red-fg}⚠ ${s}{/red-fg} `).join("");
}

export function statusContent(
  mode: Mode,
  refineOn: boolean,
  active: number,
  notice: Notice | null,
  now: number,
  down: Service[],
): string {
  const refineChip = refineOn
    ? "{black-fg}{green-bg} REFINE ON {/green-bg}{/black-fg} "
    : "{black-fg}{red-bg} REFINE OFF {/red-bg}{/black-fg} ";
  const base = `${reachWarnings(down)}${refineChip}${modeContent(mode)} live | ${active} active`;
  return notice && now < notice.until ? `${base} | ${notice.text}` : base;
}

export async function handleReadyPress(
  row: BoardRow | undefined,
  addReady: (pr: number, key: string, label: string, repo?: string) => Promise<void>,
  setNotice: (text: string, ttlMs: number) => void,
): Promise<void> {
  if (!row) return;
  if (row.pr == null) {
    setNotice("{red-fg}selected row has no PR to queue{/red-fg}", NOTICE_ERROR_TTL_MS);
    return;
  }
  setNotice(`queueing #${row.pr} to merge…`, NOTICE_TTL_MS);
  try {
    await addReady(row.pr, row.key, row.label, row.repo);
    setNotice(`{green-fg}#${row.pr} ready to merge{/green-fg}`, NOTICE_TTL_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setNotice(`{red-fg}queueing #${row.pr} failed: ${msg}{/red-fg}`, NOTICE_ERROR_TTL_MS);
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

// One header for all three panes, in one order, so a row reads the same
// wherever it sits.
export const BOARD_HEADER = ["TIME", "DUR", "STATUS", "TICKET", "PR", "REPO", "TITLE", "FLAG", "REASON"];

// What the REPO column reads: nothing until the row has a PR, the codebase
// checkout's directory name for a codebase-repo PR, the name half of the
// owner/name slug for an extra-repo PR.
export function repoDisplayName(row: Pick<BoardRow, "pr" | "repo">, codebaseName: string): string {
  if (row.pr == null) return "";
  if (!row.repo) return codebaseName;
  return row.repo.split("/").pop() ?? row.repo;
}

function codebaseRepoName(): string {
  return basename(configFromEnv(process.env).codebasePath);
}

export type BoardEntry = { row: BoardRow };

export function boardTable(
  entries: BoardEntry[],
  now: number = Date.now(),
  codebaseName: string = codebaseRepoName(),
): string[][] {
  const body = entries.map(({ row: r }) => {
    const durMs = r.terminal ? r.ts - r.startTs : now - r.startTs;
    return [
      fmtTime(r.ts),
      fmtDuration(durMs),
      r.terminal ? `{grey-fg}${r.status}{/grey-fg}` : r.status,
      r.label,
      r.pr != null ? `#${r.pr}` : "",
      repoDisplayName(r, codebaseName),
      r.title ?? "",
      isFlagged(r) ? "{red-fg}⚑{/red-fg}" : "",
      r.flagReasons.length > 0 ? `{red-fg}${r.flagReasons.join(",")}{/red-fg}` : "",
    ];
  });
  return [BOARD_HEADER, ...body];
}

// The parent tickets box is the queue's width, far too narrow for the board's
// nine columns, so each parent gets one line: the ticket, then whatever of the
// title fits in grey. The status is implied by the box.
export function parentRows(rows: BoardRow[]): string[][] {
  const room = QUEUE_PANE_WIDTH - 2;
  const body = rows.map((r) => {
    const label = fitCell(r.label, room);
    const titleRoom = room - cellWidth(label) - 1;
    const title = r.title ? fitCell(r.title, titleRoom) : "";
    return [title ? `${label} {grey-fg}${title}{/grey-fg}` : label];
  });
  return [["PARENTS"], ...body];
}

function fitCell(text: string, room: number): string {
  if (room <= 0) return "";
  if (cellWidth(text) <= room) return text;
  let out = "";
  for (const ch of text) {
    if (cellWidth(out + ch) > room - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// A cell's on-screen width, measured through blessed's own helpers rather than
// reimplemented: Element.strWidth strips tags and then, under fullUnicode,
// counts display columns (a CJK title is two per character, a combining mark
// zero). Padding by String.length instead would size a non-ASCII title wrong
// and knock that pane's columns off the shared grid.
export function cellWidth(cell: string): number {
  return blessed.unicode.strWidth(blessed.helpers.stripTags(cell));
}

// blessed sizes each table's columns from that table's own rows, so three panes
// sharing a header still land on three different grids. Pad every cell out to
// the widest cell in its column across ALL the tables and each pane computes the
// same maxes, which is what puts the columns on the same offsets. An empty pane
// still has its header row, so it lines up too.
export function alignTables(tables: string[][][]): string[][][] {
  const widths: number[] = [];
  for (const table of tables) {
    for (const row of table) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell));
      });
    }
  }
  return tables.map((table) =>
    table.map((row) => row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - cellWidth(cell)))),
  );
}

// screen.key's handler runs before the focused widget's own keypress handling
// (see neo-blessed's screen.js _listenKeys: it emits on the screen first, then
// on screen.focused). While any overlay (settings or review) is open, the
// overlay's own widgets own q/escape (e.g. list.js maps them to
// cancelSelected, which drives the settings panel's unsaved-changes
// double-escape prompt), so the board must not act on them here. C-c stays a
// hard quit except while the review overlay's claude pane is focused: there
// it is claude's own interrupt, and because the screen handler fires first it
// must stand down for the sequence to reach the pane's keypress forwarding.
export function bindQuitKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  isClaudeFocused: () => boolean,
  quit: () => void,
): void {
  screen.key(["q", "escape"], () => {
    if (!isOverlayOpen()) quit();
  });
  screen.key(["C-c"], () => {
    if (!isClaudeFocused()) quit();
  });
}

// Gated the same way as bindQuitKeys: without this, a second s while any
// overlay (settings or review) is already open attaches a second list/footer
// pair on top of the first (openSettings has no idea it is already open), and
// the first pair is then permanently unreachable since only the overlay that
// receives the close ever detaches its own widgets.
export function bindSettingsKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  openPanel: () => void,
): void {
  screen.key(["s"], () => {
    if (!isOverlayOpen()) openPanel();
  });
}

// Gated the same way as bindQuitKeys/bindSettingsKey: while any overlay
// (settings or review) has focus, grabKeys is false, so without this gate f
// would still reach the screen-level handler and flag/unflag the hidden
// board's selected row out from under the operator.
export function bindFlagKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["f"], () => {
    if (!isOverlayOpen()) toggle();
  });
}

// r manually adds the ready label to the selected row's PR, gated like f. The
// operator's escape hatch for a PR that is ready but unlabeled (e.g. the ready
// step latched it after a removal, or the daemon is supervised): the write is
// unconditional on readiness because the human is the judge here.
export function bindReadyKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  addReady: () => void,
): void {
  screen.key(["r"], () => {
    if (!isOverlayOpen()) addReady();
  });
}

// m toggles the operating mode, gated like f: while any overlay (settings or
// review) is open the board is hidden, so mutating global state under it
// would surprise.
export function bindModeKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["m"], () => {
    if (!isOverlayOpen()) toggle();
  });
}

// R (shift-r) opens the review overlay for the selected row's PR,
// gated like s: a second R while any overlay is open would stack widgets.
export function bindReviewKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  open: () => void,
): void {
  screen.key(["S-r"], () => {
    if (!isOverlayOpen()) open();
  });
}

export function runTui(opts: {
  onQuit: () => void;
  liveKeys: () => Set<string>;
  // Keys of the instance's open PRs: a PR-backed row stays on the board while
  // its PR is open even with no worktree behind it. See filterToLiveRows.
  openPrKeys: () => Set<string>;
  // Keys of worktrees whose tmux session is still live: their merged rows
  // render as "working (manual)" instead of aging off the board.
  manualLiveKeys: () => Set<string>;
  // Merged split slices whose worktree cleanup holds for the group; their rows
  // read "merged, waiting on slices" and stay on the merge pane.
  heldSliceKeys: () => Set<string>;
  // Merged worktrees the cleanup step is holding for the ticket's other PRs or
  // its Linear state; their rows read "merged, waiting on ticket".
  heldMergedKeys: () => Set<string>;
  onToggleFlag: (key: string, label: string, flagged: boolean) => void;
  onOpenSession: (key: string, label: string) => void;
  onAddReadyLabel: (pr: number, key: string, label: string, repo?: string) => Promise<void>;
  mode: () => Mode;
  onToggleMode: () => Mode;
  refineEnabled: () => boolean;
  settings: SettingsDeps;
  reviewDeps: (pr: number, key: string, label: string, repo?: string) => ReviewDeps;
  // Feeds the ready-to-review pane's AI ordering: per-PR meta reads and the
  // headless prompt runner (same claude -p shape as the review grouping).
  orderDeps: OrderSourceDeps;
}): void {
  const term = screenTerm(process.env.TERM);
  const screen = blessed.screen({ smartCSR: true, title: "yimbot", fullUnicode: true, ...(term ? { term } : {}) });

  const makePane = (pane: Pane, position: Record<string, unknown>) =>
    blessed.listtable({
      parent: screen,
      ...position,
      tags: true,
      align: "left",
      keys: true,
      vi: true,
      mouse: true,
      border: { type: "line" },
      // A bordered listtable defaults to drawing cell borders between every
      // column, which turns the pane into a full grid; keep the flat look.
      noCellBorders: true,
      style: {
        header: { bold: true },
        cell: { selected: { inverse: true } },
        border: { fg: PANE_BORDER[pane] },
        label: { fg: PANE_BORDER[pane] },
      },
    });
  // Positions are re-fit by render() from boardLayout on every repaint.
  const tasksPane = makePane("tasks", { top: 1, left: 0, right: 0, bottom: 1 });
  const reviewPane = makePane("review", { left: 0, right: 0, bottom: 1, height: 4, hidden: true });
  const mergePane = makePane("merge", { left: 0, right: 0, bottom: 1, height: 4, hidden: true });
  const parentsPane = makePane("parents", { left: 0, width: QUEUE_PANE_WIDTH, bottom: 1, height: 4, hidden: true });
  const paneWidgets: Record<Pane, any> = { tasks: tasksPane, review: reviewPane, merge: mergePane, parents: parentsPane };
  tasksPane.focus();

  // Never focused, never in the pane rotation. Reading the queue reaps stale
  // tickets, so this pane is a writer and not an observer. Inspection and
  // force-release live in `pnpm heavy status`.
  const queuePane = blessed.listtable({
    parent: screen,
    top: 1,
    left: 0,
    width: QUEUE_PANE_WIDTH,
    bottom: 1,
    tags: true,
    align: "left",
    border: { type: "line" },
    noCellBorders: true,
    style: { header: { bold: true }, border: { fg: "grey" }, label: { fg: "grey" } },
  });

  const title = blessed.text({ parent: screen, ...titleLayout(), content: "yimbot" });
  const status = blessed.text({ parent: screen, ...statusLayout(), content: "live" });
  const footer = blessed.text({ parent: screen, ...footerLayout() });

  let currentRows: BoardRow[] = [];
  let currentTasks: BoardRow[] = [];
  let currentMerge: BoardRow[] = [];
  let currentParents: BoardRow[] = [];
  let currentReview: ReviewEntry[] = [];
  let focusedPane: Pane = "tasks";
  // Set when a settings apply's rollback restart also failed, so the daemon
  // is confirmed down. The panel itself closes on esc/w regardless of draft
  // state, so this has to outlive it to keep showing on the board.
  let daemonStopped = false;
  let notice: Notice | null = null;
  const paneCounts = (): PaneCounts => ({
    tasks: currentTasks.length,
    review: currentReview.length,
    merge: currentMerge.length,
    parents: currentParents.length,
  });
  const render = () => {
    currentRows = filterToLiveRows(
      reduceRows(readEvents(), Date.now(), {
        manualLiveKeys: opts.manualLiveKeys(),
        heldSliceKeys: opts.heldSliceKeys(),
        heldMergedKeys: opts.heldMergedKeys(),
      }),
      opts.liveKeys(),
      opts.openPrKeys(),
    );
    const split = partitionRows(currentRows);
    const layout = boardLayout(Number(screen.rows) || 24, Number(screen.cols) || 80, split.parents.length);
    // No room for the box (narrow screen, short screen): the parents go back
    // to the tasks pane rather than off the board.
    const parents = layout.parents ? split.parents : [];
    const tasks = layout.parents ? split.tasks : [...split.tasks, ...split.parents];
    const { review, merge } = split;
    const withPr = review.filter((r): r is BoardRow & { pr: number } => r.pr != null);
    orderFetcher.ensure(
      withPr.map((r) => r.pr),
      new Map(withPr.flatMap((r) => (r.repo ? [[r.pr, r.repo] as const] : []))),
    );
    currentReview = applyOrder(review, orderFetcher.get());
    currentTasks = tasks;
    currentMerge = merge;
    currentParents = parents;
    const now = Date.now();
    const [tasksData, reviewData, mergeData] = alignTables([
      boardTable(tasks.map((row) => ({ row })), now),
      boardTable(currentReview.map((e) => ({ row: e.row })), now),
      boardTable(merge.map((row) => ({ row })), now),
    ]);
    tasksPane.bottom = layout.tasks.bottom;
    tasksPane.setLabel(` tasks (${tasks.length}) `);
    tasksPane.setData(tasksData);
    reviewPane.height = layout.review.height;
    reviewPane.bottom = layout.review.bottom;
    reviewPane.setLabel(` ready to review (${currentReview.length}) `);
    reviewPane.setData(reviewData);
    mergePane.height = layout.merge.height;
    mergePane.bottom = layout.merge.bottom;
    mergePane.setLabel(` ready to merge (${merge.length}) `);
    mergePane.setData(mergeData);
    if (layout.parents) {
      parentsPane.height = layout.parents.height;
      parentsPane.setLabel(` parent tickets (${parents.length}) `);
      parentsPane.setData(parentRows(parents));
    }
    tasksPane.left = layout.tasks.left;
    reviewPane.left = layout.review.left;
    mergePane.left = layout.merge.left;
    // Skip the read while an overlay hides the pane: it reaps tickets, so
    // polling it here would write state nobody can see.
    if (layout.queue && !isOverlayOpen()) {
      queuePane.bottom = layout.queue.bottom;
      queuePane.setData(queueRows(readQueueState()));
      queuePane.show();
    } else {
      queuePane.hide();
    }
    // While an overlay is open every pane stays hidden (the overlay owns
    // the screen); the close callback re-renders, which shows them again.
    // The parents box has no reserved space, so no rows means hidden. Hiding
    // it while focused makes blessed rewind focus onto a history pane, which
    // the focus sync would record; keep the operator's pane so resolvePane
    // below picks the fallback deterministically instead.
    if (!isOverlayOpen()) {
      reviewPane.show();
      mergePane.show();
      if (layout.parents) {
        parentsPane.show();
      } else {
        const keep = focusedPane;
        parentsPane.hide();
        focusedPane = keep;
      }
    }
    const pane = resolvePane(focusedPane, paneCounts());
    if (pane !== focusedPane) {
      focusedPane = pane;
      if (!isOverlayOpen()) focusedWidget().focus();
    }
    applyPaneFocusStyle(paneWidgets, focusedPane);
    footer.setContent(footerHint(focusedPane));
    const active = currentRows.filter((r) => !r.terminal).length;
    status.setContent(
      daemonStopped
        ? "daemon stopped"
        : statusContent(opts.mode(), opts.refineEnabled(), active, notice, Date.now(), unreachable()),
    );
    screen.render();
  };
  const setNotice = (text: string, ttlMs: number) => {
    notice = { text, until: Date.now() + ttlMs };
    render();
  };
  const orderFetcher = makeOrderFetcher({ ...opts.orderDeps, onUpdate: () => render() });
  const selRow = () =>
    selectedBoardRow(focusedPane, {
      tasks: { rows: currentTasks, selected: tasksPane.selected },
      review: { entries: currentReview, selected: reviewPane.selected },
      merge: { rows: currentMerge, selected: mergePane.selected },
      parents: { rows: currentParents, selected: parentsPane.selected },
    });
  const focusedWidget = () => paneWidgets[focusedPane];
  const focusPane = (p: Pane) => {
    focusedPane = p;
    focusedWidget().focus();
    render();
  };
  bindPaneFocusSync(
    paneWidgets,
    onPaneFocusChange(
      () => focusedPane,
      (p) => {
        focusedPane = p;
      },
      render,
    ),
  );

  const onEvent = (_ev: YimbotEvent) => render();
  bus.on("event", onEvent);
  const refreshTimer = setInterval(render, refreshMs());
  // Reposition the absolutely-placed section immediately on a terminal resize
  // instead of leaving stale rows painted until the next tick.
  screen.on("resize", render);

  const quit = () => {
    clearInterval(refreshTimer);
    bus.off("event", onEvent);
    screen.destroy();
    opts.onQuit();
  };
  let settingsOpen = false;
  let reviewOpen = false;
  let helpOpen = false;
  const isOverlayOpen = () => settingsOpen || reviewOpen || helpOpen;
  // Swapped in by bindReviewKey's open below; openReview's getter reports
  // false once the overlay closes, so no reset is needed here.
  let reviewClaudeFocused: () => boolean = () => false;
  bindQuitKeys(screen, isOverlayOpen, () => reviewClaudeFocused(), quit);

  // The help box floats over the board (panes stay visible under it), owns
  // the keyboard while open, and closes on ?, q or escape.
  bindHelpKey(screen, isOverlayOpen, () => {
    helpOpen = true;
    const lines = helpLines(returnKey());
    const visibleLen = (l: string) => l.replace(/\{[^{}]*\}/g, "").length;
    const box: any = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: Math.max(...lines.map(visibleLen)) + 4,
      height: lines.length + 2,
      tags: true,
      keys: true,
      border: { type: "line" },
      label: " help ",
      content: lines.join("\n"),
    });
    box.focus();
    box.on("keypress", (ch: string, k: { name?: string }) => {
      if (ch !== "?" && k?.name !== "q" && k?.name !== "escape") return;
      helpOpen = false;
      box.detach();
      focusedWidget().focus();
      render();
    });
    screen.render();
  });

  const hidePanes = () => {
    hidePanesKeepingFocus(
      paneWidgets,
      () => focusedPane,
      (p) => {
        focusedPane = p;
      },
    );
    queuePane.hide();
  };
  // The review and merge panes are deliberately not shown here: the render()
  // every caller issues right after restores them only when they have rows.
  const showPanes = () => {
    tasksPane.show();
    focusedWidget().focus();
  };

  bindSettingsKey(screen, isOverlayOpen, () => {
    settingsOpen = true;
    hidePanes();
    openSettings(
      screen,
      opts.settings,
      (stopped) => {
        settingsOpen = false;
        daemonStopped = stopped;
        showPanes();
        render();
      },
      daemonStopped,
    );
  });

  bindFlagKey(screen, isOverlayOpen, () => {
    const r = selRow();
    if (!r) return;
    opts.onToggleFlag(r.key, r.label, isFlagged(r));
  });

  // A parent row's pr, when it has one, is the PR the split closed: the fold
  // carries it forward, but nothing about it is actionable any more.
  const refuseParentRow = (): boolean => {
    if (focusedPane !== "parents") return false;
    setNotice("{red-fg}parent tickets have no PR of their own{/red-fg}", NOTICE_ERROR_TTL_MS);
    return true;
  };

  bindReadyKey(screen, isOverlayOpen, () => {
    if (refuseParentRow()) return;
    void handleReadyPress(selRow(), opts.onAddReadyLabel, setNotice);
  });

  bindModeKey(screen, isOverlayOpen, () => {
    opts.onToggleMode();
    render();
  });

  bindPaneToggle(screen, isOverlayOpen, () => {
    const next = nextPane(focusedPane, paneCounts());
    if (next !== focusedPane) focusPane(next);
  });

  bindPaneNavKeys(screen, isOverlayOpen, (dir) => {
    const next = movePane(focusedPane, dir, paneCounts());
    if (next !== focusedPane) focusPane(next);
  });

  bindReviewKey(screen, isOverlayOpen, () => {
    if (refuseParentRow()) return;
    const r = selRow();
    if (!r) return;
    if (r.pr == null) {
      setNotice("{red-fg}selected row has no PR to review{/red-fg}", NOTICE_ERROR_TTL_MS);
      return;
    }
    reviewOpen = true;
    hidePanes();
    const overlay = openReview(screen, opts.reviewDeps(r.pr, r.key, r.label, r.repo), (noticeMsg, isError) => {
      reviewOpen = false;
      showPanes();
      if (noticeMsg) setNotice(noticeMsg, isError ? NOTICE_ERROR_TTL_MS : NOTICE_TTL_MS);
      else render();
    });
    reviewClaudeFocused = overlay.claudeFocused;
  });

  const openSelectedSession = (r: BoardRow | undefined) => {
    if (!r) return;
    opts.onOpenSession(r.key, r.label);
  };
  tasksPane.on("select", () => openSelectedSession(currentTasks[tasksPane.selected - 1]));
  reviewPane.on("select", () => openSelectedSession(currentReview[reviewPane.selected - 1]?.row));
  mergePane.on("select", () => openSelectedSession(currentMerge[mergePane.selected - 1]));
  parentsPane.on("select", () => openSelectedSession(currentParents[parentsPane.selected - 1]));

  render();
}
