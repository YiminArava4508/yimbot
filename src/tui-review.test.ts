import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import blessed from "neo-blessed";
// Node's ESM loader cannot statically detect named exports on this package's
// bundled CJS output, so the value import goes through the default export.
import xtermHeadless from "@xterm/headless";
import type { ClaudeSession } from "./claude-sessions.ts";
import {
  claudePaneLabel,
  diffPaneLines,
  flattenFiles,
  groupOf,
  guideHeight,
  guideLines,
  nextReviewPane,
  nextUnviewed,
  openReview,
  placeholderGroups,
  planLines,
  reviewFooterHint,
  reviewHeader,
  reviewLayout,
  reviewPaneBorderColor,
  type ReviewDeps,
} from "./tui-review.ts";
import type { FileDiff } from "./review-diff.ts";

const { Terminal } = xtermHeadless;

const GROUPS = [
  { title: "core", context: "the change itself", files: ["src/a.ts", "src/b.ts"] },
  { title: "tests", context: "", files: ["src/a.test.ts"] },
];

test("flattenFiles preserves group order then file order", () => {
  assert.deepEqual(flattenFiles(GROUPS), ["src/a.ts", "src/b.ts", "src/a.test.ts"]);
});

test("groupOf finds the owning group and null for unknown paths", () => {
  assert.equal(groupOf(GROUPS, "src/a.test.ts")?.title, "tests");
  assert.equal(groupOf(GROUPS, "nope.ts"), null);
});

test("nextUnviewed wraps past the end and stays put when everything is viewed", () => {
  const files = ["a", "b", "c"];
  assert.equal(nextUnviewed(files, new Set(["b"]), 0), 2);
  assert.equal(nextUnviewed(files, new Set(["b", "c"]), 1), 0);
  assert.equal(nextUnviewed(files, new Set(files), 1), 1);
});

test("placeholderGroups puts every path under one organizing group", () => {
  const g = placeholderGroups(["a.ts", "b.ts"]);
  assert.equal(g.groups.length, 1);
  assert.ok(g.groups[0].title.includes("organizing"));
  assert.deepEqual(g.groups[0].files, ["a.ts", "b.ts"]);
});

test("planLines colors group titles yellow, files cyan, and viewed files green", () => {
  const { lines, selectedLine } = planLines(GROUPS, new Set(["src/b.ts"]), new Set(), "src/a.ts");
  assert.equal(lines[0], "{yellow-fg}{bold}core{/bold}{/yellow-fg}");
  assert.equal(lines[1], "{inverse}   {cyan-fg}src/a.ts{/cyan-fg}{/inverse}");
  assert.equal(lines[2], " {green-fg}✓{/green-fg} {green-fg}src/b.ts{/green-fg}");
  assert.equal(lines[3], "{yellow-fg}{bold}tests{/bold}{/yellow-fg}");
  assert.equal(selectedLine, 1);
});

test("planLines keeps a viewed selected file green under the inverse highlight", () => {
  const { lines } = planLines(GROUPS, new Set(["src/a.ts"]), new Set(), "src/a.ts");
  assert.equal(lines[1], "{inverse} {green-fg}✓{/green-fg} {green-fg}src/a.ts{/green-fg}{/inverse}");
});

test("planLines marks context files with a magenta +, combined with the viewed check", () => {
  const context = new Set(["src/a.ts", "src/b.ts"]);
  const { lines } = planLines(GROUPS, new Set(["src/b.ts"]), context, null);
  assert.equal(lines[1], "  {magenta-fg}+{/magenta-fg}{cyan-fg}src/a.ts{/cyan-fg}");
  assert.equal(lines[2], " {green-fg}✓{/green-fg}{magenta-fg}+{/magenta-fg}{green-fg}src/b.ts{/green-fg}");
});

test("planLines returns selectedLine -1 when nothing is selected", () => {
  assert.equal(planLines(GROUPS, new Set(), new Set(), null).selectedLine, -1);
});

test("diffPaneLines renders just the diff, guidance lives in the guide band", () => {
  const fd: FileDiff = {
    path: "src/a.ts", oldPath: "src/a.ts", status: "modified", additions: 0, deletions: 0, lines: [],
  };
  const out = diffPaneLines(fd);
  assert.ok(out[0].includes("src/a.ts"));
});

