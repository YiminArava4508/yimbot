import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { FOCUS_BORDER } from "./arch-layout.ts";
import { createCardColumn, type CardView } from "./tui-cards.ts";

function fakeTty(columns: number, rows: number) {
  class FakeStream extends EventEmitter {
    columns = columns;
    rows = rows;
    isTTY = true;
    writable = true;
    write() {
      return true;
    }
    setRawMode() {}
    pause() {}
    resume() {}
    ref() {}
    unref() {}
    end() {}
  }
  return { input: new FakeStream(), output: new FakeStream() };
}

function testScreen(rows = 24) {
  const { input, output } = fakeTty(40, rows);
  return blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
}

function press(screen: any, name: string) {
  screen.focused.emit("keypress", name.length === 1 ? name : "", { name, full: name });
}

function screenText(screen: any): string[] {
  return screen.lines.map((line: any[]) => line.map((cell) => cell[1]).join(""));
}

function cards(n: number): CardView[] {
  return Array.from({ length: n }, (_, i) => ({ key: `ENG-${i}`, lines: [`title ${i}`, `state ${i}`] }));
}

function column(rows = 24) {
  const screen = testScreen(rows);
  const opened: string[] = [];
  let focused = 0;
  const col = createCardColumn({ parent: screen, onOpen: (k) => opened.push(k), onFocus: () => focused++ });
  col.widget.position.top = 0;
  col.widget.position.left = 0;
  col.widget.position.width = 30;
  col.widget.position.height = rows;
  return { screen, col, opened, focusCount: () => focused };
}

test("a scrollable bordered box clips a child box that overflows it", () => {
  const screen = testScreen(20);
  const parent = blessed.box({ parent: screen, top: 0, left: 0, width: 20, height: 6, border: { type: "line" }, scrollable: true });
  blessed.box({ parent, top: 2, left: 0, width: 18, height: 5, border: { type: "line" }, content: "AAAA\nBBBB\nCCCC" });
  screen.render();
  const text = screenText(screen);
  assert.match(text[4], /AAAA/);
  assert.equal(text.some((l) => l.includes("BBBB")), false);
  screen.destroy();
});

test("setCards selects the first card and selectedKey returns its key", () => {
  const { screen, col } = column();
  assert.equal(col.selectedKey(), null);
  col.setCards(cards(3));
  assert.equal(col.selectedKey(), "ENG-0");
  screen.destroy();
});

test("moveSelection moves down and up and clamps at both ends", () => {
  const { screen, col } = column();
  col.setCards(cards(3));
  col.moveSelection(1);
  assert.equal(col.selectedKey(), "ENG-1");
  col.moveSelection(5);
  assert.equal(col.selectedKey(), "ENG-2");
  col.moveSelection(-1);
  assert.equal(col.selectedKey(), "ENG-1");
  col.moveSelection(-9);
  assert.equal(col.selectedKey(), "ENG-0");
  screen.destroy();
});

test("setCards keeps the selection on the same key after the cards reorder", () => {
  const { screen, col } = column();
  col.setCards(cards(3));
  col.moveSelection(1);
  col.setCards([...cards(3)].reverse());
  assert.equal(col.selectedKey(), "ENG-1");
  screen.destroy();
});

test("setCards clamps to the last card when the selected key is gone", () => {
  const { screen, col } = column();
  col.setCards(cards(4));
  col.moveSelection(3);
  col.setCards(cards(2));
  assert.equal(col.selectedKey(), "ENG-1");
  col.setCards([]);
  assert.equal(col.selectedKey(), null);
  screen.destroy();
});

test("a column taller than the viewport keeps the selected card in view while moving down", () => {
  const { screen, col } = column(12);
  col.setCards(cards(6));
  col.widget.focus();
  screen.render();
  for (let i = 0; i < 6; i++) {
    const text = screenText(screen);
    assert.equal(col.selectedKey(), `ENG-${i}`);
    assert.ok(text.some((l) => l.includes(`title ${i}`)), `title ${i} visible`);
    assert.ok(text.some((l) => l.includes(`state ${i}`)), `state ${i} visible`);
    press(screen, "j");
  }
  for (let i = 5; i >= 0; i--) {
    assert.equal(col.selectedKey(), `ENG-${i}`);
    assert.ok(screenText(screen).some((l) => l.includes(`title ${i}`)), `title ${i} visible going up`);
    press(screen, "k");
  }
  press(screen, "G");
  assert.equal(col.selectedKey(), "ENG-5");
  assert.ok(screenText(screen).some((l) => l.includes("title 5")));
  press(screen, "g");
  assert.equal(col.selectedKey(), "ENG-0");
  assert.ok(screenText(screen).some((l) => l.includes("title 0")));
  screen.destroy();
});

test("cards are separated by one blank line", () => {
  const { screen, col } = column();
  col.setCards(cards(2));
  screen.render();
  const text = screenText(screen);
  const firstEnd = text.findIndex((l) => l.includes("state 0")) + 1;
  const secondTitle = text.findIndex((l) => l.includes("title 1"));
  // card bottom border, one blank line, next card top border, then its title
  assert.equal(secondTitle - firstEnd, 3);
  assert.equal(text[firstEnd + 1].slice(1, 29).trim(), "");
  screen.destroy();
});

test("enter calls onOpen with the selected key; on an empty column j, k and enter do nothing and do not throw", () => {
  const { screen, col, opened } = column();
  col.widget.focus();
  press(screen, "j");
  press(screen, "k");
  press(screen, "enter");
  assert.deepEqual(opened, []);
  assert.equal(col.selectedKey(), null);
  col.setCards(cards(3));
  press(screen, "down");
  press(screen, "enter");
  assert.deepEqual(opened, ["ENG-1"]);
  screen.destroy();
});

test("a click on the second card selects it and calls onFocus", () => {
  const { screen, col, focusCount } = column();
  col.setCards(cards(3));
  screen.render();
  const y = screenText(screen).findIndex((l) => l.includes("title 1"));
  screen.program.emit("mouse", { action: "mousedown", button: "left", x: 5, y });
  screen.program.emit("mouse", { action: "mouseup", button: "left", x: 5, y });
  assert.equal(col.selectedKey(), "ENG-1");
  assert.equal(focusCount(), 1);
  screen.destroy();
});

test("setFocused toggles the border color between cyan and grey", () => {
  const { screen, col } = column();
  col.setCards(cards(2));
  col.setFocused(true);
  assert.equal(col.widget.style.border.fg, FOCUS_BORDER);
  const [selected, other] = col.widget.children;
  assert.equal(selected.style.border.fg, FOCUS_BORDER);
  assert.equal(other.style.border.fg, "grey");
  col.setFocused(false);
  assert.equal(col.widget.style.border.fg, "grey");
  assert.equal(selected.style.border.fg, "grey");
  screen.destroy();
});

test("setLabel sets the column label", () => {
  const { screen, col } = column();
  col.setLabel("Todo 3");
  screen.render();
  assert.match(screenText(screen)[0], /Todo 3/);
  screen.destroy();
});
