// src/headless.ts
// The one-shot `claude -p` call the review overlay's AI steps and the map
// generator both make. Each caller picks its own model env chain; only the
// execFile shape lives here, so the two cannot drift apart.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function runHeadless(model: string, cwd: string): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const args = ["-p", prompt];
    if (model) args.push("--model", model);
    const { stdout } = await execFileAsync("claude", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  };
}
