// src/mcp-health.ts
// The ticket sessions reach GitHub through Claude Code's MCP plugin, a path the
// daemon itself never takes, so nothing in reach.ts would notice it breaking.
// `claude mcp list` already connects to every registered server and prints a
// verdict per line; this runs it on a slow timer and records the watched
// servers' verdicts as reach outcomes, so the board shows them the same way.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { envOr } from "./env.ts";
import { recordReach, type Service } from "./reach.ts";

const execFileAsync = promisify(execFile);

export type McpHealth = { name: string; ok: boolean; detail: string };
export type McpVerdict = { service: Service; ok: boolean; detail: string };

// Registered name as `claude mcp list` prints it, and the board service it maps to.
const WATCHED: { name: string; service: Service }[] = [{ name: "plugin:github:github", service: "github-mcp" }];

// One row reads "<name>: <command or url> - <glyph> <verdict>". The name may
// hold colons (plugin:github:github), so it ends at the first ": "; the command
// may hold " - ", so the glyph is what anchors the split.
const ROW = /^(\S+?):\s.*\s-\s([✔✘!])\s(.*)$/;

export function parseMcpHealth(output: string): McpHealth[] {
  const rows: McpHealth[] = [];
  for (const line of output.split("\n")) {
    const m = ROW.exec(line.trim());
    if (m) rows.push({ name: m[1], ok: m[2] === "✔", detail: m[3].trim() });
  }
  return rows;
}

export function judgeMcp(rows: McpHealth[], watched = WATCHED): McpVerdict[] {
  return watched.map(({ name, service }) => {
    const row = rows.find((r) => r.name === name);
    if (!row) return { service, ok: false, detail: "not registered" };
    return { service, ok: row.ok, detail: row.detail };
  });
}

// `claude mcp list` exits 0 even when a server fails, and prints to stdout. It
// starts every registered stdio server, several through `npx -y ...@latest`,
// so a cold cache or slow registry can take a while; the deadline is generous.
export async function runMcpList(): Promise<string> {
  const { stdout } = await execFileAsync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 180_000 });
  return stdout;
}

// A failure recorded here has to outlive the gap until the next probe, or the
// warning would blink off between checks; hence the caller-supplied ttl.
export async function checkMcpHealth(
  run: () => Promise<string>,
  log: (msg: string) => void,
  now: number = Date.now(),
  ttlMs?: number,
): Promise<void> {
  let output: string;
  try {
    output = await run();
  } catch (err) {
    log(`mcp health: could not run claude mcp list (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  for (const v of judgeMcp(parseMcpHealth(output))) {
    recordReach(v.service, v.ok, now, ttlMs);
    if (!v.ok) log(`mcp health: ${v.service} down: ${v.detail}`);
  }
}

// The probe interval from MCP_HEALTH_INTERVAL_MINUTES: default 30, 0 or an
// off-word disables, anything unparsable is reported so the probe cannot
// vanish over a typo.
export function mcpHealthIntervalMinutes(raw: string): number | "invalid" {
  const v = raw.trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(v)) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : "invalid";
}

// Every MCP_HEALTH_INTERVAL_MINUTES, once at startup. Returns the stop
// function. Off the heartbeat on purpose: the list spawns every stdio server
// and takes seconds.
export function startMcpHealth(log: (msg: string) => void, run: () => Promise<string> = runMcpList): () => void {
  const raw = envOr("MCP_HEALTH_INTERVAL_MINUTES", "30");
  const minutes = mcpHealthIntervalMinutes(raw);
  if (minutes === "invalid") {
    log(`mcp health OFF: MCP_HEALTH_INTERVAL_MINUTES="${raw}" is not a positive number or off`);
    return () => {};
  }
  if (minutes === 0) {
    log("mcp health OFF (MCP_HEALTH_INTERVAL_MINUTES=0)");
    return () => {};
  }
  log(`mcp health ON: probing github-mcp every ${minutes}m`);
  const intervalMs = minutes * 60 * 1000;
  const tick = (): Promise<void> => checkMcpHealth(run, log, Date.now(), intervalMs * 2);
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
