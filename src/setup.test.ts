import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commandExists,
  configReferencesFeatureStatus,
  configToEnvRecord,
  detectPackageManager,
  ensureHostLinks,
  expandTilde,
  ghHasScopes,
  hasClaudeAuth,
  hostLinks,
  installCommand,
  installHint,
  isConfigured,
  isGitRepo,
  linkState,
  parseGhScopes,
  parseInstalledPlugins,
  parseMcpServers,
  PREREQUISITES,
  serializeEnvFile,
  type YimbotConfig,
} from "./setup.ts";

const sample: YimbotConfig = {
  apiKey: "lin_api_secret",
  teamName: "Engineering",
  deployStateName: "In Progress",
  reviewStateName: "In Review",
  todoStateName: "Todo",
  heartbeatIntervalMinutes: 3,
  codebasePath: "/home/ymbo/Work/gemini",
  planModel: "opus",
  implModel: "sonnet",
  autoClaim: false,
  riskLabels: ["migration", "infra"],
  maxInProgress: 5,
  autoCleanup: true,
  autoContinue: true,
  maxContinuations: 5,
  acJudgeModel: "",
  labelFilter: "",
};

test("isConfigured requires a non-empty API key", () => {
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "" }), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "   " }), false);
  assert.equal(isConfigured({ LINEAR_API_KEY: "lin_api_x" }), true);
});

test("expandTilde expands a leading ~ only", () => {
  assert.equal(expandTilde("~"), homedir());
  assert.equal(expandTilde("~/Work/gemini"), join(homedir(), "Work/gemini"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
  assert.equal(expandTilde("relative"), "relative");
  assert.equal(expandTilde("/has/~/inside"), "/has/~/inside");
});

test("isGitRepo is true for a real repo, false otherwise", () => {
  // The yimbot repo root is a git repo (tests run with cwd = project root).
  assert.equal(isGitRepo(process.cwd()), true);
  const notARepo = mkdtempSync(join(tmpdir(), "yimbot-nogit-"));
  assert.equal(isGitRepo(notARepo), false);
  assert.equal(isGitRepo(join(notARepo, "does-not-exist")), false);
  // A freshly-init'd repo reads as a repo.
  const repo = mkdtempSync(join(tmpdir(), "yimbot-git-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  assert.equal(isGitRepo(repo), true);
});

test("linkState detects our symlink vs other vs missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-link-"));
  const source = join(dir, "source.sh");
  writeFileSync(source, "#!/bin/bash\n");
  assert.equal(linkState(source, join(dir, "missing")), "missing");
  const ours = join(dir, "ours");
  symlinkSync(source, ours);
  assert.equal(linkState(source, ours), "ours");
  const other = join(dir, "other");
  symlinkSync(join(dir, "elsewhere"), other);
  assert.equal(linkState(source, other), "other");
  const regular = join(dir, "regular");
  writeFileSync(regular, "x");
  assert.equal(linkState(source, regular), "other");
});

test("ensureHostLinks creates a missing link when the source exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-ensure-"));
  const source = join(dir, "skill");
  mkdirSync(source);
  const target = join(dir, "home", ".claude", "skills", "skill");
  const results = ensureHostLinks([{ source, target, label: "skill" }]);
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(readlinkSync(target), source);
  assert.ok(results.some((r) => r.includes("[ok]") && r.includes("linked")));
});

test("ensureHostLinks skips a link that is already ours", () => {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-ensure-ours-"));
  const source = join(dir, "skill");
  mkdirSync(source);
  const target = join(dir, "ours");
  symlinkSync(source, target);
  const results = ensureHostLinks([{ source, target, label: "skill" }]);
  assert.ok(results.some((r) => r.includes("already linked")));
});

test("ensureHostLinks leaves a non-yimbot target untouched and warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-ensure-other-"));
  const source = join(dir, "skill");
  mkdirSync(source);
  const target = join(dir, "other");
  mkdirSync(target); // a plain directory, like the merge-main copy
  const results = ensureHostLinks([{ source, target, label: "skill" }]);
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.ok(results.some((r) => r.includes("[warn]")));
});

