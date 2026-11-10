import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTilde, isGitRepo as defaultIsGitRepo } from "./settings-model.ts";

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
  { key: "shortcut", label: "Shortcut MCP server (shortcut)", severity: "recommended" },
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
export function resetMcpCache(): void {
  mcpServersCache = null;
}
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
    case "shortcut":
      return mcpServers().includes("shortcut");
    case "git-identity":
      return gitIdentitySet();
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
    case "shortcut":
      return "Register the Shortcut MCP under the name 'shortcut' (claude mcp add shortcut -- npx -y @shortcut/mcp@latest)";
    case "tmux-status":
      return "Add @feature_status to your tmux status line so the ready-to-test flag shows";
  }
  const cmd = installCommand(key, pm);
  if (cmd) return `Run: ${cmd.join(" ")}`;
  const pkg = pmPackage[key];
  const name = pkg?.default ?? key;
  return `Install "${name}" with your system package manager (pacman/apt/dnf/brew)`;
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
    source: join(repoRoot, "scripts/create-subticket.sh"),
    target: join(homedir(), "create-subticket.sh"),
    label: "split subticket creator (~/create-subticket.sh)",
  },
  {
    source: join(repoRoot, "scripts/refine-session.sh"),
    target: join(homedir(), "refine-session.sh"),
    label: "refine session launcher (~/refine-session.sh)",
  },
  {
    source: join(repoRoot, "scripts/qa-session.sh"),
    target: join(homedir(), "qa-session.sh"),
    label: "QA session launcher (~/qa-session.sh)",
  },
  {
    source: join(repoRoot, "scripts/relate-tickets.sh"),
    target: join(homedir(), "relate-tickets.sh"),
    label: "blocks-relation writer (~/relate-tickets.sh)",
  },
  {
    source: join(repoRoot, "scripts/estimate-ticket.sh"),
    target: join(homedir(), "estimate-ticket.sh"),
    label: "estimate setter (~/estimate-ticket.sh)",
  },
  {
    source: join(repoRoot, "scripts/get-ticket.sh"),
    target: join(homedir(), "get-ticket.sh"),
    label: "ticket reader (~/get-ticket.sh)",
  },
  {
    source: join(repoRoot, "scripts/comment-ticket.sh"),
    target: join(homedir(), "comment-ticket.sh"),
    label: "ticket commenter (~/comment-ticket.sh)",
  },
  {
    source: join(repoRoot, "scripts/attach-ticket.sh"),
    target: join(homedir(), "attach-ticket.sh"),
    label: "ticket file attacher (~/attach-ticket.sh)",
  },
  {
    source: join(repoRoot, "scripts/move-ticket.sh"),
    target: join(homedir(), "move-ticket.sh"),
    label: "ticket state mover (~/move-ticket.sh)",
  },
  {
    source: join(repoRoot, "skills/refine-ticket"),
    target: join(homedir(), ".claude/skills/refine-ticket"),
    label: "refine-ticket skill (~/.claude/skills/refine-ticket)",
  },
  {
    source: join(repoRoot, "skills/qa-instructions"),
    target: join(homedir(), ".claude/skills/qa-instructions"),
    label: "qa-instructions skill (~/.claude/skills/qa-instructions)",
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
    source: join(repoRoot, "skills/fix-pr-blocked"),
    target: join(homedir(), ".claude/skills/fix-pr-blocked"),
    label: "fix-pr-blocked skill (~/.claude/skills/fix-pr-blocked)",
  },
  {
    source: join(repoRoot, "skills/merge-main"),
    target: join(homedir(), ".claude/skills/merge-main"),
    label: "merge-main skill (~/.claude/skills/merge-main)",
  },
  {
    source: join(repoRoot, "skills/receiving-code-review"),
    target: join(homedir(), ".claude/skills/receiving-code-review"),
    label: "receiving-code-review skill (~/.claude/skills/receiving-code-review)",
  },
  {
    source: join(repoRoot, "skills/daily-standup"),
    target: join(homedir(), ".claude/skills/daily-standup"),
    label: "daily-standup skill (~/.claude/skills/daily-standup)",
  },
  {
    source: join(repoRoot, "settings/session-settings.json"),
    target: join(homedir(), ".config/yimbot/session-settings.json"),
    label: "session deny-list (~/.config/yimbot/session-settings.json)",
  },
  {
    source: join(repoRoot, "scripts/heavy-queue.sh"),
    target: join(homedir(), ".config/yimbot/heavy-queue.sh"),
    label: "heavy job queue (~/.config/yimbot/heavy-queue.sh)",
  },
  {
    source: join(repoRoot, "settings/heavy-jobs.conf"),
    target: join(homedir(), ".config/yimbot/heavy-jobs.conf"),
    label: "heavy job patterns (~/.config/yimbot/heavy-jobs.conf)",
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

// The argv that satisfies a prerequisite interactively: the gh login for the
// auth check, otherwise its install command (may be null when unfixable here).
export function fixCommandFor(pr: Prerequisite, pm: PackageManager | null): string[] | null {
  if (pr.key === "gh-auth") return ["gh", "auth", "login"];
  return installCommand(pr.key, pm);
}

// Create target as a symlink to source, making parent dirs as needed. Shared by
// the interactive installer and the non-interactive startup healer so the two
// cannot drift.
export function createLink(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target);
}

