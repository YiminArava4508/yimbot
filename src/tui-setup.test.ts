import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import blessed from "neo-blessed";
import type { PtyLike } from "./claude-sessions.ts";
import type { ApplyResult } from "./settings-apply.ts";
import type { YimbotConfig } from "./settings-model.ts";
import { PREREQUISITES, fixCommandFor, type CheckResult } from "./setup-core.ts";
import { tempDir } from "./test-temp.ts";
import type { SettingsDeps } from "./tui-settings.ts";
import { configureError, linearConfigError, linkLines, openSetup, tooSmallMessage, type SetupDeps } from "./tui-setup.ts";

const KEY = "lin_api_SECRETKEY0123456789";

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

function testScreen(cols = 80, rows = 24) {
  const { input, output } = fakeTty(cols, rows);
  return blessed.screen({ input, output, terminal: "xterm", smartCSR: true, fullUnicode: true });
}

const baseConfig: YimbotConfig = {
  apiKey: KEY,
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
  claimsPerHeartbeat: 1,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "",
  maxEstimate: "",
  autoRefine: true,
  refineUsers: "",
  refineLabelFilter: "",
  maxRefining: 1,
  splitTickets: true,
};

function settingsDeps(): SettingsDeps {
  return {
    loadConfig: () => {
      throw new Error("the wizard seeds the panel from its own draft");
    },
    assignee: () => Promise.resolve("Ada"),
    teams: () => Promise.resolve(["Engineering"]),
    states: () => Promise.resolve(["Todo", "In Progress", "In Review"]),
    labels: () => Promise.resolve([]),
    apply: () => Promise.reject(new Error("the wizard supplies its own apply")),
  };
}

function results(missing: string[]): CheckResult[] {
  return PREREQUISITES.map((pr) => ({ pr, ok: !missing.includes(pr.key) }));
}

function prereq(key: string) {
  const pr = PREREQUISITES.find((p) => p.key === key);
  if (!pr) throw new Error(key);
  return pr;
}

function fakePty() {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let kills = 0;
  let exitCb: (code: number | undefined) => void = () => {};
  const dataCbs: Array<(d: string) => void> = [];
  const pty: PtyLike = {
    write: (d) => void writes.push(d),
    resize: (c, r) => void resizes.push([c, r]),
    kill: () => void kills++,
    onData: (cb) => {
      dataCbs.push(cb);
      return { dispose() {} };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose() {} };
    },
  };
  return { pty, writes, resizes, kills: () => kills, exit: (c?: number) => exitCb(c), data: (d: string) => dataCbs.forEach((cb) => cb(d)) };
}

type Opts = Partial<SetupDeps> & { checks?: CheckResult[][]; cols?: number; rows?: number };