test("ensureHostLinks reports a missing source and creates nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "yimbot-ensure-nosrc-"));
  const source = join(dir, "absent");
  const target = join(dir, "home", "skills", "absent");
  const results = ensureHostLinks([{ source, target, label: "absent" }]);
  assert.throws(() => lstatSync(target));
  assert.ok(results.some((r) => r.includes("[fail]") && r.includes("source missing")));
});

test("configToEnvRecord maps every setting to its env key", () => {
  const r = configToEnvRecord(sample);
  assert.equal(r.LINEAR_API_KEY, "lin_api_secret");
  assert.equal(r.LINEAR_TEAM_NAME, "Engineering");
  assert.equal(r.DEPLOY_STATE_NAME, "In Progress");
  assert.equal(r.REVIEW_STATE_NAME, "In Review");
  assert.equal(r.TODO_STATE_NAME, "Todo");
  assert.equal(r.HEARTBEAT_INTERVAL_MINUTES, "3");
  assert.equal(r.CODEBASE_PATH, "/home/ymbo/Work/gemini");
  assert.equal(r.PLAN_MODEL, "opus");
  assert.equal(r.IMPL_MODEL, "sonnet");
  assert.equal(r.AUTO_CLAIM, "false");
  assert.equal(r.RISK_LABELS, "migration,infra");
  assert.equal(r.MAX_IN_PROGRESS, "5");
  assert.equal(r.AUTO_CLEANUP, "true");
  assert.equal(r.AUTO_CONTINUE, "true");
  assert.equal(r.MAX_CONTINUATIONS, "5");
  assert.equal(r.AC_JUDGE_MODEL, "");
});

test("serializeEnvFile emits parseable KEY=value lines with the claim section", () => {
  const text = serializeEnvFile(sample);
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    kv[line.slice(0, i)] = line.slice(i + 1);
  }
  assert.equal(kv.LINEAR_API_KEY, "lin_api_secret");
  assert.equal(kv.REVIEW_STATE_NAME, "In Review");
  assert.equal(kv.AUTO_CLAIM, "false");
  assert.equal(kv.RISK_LABELS, "migration,infra");
  assert.equal(kv.MAX_IN_PROGRESS, "5");
  assert.equal(kv.AUTO_CLEANUP, "true");
  assert.equal(kv.AUTO_CONTINUE, "true");
  assert.equal(kv.MAX_CONTINUATIONS, "5");
  assert.equal(kv.AC_JUDGE_MODEL, "");
  assert.ok(text.includes("# --- Autonomous claim step ---"));
  assert.ok(text.includes("# --- Advance step ---"));
});

test("serializeEnvFile round-trips empty risk labels", () => {
  const text = serializeEnvFile({ ...sample, riskLabels: [], autoClaim: true });
  assert.match(text, /^RISK_LABELS=$/m);
  assert.match(text, /^AUTO_CLAIM=true$/m);
});

test("serializeEnvFile round-trips the advance step config", () => {
  const text = serializeEnvFile({
    ...sample,
    autoContinue: false,
    maxContinuations: 8,
    acJudgeModel: "haiku",
  });
  assert.match(text, /^AUTO_CONTINUE=false$/m);
  assert.match(text, /^MAX_CONTINUATIONS=8$/m);
  assert.match(text, /^AC_JUDGE_MODEL=haiku$/m);
});

test("configToEnvRecord carries the label filter", () => {
  assert.equal(configToEnvRecord({ ...sample, labelFilter: "!bot" }).LABEL_FILTER, "!bot");
  assert.equal(configToEnvRecord(sample).LABEL_FILTER, "");
});

test("serializeEnvFile writes LABEL_FILTER in the claim section", () => {
  const text = serializeEnvFile({ ...sample, labelFilter: "bot" });
  assert.match(text, /^LABEL_FILTER=bot$/m);
});

test("commandExists is true for a real binary, false for a bogus one", () => {
  assert.equal(commandExists("git"), true);
  assert.equal(commandExists("definitely-not-a-real-binary-xyz-123"), false);
});

