// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import type { PtyLike } from "./claude-sessions.ts";
import type { ApplyResult } from "./settings-apply.ts";
import { isGitRepo, settingRows, type YimbotConfig } from "./settings-model.ts";
import {
  errMsg,
  fixCommandFor,
  hostLinks,
  installHint,
  linkState,
  type checkAll,
  type CheckResult,
  type PackageManager,
  type Prerequisite,
} from "./setup-core.ts";
import { walkFixes, type FixEvent } from "./setup-fix.ts";
import { stepHeader, type finishWizard, type validateKey, type WizardStep } from "./setup-wizard.ts";
import { openCommandPane, type CommandPane } from "./tui-command-pane.ts";
import { openSettings, type SettingsDeps } from "./tui-settings.ts";

// openCommandPane hands a custom spawn the full argv (command first) as its
// second parameter, unlike SpawnPty elsewhere where args excludes the command.
export type SpawnArgv = (cwd: string, argv: string[], cols: number, rows: number) => PtyLike;

export type SetupDeps = {
  initial: YimbotConfig;
  checkAll: typeof checkAll;
  pm: PackageManager | null;
  spawn?: SpawnArgv;
  validateKey: typeof validateKey;
  settings: (apiKey: string) => SettingsDeps;
  finish: (c: YimbotConfig) => ReturnType<typeof finishWizard>;
  minSize?: { cols: number; rows: number };
};

const DEFAULT_MIN_SIZE = { cols: 80, rows: 24 };
const LABEL_WIDTH = 20;
const CHOICES = ["Fix everything for me", "Go step by step"];

export function tooSmallMessage(cols: number, rows: number, min: { cols: number; rows: number }): string | null {
  if (cols >= min.cols && rows >= min.rows) return null;
  return `Resize the terminal to at least ${min.cols}x${min.rows} (now ${cols}x${rows})`;
}

function requiredFailing(checks: CheckResult[] | null): boolean {
  if (!checks) return true;
  return checks.some((c) => !c.ok && c.pr.severity === "required");
}

export function prereqLines(checks: CheckResult[], pm: PackageManager | null): string[] {
  return checks.map(({ pr, ok }) => {
    if (ok) return `{green-fg}[ok]{/green-fg}      ${pr.label}`;
    const color = pr.severity === "required" ? "red" : "yellow";
    const tier = pr.severity === "recommended" ? " (recommended)" : "";
    const fix = fixCommandFor(pr, pm);
    const how = fix ? `Run: ${fix.join(" ")}` : installHint(pr.key, pm);
    return `{${color}-fg}[missing]{/${color}-fg} ${pr.label}${tier}  {gray-fg}${blessed.escape(how)}{/gray-fg}`;
  });
}

// The settings panel checks only edited rows; the wizard also needs the rows a
// fresh install has never set, and the key must stay the one step 2 verified.
export function configureError(c: YimbotConfig, apiKey: string): string | null {
  if (c.apiKey !== apiKey) return "change the key on the Linear key step";
  const required: Array<[string, string]> = [
    ["team", c.teamName],
    ["deploy state", c.deployStateName],
    ["todo state", c.todoStateName],
    ["review state", c.reviewStateName],
    ["codebase path", c.codebasePath],
  ];
  const empty = required.find(([, value]) => !value.trim());
  if (empty) return `${empty[0]} cannot be empty`;
  if (!isGitRepo(c.codebasePath)) return "codebase path must be an existing git repository";
  return null;
}

export function summaryLines(c: YimbotConfig, viewerName: string): string[] {
  const rows = settingRows(c, viewerName).filter((r) => r.envKey !== "LINEAR_API_KEY" && r.envKey !== "ASSIGNEE");
  return rows.map((r) => `  ${r.label.padEnd(LABEL_WIDTH, " ")}${blessed.escape(r.display)}`);
}

