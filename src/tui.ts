// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";
import { envOr } from "./env.ts";
import { bus, filterToLiveRows, isFlagged, isParentRow, readEvents, reduceRows, type BoardRow, type YimbotEvent } from "./events.ts";
import { QUEUE_PANE_WIDTH, queueRows, readQueueState } from "./heavy-queue.ts";
import type { Mode } from "./mode.ts";
import { unreachable, type Service } from "./reach.ts";
import { openReview, type ReviewDeps } from "./tui-review.ts";
import { cellWidth, codebaseRepoName, fitCell, grey, paneLabel } from "./board-format.ts";
import { PANE_CHROME_ROWS, PANE_MIN_HEIGHT, QUEUE_MIN_SCREEN_WIDTH, applyOrder, partitionTable, tableBoxes, tableFocusOrder, type ReviewEntry, type TableId } from "./table-view.ts";
import { makeOrderFetcher, type OrderSourceDeps } from "./review-order.ts";
import { createTableView } from "./tui-table-view.ts";
import { openSettings, type SettingsDeps } from "./tui-settings.ts";
import { createCardColumn, type CardColumn } from "./tui-cards.ts";
import { buildColumns, cardLines, cycleFocus, focusOrder, stepFocus, visibleWindow, type Card, type Column } from "./kanban.ts";
import type { CycleBoard } from "./linear-api.ts";

// How often the board repaints on its own, independent of daemon events. Without
// it the TUI freezes on its last paint between events: time-based row pruning
// never advances, and after the machine sleeps the whole board stays stale until
// the next event fires (which can be a full heartbeat away). A wall-clock timer
// also catches up on wake, so the board refreshes within seconds of resuming.
function refreshMs(): number {
  const n = Number(envOr("TUI_REFRESH_MS", "5000"));
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

const BOARD_REFRESH_MS = 30_000;

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
// help, quit, and r/R.
export function footerHint(): string {
  return "r ready   R review   v view   ? help   ^c quit";
}

// The help overlay's body: every keybind, one per line, aligned.
export function helpLines(key: string): string[] {
  const binds: [string, string][] = [
    ["j/k", "move selection"],
    ["^j/^k", "switch column (tab cycles)"],
    ["h/l", "move between columns (kanban)"],
    ["enter", "open the selected card's tmux session"],
    ["f", "flag/unflag the selected card"],
    ["r", "queue the selected card's PR to merge (also inside R)"],
    ["R", "review the selected card's PR"],
    ["m", "toggle supervised/autonomous"],
    ["s", "settings"],
    ["v", "toggle kanban view"],
    [`prefix+${key}`, "return here from a session"],
    ["?", "toggle this help"],
    ["^c", "quit"],
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

export type View = "table" | "kanban";

export const DEFAULT_VIEW: View = "table";

export function nextView(view: View): View {
  return view === "table" ? "kanban" : "table";
}

// v flips the board between the table and the kanban, gated like m.
export function bindViewKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isOverlayOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["v"], () => {
    if (!isOverlayOpen()) toggle();
  });
}

export function viewFocusOrder(
  view: View,
  tableCounts: Record<TableId, number>,
  columns: Column[],
  hasParents: boolean,
): string[] {
  if (view === "table") return tableFocusOrder(tableCounts, hasParents);
  return focusOrder(columns, hasParents);
}

const TABLE_STOPS = new Set(["tasks", "review", "merge", "parents"]);

// A column id carried over from the kanban means nothing to the table, and
// with every table pane empty resolveFocus would keep it; the table then
// falls back to the tasks pane, as it did before the kanban existed.
export function viewFocus(view: View, order: string[], current: string): string {
  const id = resolveFocus(order, current);
  if (view === "kanban" || TABLE_STOPS.has(id)) return id;
  return "tasks";
}

export function headerBoard(view: View, board: CycleBoard | null): CycleBoard | null {
  return view === "kanban" ? board : null;
}

// With no room for the parents box (narrow or short screen) the parents go
// back to the tasks pane rather than off the board.
export function tableSections(
  rows: BoardRow[],
  hasParentsBox: boolean,
): { tasks: BoardRow[]; review: BoardRow[]; merge: BoardRow[]; parents: BoardRow[] } {
  const split = partitionTable(rows);
  if (hasParentsBox) return split;
  return { ...split, tasks: [...split.tasks, ...split.parents], parents: [] };
}

export function onlyInView(view: View, current: () => View, fn: () => void): () => void {
  return () => {
    if (current() === view) fn();
  };
}

// The board's geometry: the kanban columns share the body between the title
// and the footer. Below this width the queue gives way rather than squeezing
// the columns; the queue holds the left edge and the columns inset past it.
//
// The parent tickets box shares the queue's column, stacked under it at the
// queue's width. It takes only what its rows need, capped at half the body so
// the queue keeps the rest, and is gone entirely while empty or whenever the
// queue is: those rows are context, and the board's width is the work's.
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
  board: { top: number; left: number; right: number; bottom: number };
  parents: ParentsBox | null;
  queue: { top: number; left: number; width: number; bottom: number } | null;
} {
  const footerRows = 1;
  const titleRows = 1;
  const body = screenHeight - titleRows - footerRows;
  const showQueue = screenWidth >= QUEUE_MIN_SCREEN_WIDTH;
  const inset = showQueue ? QUEUE_PANE_WIDTH : 0;
  const parentsHeight = showQueue ? parentsBoxHeight(body, parentRows) : 0;
  return {
    board: { top: titleRows, left: inset, right: 0, bottom: footerRows },
    parents:
      parentsHeight > 0 ? { left: 0, width: QUEUE_PANE_WIDTH, bottom: footerRows, height: parentsHeight } : null,
    queue: showQueue ? { top: titleRows, left: 0, width: QUEUE_PANE_WIDTH, bottom: footerRows + parentsHeight } : null,
  };
}