test("PREREQUISITES cover the daemon's runtime tools in a fixable order", () => {
  const keys = PREREQUISITES.map((pr) => pr.key);
  for (const k of ["git", "tmux", "gh", "claude", "node", "pnpm", "gh-auth"]) {
    assert.ok(keys.includes(k), `${k} is checked`);
  }
  // claude installs via npm, which needs node, so node must be fixed first.
  assert.ok(keys.indexOf("node") < keys.indexOf("claude"), "node before claude");
  // gh authentication needs the gh binary present first.
  assert.ok(keys.indexOf("gh") < keys.indexOf("gh-auth"), "gh before gh-auth");
});

test("PREREQUISITES split into blocking required and non-blocking recommended checks", () => {
  const sev = (k: string) => PREREQUISITES.find((pr) => pr.key === k)?.severity;
  // Required: the daemon is useless without these.
  for (const k of ["git", "tmux", "gh", "node", "pnpm", "claude", "gh-auth", "superpowers", "claude-auth"]) {
    assert.equal(sev(k), "required", `${k} is required`);
  }
  // Recommended: warn but never block.
  for (const k of ["gh-scopes", "git-identity", "linear-server", "shortcut", "tmux-status"]) {
    assert.equal(sev(k), "recommended", `${k} is recommended`);
  }
  // Every prerequisite declares one of the two severities.
  for (const pr of PREREQUISITES) {
    assert.ok(pr.severity === "required" || pr.severity === "recommended", `${pr.key} has a severity`);
  }
});

test("parseGhScopes pulls the token scopes out of gh auth status", () => {
  const out = [
    "github.com",
    "  ✓ Logged in to github.com account YiminArava4508 (keyring)",
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
  ].join("\n");
  assert.deepEqual(parseGhScopes(out), ["gist", "read:org", "repo", "workflow"]);
  assert.deepEqual(parseGhScopes("no scopes line here"), []);
});

test("ghHasScopes checks every required scope is present", () => {
  const out = "  - Token scopes: 'repo', 'workflow', 'read:org'";
  assert.equal(ghHasScopes(["repo", "workflow"], out), true);
  assert.equal(ghHasScopes(["repo", "admin:org"], out), false);
});

test("parseMcpServers extracts server names and skips headers and plugin entries", () => {
  const out = [
    "Checking MCP server health…",
    "",
    "plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication",
    "context7: npx -y @upstash/context7-mcp@latest - ✔ Connected",
    "shortcut: npx -y @shortcut/mcp@latest - ✔ Connected",
  ].join("\n");
  const names = parseMcpServers(out);
  assert.ok(names.includes("context7"));
  assert.ok(names.includes("shortcut"));
  assert.ok(!names.includes("Checking MCP server health…"));
  // A plugin-scoped entry is not a user-configured server name.
  assert.ok(!names.includes("plugin:figma:figma"));
});

test("parseInstalledPlugins returns base plugin names from the name@marketplace keys", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: {
      "superpowers@claude-plugins-official": [{ scope: "user" }],
      "code-review@claude-plugins-official": [{ scope: "user" }],
    },
  });
  const names = parseInstalledPlugins(json);
  assert.ok(names.includes("superpowers"));
  assert.ok(names.includes("code-review"));
  assert.deepEqual(parseInstalledPlugins("not json"), []);
  assert.deepEqual(parseInstalledPlugins(JSON.stringify({})), []);
});

test("hasClaudeAuth is true with an API key or existing credentials", () => {
  assert.equal(hasClaudeAuth({ ANTHROPIC_API_KEY: "sk-abc" }, false), true);
  assert.equal(hasClaudeAuth({}, true), true);
  assert.equal(hasClaudeAuth({ ANTHROPIC_API_KEY: "  " }, false), false);
  assert.equal(hasClaudeAuth({}, false), false);
});

test("configReferencesFeatureStatus detects the tmux status flag", () => {
  assert.equal(configReferencesFeatureStatus('set -g status-right "#{@feature_status}"'), true);
  assert.equal(configReferencesFeatureStatus("set -g status-right '#{pane_title}'"), false);
  assert.equal(configReferencesFeatureStatus(""), false);
});

test("detectPackageManager returns a known manager or null", () => {
  const pm = detectPackageManager();
  assert.ok(pm === null || ["pacman", "apt", "dnf", "brew"].includes(pm));
});

