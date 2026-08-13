import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import blessed from "neo-blessed";
import { openSettings, rowsToLines, settingsFooterHint, settingsPanelLayout, type SettingsDeps } from "./tui-settings.ts";
import type { SettingRow, YimbotConfig } from "./settings-model.ts";
import type { ApplyResult } from "./settings-apply.ts";

const rows: SettingRow[] = [
  { envKey: "LINEAR_TEAM_NAME", label: "team", editor: "pickTeam", value: "Engineering", display: "Engineering" },
  { envKey: "MAX_IN_PROGRESS", label: "wip cap", editor: "number", value: "9", display: "9" },
  { envKey: "CODEBASE_PATH", label: "codebase path", editor: "text", value: "/nope", display: "/nope" },
];

test("rowsToLines pads labels into one column and marks dirty rows", () => {
  const lines = rowsToLines(rows, ["MAX_IN_PROGRESS"], {});
  assert.equal(lines.length, 3);
  // Every value starts at the same column: the label field is padded to 20.
  for (const [i, line] of lines.entries()) {
    assert.equal(line.slice(0, 20), rows[i].label.padEnd(20, " "));
  }
  assert.equal(lines[0].includes("Engineering"), true);
  assert.match(lines[1], /\*/);
  assert.equal(lines[0].includes("*"), false);
});

test("rowsToLines shows a row's error instead of hiding it", () => {
  const lines = rowsToLines(rows, ["CODEBASE_PATH"], { CODEBASE_PATH: "must be an existing git repository" });
  assert.match(lines[2], /must be an existing git repository/);
});

test("settingsFooterHint names the exits and only offers a write when dirty", () => {
  assert.match(settingsFooterHint(0, false), /esc back/);
  assert.equal(settingsFooterHint(0, false).includes("w write"), false);
  assert.match(settingsFooterHint(2, false), /w write \+ restart \(2 changed\)/);
  assert.match(settingsFooterHint(1, true), /enter accept/);
});

test("settingsPanelLayout fills the screen between the header and the footer", () => {
  const l = settingsPanelLayout();
  assert.equal(l.top, 1);
  assert.equal(l.bottom, 1);
  assert.equal(l.width, "100%");
  assert.equal(l.tags, true);
});

// A minimal EventEmitter standing in for a TTY stream, mirroring the harness in
// tui.test.ts, sized so blessed renders headlessly without touching a real fd.
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

function testScreen() {
  const { input, output } = fakeTty(80, 24);
  return blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
}

const baseConfig: YimbotConfig = {
  apiKey: "key-1234567890",
  teamName: "Engineering",
  deployStateName: "In Progress",
  reviewStateName: "In Review",
  todoStateName: "Todo",
  heartbeatIntervalMinutes: 3,
  codebasePath: process.cwd(),
  planModel: "opus",
  implModel: "sonnet",
  autoClaim: true,
  riskLabels: ["migration"],
  maxInProgress: 3,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "",
};

function testDeps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    loadConfig: () => baseConfig,
    assignee: () => Promise.resolve("bot@example.com"),
    teams: () => Promise.resolve(["Engineering", "Design"]),
    states: () => Promise.resolve(["Todo", "In Progress"]),
    labels: () => Promise.resolve(["bug", "feature"]),
    apply: () => Promise.resolve({ ok: true } as ApplyResult),
    ...overrides,
  };
}

// Emit a keypress on the currently focused widget, matching how the real
// screen dispatches: screen.js only forwards keypress to screen.focused, so
// this exercises exactly the routing openSettings' key handlers rely on.
function press(screen: any, name: string) {
  screen.focused.emit("keypress", name.length === 1 ? name : "", { name, full: name });
}

test("openSettings paints every row on open", () => {
  const screen = testScreen();
  openSettings(screen, testDeps(), () => {});
  const list = screen.children.find((c: any) => c.type === "list");
  assert.ok(list);
  assert.equal(list.items.length > 10, true);
  screen.destroy();
});

test("openSettings: esc on a clean draft closes immediately", () => {
  const screen = testScreen();
  let closed = false;
  openSettings(screen, testDeps(), () => {
    closed = true;
  });
  press(screen, "escape");
  assert.equal(closed, true);
});