const PARENTS_BORDER = "grey";

// The parents pane is the one listtable left on the board: only while it
// holds the focus does it take the focus hue and inverse its selected row.
// neo-blessed aliases style.selected to style.cell.selected on a listtable and
// resolves it at paint time, so mutating it here is enough.
export function styleParentsPane(
  pane: { style: { border: { fg: string }; label: { fg: string }; selected: { inverse: boolean } } },
  focused: boolean,
): void {
  const fg = focused ? FOCUS_BORDER : PARENTS_BORDER;
  pane.style.border.fg = fg;
  pane.style.label.fg = fg;
  pane.style.selected.inverse = focused;
}

// The focus id is a column id or "parents". A focused column that left the
// board hands the focus to the first entry; an empty board keeps the id. An
// unset focus waits for the first column rather than settling on the parents
// pane before the first Linear board lands.
export function resolveFocus(order: string[], current: string): string {
  if (order.length === 0 || order.includes(current)) return current;
  const hasColumns = order.some((id) => id !== "parents");
  if (current === "" && !hasColumns) return current;
  return order[0];
}

// Wraps a fetch so only results newer than the last applied one land: a slow
// older request cannot overwrite a newer board. A rejection is dropped; a
// failed Linear fetch already raises the reach warning inside the client.
export function latestOnly<T>(fetch: () => Promise<T>, apply: (value: T) => void): () => void {
  let issued = 0;
  let applied = 0;
  return () => {
    const seq = ++issued;
    fetch().then(
      (value) => {
        if (seq <= applied) return;
        applied = seq;
        apply(value);
      },
      () => {},
    );
  };
}

export type ColumnSlot = { id: string; left: number; width: number };

// The columns that fit the board area, with their screen offsets. The parents
// pane is not a column, so while it holds the focus the window stays where it
// was. The last visible column takes the cells the even split leaves over.
export function placeColumns(
  ids: string[],
  focusedId: string,
  prevStart: number,
  left: number,
  width: number,
): { start: number; slots: ColumnSlot[] } {
  if (ids.length === 0) return { start: 0, slots: [] };
  const i = ids.indexOf(focusedId);
  const focusedIndex = i >= 0 ? i : Math.min(prevStart, ids.length - 1);
  const { start, count, colWidth } = visibleWindow(ids.length, focusedIndex, prevStart, width);
  const slots = ids.slice(start, start + count).map((id, k) => {
    const last = k === count - 1;
    return { id, left: left + k * colWidth, width: last ? width - colWidth * (count - 1) : colWidth };
  });
  return { start, slots };
}

export const PARENT_NOTICE = "{red-fg}parent tickets have no PR of their own{/red-fg}";