test("diffPaneLines shows a loading stub without a diff", () => {
  assert.ok(diffPaneLines(null)[0].includes("loading"));
});

test("guideLines shows organizing while groups are in flight", () => {
  const out = guideLines({ summary: "", group: null, loaded: false, usedFallback: false });
  assert.equal(out.length, 1);
  assert.ok(out[0].includes("organizing review"));
});

test("guideLines shows the fallback warning when AI grouping failed", () => {
  const out = guideLines({ summary: "", group: GROUPS[1], loaded: true, usedFallback: true });
  assert.equal(out[0], "{red-fg}AI grouping failed, grouped by directory{/red-fg}");
});

test("guideLines renders the selected group's guidance first, then the summary dim", () => {
  const out = guideLines({ summary: "adds a widget", group: GROUPS[0], loaded: true, usedFallback: false });
  assert.equal(out[0], "{bold}core{/bold}: the change itself");
  assert.equal(out[1], "{grey-fg}adds a widget{/grey-fg}");
});

test("guideLines skips empty summary and empty context", () => {
  assert.deepEqual(
    guideLines({ summary: "", group: GROUPS[0], loaded: true, usedFallback: false }),
    ["{bold}core{/bold}: the change itself"],
  );
  assert.deepEqual(
    guideLines({ summary: "s", group: GROUPS[1], loaded: true, usedFallback: false }),
    ["{bold}tests{/bold}", "{grey-fg}s{/grey-fg}"],
  );
  assert.deepEqual(guideLines({ summary: "", group: null, loaded: true, usedFallback: false }), []);
});

test("guideHeight fits the wrapped content between a floor of 3 and the cap", () => {
  // Two short lines on a wide band: 2 content rows + 2 border rows, floored at 3.
  assert.equal(guideHeight(["a", "b"], 100, 20), 4);
  assert.equal(guideHeight([], 100, 20), 3);
  assert.equal(guideHeight(["a"], 100, 20), 3);
  // A 25-char line on a 10-wide band word-wraps to 3 rows: 3 + 2 borders.
  assert.equal(guideHeight(["aaaa bbbb cccc dddd eeee"], 10, 20), 5);
  // The cap wins when content would eat the screen.
  assert.equal(guideHeight(Array(30).fill("x"), 100, 8), 8);
  // Tags and escaped braces do not count toward the visible width.
  assert.equal(guideHeight([`{bold}${"x".repeat(10)}{/bold}`], 10, 20), 3);
  assert.equal(guideHeight(["{open}x{close}"], 3, 20), 3);
});

test("reviewHeader shows PR, title and progress", () => {
  assert.equal(reviewHeader(42, "add widget", 3, 9), "PR #42  add widget  |  3/9 viewed");
});

test("reviewFooterHint offers y only when all viewed and draft", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: true, focused: "plan" as const, contextCount: 0 };
  assert.ok(!reviewFooterHint(base).includes("y mark PR ready"));
  assert.ok(reviewFooterHint({ ...base, allViewed: true }).includes("y mark PR ready"));
  assert.ok(reviewFooterHint({ ...base, allViewed: true, isDraft: false }).includes("review complete"));
  assert.ok(reviewFooterHint({ ...base, loaded: false }).includes("loading"));
  assert.ok(reviewFooterHint({ ...base, total: 0 }).includes("no changes"));
});

test("reviewFooterHint lists the 1/2/3 pane jumps on plan and diff", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: true, focused: "plan" as const, contextCount: 0 };
  assert.ok(reviewFooterHint(base).includes("1/2/3 pane"));
  assert.ok(reviewFooterHint({ ...base, focused: "diff" }).includes("1/2/3 pane"));
  assert.ok(!reviewFooterHint({ ...base, focused: "claude" }).includes("1/2/3 pane"));
});