test("openSettings: w with an invalid draft never calls apply", async () => {
  const screen = testScreen();
  let applied = false;
  openSettings(
    screen,
    testDeps({
      apply: () => {
        applied = true;
        return Promise.resolve({ ok: true } as ApplyResult);
      },
    }),
    () => {},
  );
  const list = screen.children.find((c: any) => c.type === "list");
  const wipIndex = list.ritems.findIndex((l: string) => l.startsWith("wip cap".padEnd(20, " ")));
  list.select(wipIndex);
  press(screen, "enter"); // opens the wip-cap textbox, prefilled with "3"
  await new Promise((r) => setImmediate(r)); // let readInput attach its keypress listener
  press(screen, "backspace"); // clear the prefilled "3"
  press(screen, "-");
  press(screen, "1");
  press(screen, "enter"); // submit "-1": not a positive integer
  assert.match(list.ritems[wipIndex], /must be a positive integer/);
  press(screen, "w");
  await new Promise((r) => setImmediate(r));
  assert.equal(applied, false, "an invalid draft must never reach apply");
  screen.destroy();
});

test("openSettings: submitting a valid textbox edit reaches the draft and w applies it", async () => {
  const screen = testScreen();
  let applied: YimbotConfig | undefined;
  openSettings(
    screen,
    testDeps({
      apply: (next) => {
        applied = next;
        return Promise.resolve({ ok: true } as ApplyResult);
      },
    }),
    () => {},
  );
  const list = screen.children.find((c: any) => c.type === "list");
  const wipIndex = list.ritems.findIndex((l: string) => l.startsWith("wip cap".padEnd(20, " ")));
  list.select(wipIndex);
  press(screen, "enter"); // opens the wip-cap textbox, prefilled with "3"
  await new Promise((r) => setImmediate(r)); // let readInput attach its keypress listener
  press(screen, "backspace");
  press(screen, "5");
  press(screen, "enter"); // submit "5"
  assert.match(list.ritems[wipIndex], /\{yellow-fg\}5 \*\{\/yellow-fg\}/, "the submitted value must land in the draft, dirtying the row");
  press(screen, "w");
  await new Promise((r) => setImmediate(r));
  assert.equal(applied?.maxInProgress, 5, "the edit reaches apply's next config");
  screen.destroy();
});

test("openSettings: esc twice discards a dirty draft and closes", () => {
  const screen = testScreen();
  let closed = false;
  const deps = testDeps();
  openSettings(screen, deps, () => {
    closed = true;
  });
  const list = screen.children.find((c: any) => c.type === "list");
  // Toggle-edit the auto-claim row directly by simulating enter on it, then
  // confirm the double-esc discard sequence.
  list.select(list.ritems.findIndex((l: string) => l.startsWith("auto-claim".padEnd(20, " "))));
  press(screen, "enter");
  press(screen, "escape");
  assert.equal(closed, false, "first esc on a dirty draft should warn, not close");
  press(screen, "escape");
  assert.equal(closed, true, "second esc should discard and close");
  screen.destroy();
});

test("openSettings: a failed apply keeps the dirty draft and reports the error", async () => {
  const screen = testScreen();
  let closed = false;
  let applyCalls = 0;
  const deps = testDeps({
    apply: () => {
      applyCalls++;
      return Promise.resolve({ ok: false, error: "boom", rolledBack: false } as ApplyResult);
    },
  });
  openSettings(screen, deps, () => {
    closed = true;
  });
  const list = screen.children.find((c: any) => c.type === "list");
  list.select(list.ritems.findIndex((l: string) => l.startsWith("auto-claim".padEnd(20, " "))));
  press(screen, "enter"); // toggle auto-claim, dirtying the draft
  press(screen, "w");
  await new Promise((r) => setImmediate(r));
  const footer = screen.children.find((c: any) => c.type === "text");
  assert.match(footer.getContent(), /boom/);
  assert.match(footer.getContent(), /daemon stopped/);
  assert.equal(applyCalls, 1);
  // the failed write must not have discarded the edit: esc on the still-dirty
  // draft should warn once rather than closing straight away.
  press(screen, "escape");
  assert.equal(closed, false, "a failed apply must leave the draft dirty");
  screen.destroy();
});

