// src/headless.ts
// The one-shot `claude -p` (or `codex exec`) call the review overlay's AI steps
// and the map generator both make. Each caller picks its own model env chain;
// only the spawn shape lives here, so the two cannot drift apart.
import { spawn } from "node:child_process";
import { agentFromEnv, headlessCommand, type Agent } from "./agent.ts";
import { observeReach } from "./reach.ts";

const TIMEOUT_MS = 120_000;

// A stale ANTHROPIC_API_KEY in the shell outranks claude's own sign-in and
// fails every call with "Invalid API key". Callers that want the sign-in pass
// this as `env`.
export function withoutApiKey(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _drop, ...rest } = env;
  return rest;
}

export function runHeadless(
  model: string,
  cwd: string,
  timeoutMs: number = TIMEOUT_MS,
  agent: Agent = agentFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): (prompt: string) => Promise<string> {
  const run = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const { bin, args } = headlessCommand(agent, model);
      const child = spawn(bin, args, { cwd, env });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => { out += d; });
      child.stderr.on("data", (d: string) => { err += d; });
      child.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        // A killed child reports no exit code, and "exited null" reads as a
        // agent failure rather than the deadline this side imposed.
        else if (timedOut) reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
        else reject(new Error(`${agent} exited ${code}: ${err.trim().slice(0, 300)}`));
      });
      // The prompt goes in on stdin: a whole repo's file list is well past the
      // kernel's 128 KiB cap on one argv entry, and spawn throws E2BIG there.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  // Wrapped so the board can warn when the agent's API stops answering. A
  // non-zero exit or the deadline above is not a reachability problem: only a
  // transport failure in the agent's own output counts (see isNetworkError).
  return (prompt: string) => observeReach(agent, () => run(prompt));
}
