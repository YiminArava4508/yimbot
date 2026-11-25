// src/agent.ts
// Which coding agent CLI the one-shot headless calls run through. Only the
// argv shape differs per agent; the spawn, timeout and error handling in
// headless.ts are shared.
export type Agent = "claude" | "codex";

export const AGENTS: Agent[] = ["claude", "codex"];

export function agentFromEnv(env: Record<string, string | undefined> = process.env): Agent {
  const raw = (env.AGENT ?? "").trim().toLowerCase();
  if (raw === "") return "claude";
  const agent = AGENTS.find((a) => a === raw);
  if (!agent) throw new Error(`AGENT must be one of ${AGENTS.join(", ")}`);
  return agent;
}

// The prompt always goes in on stdin, so neither shape puts it in argv.
// restricted strips claude of every tool, MCP server and command, for runs whose
// input is untrusted; codex is already confined to a read-only sandbox.
export function headlessCommand(
  agent: Agent,
  model: string,
  opts: { restricted?: boolean } = {},
): { bin: string; args: string[] } {
  if (agent === "codex") {
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only"];
    if (model) args.push("-m", model);
    args.push("-");
    return { bin: "codex", args };
  }
  const args = ["-p"];
  if (model) args.push("--model", model);
  if (opts.restricted) {
    args.push("--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "dontAsk");
  }
  return { bin: "claude", args };
}

// The tolerant read for config surfaces: a hand-edited bad value shows as the
// default instead of breaking the panel (the daemon's agentFromEnv still throws).
export function agentOr(raw: string): Agent {
  return AGENTS.find((a) => a === raw.trim().toLowerCase()) ?? "claude";
}