// Counts first, then only the links finishing will create or leave alone, so
// the summary still fits on one screen on a machine that is already linked.
export function linkLines(links: typeof hostLinks = hostLinks): string[] {
  const states = links.map((l) => ({ label: l.label, state: linkState(l.source, l.target) }));
  const count = (state: string) => states.filter((x) => x.state === state).length;
  return [
    `Host links: ${count("ours")} linked, ${count("missing")} to create, ${count("other")} left as-is`,
    ...states.filter((x) => x.state !== "ours").map((x) => `  [${x.state}] ${x.label}`),
  ];
}

function failedText(label: string, code: number | undefined): string {
  return `{red-fg}${blessed.escape(label)} failed (exit ${code ?? "unknown"}){/red-fg}`;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export function openSetup(
  screen: unknown,
  deps: SetupDeps,
  onDone: (result: { config: YimbotConfig } | null) => void,
): void {
  const s: any = screen;
  const min = deps.minSize ?? DEFAULT_MIN_SIZE;
  // Everything attached after this point (ours and the settings panel's) is
  // detached on the way out, so a reconfigure run leaves the host screen clean.
  const preexisting = new Set<unknown>(s.children);

  const header: any = blessed.text({ parent: s, top: 0, left: 0, width: "100%", height: 1, tags: true, style: { fg: "cyan", bold: true } });
  const body: any = blessed.box({
    parent: s,
    top: 1,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    keys: true,
    vi: true,
    scrollable: true,
    alwaysScroll: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
  });
  const list: any = blessed.list({
    parent: s,
    top: 1,
    left: 0,
    width: "100%",
    height: 1,
    keys: true,
    vi: true,
    tags: true,
    border: { type: "line" },
    style: { selected: { inverse: true }, border: { fg: "cyan" } },
  });
  const paneBox: any = blessed.box({
    parent: s,
    top: 1,
    left: 0,
    width: "100%",
    height: 3,
    wrap: false,
    tags: true,
    border: { type: "line" },
    label: " command ",
    style: { border: { fg: "gray" } },
  });
  const status: any = blessed.text({ parent: s, bottom: 1, left: 0, width: "100%", height: 1, wrap: false, tags: true });
  const footer: any = blessed.text({ parent: s, bottom: 0, left: 0, width: "100%", height: 1, wrap: false, tags: true, style: { fg: "white" } });
  const tooSmall: any = blessed.box({ parent: s, top: 0, left: 0, width: "100%", height: "100%", tags: true, hidden: true });

  let step: WizardStep = "prereqs";
  let mode: "checking" | "choice" | "list" = "checking";
  let checks: CheckResult[] | null = null;
  let walking = false;
  let pane: CommandPane | null = null;
  // Set before the pty spawns, so layout() reserves the rows the pane is sized from.
  let paneOpen = false;
  let paneRunning = false;
  let paneFocused = false;
  let statusText = "";
  let bodyText = "";
  let apiKey = "";
  let viewerName = "";
  let configured: YimbotConfig | null = null;
  let keyInput: any = null;
  let finished = false;

  function setVisible(el: any, visible: boolean): void {
    if (visible) el.show();
    else el.hide();
  }

  function layout(): void {
    const avail = Math.max(s.height - 3, 2);
    const paneHeight = paneOpen && step === "prereqs" ? Math.floor(avail / 2) : 0;
    const main = avail - paneHeight;
    const choiceHeight = mode === "choice" ? CHOICES.length + 2 : 0;
    body.top = 1;
    body.height = step === "prereqs" ? Math.max(main - choiceHeight, 1) : main;
    list.top = mode === "list" ? 1 : 1 + body.height;
    list.height = mode === "list" ? main : Math.max(choiceHeight, 1);
    paneBox.top = 1 + main;
    paneBox.height = Math.max(paneHeight, 3);
  }

  const paneCols = () => Math.max(paneBox.width - 2, 2);
  const paneRows = () => Math.max(paneBox.height - 2, 2);

  function headerText(): string {
    if (step === "configure") return `${stepHeader(step)}   {gray-fg}w save, then esc to continue{/gray-fg}`;
    return stepHeader(step);
  }

  function footerHint(): string {
    if (paneFocused) return "keys go to the command   ctrl+] back to the wizard";
    if (step === "key") return "enter check key   esc back   ctrl+c quit";
    if (step === "confirm") return "j/k scroll   enter write .env and finish   esc back   ctrl+c quit";
    if (mode === "checking") return "ctrl+c quit";
    if (mode === "choice") return "j/k move   enter choose   q quit";
    const tab = paneRunning ? "   tab command" : "";
    return `j/k move   f fix   r re-check   enter next${tab}   q quit`;
  }

  function prereqBody(): string {
    if (!checks) return "checking prerequisites...";
    return prereqLines(checks, deps.pm).join("\n");
  }

  function paint(): void {
    if (finished) return;
    const message = tooSmallMessage(s.width, s.height, min);
    const small = message !== null;
    tooSmall.setContent(message ?? "");
    setVisible(tooSmall, small);
    if (small) tooSmall.setFront();

    const prereqs = step === "prereqs";
    const own = step !== "configure";
    setVisible(header, true);
    setVisible(body, (prereqs && mode !== "list") || step === "key" || step === "confirm");
    setVisible(list, prereqs && mode !== "checking");
    setVisible(paneBox, prereqs && paneOpen);
    setVisible(status, own);
    setVisible(footer, own);
    layout();

    if (prereqs && mode === "choice") list.setItems(CHOICES);
    if (prereqs && mode === "list") list.setItems(prereqLines(checks ?? [], deps.pm));
    if (prereqs) {
      body.setLabel(" prerequisites ");
      body.setContent(prereqBody());
    } else {
      body.setContent(bodyText);
    }
    header.setContent(headerText());
    status.setContent(statusText);
    footer.setContent(footerHint());
    s.render();
  }

  function focusWizard(): void {
    paneFocused = false;
    if (step === "prereqs") list.focus();
    if (step === "key" && keyInput) keyInput.focus();
    if (step === "confirm") body.focus();
  }

  // readInput holds screen.grabKeys until it finishes; blur is the finisher it
  // registers synchronously, so this works even before its key listener lands.
  function stopReading(): void {
    if (!keyInput) return;
    const input = keyInput;
    keyInput = null;
    input.emit("blur");
    input.detach();
  }

  function teardown(result: { config: YimbotConfig } | null): void {
    if (finished) return;
    finished = true;
    pane?.dispose();
    stopReading();
    s.unkey(["C-c"], onCtrlC);
    s.removeListener("resize", onResize);
    for (const child of [...s.children]) {
      if (!preexisting.has(child)) child.detach();
    }
    s.render();
    onDone(result);
  }

  function onCtrlC(): void {
    if (!paneFocused) teardown(null);
  }

  function onResize(): void {
    paint();
    pane?.resize(paneCols(), paneRows());
  }

  async function refreshChecks(): Promise<CheckResult[]> {
    const r = await deps.checkAll();
    if (!finished) {
      checks = r;
      paint();
    }
    return r;
  }

  function runInPane(argv: string[]): Promise<number | undefined> {
    return new Promise((resolve) => {
      pane?.dispose();
      pane = null;
      paneOpen = true;
      paneBox.setContent("");
      paneBox.setLabel(` ${blessed.escape(argv.join(" "))} `);
      paint();
      paneRunning = true;
      pane = openCommandPane({
        box: paneBox,
        argv,
        cwd: process.cwd(),
        cols: paneCols(),
        rows: paneRows(),
        spawn: deps.spawn,
        render: () => {
          if (!finished) s.render();
        },
        onExit: (code) => {
          paneRunning = false;
          if (finished) return;
          if (paneFocused) focusWizard();
          paint();
          resolve(code);
        },
      });
      paneFocused = true;
      paneBox.focus();
      paint();
    });
  }

  async function recheck(pr: Prerequisite): Promise<boolean> {
    const r = await refreshChecks();
    return r.find((c) => c.pr.key === pr.key)?.ok ?? false;
  }

  function onFixEvent(e: FixEvent): void {
    switch (e.kind) {
      case "start":
        statusText = `fixing ${blessed.escape(e.pr.label)}`;
        break;
      case "manual":
        statusText = `{yellow-fg}${blessed.escape(`${e.pr.label}: ${e.hint}`)}{/yellow-fg}`;
        break;
      case "ok":
        statusText = `{green-fg}${blessed.escape(e.pr.label)} fixed{/green-fg}`;
        break;
      case "failed":
        statusText = failedText(e.pr.label, e.code);
        break;
    }
    paint();
  }

  async function fixEverything(): Promise<void> {
    walking = true;
    mode = "list";
    paint();
    const { stoppedAt } = await walkFixes(checks ?? [], { pm: deps.pm, run: runInPane, recheck, emit: onFixEvent });
    walking = false;
    if (finished) return;
    if (!stoppedAt) await refreshChecks();
    paint();
  }

  function fixSelected(): void {
    const item = checks?.[list.selected];
    if (!item || item.ok) return;
    const argv = fixCommandFor(item.pr, deps.pm);
    if (!argv) {
      statusText = `{yellow-fg}${blessed.escape(installHint(item.pr.key, deps.pm))}{/yellow-fg}`;
      paint();
      return;
    }
    statusText = `fixing ${blessed.escape(item.pr.label)}`;
    void runInPane(argv).then(async (code) => {
      const fixed = code === 0 && (await recheck(item.pr));
      if (finished) return;
      statusText = fixed ? `{green-fg}${blessed.escape(item.pr.label)} fixed{/green-fg}` : failedText(item.pr.label, code);
      paint();
    });
  }

  function onPrereqKey(key: { name?: string }): void {
    if (key.name === "q") {
      teardown(null);
      return;
    }
    if (walking || paneRunning) {
      if (key.name === "tab" && paneRunning) {
        paneFocused = true;
        paneBox.focus();
        paint();
      }
      return;
    }
    if (mode !== "list") return;
    if (key.name === "f") fixSelected();
    if (key.name === "r") {
      statusText = "checking...";
      paint();
      void refreshChecks().then(() => {
        statusText = "";
        paint();
      });
    }
  }

  function onPrereqSelect(index: number): void {
    if (walking || paneRunning) return;
    if (mode === "choice") {
      if (index === 0) {
        void fixEverything();
        return;
      }
      mode = "list";
      paint();
      return;
    }
    if (mode !== "list") return;
    if (requiredFailing(checks)) {
      statusText = "{red-fg}every required item must pass before continuing (f fix, r re-check){/red-fg}";
      paint();
      return;
    }
    goTo("key");
  }

  function readKey(prefill: string): void {
    const input: any = blessed.textbox({
      parent: s,
      top: 6,
      left: 2,
      width: "100%-4",
      height: 3,
      border: { type: "line" },
      label: " key ",
      censor: true,
    });
    keyInput = input;
    input.setValue(prefill);
    // A reading textbox sets screen.grabKeys, which hides C-c from the
    // screen-level binding, so the input carries its own.
    input.on("keypress", (_ch: string, key: { full?: string }) => {
      if (key.full === "C-c") teardown(null);
    });
    input.focus();
    paint();
    input.readInput((_err: unknown, value: string | null) => {
      if (finished || keyInput !== input) return;
      keyInput = null;
      input.detach();
      if (value == null) {
        goTo("prereqs");
        return;
      }
      void checkKey(value);
    });
  }

  async function checkKey(value: string): Promise<void> {
    statusText = "checking key...";
    paint();
    let result: Awaited<ReturnType<typeof validateKey>>;
    try {
      result = await deps.validateKey(value);
    } catch (err) {
      result = { ok: false, error: redact(errMsg(err), value.trim()) };
    }
    if (finished) return;
    if (!result.ok) {
      statusText = `{red-fg}${blessed.escape(result.error)}{/red-fg}`;
      readKey("");
      return;
    }
    apiKey = result.apiKey;
    viewerName = result.viewerName;
    if (configured) configured = { ...configured, apiKey };
    statusText = "";
    goTo("configure");
  }

  function applyConfigure(next: YimbotConfig): Promise<ApplyResult> {
    const error = configureError(next, apiKey);
    if (error) return Promise.resolve({ ok: false, error, rolledBack: false });
    configured = next;
    return Promise.resolve({ ok: true });
  }

  function openConfigure(): void {
    const seed = { ...(configured ?? deps.initial), apiKey };
    const settingsDeps: SettingsDeps = { ...deps.settings(apiKey), loadConfig: () => seed, apply: applyConfigure };
    openSettings(
      s,
      settingsDeps,
      () => {
        if (!finished) goTo(configured ? "confirm" : "key");
      },
      false,
      { saveLabel: "save" },
    );
  }

  function finishNow(): void {
    if (!configured) return;
    const config = configured;
    let result: ReturnType<typeof finishWizard>;
    try {
      result = deps.finish(config);
    } catch (err) {
      result = { ok: false, error: errMsg(err) };
    }
    if (!result.ok) {
      statusText = `{red-fg}${blessed.escape(redact(result.error, config.apiKey))}{/red-fg}`;
      paint();
      return;
    }
    teardown({ config });
  }

  function goTo(next: WizardStep): void {
    step = next;
    switch (next) {
      case "prereqs":
        statusText = "";
        paint();
        focusWizard();
        break;
      case "key":
        body.setLabel(" linear api key ");
        bodyText =
          "Paste your Linear personal API key (Linear: Settings, Account, Security & access).\n" +
          "It is checked against Linear before you continue and is never shown.";
        paint();
        readKey(apiKey || deps.initial.apiKey);
        break;
      case "configure":
        paint();
        openConfigure();
        break;
      case "confirm":
        statusText = "";
        body.setLabel(" confirm ");
        const [linkCounts, ...linkDetails] = linkLines();
        bodyText = [
          `signed in as ${blessed.escape(viewerName)}`,
          linkCounts,
          "",
          ...summaryLines(configured ?? deps.initial, viewerName),
          "",
          ...linkDetails,
        ].join("\n");
        paint();
        focusWizard();
        break;
    }
  }

  list.on("select", (_item: unknown, index: number) => onPrereqSelect(index));
  list.on("keypress", (_ch: string, key: { name?: string }) => onPrereqKey(key));
  body.on("keypress", (_ch: string, key: { name?: string }) => {
    if (step !== "confirm") return;
    if (key.name === "enter") finishNow();
    if (key.name === "escape") goTo("configure");
  });
  paneBox.on("keypress", (_ch: string, key: { sequence?: string; ch?: string }) => {
    if (!pane || !paneRunning) {
      focusWizard();
      paint();
      return;
    }
    if (pane.sendKey(key) === "leave") {
      focusWizard();
      paint();
    }
  });
  s.key(["C-c"], onCtrlC);
  s.on("resize", onResize);

  paint();
  deps
    .checkAll()
    .then((r) => {
      if (finished) return;
      checks = r;
      mode = requiredFailing(r) ? "choice" : "list";
      list.select(0);
      paint();
      focusWizard();
      s.render();
    })
    .catch((err) => {
      if (finished) return;
      mode = "list";
      statusText = `{red-fg}checks failed: ${blessed.escape(errMsg(err))} (r to retry){/red-fg}`;
      paint();
      focusWizard();
    });
}
