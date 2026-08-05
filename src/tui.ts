// src/tui.ts
// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { bus, readEvents, reduceRows, type BoardRow, type YimbotEvent } from "./events.ts";

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

export function runTui(opts: { onQuit: () => void }): void {
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
    const rows = reduceRows(readEvents(), Date.now());
    table.setData(rowsToTable(rows));
    const active = rows.filter((r) => !r.terminal).length;
    status.setContent(`live | ${active} active`);
    screen.render();
  };

  const onEvent = (_ev: YimbotEvent) => render();
  bus.on("event", onEvent);

  const quit = () => {
    bus.off("event", onEvent);
    screen.destroy();
    opts.onQuit();
  };
  screen.key(["q", "escape", "C-c"], quit);

  render();
}
