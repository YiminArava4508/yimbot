// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { envOr } from "./env.ts";
import { bus, filterToLiveWorktrees, isFlagged, readEvents, reduceRows, statusFor, type BoardRow, type YimbotEvent } from "./events.ts";
import type { Mode } from "./mode.ts";
import { makeOrderFetcher, type OrderEntry, type OrderSourceDeps } from "./review-order.ts";
import { openReview, type ReviewDeps } from "./tui-review.ts";
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

// The legend follows the focused pane: r/R act only on the review pane, so
// only its hint advertises them.
export function footerHint(key: string, pane: Pane): string {
  const reviewKeys = pane === "review" ? "r ready   R review   " : "";
  return `j/k move   ^hjkl/tab pane   enter open   f flag/unflag   ${reviewKeys}m mode   s settings   q quit   prefix+${key} returns here`;
}

// A draft_pr event is a supervised draft whose ready verdict held (threads
// resolved, mergeable, CI green): waiting on a human review, so its status is
// the review pane's membership test. ready_to_merge feeds the merge pane the
// same way. Both derived from the STATUS map rather than repeating the display
// strings here.
const REVIEW_STATUS = statusFor("draft_pr")?.status ?? "draft pr";
const MERGE_STATUSES = new Set([
  statusFor("ready_to_merge")?.status ?? "ready to merge",
  statusFor("merged")?.status ?? "merged",
]);

