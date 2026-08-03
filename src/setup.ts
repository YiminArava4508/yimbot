import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { envOr } from "./env.ts";
import { fetchTeamStates, fetchTeams, fetchViewer } from "./linear-api.ts";
import { endSessionScriptPath, sessionScriptPath } from "./watcher.ts";

// The full set of settings the daemon reads from the environment. The wizard
// collects these; the daemon reads them back via envOr() at startup.
export type YimbotConfig = {
  apiKey: string;
  teamName: string;
  deployStateName: string;
  reviewStateName: string;
  todoStateName: string;
  heartbeatIntervalMinutes: number;
  codebasePath: string;
  planModel: string;
  implModel: string;
  autoClaim: boolean;
  riskLabels: string[];
  maxInProgress: number;
  autoCleanup: boolean;
};

// Where the daemon's --env-file points (relative to the project root, which is
// pnpm's cwd for `pnpm start` / `pnpm onboard`).
export const envPath = join(process.cwd(), ".env");

// True once the one required setting is present. LINEAR_API_KEY is the only
// hard requirement; everything else has a default, so its absence is what marks
// a fresh, never-configured install that should be walked through setup.
export function isConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.LINEAR_API_KEY?.trim());
}

// Expand a leading ~ to the home directory. The daemon does no tilde expansion,
// so paths must be absolute in .env; the wizard expands before writing.
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// Whether a path is an existing git repository — the CODEBASE_PATH invariant the
// daemon enforces at startup, checked here so the wizard catches it up front.
export function isGitRepo(path: string): boolean {
  const dir = expandTilde(path);
  if (!existsSync(dir)) return false;
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- Prerequisite pre-flight ---------------------------------------------
// The daemon and new-session.sh shell out to these at runtime; the wizard
// verifies them up front and blocks until each is satisfied. See
// docs/superpowers/specs/2026-08-03-prereq-preflight-design.md.

export type PackageManager = "pacman" | "apt" | "dnf" | "brew";
export type Severity = "required" | "recommended";

export type Prerequisite = {
  key: string; // command name for binaries, or a synthetic key for the rest
  label: string;
  severity: Severity;
};

// Required checks block setup (the daemon/sessions are useless without them);
// recommended checks only warn. Binaries come first, ordered so auto-fixes run
// in a satisfiable sequence: node/pnpm before claude (claude installs via npm),
// gh before gh-auth (auth needs the binary).
export const PREREQUISITES: Prerequisite[] = [
  { key: "git", label: "git", severity: "required" },
  { key: "tmux", label: "tmux", severity: "required" },
  { key: "gh", label: "GitHub CLI (gh)", severity: "required" },
  { key: "node", label: "Node.js (node)", severity: "required" },
  { key: "pnpm", label: "pnpm", severity: "required" },
  { key: "claude", label: "Claude Code CLI (claude)", severity: "required" },
  { key: "gh-auth", label: "gh authenticated", severity: "required" },
  { key: "superpowers", label: "superpowers plugin (Claude Code)", severity: "required" },
  { key: "claude-auth", label: "Claude Code authenticated", severity: "required" },
  { key: "gh-scopes", label: "gh token scopes (repo, workflow)", severity: "recommended" },
  { key: "git-identity", label: "git identity (user.name, user.email)", severity: "recommended" },
  { key: "linear-server", label: "Linear MCP server (linear-server)", severity: "recommended" },
  { key: "shortcut", label: "Shortcut MCP server (shortcut)", severity: "recommended" },
  { key: "merge-main", label: "merge-main skill (repo-specific)", severity: "recommended" },
  { key: "tmux-status", label: "tmux @feature_status in status line", severity: "recommended" },
];

// Whether a command is resolvable on PATH. Name comes from PREREQUISITES, never
// user input, but it is passed as an argument (not interpolated) regardless.
export function commandExists(name: string): boolean {
  try {
    execFileSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Whether `gh` has an authenticated account. False if gh is absent.
export function ghAuthenticated(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// `gh auth status` writes to stderr and may exit non-zero; capture both streams.
function ghAuthStatusOutput(): string {
  try {
    return execFileSync("sh", ["-c", "gh auth status 2>&1"], { encoding: "utf8" });
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

// The OAuth scopes on the current gh token, parsed from `gh auth status`.
export function parseGhScopes(output: string): string[] {
  const line = output.split("\n").find((l) => l.includes("Token scopes:"));
  if (!line) return [];
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export function ghHasScopes(required: string[], output: string): boolean {
  const have = new Set(parseGhScopes(output));
  return required.every((s) => have.has(s));
}

// Server names from `claude mcp list` output, skipping the health-check header
// and plugin-scoped entries (plugin:<name>:<name>), which are not user servers.
export function parseMcpServers(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s/);
    if (m) names.push(m[1]);
  }
  return names;
}

let mcpServersCache: string[] | null = null;
function mcpServers(): string[] {
  if (mcpServersCache) return mcpServersCache;
  let out = "";
  try {
    out = execFileSync("sh", ["-c", "claude mcp list 2>&1"], { encoding: "utf8", timeout: 20_000 });
  } catch (err) {
    out = (err as { stdout?: string }).stdout ?? "";
  }
  mcpServersCache = parseMcpServers(out);
  return mcpServersCache;
}

// Base plugin names (before the @marketplace suffix) from installed_plugins.json.
export function parseInstalledPlugins(json: string): string[] {
  try {
    const data = JSON.parse(json) as { plugins?: Record<string, unknown> };
    if (!data.plugins || typeof data.plugins !== "object") return [];
    return Object.keys(data.plugins).map((k) => k.split("@")[0]);
  } catch {
    return [];
  }
}

function pluginInstalled(name: string): boolean {
  const path = join(homedir(), ".claude/plugins/installed_plugins.json");
  if (!existsSync(path)) return false;
  try {
    return parseInstalledPlugins(readFileSync(path, "utf8")).includes(name);
  } catch {
    return false;
  }
}

// Claude Code is usable if an API key is set or a stored credential exists.
export function hasClaudeAuth(env: NodeJS.ProcessEnv, credsExist: boolean): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim()) || credsExist;
}

function claudeAuthenticated(): boolean {
  return hasClaudeAuth(process.env, existsSync(join(homedir(), ".claude/.credentials.json")));
}

export function configReferencesFeatureStatus(text: string): boolean {
  return text.includes("@feature_status");
}

function tmuxStatusConfigured(): boolean {
  const paths = [join(homedir(), ".tmux.conf"), join(homedir(), ".config/tmux/tmux.conf")];
  return paths.some((p) => existsSync(p) && configReferencesFeatureStatus(readFileSync(p, "utf8")));
}

function gitConfigGet(key: string): string {
  try {
    return execFileSync("git", ["config", "--global", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function gitIdentitySet(): boolean {
  return Boolean(gitConfigGet("user.name")) && Boolean(gitConfigGet("user.email"));
}

function skillInstalled(name: string): boolean {
  return existsSync(join(homedir(), ".claude/skills", name, "SKILL.md"));
}

export function isSatisfied(pr: Prerequisite): boolean {
  switch (pr.key) {
    case "gh-auth":
      return ghAuthenticated();
    case "gh-scopes":
      return ghHasScopes(["repo", "workflow"], ghAuthStatusOutput());
    case "superpowers":
      return pluginInstalled("superpowers");
    case "claude-auth":
      return claudeAuthenticated();
    case "linear-server":
      return mcpServers().includes("linear-server");
    case "shortcut":
      return mcpServers().includes("shortcut");
    case "git-identity":
      return gitIdentitySet();
    case "merge-main":
      return skillInstalled("merge-main");
    case "tmux-status":
      return tmuxStatusConfigured();
    default:
      return commandExists(pr.key);
  }
}

// The first system package manager found, or null if none is available.
export function detectPackageManager(): PackageManager | null {
  const managers: [PackageManager, string][] = [
    ["pacman", "pacman"],
    ["apt", "apt-get"],
    ["dnf", "dnf"],
    ["brew", "brew"],
  ];
  for (const [pm, bin] of managers) if (commandExists(bin)) return pm;
  return null;
}

const pmInstall: Record<PackageManager, (pkg: string) => string[]> = {
  pacman: (pkg) => ["sudo", "pacman", "-S", "--needed", pkg],
  apt: (pkg) => ["sudo", "apt-get", "install", "-y", pkg],
  dnf: (pkg) => ["sudo", "dnf", "install", "-y", pkg],
  brew: (pkg) => ["brew", "install", pkg],
};

// Package name per manager for the tools installed through one, keyed by the
// default plus any manager that names the package differently.
const pmPackage: Record<string, Partial<Record<PackageManager, string>> & { default: string }> = {
  git: { default: "git" },
  tmux: { default: "tmux" },
  gh: { default: "gh", pacman: "github-cli" },
  node: { default: "nodejs", brew: "node" },
};

// The argv that installs (or authenticates) a prerequisite, or null when there
// is nothing to run automatically. claude/pnpm route around the package manager
// (npm / corepack); gh-auth is handled by the interactive step, not here.
export function installCommand(key: string, pm: PackageManager | null): string[] | null {
  if (key === "claude") return ["npm", "install", "-g", "@anthropic-ai/claude-code"];
  if (key === "pnpm") return ["corepack", "enable", "pnpm"];
  if (key === "gh-scopes") return ["gh", "auth", "refresh", "-s", "repo,workflow"];
  const pkg = pmPackage[key];
  if (!pkg || !pm) return null;
  return pmInstall[pm](pkg[pm] ?? pkg.default);
}

// A human-readable instruction for a check the wizard cannot run for the user
// (needs a package manager, a secret, an interactive login, or a manual edit).
export function installHint(key: string, pm: PackageManager | null): string {
  switch (key) {
    case "gh-auth":
      return "Run: gh auth login";
    case "gh-scopes":
      return "Run: gh auth refresh -s repo,workflow";
    case "git-identity":
      return 'Run: git config --global user.name "<you>" && git config --global user.email "<you@example.com>"';
    case "superpowers":
      return "Install the superpowers plugin in Claude Code (run /plugin, then add superpowers)";
    case "claude-auth":
      return "Authenticate Claude Code: run `claude` and log in, or set ANTHROPIC_API_KEY";
    case "linear-server":
      return "Register the Linear MCP under the name 'linear-server' (claude mcp add linear-server ...)";
    case "shortcut":
      return "Register the Shortcut MCP under the name 'shortcut' (claude mcp add shortcut -- npx -y @shortcut/mcp@latest)";
    case "merge-main":
      return "Create a repo-specific merge-main skill at ~/.claude/skills/merge-main (fix-pr-ci uses it to sync origin/main)";
    case "tmux-status":
      return "Add @feature_status to your tmux status line so the ready-to-test flag shows";
  }
  const cmd = installCommand(key, pm);
  if (cmd) return `Run: ${cmd.join(" ")}`;
  const pkg = pmPackage[key];
  const name = pkg?.default ?? key;
  return `Install "${name}" with your system package manager (pacman/apt/dnf/brew)`;
}

// The config as an ordered KEY→value map. Single source of truth for both the
// .env file text and the in-process env applied on an auto-run first launch.
export function configToEnvRecord(c: YimbotConfig): Record<string, string> {
  return {
    LINEAR_API_KEY: c.apiKey,
    LINEAR_TEAM_NAME: c.teamName,
    DEPLOY_STATE_NAME: c.deployStateName,
    REVIEW_STATE_NAME: c.reviewStateName,
    HEARTBEAT_INTERVAL_MINUTES: String(c.heartbeatIntervalMinutes),
    CODEBASE_PATH: c.codebasePath,
    PLAN_MODEL: c.planModel,
    IMPL_MODEL: c.implModel,
    AUTO_CLAIM: String(c.autoClaim),
    TODO_STATE_NAME: c.todoStateName,
    RISK_LABELS: c.riskLabels.join(","),
    MAX_IN_PROGRESS: String(c.maxInProgress),
    AUTO_CLEANUP: String(c.autoCleanup),
  };
}

// Render .env with section comments, grouped the same way as .env.example.
export function serializeEnvFile(c: YimbotConfig): string {
  const r = configToEnvRecord(c);
  return [
    "# yimbot configuration — generated by `pnpm onboard`. Re-run it to change these.",
    "",
    `LINEAR_API_KEY=${r.LINEAR_API_KEY}`,
    `LINEAR_TEAM_NAME=${r.LINEAR_TEAM_NAME}`,
    `DEPLOY_STATE_NAME=${r.DEPLOY_STATE_NAME}`,
    `REVIEW_STATE_NAME=${r.REVIEW_STATE_NAME}`,
    `HEARTBEAT_INTERVAL_MINUTES=${r.HEARTBEAT_INTERVAL_MINUTES}`,
    `CODEBASE_PATH=${r.CODEBASE_PATH}`,
    "",
    "# --- Session models (Claude Code model alias or id) ---",
    `PLAN_MODEL=${r.PLAN_MODEL}`,
    `IMPL_MODEL=${r.IMPL_MODEL}`,
    "",
    "# --- Autonomous claim step ---",
    `AUTO_CLAIM=${r.AUTO_CLAIM}`,
    `TODO_STATE_NAME=${r.TODO_STATE_NAME}`,
    `RISK_LABELS=${r.RISK_LABELS}`,
    `MAX_IN_PROGRESS=${r.MAX_IN_PROGRESS}`,
    "",
    "# --- Cleanup step ---",
    `AUTO_CLEANUP=${r.AUTO_CLEANUP}`,
    "",
  ].join("\n");
}

// Write .env, backing up any existing file to .env.bak first. Mode 0600 because
// it holds the Linear API key.
export function writeEnvFile(contents: string, path: string = envPath): void {
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  writeFileSync(path, contents, { mode: 0o600 });
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Abort cleanly on Ctrl-C / Esc at any prompt. Nothing is written until the very
// end, so cancelling always leaves the existing config untouched.
function bail<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled — no changes written.");
    process.exit(0);
  }
  return value;
}

// Repo root, so the wizard can link the vendored launcher + skill into place.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type HostLink = { source: string; target: string; label: string };
export const hostLinks: HostLink[] = [
  {
    source: join(repoRoot, "scripts/new-session.sh"),
    target: join(homedir(), "new-session.sh"),
    label: "session launcher (~/new-session.sh)",
  },
  {
    source: join(repoRoot, "scripts/end-session.sh"),
    target: join(homedir(), "end-session.sh"),
    label: "session teardown (~/end-session.sh)",
  },
  {
    source: join(repoRoot, "scripts/split-pr.sh"),
    target: join(homedir(), "split-pr.sh"),
    label: "split-PR launcher (~/split-pr.sh)",
  },
  {
    source: join(repoRoot, "skills/pickup-ticket"),
    target: join(homedir(), ".claude/skills/pickup-ticket"),
    label: "pickup-ticket skill (~/.claude/skills/pickup-ticket)",
  },
  {
    source: join(repoRoot, "skills/address-pr-comments"),
    target: join(homedir(), ".claude/skills/address-pr-comments"),
    label: "address-pr-comments skill (~/.claude/skills/address-pr-comments)",
  },
  {
    source: join(repoRoot, "skills/fix-pr-ci"),
    target: join(homedir(), ".claude/skills/fix-pr-ci"),
    label: "fix-pr-ci skill (~/.claude/skills/fix-pr-ci)",
  },
  {
    source: join(repoRoot, "skills/fix-pr-conflict"),
    target: join(homedir(), ".claude/skills/fix-pr-conflict"),
    label: "fix-pr-conflict skill (~/.claude/skills/fix-pr-conflict)",
  },
  {
    source: join(repoRoot, "settings/session-settings.json"),
    target: join(homedir(), ".config/yimbot/session-settings.json"),
    label: "session deny-list (~/.config/yimbot/session-settings.json)",
  },
];

// Whether `target` is already our symlink to `source`, some other existing
// file/dir, or absent. Drives whether the installer links, skips, or asks.
export function linkState(source: string, target: string): "ours" | "other" | "missing" {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) {
    try {
      if (readlinkSync(target).replace(/\/+$/, "") === source.replace(/\/+$/, "")) return "ours";
    } catch {
      /* unreadable link → treat as other */
    }
  }
  return "other";
}

// Run a fix command with the terminal attached so sudo / gh auth login can
// prompt. Returns whether it exited zero.
function runFix(cmd: string[]): boolean {
  try {
    execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

// The argv that satisfies a prerequisite interactively: the gh login for the
// auth check, otherwise its install command (may be null when unfixable here).
function fixCommandFor(pr: Prerequisite, pm: PackageManager | null): string[] | null {
  if (pr.key === "gh-auth") return ["gh", "auth", "login"];
  return installCommand(pr.key, pm);
}

// First step of the wizard: verify prerequisites. Required checks block in a
// loop until satisfied; recommended checks only warn. Cancelling the required
// loop exits without writing config.
export async function ensurePrerequisites(): Promise<void> {
  await ensureRequired();
  await reviewRecommended();
}

// Block until every required prerequisite is satisfied. Auto-installs what it
// can, shows manual hints for the rest, and re-checks on each pass.
async function ensureRequired(): Promise<void> {
  const required = PREREQUISITES.filter((pr) => pr.severity === "required");
  while (true) {
    const checks = required.map((pr) => ({ pr, ok: isSatisfied(pr) }));
    p.note(checks.map((c) => `${c.ok ? "[ok]" : "[missing]"} ${c.pr.label}`).join("\n"), "Required");
    const missing = checks.filter((c) => !c.ok).map((c) => c.pr);
    if (missing.length === 0) return;

    const pm = detectPackageManager();
    const fixable = missing.filter((pr) => fixCommandFor(pr, pm) !== null);
    const manual = missing.filter((pr) => fixCommandFor(pr, pm) === null);

    if (manual.length) {
      p.note(manual.map((pr) => `${pr.label}: ${installHint(pr.key, pm)}`).join("\n"), "Install manually");
    }

    if (fixable.length) {
      p.note(
        fixable.map((pr) => `${pr.label}: ${fixCommandFor(pr, pm)!.join(" ")}`).join("\n"),
        pm ? `Auto-install (via ${pm})` : "Auto-install",
      );
      const doFix = bail(await p.confirm({ message: "Run these now?", initialValue: true }));
      if (doFix) {
        for (const pr of fixable) {
          const cmd = fixCommandFor(pr, pm)!;
          p.log.step(`$ ${cmd.join(" ")}`);
          if (!runFix(cmd)) p.log.warn(`${pr.label}: command failed`);
        }
        mcpServersCache = null; // a fix may have changed MCP config
        continue; // re-check everything from the top
      }
    }

    const retry = bail(
      await p.confirm({
        message: "Required prerequisites still missing. Install them in another terminal, then retry?",
        initialValue: true,
      }),
    );
    if (!retry) {
      p.cancel("Setup cancelled. Install the missing prerequisites and re-run `pnpm onboard`.");
      process.exit(1);
    }
    mcpServersCache = null; // the user may have changed config while we waited
  }
}

// Report recommended checks and offer the safe fixes, but never block setup.
async function reviewRecommended(): Promise<void> {
  const recommended = PREREQUISITES.filter((pr) => pr.severity === "recommended");
  const checks = recommended.map((pr) => ({ pr, ok: isSatisfied(pr) }));
  p.note(checks.map((c) => `${c.ok ? "[ok]" : "[warn]"} ${c.pr.label}`).join("\n"), "Recommended");
  const missing = new Set(checks.filter((c) => !c.ok).map((c) => c.pr.key));
  if (missing.size === 0) return;

  if (missing.has("git-identity")) {
    const set = bail(
      await p.confirm({ message: "git user.name / user.email are not set. Set them now?", initialValue: true }),
    );
    if (set) {
      const name = bail(
        await p.text({ message: "git user.name", validate: (v) => (v?.trim() ? undefined : "Required") }),
      ).trim();
      const email = bail(
        await p.text({ message: "git user.email", validate: (v) => (v?.trim() ? undefined : "Required") }),
      ).trim();
      runFix(["git", "config", "--global", "user.name", name]);
      runFix(["git", "config", "--global", "user.email", email]);
    }
  }

  if (missing.has("gh-scopes")) {
    const refresh = bail(
      await p.confirm({
        message: "gh token is missing repo/workflow scope. Run `gh auth refresh -s repo,workflow` now?",
        initialValue: true,
      }),
    );
    if (refresh) runFix(["gh", "auth", "refresh", "-s", "repo,workflow"]);
  }

  const guideOnly = checks
    .filter((c) => !c.ok && !["git-identity", "gh-scopes"].includes(c.pr.key))
    .map((c) => `${c.pr.label}: ${installHint(c.pr.key, null)}`);
  if (guideOnly.length) {
    p.note(guideOnly.join("\n"), "Optional (set these up when convenient)");
  }
}

// Symlink the repo's vendored launcher + skill into the places the daemon and
// Claude Code expect. Idempotent; never clobbers an unrelated existing file
// without asking (backs it up to .bak if the user agrees).
async function installHostLinks(): Promise<void> {
  const link = bail(
    await p.confirm({
      message: "Link yimbot's session launcher and pickup-ticket skill into place?",
      initialValue: true,
    }),
  );
  if (!link) return;
  const results: string[] = [];
  for (const { source, target, label } of hostLinks) {
    try {
      const state = linkState(source, target);
      if (state === "ours") {
        results.push(`[ok] ${label} already linked`);
        continue;
      }
      if (state === "other") {
        const replace = bail(
          await p.confirm({
            message: `${target} exists and isn't a yimbot link. Back it up (.bak) and replace with a link to the repo copy?`,
            initialValue: false,
          }),
        );
        if (!replace) {
          results.push(`[skip] ${label} left as-is`);
          continue;
        }
        renameSync(target, `${target}.bak`);
      }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
      results.push(`[ok] ${label} linked`);
    } catch (err) {
      results.push(`[fail] ${label}: ${errMsg(err)}`);
    }
  }
  p.note(results.join("\n"), "Install");
}

// Obtain an API key that authenticates. Offers to keep an existing key on a
// re-run; otherwise (or on any auth failure) prompts until one works.
async function resolveApiKey(): Promise<{ apiKey: string; viewerName: string }> {
  const existing = process.env.LINEAR_API_KEY?.trim();
  let candidate = "";
  if (existing) {
    const keep = bail(await p.confirm({ message: "Keep the existing Linear API key?", initialValue: true }));
    if (keep) candidate = existing;
  }
  while (true) {
    if (!candidate) {
      candidate = bail(
        await p.password({
          message: "Linear API key (Settings → Account → Security & Access)",
          validate: (v) => (v?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }
    const s = p.spinner();
    s.start("Authenticating with Linear");
    try {
      const viewer = await fetchViewer(candidate);
      s.stop(`Authenticated as ${viewer.name}`);
      return { apiKey: candidate, viewerName: viewer.name };
    } catch (err) {
      s.stop(`Authentication failed: ${errMsg(err)}`);
      candidate = ""; // re-prompt
    }
  }
}

// Interactive first-run / reconfigure wizard. Validates against Linear as it
// goes, writes .env, and returns the collected config so an auto-run caller can
// start the daemon in the same process.
export async function runSetup(): Promise<YimbotConfig> {
  p.intro("yimbot setup");
  await ensurePrerequisites();
  if (isConfigured(process.env)) {
    p.note("Existing .env found — current values are the defaults below; it will be backed up to .env.bak.");
  }

  const { apiKey, viewerName } = await resolveApiKey();

  const teamsSpin = p.spinner();
  teamsSpin.start("Loading teams");
  const teams = await fetchTeams(apiKey);
  teamsSpin.stop(`Loaded ${teams.length} team(s)`);
  if (teams.length === 0) {
    p.cancel("This account has no accessible teams.");
    process.exit(1);
  }
  const defaultTeam = envOr("LINEAR_TEAM_NAME", "Engineering");
  const teamId = bail(
    await p.select({
      message: "Team to watch",
      options: teams.map((t) => ({ value: t.id, label: t.name, hint: t.key })),
      initialValue:
        teams.find((t) => t.name.toLowerCase() === defaultTeam.toLowerCase())?.id ?? teams[0].id,
    }),
  );
  const teamName = teams.find((t) => t.id === teamId)!.name;

  const statesSpin = p.spinner();
  statesSpin.start("Loading workflow states");
  const states = await fetchTeamStates(apiKey, teamId);
  statesSpin.stop(`Loaded ${states.length} state(s)`);

  const pickState = async (message: string, defaultName: string): Promise<string> =>
    bail(
      await p.select({
        message,
        options: states.map((s) => ({ value: s.name, label: s.name, hint: s.type })),
        initialValue:
          states.find((s) => s.name.toLowerCase() === defaultName.toLowerCase())?.name ??
          states[0].name,
      }),
    );

  const deployStateName = await pickState(
    "Launch a session when an issue enters…",
    envOr("DEPLOY_STATE_NAME", envOr("TRIGGER_STATE_NAME", "In Progress")),
  );
  const reviewStateName = await pickState(
    'Your "In Review" state (flags a session ready to test)',
    envOr("REVIEW_STATE_NAME", "In Review"),
  );
  const todoStateName = await pickState(
    "Auto-claim ready work from…",
    envOr("TODO_STATE_NAME", "Todo"),
  );

  const codebasePath = expandTilde(
    bail(
      await p.text({
        message: "Codebase path (git repo pulled every poll)",
        initialValue: envOr("CODEBASE_PATH", join(homedir(), "Work/gemini")),
        validate: (v) => {
          const t = (v ?? "").trim();
          if (!t) return "Required";
          if (!isAbsolute(expandTilde(t))) return "Must be an absolute path";
          if (!isGitRepo(t)) return "Not an existing git repository";
          return undefined;
        },
      }),
    ).trim(),
  );

  const isPositive = (v: string | undefined) => Number(v) > 0 && Number.isFinite(Number(v));
  const heartbeatIntervalMinutes = Number(
    bail(
      await p.text({
        message: "Heartbeat interval (minutes) — how often to check the board",
        initialValue: envOr("HEARTBEAT_INTERVAL_MINUTES", envOr("POLL_INTERVAL_MINUTES", "3")),
        validate: (v) => (isPositive(v) ? undefined : "Must be a positive number"),
      }),
    ),
  );

  const planModel = bail(
    await p.text({
      message: "Model for planning (Claude Code alias or id, e.g. opus)",
      initialValue: envOr("PLAN_MODEL", "opus"),
      validate: (v) => (v?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const implModel = bail(
    await p.text({
      message: "Model for implementing (runs the implementation subagents)",
      initialValue: envOr("IMPL_MODEL", "sonnet"),
      validate: (v) => (v?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const autoClaimDefault = !["false", "off", "no", "0"].includes(
    envOr("AUTO_CLAIM", envOr("AUTO_PICK", "true")).toLowerCase(),
  );
  const autoClaim = bail(
    await p.confirm({ message: "Enable the autonomous claim step?", initialValue: autoClaimDefault }),
  );
  let riskLabels = envOr("RISK_LABELS", "migration,infra,security,breaking")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  let maxInProgress = Number(envOr("MAX_IN_PROGRESS", "3"));
  if (autoClaim) {
    const labelsStr = bail(
      await p.text({
        message: "Never auto-claim tickets with these labels (comma-separated)",
        initialValue: riskLabels.join(","),
      }),
    );
    riskLabels = labelsStr
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const maxStr = bail(
      await p.text({
        message: "Max tickets In Progress at once (WIP cap)",
        initialValue: String(Number.isInteger(maxInProgress) && maxInProgress >= 1 ? maxInProgress : 3),
        validate: (v) =>
          Number.isInteger(Number(v)) && Number(v) >= 1 ? undefined : "Enter a positive integer",
      }),
    );
    maxInProgress = Number(maxStr);
  }

  const autoCleanupDefault = !["false", "off", "no", "0"].includes(
    envOr("AUTO_CLEANUP", "true").toLowerCase(),
  );
  const autoCleanup = bail(
    await p.confirm({
      message: "Enable the cleanup step? (remove a worktree + session once its PR merges)",
      initialValue: autoCleanupDefault,
    }),
  );

  await installHostLinks();

  const preflight = [
    { path: sessionScriptPath, label: "~/new-session.sh", role: "launches worktree+tmux sessions (required)" },
    {
      path: endSessionScriptPath,
      label: "~/end-session.sh",
      role: "cleanup step: tears down merged PRs' worktrees (required for cleanup)",
    },
    {
      path: join(homedir(), "split-pr.sh"),
      label: "~/split-pr.sh",
      role: "adds a PR window per split slice (required for split PRs)",
    },
    {
      path: join(homedir(), ".claude/skills/pickup-ticket"),
      label: "~/.claude/skills/pickup-ticket",
      role: "plan→implement→review flow (required)",
    },
    {
      path: join(homedir(), ".claude/skills/address-pr-comments"),
      label: "~/.claude/skills/address-pr-comments",
      role: "review step: address PR comments (required for PR handling)",
    },
    {
      path: join(homedir(), ".claude/skills/fix-pr-ci"),
      label: "~/.claude/skills/fix-pr-ci",
      role: "review step: fix failing PR CI (required for CI handling)",
    },
    {
      path: join(homedir(), ".claude/skills/fix-pr-conflict"),
      label: "~/.claude/skills/fix-pr-conflict",
      role: "review step: resolve PR merge conflicts (required for conflict handling)",
    },
    {
      path: join(homedir(), ".config/yimbot/session-settings.json"),
      label: "~/.config/yimbot/session-settings.json",
      role: "deny-list safety net for spawned sessions (recommended)",
    },
  ];
  p.note(
    preflight.map((c) => `${existsSync(c.path) ? "[ok]" : "[missing]"} ${c.label} — ${c.role}`).join("\n"),
    "Pre-flight",
  );
  if (!existsSync(sessionScriptPath)) {
    const proceed = bail(
      await p.confirm({
        message: "~/new-session.sh is missing; the daemon can't launch sessions without it. Save config anyway?",
        initialValue: true,
      }),
    );
    if (!proceed) {
      p.cancel("Setup cancelled — no changes written.");
      process.exit(0);
    }
  }

  const config: YimbotConfig = {
    apiKey,
    teamName,
    deployStateName,
    reviewStateName,
    todoStateName,
    heartbeatIntervalMinutes,
    codebasePath,
    planModel,
    implModel,
    autoClaim,
    riskLabels,
    maxInProgress,
    autoCleanup,
  };
  writeEnvFile(serializeEnvFile(config));
  p.outro(`Saved to .env — signed in as ${viewerName}, watching "${teamName}".`);
  return config;
}
