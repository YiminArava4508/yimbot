// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";

export type CardView = { key: string; lines: string[] };

export type CardColumn = {
  widget: any;
  setCards(cards: CardView[]): void;
  selectedKey(): string | null;
  moveSelection(delta: number): void;
  setFocused(focused: boolean): void;
  setLabel(text: string): void;
};

const CARD_GAP = 1;
const QUIET_BORDER = "grey";

export function createCardColumn(opts: { parent: any; onOpen: (key: string) => void; onFocus: () => void }): CardColumn {
  // A scrollable box clips its children to its inner area, so a card that
  // overflows the column is cut at the border instead of drawn past it.
  const widget = blessed.box({
    parent: opts.parent,
    tags: true,
    keyable: true,
    scrollable: true,
    border: { type: "line" },
    style: { border: { fg: QUIET_BORDER }, label: { fg: QUIET_BORDER } },
  });

  let cards: CardView[] = [];
  let boxes: any[] = [];
  let tops: number[] = [];
  let selected = 0;
  let offset = 0;
  let contentHeight = 0;
  let focused = false;

  const cardHeight = (card: CardView) => card.lines.length + 2;

  const paint = () => {
    const accent = focused ? FOCUS_BORDER : QUIET_BORDER;
    widget.style.border.fg = accent;
    widget.style.label.fg = accent;
    boxes.forEach((box, i) => {
      box.style.border.fg = i === selected ? accent : QUIET_BORDER;
    });
  };

  const scrollIntoView = () => {
    const viewport = Math.max(1, widget.height - widget.iheight);
    offset = Math.min(offset, Math.max(0, contentHeight - viewport));
    if (cards.length > 0) {
      const top = tops[selected];
      const bottom = top + cardHeight(cards[selected]);
      if (bottom - offset > viewport) offset = bottom - viewport;
      if (top < offset) offset = top;
    }
    // Driving childBase directly instead of scrollTo: scrollTo clamps against
    // content lines and only nudges by the cursor offset, and this column
    // needs the exact row the selected card starts on.
    widget.childBase = offset;
    widget.childOffset = 0;
  };

  const select = (index: number) => {
    if (cards.length === 0) return;
    selected = Math.min(cards.length - 1, Math.max(0, index));
    paint();
  };

  const setCards = (next: CardView[]) => {
    const key = cards[selected]?.key;
    for (const box of boxes) box.destroy();
    cards = next;
    tops = [];
    let y = 0;
    boxes = next.map((card, i) => {
      tops.push(y);
      const box = blessed.box({
        parent: widget,
        top: y,
        left: 0,
        right: 0,
        height: cardHeight(card),
        tags: true,
        mouse: true,
        border: { type: "line" },
        style: { border: { fg: QUIET_BORDER } },
        content: card.lines.join("\n"),
      });
      box.on("click", () => {
        select(i);
        opts.onFocus();
        widget.screen.render();
      });
      y += cardHeight(card) + CARD_GAP;
      return box;
    });
    const kept = next.findIndex((c) => c.key === key);
    selected = kept >= 0 ? kept : Math.min(selected, Math.max(0, next.length - 1));
    contentHeight = Math.max(0, y - CARD_GAP);
    paint();
  };

  // Scrolling runs on every render so a resize from the caller's layout
  // still keeps the selected card in view.
  widget.on("prerender", scrollIntoView);

  widget.on("keypress", (ch: string, key: { name?: string }) => {
    if (cards.length === 0) return;
    if (ch === "G") {
      select(cards.length - 1);
    } else if (key.name === "j" || key.name === "down") {
      select(selected + 1);
    } else if (key.name === "k" || key.name === "up") {
      select(selected - 1);
    } else if (key.name === "g") {
      select(0);
    } else if (key.name === "enter") {
      opts.onOpen(cards[selected].key);
      return;
    } else {
      return;
    }
    widget.screen.render();
  });

  return {
    widget,
    setCards,
    selectedKey: () => cards[selected]?.key ?? null,
    moveSelection: (delta) => select(selected + delta),
    setFocused: (value) => {
      focused = value;
      paint();
    },
    setLabel: (text) => widget.setLabel(text),
  };
}
