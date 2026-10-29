import type { BoardRow } from "./events.ts";
import type { CycleBoard } from "./linear-api.ts";

export type Card = { key: string; title: string; stateName: string; row: BoardRow | null };
export type Column = { id: string; title: string; cards: Card[] };

const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const HIDDEN_WHEN_EMPTY = new Set(["triage", "canceled"]);

function typeRank(type: string): number {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

export function pickRow(rows: BoardRow[], identifier: string): BoardRow | null {
  const matches = rows.filter((r) => r.label === identifier);
  return matches.find((r) => !r.terminal) ?? matches[0] ?? null;
}

export function buildColumns(board: CycleBoard, rows: BoardRow[]): Column[] {
  const states = [...board.states].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position,
  );
  const columns: Column[] = [];
  for (const state of states) {
    const cards = board.issues
      .filter((i) => i.stateId === state.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => ({
        key: i.identifier,
        title: i.title,
        stateName: state.name,
        row: pickRow(rows, i.identifier),
      }));
    if (cards.length === 0 && HIDDEN_WHEN_EMPTY.has(state.type)) continue;
    columns.push({ id: state.id, title: state.name, cards });
  }
  return columns;
}