function harness(o: Opts = {}) {
  const { checks = [results([])], cols, rows, ...overrides } = o;
  const ptys: Array<ReturnType<typeof fakePty>> = [];
  // openCommandPane hands a custom spawn the FULL argv (command first) as its
  // second parameter, unlike spawnClaudePty where args excludes the command.
  const spawned: Array<{ cwd: string; argv: string[]; cols: number; rows: number }> = [];
  const finished: YimbotConfig[] = [];
  const done: Array<{ config: YimbotConfig } | null> = [];
  let checkCalls = 0;
  const deps: SetupDeps = {
    initial: baseConfig,
    checkAll: async () => {
      const r = checks[Math.min(checkCalls, checks.length - 1)];
      checkCalls++;
      return r;
    },
    pm: "pacman",
    spawn: (cwd, argv, c, r) => {
      const f = fakePty();
      ptys.push(f);
      spawned.push({ cwd, argv, cols: c, rows: r });
      return f.pty;
    },
    validateKey: async (raw) =>
      raw.trim() === KEY ? { ok: true, apiKey: KEY, viewerName: "Ada" } : { ok: false, error: "Authentication failed" },
    settings: () => settingsDeps(),
    finish: (c) => {
      finished.push(c);
      return { ok: true, linkResults: [] };
    },
    ...overrides,
  };
  const screen: any = testScreen(cols, rows);
  openSetup(screen, deps, (r) => void done.push(r));
  return { screen, ptys, spawned, finished, done, checkCalls: () => checkCalls };
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// Routes through the program like a real keystroke, so screen-level keys
// (C-c) and the focused widget both see it.
function press(screen: any, name: string, extra: Record<string, unknown> = {}) {
  const ch = name.length === 1 ? name : "";
  screen.program.emit("keypress", ch, { name, full: name, sequence: ch, ...extra });
}

const ctrlC = (screen: any) => screen.program.emit("keypress", "\u0003", { name: "c", ctrl: true, full: "C-c", sequence: "\u0003" });
const ctrlBracket = (screen: any) =>
  screen.program.emit("keypress", "\u001d", { name: "]", ctrl: true, full: "C-]", sequence: "\u001d" });

function type(screen: any, text: string) {
  for (const c of text) press(screen, c);
}

function screenText(screen: any): string {
  screen.render();
  return screen.lines.map((line: Array<[number, string]>) => line.map((cell) => cell[1]).join("")).join("\n");
}

async function toKeyStep(h: ReturnType<typeof harness>) {
  await flush();
  press(h.screen, "enter");
  await flush();
}

async function toConfigure(h: ReturnType<typeof harness>) {
  await toKeyStep(h);
  press(h.screen, "enter");
  await flush();
}

async function toConfirm(h: ReturnType<typeof harness>) {
  await toConfigure(h);
  press(h.screen, "w");
  await flush();
  press(h.screen, "escape");
  await flush();
}

test("linkLines counts link states and names every link that is not ours", () => {
  const lines = linkLines([
    { source: "/nonexistent/a", target: "/nonexistent/yimbot-wizard-a", label: "launcher a" },
    { source: "/nonexistent/b", target: "/nonexistent/yimbot-wizard-b", label: "launcher b" },
  ]);
  assert.equal(lines[0], "Host links: 0 linked, 2 to create, 0 left as-is");
  assert.deepEqual(lines.slice(1), ["  [missing] launcher a", "  [missing] launcher b"]);
});

test("configureError requires the unset rows and the verified key", () => {
  assert.equal(configureError(baseConfig, KEY), null);
  assert.equal(configureError({ ...baseConfig, teamName: " " }, KEY), "team cannot be empty");
  assert.equal(configureError({ ...baseConfig, todoStateName: "" }, KEY), "todo state cannot be empty");
  assert.equal(configureError({ ...baseConfig, codebasePath: "" }, KEY), "codebase path cannot be empty");
  assert.equal(configureError(baseConfig, "lin_api_other"), "change the key on the Linear key step");
});

const linear = (teams: string[], states: string[]) => ({
  teams: () => Promise.resolve(teams),
  states: () => Promise.resolve(states),
});

test("linearConfigError accepts a team and states Linear has, matching case like the daemon", async () => {
  assert.equal(await linearConfigError(baseConfig, linear(["engineering"], ["todo", "IN PROGRESS", "In Review"])), null);
});

test("linearConfigError names a team Linear does not have", async () => {
  const error = await linearConfigError(baseConfig, linear(["Platform"], ["Todo", "In Progress", "In Review"]));
  assert.equal(error, 'Linear has no team named "Engineering"');
});

test("linearConfigError names the first state the team does not have", async () => {
  const c = { ...baseConfig, teamName: "Platform" };
  const error = await linearConfigError(c, linear(["Platform"], ["Backlog", "Doing", "In Review"]));
  assert.equal(error, 'team "Platform" has no deploy state named "In Progress"');
});

test("linearConfigError reports a failed lookup instead of rejecting", async () => {
  const error = await linearConfigError(baseConfig, {
    teams: () => Promise.reject(new Error("network down")),
    states: () => Promise.resolve([]),
  });
  assert.equal(error, "could not check the team against Linear: network down");
});

test("tooSmallMessage is null at the minimum and names the size below it", () => {
  const min = { cols: 80, rows: 24 };
  assert.equal(tooSmallMessage(80, 24, min), null);
  assert.equal(tooSmallMessage(79, 24, min), "Resize the terminal to at least 80x24 (now 79x24)");
  assert.equal(tooSmallMessage(80, 23, min), "Resize the terminal to at least 80x24 (now 80x23)");
});

test("prereqs: shows a checking state, then [ok]/[missing] per item and the fix choice", async () => {
  const h = harness({ checks: [results(["tmux"])] });
  assert.match(screenText(h.screen), /checking/i);
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /Step 1 of 4/);
  assert.match(text, /\[ok\]\s+git/);
  assert.match(text, /\[missing\] tmux/);
  assert.match(text, /Fix everything for me/);
  assert.match(text, /Go step by step/);
  h.screen.destroy();
});

