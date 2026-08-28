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

export function footerHint(key: string): string {
  return `j/k move   tab pane   enter open   f flag/unflag   r ready   R review   m mode   s settings   q quit   prefix+${key} returns here`;
}

// A draft_pr event is a supervised draft whose ready verdict held (threads
// resolved, mergeable, CI green): waiting on a human review, so its status is
// the review section's membership test. Derived from the STATUS map rather than
// repeating the display string here.
const REVIEW_STATUS = statusFor("draft_pr")?.status ?? "draft pr";

export function partitionRows(rows: BoardRow[]): { review: BoardRow[]; rest: BoardRow[] } {
  const review: BoardRow[] = [];
  const rest: BoardRow[] = [];
  for (const r of rows) (r.status === REVIEW_STATUS ? review : rest).push(r);
  return { review, rest };
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

// Vertical layout of the split board: section header line, review table sized
// to its rows (plus its column header), a horizontal rule with one blank margin
// row on each side, then the main board from boardTop down to the footer. With
// nothing to review the section collapses entirely (separator: null) and the
// board keeps its original top. Visible review rows are clamped so the board
// always keeps its column header plus two rows above the footer, and on a
// screen too small to afford the rule and margins those three rows are dropped
// (separator: null) rather than squeezing the board out.
export function reviewSectionLayout(
  count: number,
  screenHeight: number,
): {
  header: { top: number; left: number; height: number };
  table: { top: number; left: number; right: number; height: number };
  separator: { top: number } | null;
  boardTop: number;
} {
  const headerTop = 1;
  const tableTop = headerTop + 1;
  const margin = 1;
  const boardMinHeight = 3; // column header + two rows
  const footerRows = 1;
  // Rows a single visible review row costs beyond the review rows themselves:
  // title, section header, column header, footer, plus the margined rule when
  // it fits (dropped below 11 rows, where it would eat the board's minimum).
  const ruleRows = margin + 1 + margin;
  const withRule = screenHeight >= tableTop + 1 + 1 + ruleRows + boardMinHeight + footerRows;
  const chrome = tableTop + 1 + (withRule ? ruleRows : 0) + footerRows;
  const maxVisible = Math.max(1, Math.min(Math.floor((screenHeight - chrome) / 2), screenHeight - chrome - boardMinHeight));
  const visible = Math.min(count, maxVisible);
  const tableHeight = visible + 1;
  const separatorTop = tableTop + tableHeight + margin;
  const boardTop = withRule ? separatorTop + margin + 1 : tableTop + tableHeight;
  return {
    header: { top: headerTop, left: 0, height: 1 },
    table: { top: tableTop, left: 0, right: 0, height: tableHeight },
    separator: count > 0 && withRule ? { top: separatorTop } : null,
    boardTop: count === 0 ? 1 : boardTop,
  };
}

export type Pane = "review" | "board";

// The pane keypresses should act on. An empty pane can never hold the focus:
// with every row a ready draft the board is empty, and without this the
// operator's f/r/R/enter would silently no-op against it.
export function resolvePane(current: Pane, reviewCount: number, boardCount: number): Pane {
  if (reviewCount === 0) return "board";
  if (boardCount === 0) return "review";
  return current;
}

// Keep focusedPane honest against blessed's own focus: a mouse click on a list
// item calls focus() on that list (neo-blessed list.js), which the tab binding
// alone would not see, leaving keypresses acting on the other pane's selection.
export function bindPaneFocusSync(
  board: { on: (ev: string, fn: () => void) => void },
  review: { on: (ev: string, fn: () => void) => void },
  set: (pane: Pane) => void,
): void {
  board.on("focus", () => set("board"));
  review.on("focus", () => set("review"));
}

// The row the operator's keypress should act on: each pane keeps its own blessed
// selection (1-based, row 0 is the column header), and the focused pane wins.
export function selectedBoardRow(
  pane: Pane,
  reviewEntries: ReviewEntry[],
  reviewSelected: number,
  boardRows: BoardRow[],
  boardSelected: number,
): BoardRow | undefined {
  if (pane === "review") return reviewEntries[reviewSelected - 1]?.row;
  return boardRows[boardSelected - 1];
}

// Tab flips focus between the review pane and the board, gated like every other
// board key: an open overlay owns the keyboard.
export function bindPaneToggle(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["tab"], () => {
    if (!isOverlayOpen()) toggle();
  });
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
    content: footerHint(key),
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
  // Feeds the READY TO REVIEW section's AI ordering: per-PR meta reads and the
  // headless prompt runner (same claude -p shape as the review grouping).
  orderDeps: OrderSourceDeps;
}): void {
  const term = screenTerm(process.env.TERM);
  const screen = blessed.screen({ smartCSR: true, title: "yimbot", fullUnicode: true, ...(term ? { term } : {}) });

  const table = blessed.listtable({
    parent: screen,
    top: 1,
    left: 0,
    right: 0,
    bottom: 1,
    tags: true,
    align: "left",
    keys: true,
    vi: true,
    mouse: true,
    style: { header: { bold: true }, cell: { selected: { inverse: true } } },
  });
  table.focus();

  const reviewHeader = blessed.text({
    parent: screen,
    top: 1,
    left: 0,
    height: 1,
    tags: true,
    hidden: true,
    content: "",
  });
  const reviewList = blessed.listtable({
    parent: screen,
    top: 2,
    left: 0,
    right: 0,
    height: 2,
    tags: true,
    align: "left",
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    style: { header: { bold: true }, cell: { selected: { inverse: true } } },
  });

  // Positioned by render() from reviewSectionLayout before it is ever shown.
  const separator = blessed.line({
    parent: screen,
    orientation: "horizontal",
    left: 0,
    right: 0,
    hidden: true,
    style: { fg: "grey" },
  });
  const reviewWidgets = [reviewHeader, reviewList, separator];

  const title = blessed.text({ parent: screen, top: 0, left: 0, content: "yimbot" });
  const status = blessed.text({ parent: screen, top: 0, right: 0, tags: true, content: "live" });
  const footer = blessed.text({ parent: screen, ...footerLayout(returnKey()) });
  void footer;

  let currentRows: BoardRow[] = [];
  let currentBoard: BoardRow[] = [];
  let currentReview: ReviewEntry[] = [];
  let focusedPane: Pane = "board";
  // Set when a settings apply's rollback restart also failed, so the daemon
  // is confirmed down. The panel itself closes on esc/w regardless of draft
  // state, so this has to outlive it to keep showing on the board.
  let daemonStopped = false;
  let notice: Notice | null = null;
  const render = () => {
    currentRows = filterToLiveWorktrees(
      reduceRows(readEvents(), Date.now(), { manualLiveKeys: opts.manualLiveKeys() }),
      opts.liveKeys(),
    );
    const { review, rest } = partitionRows(currentRows);
    orderFetcher.ensure(review.map((r) => r.pr).filter((n): n is number => n != null));
    currentReview = applyOrder(review, orderFetcher.get());
    currentBoard = rest;
    const layout = reviewSectionLayout(currentReview.length, Number(screen.rows) || 24);
    if (currentReview.length === 0) {
      for (const w of reviewWidgets) w.hide();
    } else {
      reviewHeader.setContent(`{bold}READY TO REVIEW (${currentReview.length}){/bold}`);
      reviewList.height = layout.table.height;
      reviewList.setData(reviewTable(currentReview));
      if (layout.separator) separator.top = layout.separator.top;
      // While an overlay is open both panes stay hidden (the overlay owns the
      // screen); the close callback re-renders, which shows them again.
      if (!isOverlayOpen()) {
        reviewHeader.show();
        reviewList.show();
        if (layout.separator) separator.show();
        else separator.hide();
      }
    }
    table.top = layout.boardTop;
    table.setData(rowsToTable(currentBoard, Date.now()));
    const pane = resolvePane(focusedPane, currentReview.length, currentBoard.length);
    if (pane !== focusedPane) {
      focusedPane = pane;
      if (!isOverlayOpen()) focusedWidget().focus();
    }
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
  const selRow = () => selectedBoardRow(focusedPane, currentReview, reviewList.selected, currentBoard, table.selected);
  const focusedWidget = () => (focusedPane === "review" ? reviewList : table);
  bindPaneFocusSync(table, reviewList, (p) => {
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
    table.hide();
    for (const w of reviewWidgets) w.hide();
  };
  // The review trio is deliberately not shown here: the render() every caller
  // issues right after restores exactly the widgets the current layout wants.
  const showPanes = () => {
    table.show();
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
    void handleReadyPress(selRow(), opts.onAddReadyLabel, setNotice);
  });

  bindModeKey(screen, isOverlayOpen, () => {
    opts.onToggleMode();
    render();
  });

  bindPaneToggle(screen, isOverlayOpen, () => {
    if (currentReview.length === 0) return;
    focusedPane = focusedPane === "review" ? "board" : "review";
    focusedWidget().focus();
    screen.render();
  });

  bindReviewKey(screen, isOverlayOpen, () => {
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
  table.on("select", () => openSelectedSession(currentBoard[table.selected - 1]));
  reviewList.on("select", () => openSelectedSession(currentReview[reviewList.selected - 1]?.row));

  render();
}
