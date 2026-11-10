import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as p from "@clack/prompts";
import { describeLabelFilter, parseLabelFilter } from "./labels.ts";
import { fetchTeamLabels, fetchTeamStates, fetchTeams, fetchViewer } from "./linear-api.ts";
import {
  configFromEnv,
  configToEnvRecord,
  envPath,
  expandTilde,
  extractPassthroughLines,
  isConfigured,
  isGitRepo,
  isPositiveInt,
  isPositiveNumber,
  parseCommaList,
  serializeEnvFile,
  writeEnvFile,
  type YimbotConfig,
} from "./settings-model.ts";
import {
  commandExists,
  configReferencesFeatureStatus,
  createLink,
  detectPackageManager,
  ensureHostLinks,
  errMsg,
  fixCommandFor,
  ghAuthenticated,
  ghHasScopes,
  hasClaudeAuth,
  hostLinks,
  installCommand,
  installHint,
  isSatisfied,
  linkState,
  PREREQUISITES,
  type PackageManager,
  parseGhScopes,
  parseInstalledPlugins,
  parseMcpServers,
  type Prerequisite,
  resetMcpCache,
  type Severity,
} from "./setup-core.ts";
import { endSessionScriptPath, sessionScriptPath } from "./watcher.ts";

export {
  configToEnvRecord,
  envPath,
  expandTilde,
  isConfigured,
  isGitRepo,
  serializeEnvFile,
  writeEnvFile,
  type YimbotConfig,
};

export {
  commandExists,
  configReferencesFeatureStatus,
  detectPackageManager,
  ensureHostLinks,
  ghAuthenticated,
  ghHasScopes,
  hasClaudeAuth,
  hostLinks,
  installCommand,
  installHint,
  isSatisfied,
  linkState,
  PREREQUISITES,
  type PackageManager,
  parseGhScopes,
  parseInstalledPlugins,
  parseMcpServers,
  type Prerequisite,
  type Severity,
};