test("openSettings: a rejected apply clears applying so the panel is usable afterwards", async () => {
  const screen = testScreen();
  let applyCalls = 0;
  const deps = testDeps({
    apply: () => {
      applyCalls++;
      return applyCalls === 1
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ ok: true } as ApplyResult);
    },
  });
  openSettings(screen, deps, () => {});
  const list = screen.children.find((c: any) => c.type === "list");
  list.select(list.ritems.findIndex((l: string) => l.startsWith("auto-claim".padEnd(20, " "))));
  press(screen, "enter"); // toggle auto-claim, dirtying the draft
  press(screen, "w"); // first write rejects outright, not { ok: false }
  await new Promise((r) => setImmediate(r));
  const footer = screen.children.find((c: any) => c.type === "text");
  assert.match(footer.getContent(), /network down/);
  assert.match(footer.getContent(), /daemon stopped/);
  // the panel must not be frozen by the unreset `applying` flag: a second
  // write attempt still reaches apply.
  press(screen, "w");
  await new Promise((r) => setImmediate(r));
  assert.equal(applyCalls, 2, "applying must have been cleared after the rejection");
  screen.destroy();
});

test("openSettings: a second edit attempt during an in-flight picker fetch does not open a second widget", async () => {
  const screen = testScreen();
  let resolveTeams: (v: string[]) => void = () => {};
  const deps = testDeps({
    teams: () =>
      new Promise((resolve) => {
        resolveTeams = resolve;
      }),
  });
  openSettings(screen, deps, () => {});
  const list = screen.children.find((c: any) => c.type === "list");
  const floating = () => screen.children.filter((c: any) => c !== list && c.type !== "text");

  const teamIndex = list.ritems.findIndex((l: string) => l.startsWith("team".padEnd(20, " ")));
  list.select(teamIndex);
  press(screen, "enter"); // starts the team fetch; list stays focused while it's pending

  const wipIndex = list.ritems.findIndex((l: string) => l.startsWith("wip cap".padEnd(20, " ")));
  list.select(wipIndex);
  press(screen, "enter"); // a second edit attempt on a different row, still mid-fetch
  assert.equal(floating().length, 0, "no widget should attach while the first fetch is still pending");

  resolveTeams(["Engineering"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(floating().length, 1, "exactly one picker should attach once the fetch resolves");
  screen.destroy();
});

test("openSettings: escape during an in-flight picker fetch does not close the panel", async () => {
  const screen = testScreen();
  let resolveTeams: (v: string[]) => void = () => {};
  let closed = false;
  const deps = testDeps({
    teams: () =>
      new Promise((resolve) => {
        resolveTeams = resolve;
      }),
  });
  openSettings(screen, deps, () => {
    closed = true;
  });
  const list = screen.children.find((c: any) => c.type === "list");
  const teamIndex = list.ritems.findIndex((l: string) => l.startsWith("team".padEnd(20, " ")));
  list.select(teamIndex);
  press(screen, "enter");
  press(screen, "escape");
  assert.equal(closed, false, "escape must be inert while an edit's fetch is in flight");
  resolveTeams(["Engineering"]);
  await new Promise((r) => setImmediate(r));
  screen.destroy();
});

// The picker-fetch analogue of this race ("a picker fetch resolving after
// close attaches nothing") is unreachable through the public API once
// escape is gated on `editing` (the test above proves that gate holds): a
// picker fetch can now only still be in flight while the panel is open. The
// one fetch that is genuinely in flight before any edit gate applies is the
// initial assignee() lookup kicked off at open, which a clean-draft escape
// can race — so that is what this test exercises, covering the same
// `closed` guard defensively added to every async callback.
test("openSettings: the initial assignee lookup resolving after the panel closed does not repaint or throw", async () => {
  const screen = testScreen();
  let resolveAssignee: (v: string) => void = () => {};
  let closed = false;
  const deps = testDeps({
    assignee: () =>
      new Promise((resolve) => {
        resolveAssignee = resolve;
      }),
  });
  openSettings(screen, deps, () => {
    closed = true;
  });
  press(screen, "escape"); // draft is clean: closes immediately, before assignee() resolves
  assert.equal(closed, true);
  resolveAssignee("bot@example.com");
  await new Promise((r) => setImmediate(r));
  screen.destroy();
});

test("openSettings: the footer stops reading 'loading...' once a remote picker actually opens", async () => {
  const screen = testScreen();
  const deps = testDeps();
  openSettings(screen, deps, () => {});
  const list = screen.children.find((c: any) => c.type === "list");
  const teamIndex = list.ritems.findIndex((l: string) => l.startsWith("team".padEnd(20, " ")));
  list.select(teamIndex);
  press(screen, "enter");
  const footer = screen.children.find((c: any) => c.type === "text");
  assert.match(footer.getContent(), /loading/);
  await new Promise((r) => setImmediate(r)); // let the already-resolved teams() promise settle
  assert.doesNotMatch(footer.getContent(), /loading/);
  assert.match(footer.getContent(), /enter accept/);
  screen.destroy();
});