// A parent row's pr, when it has one, is the PR the split closed: the fold
// carries it forward, but nothing about it is actionable any more.
export function prActionRefusal(row: Pick<BoardRow, "status">): string | undefined {
  return isParentRow(row) ? PARENT_NOTICE : undefined;
}

export const NO_CARD_NOTICE = "{red-fg}no ticket selected{/red-fg}";
export const NO_SESSION_NOTICE = "{red-fg}no yimbot session for this ticket{/red-fg}";

// A card is a Linear ticket; only one yimbot has a row for can be opened,
// flagged, queued or reviewed.
export function rowForAction(card: Card | undefined): { row: BoardRow } | { notice: string } {
  if (!card) return { notice: NO_CARD_NOTICE };
  if (!card.row) return { notice: NO_SESSION_NOTICE };
  return { row: card.row };
}

// The setter for the mouse focus sync. A click on a card or the parents list
// moves blessed focus without going through focusPane, so this records the
// clicked column as focused and repaints; the column borders and footer are
// only fitted by render(), and without it the board waits for the refresh
// timer. The repaint is deferred past blessed's own click handler and dropped
// if the focus moved on before the tick (hidePanesKeepingFocus's rewind).
export function onPaneFocusChange(
  get: () => string,
  set: (id: string) => void,
  render: () => void,
  defer: (fn: () => void) => void = (fn) => setImmediate(fn),
): (id: string) => void {
  return (id) => {
    if (id === get()) return;
    set(id);
    defer(() => {
      if (get() === id) render();
    });
  };
}