// Abort cleanly on Ctrl-C / Esc at any prompt. Nothing is written until the very
// end, so cancelling always leaves the existing config untouched.
function bail<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled — no changes written.");
    process.exit(0);
  }
  return value;
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
        resetMcpCache(); // a fix may have changed MCP config
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
    resetMcpCache(); // the user may have changed config while we waited
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
      createLink(source, target);
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

  const current = configFromEnv(process.env);

  const { apiKey, viewerName } = await resolveApiKey();

  const teamsSpin = p.spinner();
  teamsSpin.start("Loading teams");
  const teams = await fetchTeams(apiKey);
  teamsSpin.stop(`Loaded ${teams.length} team(s)`);
  if (teams.length === 0) {
    p.cancel("This account has no accessible teams.");
    process.exit(1);
  }
  const teamId = bail(
    await p.select({
      message: "Team to watch",
      options: teams.map((t) => ({ value: t.id, label: t.name, hint: t.key })),
      initialValue:
        teams.find((t) => t.name.toLowerCase() === current.teamName.toLowerCase())?.id ?? teams[0].id,
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
    current.deployStateName,
  );
  const reviewStateName = await pickState(
    'Your "In Review" state (flags a session ready to test)',
    current.reviewStateName,
  );
  const todoStateName = await pickState("Auto-claim ready work from…", current.todoStateName);

  const labelsSpin = p.spinner();
  labelsSpin.start("Loading labels");
  const teamLabels = await fetchTeamLabels(apiKey, teamId);
  labelsSpin.stop(`Loaded ${teamLabels.length} label(s)`);

  const currentFilter = parseLabelFilter(process.env.LABEL_FILTER);
  // Preserves an existing LABEL_FILTER on a re-run when the team has zero
  // labels and the prompt below is skipped.
  let labelFilter = current.labelFilter;
  if (teamLabels.length > 0) {
    const mode = bail(
      await p.select({
        message: "Which tickets should this instance work?",
        options: [
          { value: "all", label: "Every ticket", hint: "one machine, no restriction" },
          { value: "only", label: "Only tickets with a label", hint: "the bot machine" },
          { value: "except", label: "Every ticket except one label", hint: "your own machine" },
        ],
        initialValue: currentFilter ? (currentFilter.negated ? "except" : "only") : "all",
      }),
    );
    if (mode === "all") {
      labelFilter = "";
    } else {
      // Seed the current filter's label even when it is missing from the
      // fetched list, so a stale label doesn't silently fall back to the
      // first one in the picker and swap the partition out from under the user.
      const currentLabelKnown = teamLabels.some((l) => l.toLowerCase() === currentFilter?.label);
      const options =
        currentFilter && !currentLabelKnown
          ? [{ value: currentFilter.label, label: currentFilter.label }, ...teamLabels.map((l) => ({ value: l, label: l }))]
          : teamLabels.map((l) => ({ value: l, label: l }));
      const picked = bail(
        await p.select({
          message: mode === "only" ? "Work only tickets labelled…" : "Never work tickets labelled…",
          options,
          initialValue:
            teamLabels.find((l) => l.toLowerCase() === currentFilter?.label) ??
            currentFilter?.label ??
            teamLabels[0],
        }),
      );
      labelFilter = mode === "only" ? picked : `!${picked}`;
    }
  }

  const codebasePath = expandTilde(
    bail(
      await p.text({
        message: "Codebase path (git repo pulled every poll)",
        initialValue: current.codebasePath,
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

  const heartbeatIntervalMinutes = Number(
    bail(
      await p.text({
        message: "Heartbeat interval (minutes) — how often to check the board",
        initialValue: String(current.heartbeatIntervalMinutes),
        validate: (v) => (isPositiveNumber(v ?? "") ? undefined : "Must be a positive number"),
      }),
    ),
  );

  const planModel = bail(
    await p.text({
      message: "Model for planning (Claude Code alias or id, e.g. opus)",
      initialValue: current.planModel,
      validate: (v) => (v?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const implModel = bail(
    await p.text({
      message: "Model for implementing (runs the implementation subagents)",
      initialValue: current.implModel,
      validate: (v) => (v?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const autoClaim = bail(
    await p.confirm({ message: "Enable the autonomous claim step?", initialValue: current.autoClaim }),
  );
  let riskLabels = current.riskLabels;
  let maxInProgress = current.maxInProgress;
  if (autoClaim) {
    const labelsStr = bail(
      await p.text({
        message: "Never auto-claim tickets with these labels (comma-separated)",
        initialValue: riskLabels.join(","),
      }),
    );
    riskLabels = parseCommaList(labelsStr);
    const maxStr = bail(
      await p.text({
        message: "Max tickets In Progress at once (WIP cap)",
        initialValue: String(Number.isInteger(maxInProgress) && maxInProgress >= 1 ? maxInProgress : 3),
        validate: (v) => (isPositiveInt(v ?? "") ? undefined : "Enter a positive integer"),
      }),
    );
    maxInProgress = Number(maxStr);
  }

  const autoCleanup = bail(
    await p.confirm({
      message: "Enable the cleanup step? (remove a worktree + session once its PR merges)",
      initialValue: current.autoCleanup,
    }),
  );

  const autoContinue = bail(
    await p.confirm({
      message: "Enable the advance step? (judge merged PRs against issue ACs and auto-continue while criteria remain)",
      initialValue: current.autoContinue,
    }),
  );
  let maxContinuations = current.maxContinuations;
  if (autoContinue) {
    const maxContinuationsStr = bail(
      await p.text({
        message: "Max continuation rounds per issue",
        initialValue: String(
          Number.isInteger(maxContinuations) && maxContinuations >= 1 ? maxContinuations : 5,
        ),
        validate: (v) => (isPositiveInt(v ?? "") ? undefined : "Enter a positive integer"),
      }),
    );
    maxContinuations = Number(maxContinuationsStr);
  }
  const acJudgeModel = bail(
    await p.text({
      message: "Model for the AC judge (blank = claude default)",
      initialValue: current.acJudgeModel,
    }),
  ).trim();

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
      path: join(homedir(), "create-subticket.sh"),
      label: "~/create-subticket.sh",
      role: "creates a Linear subticket per split slice (required for split PRs)",
    },
    {
      path: join(homedir(), "refine-session.sh"),
      label: "~/refine-session.sh",
      role: "spawns refine sessions for unestimated tickets (required for refine)",
    },
    {
      path: join(homedir(), "relate-tickets.sh"),
      label: "~/relate-tickets.sh",
      role: "wires subticket ordering during refine (required for refine)",
    },
    {
      path: join(homedir(), "estimate-ticket.sh"),
      label: "~/estimate-ticket.sh",
      role: "sets estimates during refine (required for refine)",
    },
    {
      path: join(homedir(), "attach-ticket.sh"),
      label: "~/attach-ticket.sh",
      role: "uploads screenshots during QA sessions (required for the QA step)",
    },
    {
      path: join(homedir(), ".claude/skills/refine-ticket"),
      label: "~/.claude/skills/refine-ticket",
      role: "refine session flow (required for refine)",
    },
    {
      path: join(homedir(), ".claude/skills/qa-instructions"),
      label: "~/.claude/skills/qa-instructions",
      role: "QA session flow (required for the QA step)",
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
      path: join(homedir(), ".claude/skills/fix-pr-blocked"),
      label: "~/.claude/skills/fix-pr-blocked",
      role: "review step: unblock a PR kicked out of the merge queue (required for blocked handling)",
    },
    {
      path: join(homedir(), ".claude/skills/merge-main"),
      label: "~/.claude/skills/merge-main",
      role: "sync branch with origin/main during CI/conflict fixes (required for PR handling)",
    },
    {
      path: join(homedir(), ".claude/skills/receiving-code-review"),
      label: "~/.claude/skills/receiving-code-review",
      role: "review step: verify review feedback before implementing (required for PR handling)",
    },
    {
      path: join(homedir(), ".config/yimbot/session-settings.json"),
      label: "~/.config/yimbot/session-settings.json",
      role: "deny-list safety net for spawned sessions (recommended)",
    },
    {
      path: join(homedir(), ".config/yimbot/heavy-queue.sh"),
      label: "~/.config/yimbot/heavy-queue.sh",
      role: "serializes CPU-heavy jobs across sessions (recommended; needs jq and flock on PATH)",
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
    claimsPerHeartbeat: current.claimsPerHeartbeat,
    autoCleanup,
    autoContinue,
    maxContinuations,
    acJudgeModel,
    labelFilter,
    maxEstimate: current.maxEstimate,
    autoRefine: true,
    refineUsers: "",
    refineLabelFilter: "",
    maxRefining: 1,
    splitTickets: true,
  };
  const existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  writeEnvFile(serializeEnvFile(config, existingEnv ? extractPassthroughLines(existingEnv) : []));
  p.outro(
    `Saved to .env, signed in as ${viewerName}, watching "${teamName}", working ${describeLabelFilter(parseLabelFilter(labelFilter))}.`,
  );
  return config;
}
