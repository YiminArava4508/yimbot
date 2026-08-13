// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { envOr } from "./env.ts";
import { bus, filterToLiveWorktrees, isFlagged, readEvents, reduceRows, type BoardRow, type YimbotEvent } from "./events.ts";
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

export function footerHint(key: string): string {
  return `j/k move   g/G top/bottom   enter open   f flag/unflag   s settings   q quit   prefix+${key} returns here`;
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
  const header = ["TIME", "DUR", "STATUS", "TICKET", "PR", "TITLE", "FLAG"];
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
    ];
  });
  return [header, ...body];
}

// screen.key's handler runs before the focused widget's own keypress handling
// (see neo-blessed's screen.js _listenKeys: it emits on the screen first, then
// on screen.focused). While the settings panel is open, the panel's own list
// owns q/escape (list.js maps them to cancelSelected, which drives the
// unsaved-changes double-escape prompt), so the board must not act on them
// here. C-c stays a hard quit regardless.
export function bindQuitKeys(
  screen: { key: (keys: string[], fn: () => void) => void },
  isSettingsOpen: () => boolean,
  quit: () => void,
): void {
  screen.key(["q", "escape"], () => {
    if (!isSettingsOpen()) quit();
  });
  screen.key(["C-c"], quit);
}

// Gated the same way as bindQuitKeys: without this, a second s while the
// panel is already open attaches a second list/footer pair on top of the
// first (openSettings has no idea it is already open), and the first pair is
// then permanently unreachable since only the panel that receives the close
// ever detaches its own widgets.
export function bindSettingsKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isSettingsOpen: () => boolean,
  openPanel: () => void,
): void {
  screen.key(["s"], () => {
    if (!isSettingsOpen()) openPanel();
  });
}

// Gated the same way as bindQuitKeys/bindSettingsKey: while the panel's list
// or a picker is focused, grabKeys is false, so without this gate f would
// still reach the screen-level handler and flag/unflag the hidden board's
// selected row out from under the operator.
export function bindFlagKey(
  screen: { key: (keys: string[], fn: () => void) => void },
  isSettingsOpen: () => boolean,
  toggle: () => void,
): void {
  screen.key(["f"], () => {
    if (!isSettingsOpen()) toggle();
  });
}

export function runTui(opts: {
  onQuit: () => void;
  liveKeys: () => Set<string>;
  onToggleFlag: (key: string, label: string, flagged: boolean) => void;
  onOpenSession: (key: string, label: string) => void;
  settings: SettingsDeps;
}): void {
  const screen = blessed.screen({ smartCSR: true, title: "yimbot", fullUnicode: true });

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

  const title = blessed.text({ parent: screen, top: 0, left: 0, content: "yimbot" });
  const status = blessed.text({ parent: screen, top: 0, right: 0, content: "live" });
  const footer = blessed.text({ parent: screen, ...footerLayout(returnKey()) });
  void footer;

  let currentRows: BoardRow[] = [];
  // Set when a settings apply's rollback restart also failed, so the daemon
  // is confirmed down. The panel itself closes on esc/w regardless of draft
  // state, so this has to outlive it to keep showing on the board.
  let daemonStopped = false;
  const render = () => {
    currentRows = filterToLiveWorktrees(reduceRows(readEvents(), Date.now()), opts.liveKeys());
    table.setData(rowsToTable(currentRows, Date.now()));
    const active = currentRows.filter((r) => !r.terminal).length;
    status.setContent(daemonStopped ? "daemon stopped" : `live | ${active} active`);
    screen.render();
  };

  const onEvent = (_ev: YimbotEvent) => render();
  bus.on("event", onEvent);
  const refreshTimer = setInterval(render, refreshMs());

  const quit = () => {
    clearInterval(refreshTimer);
    bus.off("event", onEvent);
    screen.destroy();
    opts.onQuit();
  };
  let settingsOpen = false;
  bindQuitKeys(screen, () => settingsOpen, quit);

  bindSettingsKey(screen, () => settingsOpen, () => {
    settingsOpen = true;
    table.hide();
    openSettings(
      screen,
      opts.settings,
      (stopped) => {
        settingsOpen = false;
        daemonStopped = stopped;
        table.show();
        table.focus();
        render();
      },
      daemonStopped,
    );
  });

  bindFlagKey(screen, () => settingsOpen, () => {
    const r = currentRows[table.selected - 1];
    if (!r) return;
    opts.onToggleFlag(r.key, r.label, isFlagged(r));
  });

  table.on("select", () => {
    const r = currentRows[table.selected - 1];
    if (!r) return;
    opts.onOpenSession(r.key, r.label);
  });

  render();
}