test("reviewFooterHint describes scrolling and the claude tab when the diff pane is focused", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: true, focused: "diff" as const, contextCount: 0 };
  const hint = reviewFooterHint(base);
  assert.ok(hint.includes("j/k scroll"));
  assert.ok(hint.includes("space viewed"));
  assert.ok(hint.includes("tab claude"));
  assert.ok(!hint.includes("g/G first/last"));
  assert.ok(reviewFooterHint({ ...base, allViewed: true }).includes("y mark PR ready"));
});

test("reviewFooterHint routes keys to claude when the claude pane is focused", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: false, focused: "claude" as const, contextCount: 0 };
  const hint = reviewFooterHint(base);
  assert.ok(hint.includes("C-q or C-\\ back"));
  assert.ok(!hint.includes("q back"));
});

test("reviewFooterHint offers c context on the plan and diff panes", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: false, focused: "plan" as const, contextCount: 0 };
  assert.ok(reviewFooterHint(base).includes("c context"));
  assert.ok(reviewFooterHint({ ...base, focused: "diff" }).includes("c context"));
});

test("reviewFooterHint offers C clear context only when the context set is non-empty", () => {
  const base = { total: 3, loaded: true, allViewed: false, isDraft: false, focused: "plan" as const, contextCount: 0 };
  assert.ok(!reviewFooterHint(base).includes("C clear context"));
  assert.ok(reviewFooterHint({ ...base, contextCount: 2 }).includes("C clear context"));
  assert.ok(reviewFooterHint({ ...base, focused: "diff", contextCount: 1 }).includes("C clear context"));
});

test("reviewLayout pins the panes: guide band on top, plan/diff/claude as thirds", () => {
  const l = reviewLayout();
  assert.equal(l.guide.top, 1);
  assert.equal(l.guide.height, 5);
  assert.equal(l.guide.width, "100%");
  assert.equal(l.plan.top, 6);
  assert.equal(l.plan.width, "25%");
  assert.equal(l.diff.top, 6);
  assert.equal(l.diff.left, "25%");
  assert.equal(l.diff.width, "45%");
  assert.equal(l.header.height, 1);
  assert.equal(l.footer.bottom, 0);
});

test("reviewLayout gives the panes resting grey borders and labels like the board", () => {
  const l = reviewLayout();
  for (const pane of ["guide", "plan", "diff"] as const) {
    assert.deepEqual(l[pane].style, { border: { fg: "grey" }, label: { fg: "grey" } });
  }
});

test("reviewPaneBorderColor turns the focused pane white and rests grey", () => {
  assert.equal(reviewPaneBorderColor(true), "white");
  assert.equal(reviewPaneBorderColor(false), "grey");
});

test("reviewLayout adds the claude pane as the right third", () => {
  const l = reviewLayout();
  assert.equal(l.plan.width, "25%");
  assert.equal(l.diff.left, "25%");
  assert.equal(l.diff.width, "45%");
  assert.equal(l.claude.left, "70%");
  assert.equal(l.claude.right, 0);
  assert.equal(l.claude.label, " claude ");
});

test("nextReviewPane cycles plan, diff, claude and skips claude when absent", () => {
  assert.equal(nextReviewPane("plan", true), "diff");
  assert.equal(nextReviewPane("diff", true), "claude");
  assert.equal(nextReviewPane("claude", true), "plan");
  assert.equal(nextReviewPane("diff", false), "plan");
});