test("installCommand maps package-manager tools per manager", () => {
  assert.deepEqual(installCommand("git", "pacman"), ["sudo", "pacman", "-S", "--needed", "git"]);
  assert.deepEqual(installCommand("git", "apt"), ["sudo", "apt-get", "install", "-y", "git"]);
  assert.deepEqual(installCommand("git", "dnf"), ["sudo", "dnf", "install", "-y", "git"]);
  assert.deepEqual(installCommand("git", "brew"), ["brew", "install", "git"]);
  // gh's package is github-cli on pacman, gh elsewhere.
  assert.deepEqual(installCommand("gh", "pacman"), ["sudo", "pacman", "-S", "--needed", "github-cli"]);
  assert.deepEqual(installCommand("gh", "apt"), ["sudo", "apt-get", "install", "-y", "gh"]);
  // node's package is nodejs except on brew.
  assert.deepEqual(installCommand("node", "pacman"), ["sudo", "pacman", "-S", "--needed", "nodejs"]);
  assert.deepEqual(installCommand("node", "brew"), ["brew", "install", "node"]);
});

test("installCommand routes claude and pnpm around the package manager", () => {
  assert.deepEqual(installCommand("claude", null), ["npm", "install", "-g", "@anthropic-ai/claude-code"]);
  assert.deepEqual(installCommand("claude", "brew"), ["npm", "install", "-g", "@anthropic-ai/claude-code"]);
  assert.deepEqual(installCommand("pnpm", null), ["corepack", "enable", "pnpm"]);
});

test("installCommand returns null for a pm tool with no package manager", () => {
  assert.equal(installCommand("git", null), null);
  assert.equal(installCommand("tmux", null), null);
});

test("installCommand has no command for gh authentication", () => {
  assert.equal(installCommand("gh-auth", "pacman"), null);
  assert.equal(installCommand("gh-auth", null), null);
});

test("installHint is a non-empty instruction for every prerequisite", () => {
  for (const pr of PREREQUISITES) {
    const hint = installHint(pr.key, null);
    assert.equal(typeof hint, "string");
    assert.ok(hint.length > 0, `${pr.key} has a hint`);
  }
});

test("hostLinks installs the split-pr launcher at ~/split-pr.sh", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/split-pr.sh"));
  assert.ok(link, "split-pr.sh host link is present");
  assert.ok(link!.source.endsWith("scripts/split-pr.sh"), "sourced from scripts/split-pr.sh");
});

test("hostLinks installs the fix-pr-ci skill", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.claude/skills/fix-pr-ci"));
  assert.ok(link, "fix-pr-ci skill host link is present");
  assert.ok(link!.source.endsWith("skills/fix-pr-ci"), "sourced from skills/fix-pr-ci");
});

test("hostLinks installs the fix-pr-conflict skill", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.claude/skills/fix-pr-conflict"));
  assert.ok(link, "fix-pr-conflict skill host link is present");
  assert.ok(link!.source.endsWith("skills/fix-pr-conflict"), "sourced from skills/fix-pr-conflict");
});

test("hostLinks installs the fix-pr-blocked skill", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.claude/skills/fix-pr-blocked"));
  assert.ok(link, "fix-pr-blocked skill host link is present");
  assert.ok(link!.source.endsWith("skills/fix-pr-blocked"), "sourced from skills/fix-pr-blocked");
});

test("hostLinks installs the merge-main skill", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.claude/skills/merge-main"));
  assert.ok(link, "merge-main skill host link is present");
  assert.ok(link!.source.endsWith("skills/merge-main"), "sourced from skills/merge-main");
});

test("hostLinks installs the receiving-code-review skill", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.claude/skills/receiving-code-review"));
  assert.ok(link, "receiving-code-review skill host link is present");
  assert.ok(link!.source.endsWith("skills/receiving-code-review"), "sourced from skills/receiving-code-review");
});

test("hostLinks installs the session deny-list settings", () => {
  const link = hostLinks.find((l) => l.target.endsWith("/.config/yimbot/session-settings.json"));
  assert.ok(link, "session-settings host link is present");
  assert.ok(link!.source.endsWith("settings/session-settings.json"), "sourced from settings/session-settings.json");
});
