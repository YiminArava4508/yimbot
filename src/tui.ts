// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { envOr } from "./env.ts";
import { bus, filterToLiveWorktrees, readEvents, reduceRows, type BoardRow, type YimbotEvent } from "./events.ts";

// How often the board repaints on its own, independent of daemon events. Without
// it the TUI freezes on its last paint between events: time-based row pruning
// never advances, and after the machine sleeps the whole board stays stale until
// the next event fires (which can be a full heartbeat away). A wall-clock timer
// also catches up on wake, so the board refreshes within seconds of resuming.
function refreshMs(): number {
  const n = Number(envOr("TUI_REFRESH_MS", "5000"));
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function rowsToTable(rows: BoardRow[]): string[][] {
  const header = ["TIME", "STATUS", "TICKET", "PR", "TITLE"];
  const body = rows.map((r) => [
    fmtTime(r.ts),
    r.terminal ? `{grey-fg}${r.status}{/grey-fg}` : r.status,
    r.label,
    r.pr != null ? `#${r.pr}` : "",
    r.title ?? "",
  ]);
  return [header, ...body];
}

export function runTui(opts: { onQuit: () => void; liveKeys: () => Set<string> }): void {
  const screen = blessed.screen({ smartCSR: true, title: "yimbot", fullUnicode: true });

  const table = blessed.listtable({
    parent: screen,
    top: 1,
    left: 0,
    right: 0,
    bottom: 0,
    tags: true,
    align: "left",
    style: { header: { bold: true }, cell: {} },
  });

  const title = blessed.text({ parent: screen, top: 0, left: 0, content: "yimbot" });
  const status = blessed.text({ parent: screen, top: 0, right: 0, content: "live" });

  const render = () => {
    const rows = filterToLiveWorktrees(reduceRows(readEvents(), Date.now()), opts.liveKeys());
    table.setData(rowsToTable(rows));
    const active = rows.filter((r) => !r.terminal).length;
    status.setContent(`live | ${active} active`);
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
  screen.key(["q", "escape", "C-c"], quit);

  render();
}