// Hiding the focused pane makes blessed rewind focus onto the last visible
// pane in its history (screen.js rewindFocus), which the sync above would
// record as a pane switch; the overlay's close then puts the highlight and the
// keys on that other pane. Hide, then put the pane the operator was on back.
export function hidePanesKeepingFocus(
  widgets: { hide: () => void }[],
  get: () => string,
  set: (id: string) => void,
): void {
  const focused = get();
  for (const widget of widgets) widget.hide();
  set(focused);
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

// The header row above the board. The panes below are bordered at column 0
// and the last column, so "yimbot" and the status chips are inset past that
// border plus one column of margin: the header then reads as sitting inside the
// panes below instead of hanging off the screen edges. Exported so the layout
// tests exercise these exact objects, not copies.
export const headerInset = 2;

export function titleLayout(): Record<string, unknown> {
  return { top: 0, left: headerInset, tags: true };
}

const WORDMARK = "{cyan-fg}{bold}yimbot{/bold}{/cyan-fg}";

export function titleContent(board: { cycleNumber: number | null } | null): string {
  if (!board) return WORDMARK;
  if (board.cycleNumber === null) return `${WORDMARK}${grey(" no active cycle")}`;
  return `${WORDMARK}${grey(` cycle ${board.cycleNumber}`)}`;
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
    content: footerHint(),
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

export function statusContent(mode: Mode, notice: Notice | null, now: number, down: Service[]): string {
  const base = `${reachWarnings(down)}${modeContent(mode)}`;
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

export { cellWidth, fitCell, fmtDuration, grey, paneLabel, repoDisplayName, titleCell } from "./board-format.ts";

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

// screen.key's handler runs before the focused widget's own keypress handling
// (see neo-blessed's screen.js _listenKeys: it emits on the screen first, then
// on screen.focused). C-c is the only quit key: q and escape are left to the
// overlays, which own them for close/cancel (list.js maps escape to
// cancelSelected, which drives the settings panel's unsaved-changes
// double-escape prompt). C-c is a hard quit everywhere except while the review
// overlay's claude pane is focused: there it is claude's own interrupt, and
// because the screen handler fires first it must stand down for the sequence
// to reach the pane's keypress forwarding.
export function bindQuitKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isClaudeFocused: () => boolean,
  quit: () => void,
): void {
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
  // read "merged, waiting on slices" and stay on the board.
  heldSliceKeys: () => Set<string>;
  // Merged worktrees the cleanup step is holding for the ticket's other PRs or
  // its Linear state; their rows read "merged, waiting on ticket".
  heldMergedKeys: () => Set<string>;
  onToggleFlag: (key: string, label: string, flagged: boolean) => void;
  onOpenSession: (key: string, label: string) => void;
  onAddReadyLabel: (pr: number, key: string, label: string, repo?: string) => Promise<void>;
  mode: () => Mode;
  onToggleMode: () => Mode;
  settings: SettingsDeps;
  reviewDeps: (pr: number, key: string, label: string, repo?: string) => ReviewDeps;
  // The watched team's active cycle for the kanban columns.
  fetchBoard: () => Promise<CycleBoard>;
  // Feeds the ready-to-review pane's AI ordering: per-PR meta reads and the
  // headless prompt runner (same claude -p shape as the review grouping).
  orderDeps: OrderSourceDeps;
}): void {
  const term = screenTerm(process.env.TERM);
  const screen = blessed.screen({ smartCSR: true, title: "yimbot", fullUnicode: true, ...(term ? { term } : {}) });

  // Positions are re-fit by render() from boardLayout on every repaint.
  const parentsPane = blessed.listtable({
    parent: screen,
    left: 0,
    width: QUEUE_PANE_WIDTH,
    bottom: 1,
    height: 4,
    hidden: true,
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
      border: { fg: PARENTS_BORDER },
      label: { fg: PARENTS_BORDER },
    },
  });

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

  const title = blessed.text({ parent: screen, ...titleLayout(), content: titleContent(null) });
  const status = blessed.text({ parent: screen, ...statusLayout(), content: "live" });
  const footer = blessed.text({ parent: screen, ...footerLayout() });

  let currentRows: BoardRow[] = [];
  let currentParents: BoardRow[] = [];
  let currentTable: { tasks: BoardRow[]; review: ReviewEntry[]; merge: BoardRow[] } = { tasks: [], review: [], merge: [] };
  let view: View = DEFAULT_VIEW;
  let currentColumns: Column[] = [];
  let lastBoard: CycleBoard | null = null;
  const columnWidgets = new Map<string, CardColumn>();
  let focusedId = "tasks";
  let windowStart = 0;
  let closed = false;
  // Set when a settings apply's rollback restart also failed, so the daemon
  // is confirmed down. The panel itself closes on esc/w regardless of draft
  // state, so this has to outlive it to keep showing on the board.
  let daemonStopped = false;
  let notice: Notice | null = null;

  const isTableId = (id: string): id is TableId => id === "tasks" || id === "review" || id === "merge";
  const focusedWidget = (): any => {
    if (focusedId === "parents") return parentsPane;
    if (view === "table") return isTableId(focusedId) ? tableView.widgets[focusedId] : undefined;
    return columnWidgets.get(focusedId)?.widget;
  };
  const tableCounts = () => ({
    tasks: currentTable.tasks.length,
    review: currentTable.review.length,
    merge: currentTable.merge.length,
  });
  const currentOrder = () => viewFocusOrder(view, tableCounts(), currentColumns, currentParents.length > 0);
  const cardFor = (columnId: string, key: string | null | undefined): Card | undefined =>
    currentColumns.find((c) => c.id === columnId)?.cards.find((c) => c.key === key);
  const selectedCard = () => cardFor(focusedId, columnWidgets.get(focusedId)?.selectedKey());
  const setFocusId = (id: string) => {
    focusedId = id;
  };
  const focusChange = onPaneFocusChange(() => focusedId, setFocusId, () => render());
  parentsPane.on("focus", () => focusChange("parents"));

  const tableView = createTableView({
    parent: screen,
    onFocus: (id) => focusChange(id),
    onOpen: (r) => opts.onOpenSession(r.key, r.label),
  });

  const makeColumn = (id: string): CardColumn => {
    const column = createCardColumn({
      parent: screen,
      onOpen: (key) => openCard(cardFor(id, key)),
      onFocus: () => {
        column.widget.focus();
        focusChange(id);
      },
    });
    return column;
  };

  // Columns are reconciled by Linear state id: a state that left the board
  // loses its widget, a new one gets one, and the window decides which show.
  const renderColumns = (area: { top: number; left: number; right: number; bottom: number }, screenWidth: number) => {
    currentColumns = lastBoard ? buildColumns(lastBoard, currentRows) : [];
    const ids = currentColumns.map((c) => c.id);
    const keep = focusedId;
    for (const [id, column] of columnWidgets) {
      if (ids.includes(id)) continue;
      column.widget.destroy();
      columnWidgets.delete(id);
    }
    focusedId = viewFocus("kanban", currentOrder(), keep);
    const { start, slots } = placeColumns(ids, focusedId, windowStart, area.left, screenWidth - area.left - area.right);
    windowStart = start;
    const now = Date.now();
    const codebase = codebaseRepoName();
    for (const column of currentColumns) {
      let widget = columnWidgets.get(column.id);
      if (!widget) {
        widget = makeColumn(column.id);
        columnWidgets.set(column.id, widget);
      }
      const slot = slots.find((s) => s.id === column.id);
      if (!slot) {
        widget.widget.hide();
        continue;
      }
      widget.widget.top = area.top;
      widget.widget.bottom = area.bottom;
      widget.widget.left = slot.left;
      widget.widget.width = slot.width;
      widget.setLabel(paneLabel(column.title, column.cards.length));
      widget.setAccent(column.color);
      // Less the column border and the card border.
      widget.setCards(column.cards.map((card) => ({ key: card.key, lines: cardLines(card, slot.width - 4, now, codebase) })));
      widget.setFocused(column.id === focusedId);
      widget.widget.show();
    }
  };

  const renderTable = (screenHeight: number, screenWidth: number) => {
    focusedId = viewFocus("table", currentOrder(), focusedId);
    tableView.render({ ...currentTable, now: Date.now(), boxes: tableBoxes(screenHeight, screenWidth), focusedId });
  };

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
    const parents = currentRows.filter(isParentRow);
    const screenHeight = Number(screen.rows) || 24;
    const screenWidth = Number(screen.cols) || 80;
    const layout = boardLayout(screenHeight, screenWidth, parents.length);
    currentParents = layout.parents ? parents : [];
    if (view === "table") {
      const sections = tableSections(currentRows, layout.parents !== null);
      const withPr = sections.review.filter((r): r is BoardRow & { pr: number } => r.pr != null);
      orderFetcher.ensure(
        withPr.map((r) => r.pr),
        new Map(withPr.flatMap((r) => (r.repo ? [[r.pr, r.repo] as const] : []))),
      );
      currentTable = { tasks: sections.tasks, review: applyOrder(sections.review, orderFetcher.get()), merge: sections.merge };
    }
    if (layout.parents) {
      parentsPane.height = layout.parents.height;
      parentsPane.setLabel(paneLabel("parent tickets", currentParents.length));
      parentsPane.setData(parentRows(currentParents));
    }
    // Skip the read while an overlay hides the pane: it reaps tickets, so
    // polling it here would write state nobody can see.
    if (layout.queue && !isOverlayOpen()) {
      queuePane.bottom = layout.queue.bottom;
      queuePane.setData(queueRows(readQueueState()));
      queuePane.show();
    } else {
      queuePane.hide();
    }
    // While an overlay is open every pane stays hidden (the overlay owns the
    // screen); the close callback re-renders, which shows them again. Hiding
    // or destroying the focused pane makes blessed rewind focus onto another,
    // which the focus sync would record; keep the operator's id so
    // resolveFocus picks the fallback deterministically instead.
    if (!isOverlayOpen()) {
      const keep = focusedId;
      if (layout.parents) parentsPane.show();
      else parentsPane.hide();
      if (view === "table") {
        for (const column of columnWidgets.values()) column.widget.hide();
        tableView.show();
      } else {
        tableView.hide();
      }
      focusedId = keep;
      if (view === "table") renderTable(screenHeight, screenWidth);
      else renderColumns(layout.board, screenWidth);
      const widget = focusedWidget();
      if (widget && !widget.hidden && screen.focused !== widget) widget.focus();
    }
    title.setContent(titleContent(headerBoard(view, lastBoard)));
    styleParentsPane(parentsPane, focusedId === "parents");
    footer.setContent(footerHint());
    status.setContent(
      daemonStopped
        ? "daemon stopped"
        : statusContent(opts.mode(), notice, Date.now(), unreachable()),
    );
    screen.render();
  };
  const setNotice = (text: string, ttlMs: number) => {
    notice = { text, until: Date.now() + ttlMs };
    render();
  };
  const orderFetcher = makeOrderFetcher({ ...opts.orderDeps, onUpdate: () => render() });
  const focusPane = (id: string) => {
    focusedId = id;
    render();
  };

  const openCard = (card: Card | undefined) => {
    const target = rowForAction(card);
    if ("notice" in target) {
      setNotice(target.notice, NOTICE_ERROR_TTL_MS);
      return;
    }
    opts.onOpenSession(target.row.key, target.row.label);
  };

  const refreshBoard = latestOnly(opts.fetchBoard, (board) => {
    if (closed) return;
    lastBoard = board;
    render();
  });

  const onEvent = (_ev: YimbotEvent) => render();
  bus.on("event", onEvent);
  const refreshTimer = setInterval(render, refreshMs());
  const boardTimer = setInterval(onlyInView("kanban", () => view, refreshBoard), BOARD_REFRESH_MS);
  // Reposition the absolutely-placed section immediately on a terminal resize
  // instead of leaving stale rows painted until the next tick.
  screen.on("resize", render);

  const quit = () => {
    closed = true;
    clearInterval(refreshTimer);
    clearInterval(boardTimer);
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
  bindQuitKeys(screen, () => reviewClaudeFocused(), quit);

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
      focusedWidget()?.focus();
      render();
    });
    screen.render();
  });

  // render() shows the panes again once the overlay closes.
  const hidePanes = () => {
    hidePanesKeepingFocus(
      [parentsPane, tableView, ...[...columnWidgets.values()].map((c) => c.widget)],
      () => focusedId,
      setFocusId,
    );
    queuePane.hide();
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
        render();
      },
      daemonStopped,
    );
  });

  const selectedParent = () => currentParents[parentsPane.selected - 1];

  // The row a key acts on: the parents pane's selection, the focused table
  // pane's row, or the focused column's card when yimbot has a row for it (a
  // notice otherwise).
  const actionRow = (): BoardRow | undefined => {
    if (focusedId === "parents") return selectedParent();
    if (view === "table") return isTableId(focusedId) ? tableView.selectedRow(focusedId, currentTable) : undefined;
    const target = rowForAction(selectedCard());
    if ("row" in target) return target.row;
    setNotice(target.notice, NOTICE_ERROR_TTL_MS);
    return undefined;
  };

  bindFlagKey(screen, isOverlayOpen, () => {
    const r = actionRow();
    if (!r) return;
    opts.onToggleFlag(r.key, r.label, isFlagged(r));
  });

  const prActionRow = (): BoardRow | undefined => {
    const r = actionRow();
    if (!r) return undefined;
    const refusal = prActionRefusal(r);
    if (!refusal) return r;
    setNotice(refusal, NOTICE_ERROR_TTL_MS);
    return undefined;
  };

  bindReadyKey(screen, isOverlayOpen, () => {
    const r = prActionRow();
    if (!r) return;
    void handleReadyPress(r, opts.onAddReadyLabel, setNotice);
  });

  bindModeKey(screen, isOverlayOpen, () => {
    opts.onToggleMode();
    render();
  });

  bindViewKey(screen, isOverlayOpen, () => {
    view = nextView(view);
    if (view === "kanban") refreshBoard();
    render();
  });

  bindPaneToggle(screen, isOverlayOpen, () => {
    const next = cycleFocus(currentOrder(), focusedId);
    if (next !== focusedId) focusPane(next);
  });

  bindPaneNavKeys(screen, isOverlayOpen, (dir) => {
    const next = stepFocus(currentOrder(), focusedId, dir === "down" ? "next" : "prev");
    if (next !== focusedId) focusPane(next);
  });

  bindReviewKey(screen, isOverlayOpen, () => {
    const r = prActionRow();
    if (!r) return;
    if (r.pr == null) {
      setNotice("{red-fg}selected row has no PR to review{/red-fg}", NOTICE_ERROR_TTL_MS);
      return;
    }
    reviewOpen = true;
    hidePanes();
    const overlay = openReview(screen, opts.reviewDeps(r.pr, r.key, r.label, r.repo), (noticeMsg, isError) => {
      reviewOpen = false;
      if (noticeMsg) setNotice(noticeMsg, isError ? NOTICE_ERROR_TTL_MS : NOTICE_TTL_MS);
      else render();
    });
    reviewClaudeFocused = overlay.claudeFocused;
  });

  parentsPane.on("select", () => {
    const r = selectedParent();
    if (r) opts.onOpenSession(r.key, r.label);
  });

  render();
}