// Non-interactive host-link healer: create only missing links, never prompting
// and never touching a pre-existing non-symlink. Returns one result line per
// link. Called on daemon startup so a removed or never-installed link repairs
// itself. `links` is injectable for tests.
export function ensureHostLinks(links: HostLink[] = hostLinks): string[] {
  const results: string[] = [];
  for (const { source, target, label } of links) {
    try {
      const state = linkState(source, target);
      if (state === "ours") {
        results.push(`[ok] ${label} already linked`);
      } else if (state === "other") {
        results.push(`[warn] ${label}: ${target} exists and isn't a yimbot link; left as-is`);
      } else if (!existsSync(source)) {
        results.push(`[fail] ${label}: source missing ${source}`);
      } else {
        createLink(source, target);
        results.push(`[ok] ${label} linked`);
      }
    } catch (err) {
      results.push(`[fail] ${label}: ${errMsg(err)}`);
    }
  }
  return results;
}

export type CheckResult = { pr: Prerequisite; ok: boolean };

// Yields to the event loop between checks so a TUI can paint "checking" while
// the synchronous probes run.
export async function checkAll(severity?: Severity): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const pr of PREREQUISITES) {
    if (severity && pr.severity !== severity) continue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    results.push({ pr, ok: isSatisfied(pr) });
  }
  return results;
}

export type NeedsSetupDeps = {
  checkRequired: () => Promise<CheckResult[]>;
  isGitRepo: (path: string) => boolean;
};

const defaultNeedsSetupDeps: NeedsSetupDeps = {
  checkRequired: () => checkAll("required"),
  isGitRepo: defaultIsGitRepo,
};

export async function needsSetup(
  env: NodeJS.ProcessEnv,
  deps: NeedsSetupDeps = defaultNeedsSetupDeps,
): Promise<{ needed: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (!env.LINEAR_API_KEY?.trim()) reasons.push("LINEAR_API_KEY is not set");
  const codebase = env.CODEBASE_PATH?.trim();
  if (!codebase) {
    reasons.push("CODEBASE_PATH is not set");
  } else if (!deps.isGitRepo(expandTilde(codebase))) {
    reasons.push(`CODEBASE_PATH is not a git repository: ${codebase}`);
  }
  for (const { pr, ok } of await deps.checkRequired()) {
    if (pr.severity === "required" && !ok) reasons.push(`Missing prerequisite: ${pr.label}`);
  }
  return { needed: reasons.length > 0, reasons };
}

export type SetupMode = "tui" | "cli" | "none";

// The wizard needs a real terminal; without one (pipes, ssh with no pty,
// TERM=dumb) the clack prompts in runSetup still work.
export function setupMode(opts: { isTTY: boolean; term: string | undefined; needed: boolean }): SetupMode {
  if (!opts.needed) return "none";
  if (!opts.isTTY || opts.term === "dumb") return "cli";
  return "tui";
}