export function partitionRows(rows: BoardRow[]): { review: BoardRow[]; merge: BoardRow[]; tasks: BoardRow[] } {
  const review: BoardRow[] = [];
  const merge: BoardRow[] = [];
  const tasks: BoardRow[] = [];
  for (const r of rows) {
    if (r.status === REVIEW_STATUS) review.push(r);
    else if (MERGE_STATUSES.has(r.status)) merge.push(r);
    else tasks.push(r);
  }
  return { review, merge, tasks };
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

// WAIT is time since the row's last event (when it went ready for review), the
// natural review-priority signal; FLAG/REASON mirror the main board so a draft
// whose session raised a flag stays visible while it sits here.
export function reviewTable(entries: ReviewEntry[], now: number = Date.now()): string[][] {
  const header = ["#", "PR", "TICKET", "TITLE", "WAIT", "FLAG", "REASON", "WHY"];
  const body = entries.map((e, i) => [
    String(i + 1),
    e.row.pr != null ? `#${e.row.pr}` : "",
    e.row.label,
    e.row.title ?? "",
    fmtDuration(now - e.row.ts),
    isFlagged(e.row) ? "{red-fg}⚑{/red-fg}" : "",
    e.row.flagReasons.length > 0 ? `{red-fg}${e.row.flagReasons.join(",")}{/red-fg}` : "",
    e.reason,
  ]);
  return [header, ...body];
}

// WAIT mirrors the review pane: time since the row's last event (went ready
// to merge, or merged). STATUS tells the two apart, merged dimmed the same
// way the tasks pane dims terminal rows.
export function mergeTable(rows: BoardRow[], now: number = Date.now()): string[][] {
  const header = ["PR", "TICKET", "TITLE", "STATUS", "WAIT", "FLAG", "REASON"];
  const body = rows.map((r) => [
    r.pr != null ? `#${r.pr}` : "",
    r.label,
    r.title ?? "",
    r.terminal ? `{grey-fg}${r.status}{/grey-fg}` : r.status,
    fmtDuration(now - r.ts),
    isFlagged(r) ? "{red-fg}⚑{/red-fg}" : "",
    r.flagReasons.length > 0 ? `{red-fg}${r.flagReasons.join(",")}{/red-fg}` : "",
  ]);
  return [header, ...body];
}

// The board's geometry: two bordered columns (tasks left, ready to review
// right) filling the body, and a full-width ready-to-merge pane pinned above
// the footer. The merge pane sizes to its rows (column header + 2 border rows)
// but never past a third of the screen, and disappears entirely when empty so
// the columns get the whole body back.
export function boardLayout(
  mergeCount: number,
  screenHeight: number,
): {
  tasks: { top: number; left: number; width: string; bottom: number };
  review: { top: number; left: string; right: number; bottom: number };
  merge: { left: number; right: number; bottom: number; height: number } | null;
} {
  const footerRows = 1;
  let mergeHeight = 0;
  if (mergeCount > 0) {
    const cap = Math.max(4, Math.floor(screenHeight / 3));
    mergeHeight = Math.min(mergeCount + 3, cap);
  }
  const columnBottom = footerRows + mergeHeight;
  return {
    tasks: { top: 1, left: 0, width: "50%", bottom: columnBottom },
    review: { top: 1, left: "50%", right: 0, bottom: columnBottom },
    merge: mergeCount > 0 ? { left: 0, right: 0, bottom: footerRows, height: mergeHeight } : null,
  };
}

export type Pane = "tasks" | "review" | "merge";
export type PaneCounts = Record<Pane, number>;

// Each pane's resting outline; the focused pane turns white so the operator
// can see where their keys land.
export const PANE_BORDER: Record<Pane, string> = { tasks: "grey", review: "yellow", merge: "green" };

export function paneBorderColor(pane: Pane, focused: boolean): string {
  return focused ? "white" : PANE_BORDER[pane];
}

// The pane keypresses should act on. An empty pane can never hold the focus:
// with every row a ready draft the tasks pane can be empty, and without this
// the operator's f/r/R/enter would silently no-op against it.
export function resolvePane(current: Pane, counts: PaneCounts): Pane {
  if (counts[current] > 0) return current;
  for (const p of ["tasks", "review", "merge"] as const) if (counts[p] > 0) return p;
  return "tasks";
}

// r (ready label) and R (guided review) only make sense on a PR that is
// waiting for review, so both act only while the review pane holds focus;
// elsewhere they return the notice to show instead.
export function reviewOnlyGuard(pane: Pane): string | null {
  if (pane === "review") return null;
  return "{yellow-fg}r/R act on the ready to review pane (^hjkl to move){/yellow-fg}";
}

// nvim-style directional focus between the panes: left/right across the
// columns, down to the merge pane, up out of it (tasks first, review when
// tasks is empty). A move onto an empty pane stays put.
export function movePane(current: Pane, dir: "left" | "right" | "up" | "down", counts: PaneCounts): Pane {
  let target: Pane | null = null;
  if (dir === "left" && current === "review") target = "tasks";
  else if (dir === "right" && current === "tasks") target = "review";
  else if (dir === "down" && current !== "merge") target = "merge";
  else if (dir === "up" && current === "merge") target = counts.tasks > 0 ? "tasks" : "review";
  if (target !== null && counts[target] > 0) return target;
  return current;
}

// Tab's fallback cycle through the panes, skipping empty ones.
export function nextPane(current: Pane, counts: PaneCounts): Pane {
  const order: Pane[] = ["tasks", "review", "merge"];
  const i = order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const p = order[(i + step) % order.length];
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

// The row the operator's keypress should act on: each pane keeps its own blessed
// selection (1-based, row 0 is the column header), and the focused pane wins.
export function selectedBoardRow(
  pane: Pane,
  panes: {
    tasks: { rows: BoardRow[]; selected: number };
    review: { entries: ReviewEntry[]; selected: number };
    merge: { rows: BoardRow[]; selected: number };
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

// Ctrl+H and Ctrl+J reach blessed as their control characters (0x08 and 0x0a),
// named "backspace" and "linefeed", so those aliases are bound alongside the
// C- names some terminals send instead. The board has no text input, so a real
// Backspace key doubling as pane-left is harmless.
export function bindPaneNavKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  move: (dir: "left" | "right" | "up" | "down") => void,
): void {
  const bind = (keys: string[], dir: "left" | "right" | "up" | "down") =>
    screen.key(keys, () => {
      if (!isOverlayOpen()) move(dir);
    });
  bind(["C-h", "backspace"], "left");
  bind(["C-l"], "right");
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

// height: 1 + wrap: false so a hint too long for the terminal clips instead of
// wrapping. blessed.text defaults to shrink: true, which would otherwise grow
// the element upward from bottom: 0 into the table's last row (bottom: 1).
// Exported so the layout test below exercises this exact object, not a copy.
export function footerLayout(key: string): Record<string, unknown> {
  return {
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    wrap: false,
    // The initial focused pane; render() re-fits the legend to the pane.
    content: footerHint(key, "tasks"),
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

export function statusContent(mode: Mode, refineOn: boolean, active: number, notice: Notice | null, now: number): string {
  const refineChip = refineOn
    ? "{black-fg}{green-bg} REFINE ON {/green-bg}{/black-fg} "
    : "{black-fg}{red-bg} REFINE OFF {/red-bg}{/black-fg} ";
  const base = `${refineChip}${modeContent(mode)} live | ${active} active`;
  return notice && now < notice.until ? `${base} | ${notice.text}` : base;
}

export async function handleReadyPress(
  row: BoardRow | undefined,
  addReady: (pr: number, key: string, label: string) => Promise<void>,
  setNotice: (text: string, ttlMs: number) => void,
): Promise<void> {
  if (!row) return;
  if (row.pr == null) {
    setNotice("{red-fg}selected row has no PR to mark ready{/red-fg}", NOTICE_ERROR_TTL_MS);
    return;
  }
  setNotice(`adding ready label to #${row.pr}…`, NOTICE_TTL_MS);
  try {
    await addReady(row.pr, row.key, row.label);
    setNotice(`{green-fg}#${row.pr} marked ready{/green-fg}`, NOTICE_TTL_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setNotice(`{red-fg}ready label on #${row.pr} failed: ${msg}{/red-fg}`, NOTICE_ERROR_TTL_MS);
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

export function rowsToTable(rows: BoardRow[], now: number = Date.now()): string[][] {
  const header = ["TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG", "REASON"];
  const body = rows.map((r) => {
    const durMs = r.terminal ? r.ts - r.startTs : now - r.startTs;
    return [
      fmtTime(r.ts),
      fmtDuration(durMs),
      r.terminal ? `{grey-fg}${r.status}{/grey-fg}` : r.status,
      r.label,
      r.pr != null ? `#${r.pr}` : "",
      r.title ?? "",
      isFlagged(r) ? "{red-fg}⚑{/red-fg}" : "",
      r.flagReasons.length > 0 ? `{red-fg}${r.flagReasons.join(",")}{/red-fg}` : "",
    ];
  });
  return [header, ...body];
}

// screen.key's handler runs before the focused widget's own keypress handling
// (see neo-blessed's screen.js _listenKeys: it emits on the screen first, then
// on screen.focused). While any overlay (settings or review) is open, the
// overlay's own widgets own q/escape (e.g. list.js maps them to
// cancelSelected, which drives the settings panel's unsaved-changes
// double-escape prompt), so the board must not act on them here. C-c stays a
// hard quit regardless.
export function bindQuitKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  quit: () => void,
): void {
  screen.key(["q", "escape"], () => {
    if (!isOverlayOpen()) quit();
  });
  screen.key(["C-c"], quit);
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

// R (shift-r) opens the guided review overlay for the selected row's PR,
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
  // Keys of worktrees whose tmux session is still live: their merged rows
  // render as "working (manual)" instead of aging off the board.
  manualLiveKeys: () => Set<string>;
  onToggleFlag: (key: string, label: string, flagged: boolean) => void;
  onOpenSession: (key: string, label: string) => void;
  onAddReadyLabel: (pr: number, key: string, label: string) => Promise<void>;
  mode: () => Mode;
  onToggleMode: () => Mode;
  refineEnabled: () => boolean;
  settings: SettingsDeps;
  reviewDeps: (pr: number) => ReviewDeps;
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
  const tasksPane = makePane("tasks", { top: 1, left: 0, width: "50%", bottom: 1 });
  const reviewPane = makePane("review", { top: 1, left: "50%", right: 0, bottom: 1 });
  const mergePane = makePane("merge", { left: 0, right: 0, bottom: 1, height: 4, hidden: true });
  const paneWidgets: Record<Pane, any> = { tasks: tasksPane, review: reviewPane, merge: mergePane };
  tasksPane.focus();

  const title = blessed.text({ parent: screen, top: 0, left: 0, content: "yimbot" });
  const status = blessed.text({ parent: screen, top: 0, right: 0, tags: true, content: "live" });
  const footer = blessed.text({ parent: screen, ...footerLayout(returnKey()) });

  let currentRows: BoardRow[] = [];
  let currentTasks: BoardRow[] = [];
  let currentMerge: BoardRow[] = [];
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
  });
  const render = () => {
    currentRows = filterToLiveWorktrees(
      reduceRows(readEvents(), Date.now(), { manualLiveKeys: opts.manualLiveKeys() }),
      opts.liveKeys(),
    );
    const { review, merge, tasks } = partitionRows(currentRows);
    orderFetcher.ensure(review.map((r) => r.pr).filter((n): n is number => n != null));
    currentReview = applyOrder(review, orderFetcher.get());
    currentTasks = tasks;
    currentMerge = merge;
    const now = Date.now();
    const layout = boardLayout(merge.length, Number(screen.rows) || 24);
    tasksPane.bottom = layout.tasks.bottom;
    reviewPane.bottom = layout.review.bottom;
    tasksPane.setLabel(` tasks (${tasks.length}) `);
    reviewPane.setLabel(` ready to review (${currentReview.length}) `);
    tasksPane.setData(rowsToTable(tasks, now));
    reviewPane.setData(reviewTable(currentReview, now));
    if (layout.merge) {
      mergePane.height = layout.merge.height;
      mergePane.setLabel(` ready to merge (${merge.length}) `);
      mergePane.setData(mergeTable(merge, now));
      // While an overlay is open every pane stays hidden (the overlay owns
      // the screen); the close callback re-renders, which shows them again.
      if (!isOverlayOpen()) mergePane.show();
    } else {
      mergePane.hide();
    }
    const pane = resolvePane(focusedPane, paneCounts());
    if (pane !== focusedPane) {
      focusedPane = pane;
      if (!isOverlayOpen()) focusedWidget().focus();
    }
    for (const p of ["tasks", "review", "merge"] as const) {
      paneWidgets[p].style.border.fg = paneBorderColor(p, p === focusedPane);
    }
    footer.setContent(footerHint(returnKey(), focusedPane));
    const active = currentRows.filter((r) => !r.terminal).length;
    status.setContent(
      daemonStopped ? "daemon stopped" : statusContent(opts.mode(), opts.refineEnabled(), active, notice, Date.now()),
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
    });
  const focusedWidget = () => paneWidgets[focusedPane];
  const focusPane = (p: Pane) => {
    focusedPane = p;
    focusedWidget().focus();
    render();
  };
  bindPaneFocusSync(paneWidgets, (p) => {
    focusedPane = p;
  });

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
  const isOverlayOpen = () => settingsOpen || reviewOpen;
  bindQuitKeys(screen, isOverlayOpen, quit);

  const hidePanes = () => {
    for (const p of ["tasks", "review", "merge"] as const) paneWidgets[p].hide();
  };
  // The merge pane is deliberately not shown here: the render() every caller
  // issues right after restores it only when it has rows.
  const showPanes = () => {
    tasksPane.show();
    reviewPane.show();
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

  bindReadyKey(screen, isOverlayOpen, () => {
    const blocked = reviewOnlyGuard(focusedPane);
    if (blocked) {
      setNotice(blocked, NOTICE_TTL_MS);
      return;
    }
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
    const blocked = reviewOnlyGuard(focusedPane);
    if (blocked) {
      setNotice(blocked, NOTICE_TTL_MS);
      return;
    }
    const r = selRow();
    if (!r) return;
    if (r.pr == null) {
      setNotice("{red-fg}selected row has no PR to review{/red-fg}", NOTICE_ERROR_TTL_MS);
      return;
    }
    reviewOpen = true;
    hidePanes();
    openReview(screen, opts.reviewDeps(r.pr), (noticeMsg, isError) => {
      reviewOpen = false;
      showPanes();
      if (noticeMsg) setNotice(noticeMsg, isError ? NOTICE_ERROR_TTL_MS : NOTICE_TTL_MS);
      else render();
    });
  });

  const openSelectedSession = (r: BoardRow | undefined) => {
    if (!r) return;
    opts.onOpenSession(r.key, r.label);
  };
  tasksPane.on("select", () => openSelectedSession(currentTasks[tasksPane.selected - 1]));
  reviewPane.on("select", () => openSelectedSession(currentReview[reviewPane.selected - 1]?.row));
  mergePane.on("select", () => openSelectedSession(currentMerge[mergePane.selected - 1]));

  render();
}