test("prereqs: fix everything runs the first failing item's fix argv in the pane, then re-checks", async () => {
  const h = harness({ checks: [results(["tmux", "gh"]), results(["gh"]), results([])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].argv, fixCommandFor(prereq("tmux"), "pacman"));
  assert.equal(h.checkCalls(), 1);
  h.ptys[0].exit(0);
  await flush();
  assert.ok(h.checkCalls() >= 2, "exit re-runs checkAll");
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.spawned[1].argv, fixCommandFor(prereq("gh"), "pacman"));
  h.ptys[1].exit(0);
  await flush();
  const text = screenText(h.screen);
  assert.doesNotMatch(text, /\[missing\]/);
  h.screen.destroy();
});

test("prereqs: a failing fix shows the label and exit code, stops the walk and keeps the output", async () => {
  const h = harness({ checks: [results(["tmux", "gh"])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  h.ptys[0].data("install exploded\r\n");
  await new Promise((r) => setTimeout(r, 80));
  h.ptys[0].exit(1);
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /tmux failed \(exit 1\)/);
  assert.match(text, /install exploded/);
  assert.equal(h.spawned.length, 1, "the walk stops at the failing item");
  h.screen.destroy();
});

test("prereqs: enter is blocked while a required item fails", async () => {
  const h = harness({ checks: [results(["tmux"])] });
  await flush();
  press(h.screen, "j");
  press(h.screen, "enter");
  await flush();
  assert.match(screenText(h.screen), /\[missing\] tmux/);
  press(h.screen, "enter");
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /Step 1 of 4/);
  assert.match(text, /required/i);
  h.screen.destroy();
});

test("prereqs: keys go to the running pane and C-] returns focus to the wizard", async () => {
  const h = harness({ checks: [results(["tmux"])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  press(h.screen, "y");
  ctrlC(h.screen);
  assert.deepEqual(h.ptys[0].writes, ["y", "\u0003"], "C-c is the child's interrupt while the pane has focus");
  assert.deepEqual(h.done, []);
  const paneFocus = h.screen.focused;
  ctrlBracket(h.screen);
  assert.notEqual(h.screen.focused, paneFocus);
  press(h.screen, "z");
  assert.deepEqual(h.ptys[0].writes, ["y", "\u0003"]);
  h.screen.destroy();
});

test("ctrl+c from the wizard kills a running pane child and reports null", async () => {
  const h = harness({ checks: [results(["tmux"])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  ctrlBracket(h.screen);
  ctrlC(h.screen);
  assert.equal(h.ptys[0].kills(), 1);
  assert.deepEqual(h.done, [null]);
  h.screen.destroy();
});

test("key: typed characters show as * and a rejected key shows the error and stays", async () => {
  const h = harness({ initial: { ...baseConfig, apiKey: "" } });
  await toKeyStep(h);
  assert.match(screenText(h.screen), /Step 2 of 4/);
  type(h.screen, "zq9x");
  let text = screenText(h.screen);
  assert.match(text, /\*\*\*\*/);
  assert.doesNotMatch(text, /zq9x/);
  press(h.screen, "enter");
  await flush();
  text = screenText(h.screen);
  assert.match(text, /Authentication failed/);
  assert.match(text, /Step 2 of 4/);
  type(h.screen, KEY);
  text = screenText(h.screen);
  assert.equal(text.includes(KEY), false);
  assert.match(text, new RegExp(`\\*{${KEY.length}}`));
  press(h.screen, "enter");
  await flush();
  assert.match(screenText(h.screen), /Step 3 of 4/);
  h.screen.destroy();
});

test("ctrl+c while the key input reads still quits", async () => {
  const h = harness();
  await toKeyStep(h);
  ctrlC(h.screen);
  assert.deepEqual(h.done, [null]);
  assert.equal(h.screen.grabKeys, false);
  h.screen.destroy();
});

test("configure: opens the settings panel in collect mode and advances only after a save", async () => {
  const h = harness();
  await toConfigure(h);
  let text = screenText(h.screen);
  assert.match(text, /Step 3 of 4/);
  assert.match(text, /linear api key/);
  assert.equal(text.includes(KEY), false);
  press(h.screen, "w");
  await flush();
  text = screenText(h.screen);
  assert.match(text, /saved/);
  assert.doesNotMatch(text, /daemon/);
  press(h.screen, "escape");
  await flush();
  assert.match(screenText(h.screen), /Step 4 of 4/);
  h.screen.destroy();
});

test("configure: a codebase path that is not a git repo blocks the save and esc goes back", async () => {
  const h = harness({ initial: { ...baseConfig, codebasePath: "/nonexistent/yimbot-wizard-test" } });
  await toConfigure(h);
  press(h.screen, "w");
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /codebase path must be an existing git repository/);
  assert.doesNotMatch(text, /daemon/);
  press(h.screen, "escape");
  await flush();
  assert.match(screenText(h.screen), /Step 2 of 4/);
  h.screen.destroy();
});

test("configure: a team whose states do not match Linear blocks the save", async () => {
  const h = harness({
    initial: { ...baseConfig, teamName: "Platform" },
    settings: () => ({ ...settingsDeps(), teams: () => Promise.resolve(["Platform"]), states: () => Promise.resolve(["Backlog"]) }),
  });
  await toConfigure(h);
  press(h.screen, "w");
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /has no deploy state named "In Progress"/);
  press(h.screen, "escape");
  await flush();
  assert.doesNotMatch(screenText(h.screen), /Step 4 of 4/);
  h.screen.destroy();
});

test("confirm: lists link states and the summary without the key; enter finishes", async () => {
  const h = harness();
  await toConfirm(h);
  const text = screenText(h.screen);
  assert.match(text, /Step 4 of 4/);
  assert.match(text, /signed in as Ada/);
  assert.match(text, /Engineering/);
  assert.match(text, /Host links: \d+ linked, \d+ to create, \d+ left as-is/);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(KEY.slice(-4)), false);
  press(h.screen, "enter");
  await flush();
  assert.equal(h.finished.length, 1);
  assert.equal(h.finished[0].apiKey, KEY);
  assert.deepEqual(h.done, [{ config: h.finished[0] }]);
  h.screen.destroy();
});

test("confirm: l backs up a foreign host link file and links it, then refreshes the counts", async () => {
  const dir = tempDir("yimbot-wizard-links-");
  const source = join(dir, "launcher.sh");
  const target = join(dir, "home-launcher.sh");
  writeFileSync(source, "#!/bin/bash\n");
  writeFileSync(target, "mine");
  const h = harness({ links: [{ source, target, label: "test launcher" }], rows: 50 });
  await toConfirm(h);
  let text = screenText(h.screen);
  assert.match(text, /\[other\] test launcher/);
  assert.match(text, /l replace/);
  press(h.screen, "l");
  await flush();
  assert.equal(readlinkSync(target), source);
  assert.equal(readFileSync(`${target}.bak`, "utf8"), "mine");
  text = screenText(h.screen);
  assert.match(text, /Host links: 1 linked, 0 to create, 0 left as-is/);
  assert.doesNotMatch(text, /\[other\]/);
  assert.deepEqual(h.finished, []);
  h.screen.destroy();
});

test("confirm: l leaves missing links for finish to create", async () => {
  const dir = tempDir("yimbot-wizard-links-missing-");
  const source = join(dir, "launcher.sh");
  writeFileSync(source, "#!/bin/bash\n");
  const target = join(dir, "home-launcher.sh");
  const h = harness({ links: [{ source, target, label: "test launcher" }] });
  await toConfirm(h);
  press(h.screen, "l");
  await flush();
  assert.throws(() => lstatSync(target));
  h.screen.destroy();
});

test("confirm: failed host links from finish show before handing over", async () => {
  const finished: YimbotConfig[] = [];
  const h = harness({
    finish: (c) => {
      finished.push(c);
      return { ok: true, linkResults: ["[ok] a linked", "[fail] b: disk on fire"] };
    },
  });
  await toConfirm(h);
  press(h.screen, "enter");
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /\[fail\] b: disk on fire/);
  assert.doesNotMatch(text, /\[ok\] a linked/);
  assert.deepEqual(h.done, []);
  press(h.screen, "enter");
  await flush();
  assert.equal(finished.length, 1, "the second enter hands over without writing again");
  assert.deepEqual(h.done, [{ config: finished[0] }]);
  h.screen.destroy();
});

test("confirm: a failed finish shows the error and stays", async () => {
  const h = harness({ finish: () => ({ ok: false, error: "disk full" }) });
  await toConfirm(h);
  press(h.screen, "enter");
  await flush();
  const text = screenText(h.screen);
  assert.match(text, /disk full/);
  assert.match(text, /Step 4 of 4/);
  assert.deepEqual(h.done, []);
  h.screen.destroy();
});

function resize(screen: any, cols: number, rows: number) {
  screen.program.cols = cols;
  screen.program.rows = rows;
  screen.program.emit("resize");
}

test("resizing below the minimum swaps the body for the too-small message and back", async () => {
  const h = harness();
  await flush();
  resize(h.screen, 70, 24);
  let text = screenText(h.screen);
  assert.match(text, /Resize the terminal to at least 80x24 \(now 70x24\)/);
  assert.doesNotMatch(text, /Step 1 of 4/);
  resize(h.screen, 80, 24);
  text = screenText(h.screen);
  assert.doesNotMatch(text, /Resize the terminal/);
  assert.match(text, /Step 1 of 4/);
  h.screen.destroy();
});

test("a running pane resizes its pty with the screen", async () => {
  const h = harness({ checks: [results(["tmux"])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  const first = h.spawned[0];
  resize(h.screen, 100, 40);
  const last = h.ptys[0].resizes.at(-1);
  assert.ok(last, "pty was resized");
  assert.ok(last[0] > first.cols && last[1] > first.rows);
  h.screen.destroy();
});

test("a screen resize after a finished fix does not touch the exited pty", async () => {
  const h = harness({ checks: [results(["tmux"]), results([])] });
  await flush();
  press(h.screen, "enter");
  await flush();
  h.ptys[0].exit(0);
  await flush();
  h.ptys[0].pty.resize = () => {
    throw new Error("ioctl(2) failed, EBADF");
  };
  assert.doesNotThrow(() => resize(h.screen, 100, 40));
  h.screen.destroy();
});

test("a rejected re-check during fix everything shows the error and frees the step", async () => {
  let calls = 0;
  const h = harness({
    checkAll: async () => {
      calls++;
      if (calls === 1) return results(["tmux"]);
      throw new Error("probe exploded");
    },
  });
  await flush();
  press(h.screen, "enter");
  await flush();
  h.ptys[0].exit(0);
  await flush();
  assert.match(screenText(h.screen), /probe exploded/);
  press(h.screen, "j");
  press(h.screen, "f");
  await flush();
  assert.equal(h.spawned.length, 2, "walking was reset, so f starts a new fix");
  h.screen.destroy();
});

test("a rejected r re-check shows the error", async () => {
  let calls = 0;
  const h = harness({
    checkAll: async () => {
      calls++;
      if (calls === 1) return results([]);
      throw new Error("probe exploded");
    },
  });
  await flush();
  press(h.screen, "r");
  await flush();
  assert.match(screenText(h.screen), /probe exploded/);
  h.screen.destroy();
});

test("finishing detaches every widget the wizard added", async () => {
  const h = harness();
  const before = h.screen.children.length;
  await toConfirm(h);
  press(h.screen, "enter");
  await flush();
  assert.ok(h.screen.children.length < before);
  assert.equal(h.screen.children.length, 0);
  h.screen.destroy();
});