test("claudePaneLabel shows the current file and context count", () => {
  assert.equal(claudePaneLabel("src/foo.ts", 2), " claude · src/foo.ts (+2 in context) ");
  assert.equal(claudePaneLabel("src/foo.ts", 0), " claude · src/foo.ts ");
  assert.equal(claudePaneLabel(null, 0), " claude ");
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

// Emit a keypress on the currently focused widget, matching how the real
// screen dispatches: screen.js only forwards keypress to screen.focused, so
// this exercises exactly the routing openSettings' key handlers rely on.
function press(screen: any, name: string) {
  screen.focused.emit("keypress", name.length === 1 ? name : "", { name, full: name });
}

const flush = () => new Promise((r) => setImmediate(r));

function makeScreen() {
  const { input, output } = fakeTty(120, 40);
  return blessed.screen({ input, output, terminal: "xterm", smartCSR: true }) as any;
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,1 @@",
  "-old",
  "+new",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 1..2 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
  "",
].join("\n");

const GROUP_JSON = JSON.stringify({
  summary: "s",
  groups: [{ title: "core", context: "look here", files: ["src/b.ts", "src/a.ts"] }],
});

function testDeps(
  overrides: Partial<ReviewDeps> = {},
): ReviewDeps & { saved: [string, Set<string>][]; savedGroups: [string, unknown][] } {
  const saved: [string, Set<string>][] = [];
  const savedGroups: [string, unknown][] = [];
  return {
    pr: 42,
    fetchDiff: async () => DIFF,
    fetchMeta: async () => ({ title: "t", body: "b", isDraft: true, headSha: "sha1" }),
    runGrouping: async () => GROUP_JSON,
    markReady: async () => {},
    loadViewed: () => new Set(),
    saveViewed: (sha, viewed) => { saved.push([sha, new Set(viewed)]); },
    loadGroups: () => null,
    saveGroups: (sha, groups) => { savedGroups.push([sha, groups]); },
    claudeSession: () => null,
    writeContext: () => true,
    saved,
    savedGroups,
    ...overrides,
  };
}

// A fake ClaudeSession: a real headless terminal (attachClaudeOutput renders
// from it) over a pty stub that records writes, data subscriptions and exit
// callbacks, mirroring claude-sessions.test.ts's fakePty.
function fakeClaudeSession() {
  const writes: string[] = [];
  const dataSubs: { disposed: boolean }[] = [];
  const exitCbs: (() => void)[] = [];
  let killed = false;
  const session: ClaudeSession = {
    pr: 42,
    cwd: "/tmp/x",
    term: new Terminal({ cols: 20, rows: 5, allowProposedApi: true }),
    exited: false,
    pty: {
      write: (d: string) => { writes.push(d); },
      resize: () => {},
      kill: () => { killed = true; },
      onData: () => {
        const sub = { disposed: false };
        dataSubs.push(sub);
        return { dispose: () => { sub.disposed = true; } };
      },
      onExit: (cb: () => void) => {
        exitCbs.push(cb);
        return { dispose: () => {} };
      },
    },
  };
  const emitExit = () => {
    session.exited = true;
    for (const cb of exitCbs) cb();
  };
  return { session, writes, dataSubs, wasKilled: () => killed, emitExit };
}

// The claude pane routes on key.sequence (claudeKeyAction), which press()
// does not carry; this mirrors how the real program hands sequences over.
function pressSeq(screen: any, ch: string, sequence: string, name = ch) {
  screen.focused.emit("keypress", ch, { name, full: name, sequence });
}

const pressUnfocus = (screen: any) => pressSeq(screen, "", "\u001c", "C-\\");

function paneByLabel(screen: any, label: string) {
  return screen.children.find((c: any) => c.options.label === label);
}

test("openReview renders the AI plan and space marks viewed, saves, and advances", async () => {
  const screen = makeScreen();
  const deps = testDeps();
  let closed = false;
  openReview(screen, deps, () => { closed = true; });
  await flush();
  await flush();
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  assert.ok(plan.getContent().includes("core"));
  const guide = screen.children.find((c: any) => c.options.label === " guide ");
  assert.ok(guide.getContent().includes("s"), "guide band must show the PR summary");
  assert.ok(guide.getContent().includes("look here"), "guide band must show the group context");
  // AI ordered b before a; selection starts on the first file, src/b.ts.
  press(screen, "space");
  await flush();
  assert.equal(deps.saved.length, 1);
  assert.deepEqual(deps.saved[0], ["sha1", new Set(["src/b.ts"])]);
  assert.ok(!closed);
  screen.destroy();
});

test("openReview reuses a cached plan and never calls the grouping model", async () => {
  const screen = makeScreen();
  let grouped = 0;
  const deps = testDeps({
    loadGroups: () => ({ summary: "cached summary", groups: [{ title: "cached group", context: "ctx", files: ["src/a.ts", "src/b.ts"] }] }),
    runGrouping: async () => { grouped++; return GROUP_JSON; },
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  assert.equal(grouped, 0, "a cached plan must not re-run the grouping model");
  const guide = paneByLabel(screen, " guide ");
  assert.ok(guide.getContent().includes("cached summary"));
  assert.ok(paneByLabel(screen, " review plan ").getContent().includes("cached group"));
  assert.deepEqual(deps.savedGroups, [], "a cache hit must not rewrite the cache");
  screen.destroy();
});

test("openReview caches the plan it just generated, under the head SHA", async () => {
  const screen = makeScreen();
  const deps = testDeps();
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  assert.equal(deps.savedGroups.length, 1);
  const [sha, groups] = deps.savedGroups[0];
  assert.equal(sha, "sha1");
  assert.deepEqual(groups, JSON.parse(GROUP_JSON));
  screen.destroy();
});

test("openReview never caches a fallback plan, so a failed grouping run retries", async () => {
  const screen = makeScreen();
  const deps = testDeps({ runGrouping: async () => { throw new Error("claude missing"); } });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  assert.deepEqual(deps.savedGroups, []);
  assert.ok(paneByLabel(screen, " guide ").getContent().includes("grouped by directory"));
  screen.destroy();
});

test("openReview falls back to the model when the cached plan is unusable", async () => {
  const screen = makeScreen();
  let grouped = 0;
  const deps = testDeps({
    loadGroups: () => ({ summary: "s", groups: [{ title: "stale", context: "", files: ["deleted.ts"] }] }),
    runGrouping: async () => { grouped++; return GROUP_JSON; },
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  assert.equal(grouped, 1, "a plan naming no current file must be discarded");
  assert.ok(paneByLabel(screen, " review plan ").getContent().includes("core"));
  screen.destroy();
});

test("openReview sizes the guide band to its content and shifts the panes below it", async () => {
  const screen = makeScreen();
  // ~360 visible chars of summary on a 118-wide inner band wraps to 4 rows,
  // plus the group line: 5 content rows + 2 borders.
  const longSummary = Array(40).fill("word like").join(" ");
  const deps = testDeps({
    runGrouping: async () => JSON.stringify({
      summary: longSummary,
      groups: [{ title: "core", context: "look here", files: ["src/b.ts", "src/a.ts"] }],
    }),
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  const guide = screen.children.find((c: any) => c.options.label === " guide ");
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  const diff = screen.children.find((c: any) => c.options.label === " diff ");
  assert.equal(guide.height, 7, "guide band must grow to hold the whole guide");
  assert.equal(plan.top, 8, "plan pane must start right under the grown guide");
  assert.equal(diff.top, 8, "diff pane must start right under the grown guide");
  screen.destroy();
});

test("openReview highlights the focused pane's border, tab moves it", async () => {
  const screen = makeScreen();
  openReview(screen, testDeps(), () => {});
  await flush();
  await flush();
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  const diff = screen.children.find((c: any) => c.options.label === " diff ");
  assert.equal(plan.style.border.fg, "white");
  assert.equal(diff.style.border.fg, "grey");
  press(screen, "tab");
  await flush();
  assert.equal(plan.style.border.fg, "grey");
  assert.equal(diff.style.border.fg, "white");
  screen.destroy();
});

test("openReview jumps focus with 1/2/3 from plan and diff; 3 needs a claude session", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  const plan = paneByLabel(screen, " review plan ");
  const diff = paneByLabel(screen, " diff ");
  const claude = paneByLabel(screen, " claude ");
  press(screen, "2");
  assert.equal(diff.style.border.fg, "white");
  press(screen, "1");
  assert.equal(plan.style.border.fg, "white");
  press(screen, "3");
  assert.equal(claude.style.border.fg, "white");
  pressUnfocus(screen);
  assert.deepEqual(fake.writes, [], "jump keys must not reach the pty");
  screen.destroy();
});

test("openReview ignores 3 when no claude session exists", async () => {
  const screen = makeScreen();
  openReview(screen, testDeps(), () => {});
  await flush();
  await flush();
  const plan = paneByLabel(screen, " review plan ");
  press(screen, "3");
  assert.equal(plan.style.border.fg, "white");
  screen.destroy();
});

test("openReview y marks ready only when all files are viewed and closes with a notice", async () => {
  const screen = makeScreen();
  let readied = 0;
  const deps = testDeps({ markReady: async () => { readied++; } });
  const closes: [string | null, boolean][] = [];
  openReview(screen, deps, (notice, isError) => closes.push([notice, isError]));
  await flush();
  await flush();
  press(screen, "y");
  await flush();
  assert.equal(readied, 0);
  press(screen, "space");
  press(screen, "space");
  await flush();
  press(screen, "y");
  await flush();
  await flush();
  assert.equal(readied, 1);
  assert.equal(closes.length, 1);
  assert.ok(closes[0][0]?.includes("#42"));
  assert.equal(closes[0][1], false);
  screen.destroy();
});

test("openReview escape closes and saves, and a failed diff fetch closes with an error", async () => {
  const screen = makeScreen();
  const deps = testDeps();
  const closes: [string | null, boolean][] = [];
  openReview(screen, deps, (notice, isError) => closes.push([notice, isError]));
  await flush();
  await flush();
  press(screen, "escape");
  assert.equal(closes.length, 1);
  assert.equal(closes[0][0], null);
  screen.destroy();

  const screen2 = makeScreen();
  const failing = testDeps({ fetchDiff: async () => { throw new Error("no such PR"); } });
  const closes2: [string | null, boolean][] = [];
  openReview(screen2, failing, (notice, isError) => closes2.push([notice, isError]));
  await flush();
  await flush();
  assert.equal(closes2.length, 1);
  assert.ok(closes2[0][0]?.includes("no such PR"));
  assert.equal(closes2[0][1], true);
  screen2.destroy();
});

test("openReview falls back to directory groups when the AI call fails", async () => {
  const screen = makeScreen();
  const deps = testDeps({ runGrouping: async () => { throw new Error("claude down"); } });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  assert.ok(plan.getContent().includes("src"));
  const guide = screen.children.find((c: any) => c.options.label === " guide ");
  assert.ok(guide.getContent().includes("grouped by directory"));
  const footer = screen.children.filter((c: any) => c.type === "text").at(-1);
  assert.ok(!footer.getContent().includes("grouped by directory"));
  screen.destroy();
});

test("openReview closes with an error notice when fetchMeta rejects, and produces no unhandled rejection", async () => {
  const screen = makeScreen();
  const failing = testDeps({ fetchMeta: async () => { throw new Error("gh unreachable"); } });
  const closes: [string | null, boolean][] = [];
  openReview(screen, failing, (notice, isError) => closes.push([notice, isError]));
  await flush();
  await flush();
  assert.equal(closes.length, 1);
  assert.ok(closes[0][0]?.includes("gh unreachable"));
  assert.equal(closes[0][1], true);
  screen.destroy();
});

test("openReview keeps the operator's selection when real groups land after they navigated", async () => {
  const screen = makeScreen();
  let resolveGrouping: (v: string) => void = () => {};
  const deps = testDeps({
    runGrouping: () => new Promise((resolve) => { resolveGrouping = resolve; }),
  });
  openReview(screen, deps, () => {});
  await flush();
  // Placeholder groups are up now (diff parse order: src/a.ts, src/b.ts),
  // selection auto-picked src/a.ts; "k" is a no-op move but still operator-
  // driven, marking the selection as no longer up for grabs.
  press(screen, "k");
  resolveGrouping(GROUP_JSON); // AI order is src/b.ts first, src/a.ts second
  await flush();
  await flush();
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  const content = plan.getContent();
  assert.ok(content.includes("core"), "real AI groups must have loaded");
  // getContent() returns tags already rendered to ANSI; reverse-video is
  // \x1b[7m ... \x1b[27m, so this locates the selected (inverse) row. The
  // file name itself sits inside cyan-fg, hence the regex across the SGRs.
  assert.ok(
    /\x1b\[7m {3}\x1b\[[0-9;]*msrc\/a\.ts/.test(content),
    "selection must stay on the operator's file, not snap to the AI order's first file",
  );
  assert.ok(!/\x1b\[7m {3}\x1b\[[0-9;]*msrc\/b\.ts/.test(content));
  screen.destroy();
});

test("openReview: space in the diff pane marks the file viewed and saves", async () => {
  const screen = makeScreen();
  const deps = testDeps();
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  press(screen, "tab");
  press(screen, "space");
  await flush();
  assert.equal(deps.saved.length, 1);
  assert.deepEqual(deps.saved[0], ["sha1", new Set(["src/b.ts"])]);
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  assert.ok(plan.getContent().includes("✓"));
  screen.destroy();
});

test("openReview: y in the diff pane marks ready once all files are viewed", async () => {
  const screen = makeScreen();
  let readied = 0;
  const deps = testDeps({ markReady: async () => { readied++; } });
  const closes: [string | null, boolean][] = [];
  openReview(screen, deps, (notice, isError) => closes.push([notice, isError]));
  await flush();
  await flush();
  press(screen, "tab");
  press(screen, "space");
  press(screen, "space");
  await flush();
  press(screen, "y");
  await flush();
  await flush();
  assert.equal(readied, 1);
  assert.equal(closes.length, 1);
  screen.destroy();
});

test("openReview keeps a mark toggled before meta arrives and persists it once meta lands", async () => {
  const screen = makeScreen();
  let resolveMeta: (v: { title: string; body: string; isDraft: boolean; headSha: string }) => void = () => {};
  const deps = testDeps({
    fetchMeta: () => new Promise((resolve) => { resolveMeta = resolve; }),
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  // Placeholder groups are up (no meta yet); mark the first file viewed. No
  // meta means toggleViewed cannot persist it yet.
  press(screen, "space");
  await flush();
  assert.equal(deps.saved.length, 0);
  resolveMeta({ title: "t", body: "b", isDraft: true, headSha: "sha1" });
  await flush();
  await flush();
  const plan = screen.children.find((c: any) => c.options.label === " review plan ");
  assert.ok(plan.getContent().includes("✓"), "the pre-meta mark must survive meta's union");
  assert.ok(
    deps.saved.some(([sha, viewed]) => sha === "sha1" && viewed.size > 0),
    "the surviving mark must be persisted once meta lands",
  );
  screen.destroy();
});

test("openReview shows a no-changes footer and skips grouping for an empty diff", async () => {
  const screen = makeScreen();
  let grouped = 0;
  const deps = testDeps({
    fetchDiff: async () => "",
    runGrouping: async () => { grouped++; return GROUP_JSON; },
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  await flush();
  await flush();
  const footer = screen.children.filter((c: any) => c.type === "text").at(-1);
  assert.ok(footer.getContent().includes("no changes in this PR"));
  assert.equal(grouped, 0);
  screen.destroy();
});

test("openReview forwards keystrokes (C-c included) to the claude pty; the unfocus chord returns focus without writing", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  const deps = testDeps({ claudeSession: () => fake.session });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  press(screen, "tab");
  press(screen, "tab");
  const claude = paneByLabel(screen, " claude ");
  const plan = paneByLabel(screen, " review plan ");
  assert.equal(claude.style.border.fg, "white", "two tabs must land focus on the claude pane");
  const INTR = String.fromCharCode(3);
  pressSeq(screen, "x", "x");
  pressSeq(screen, "", INTR, "C-c");
  assert.deepEqual(fake.writes, ["x", INTR], "keys and the interrupt sequence must reach the pty");
  pressUnfocus(screen);
  assert.deepEqual(fake.writes, ["x", INTR], "the unfocus chord must not be forwarded");
  assert.equal(plan.style.border.fg, "white");
  assert.equal(claude.style.border.fg, "grey");
  press(screen, "tab");
  press(screen, "tab");
  pressSeq(screen, "", String.fromCharCode(17), "C-q");
  assert.deepEqual(fake.writes, ["x", INTR], "C-q must unfocus without forwarding");
  assert.equal(plan.style.border.fg, "white");
  assert.equal(claude.style.border.fg, "grey");
  screen.destroy();
});

test("openReview writes context lazily: once per signature, again after a context toggle, retrying after a failed write", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  const written: string[] = [];
  let writeOk = true;
  const deps = testDeps({
    claudeSession: () => fake.session,
    writeContext: (content) => {
      written.push(content);
      return writeOk;
    },
  });
  openReview(screen, deps, () => {});
  await flush();
  await flush();
  press(screen, "tab");
  press(screen, "tab");
  pressSeq(screen, "x", "x");
  pressSeq(screen, "y", "y");
  assert.equal(written.length, 1, "an unchanged signature must write exactly once");
  assert.ok(written[0].includes("src/b.ts"), "the context must cover the selected file");
  pressUnfocus(screen);
  press(screen, "c");
  press(screen, "tab");
  press(screen, "tab");
  pressSeq(screen, "z", "z");
  assert.equal(written.length, 2, "a context toggle must dirty the signature");
  writeOk = false;
  pressUnfocus(screen);
  press(screen, "j");
  press(screen, "tab");
  press(screen, "tab");
  pressSeq(screen, "a", "a");
  pressSeq(screen, "b", "b");
  assert.equal(written.length, 4, "a failed write must not mark the signature clean; each keystroke retries");
  screen.destroy();
});

test("openReview: c toggles the context file and the claude label shows the count", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  const claude = paneByLabel(screen, " claude ");
  press(screen, "c");
  assert.ok(claude._label.getContent().includes("(+1 in context)"));
  press(screen, "c");
  assert.ok(!claude._label.getContent().includes("in context"));
  screen.destroy();
});

test("openReview: shift-C clears every context file at once", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  const claude = paneByLabel(screen, " claude ");
  press(screen, "c");
  press(screen, "j");
  press(screen, "c");
  assert.ok(claude._label.getContent().includes("(+2 in context)"));
  screen.focused.emit("keypress", "C", { name: "c", full: "S-c", shift: true });
  assert.ok(!claude._label.getContent().includes("in context"));
  screen.destroy();
});

test("openReview close disposes the output attachment and exit hook without killing the session", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  press(screen, "q");
  assert.equal(fake.dataSubs.length, 1, "attachClaudeOutput must subscribe to pty data exactly once");
  assert.ok(fake.dataSubs.every((s) => s.disposed), "close must dispose the output attachment");
  assert.equal(fake.wasKilled(), false, "the session must survive overlay close");
  screen.destroy();
});

test("openReview: a dead claude pty shows a notice, hands focus to plan, and stops forwarding", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  press(screen, "tab");
  press(screen, "tab");
  const claude = paneByLabel(screen, " claude ");
  const plan = paneByLabel(screen, " review plan ");
  const diff = paneByLabel(screen, " diff ");
  assert.equal(claude.style.border.fg, "white");
  fake.emitExit();
  await flush();
  assert.ok(claude.getContent().includes("claude exited"), "the pane must show the exit notice");
  assert.equal(plan.style.border.fg, "white", "focus must return to plan when claude dies focused");
  claude.emit("keypress", "x", { name: "x", full: "x", sequence: "x" });
  assert.deepEqual(fake.writes, [], "keys must not be forwarded to the dead pty");
  press(screen, "tab");
  press(screen, "tab");
  assert.equal(plan.style.border.fg, "white", "tab must cycle plan-diff only once claude is dead");
  assert.equal(diff.style.border.fg, "grey");
  assert.equal(claude.style.border.fg, "grey");
  screen.destroy();
});

test("openReview subscribes the screen resize repaint on open and removes it on close", async () => {
  const screen = makeScreen();
  const fake = fakeClaudeSession();
  const before = screen.listeners("resize").length;
  openReview(screen, testDeps({ claudeSession: () => fake.session }), () => {});
  await flush();
  await flush();
  assert.equal(screen.listeners("resize").length, before + 1, "open must add exactly one resize listener");
  const claude = paneByLabel(screen, " claude ");
  // Knock the terminal out of shape first so the re-fit is attributable to
  // the resize event, not the paint that ran at open.
  fake.session.term.resize(19, 4);
  screen.emit("resize");
  assert.equal(fake.session.term.cols, claude.width - 2, "the resize repaint must re-fit the terminal to the pane");
  press(screen, "q");
  assert.equal(screen.listeners("resize").length, before, "close must remove the resize listener");
  screen.destroy();
});
