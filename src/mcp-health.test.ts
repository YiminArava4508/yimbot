import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMcpHealth, judgeMcp, mcpHealthIntervalMinutes, parseMcpHealth, startMcpHealth } from "./mcp-health.ts";
import { resetReach, unreachable } from "./reach.ts";

const LIST = `⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY is set
Checking MCP server health…

plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✘ Failed to connect - HTTP 400: Error POSTing to endpoint: bad request
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
context7: npx -y @upstash/context7-mcp@latest - ✔ Connected
HubSpotDev: hs mcp start --ai-agent claude - ✔ Connected
`;

test("parseMcpHealth reads one row per server, keeping plugin-scoped names whole", () => {
  const rows = parseMcpHealth(LIST);
  assert.deepEqual(
    rows.map((r) => [r.name, r.ok]),
    [
      ["plugin:github:github", false],
      ["plugin:figma:figma", false],
      ["context7", true],
      ["HubSpotDev", true],
    ],
  );
  assert.equal(rows[0].detail, "Failed to connect - HTTP 400: Error POSTing to endpoint: bad request");
  assert.equal(rows[1].detail, "Needs authentication");
});

test("parseMcpHealth finds the verdict glyph even when the command holds ' - '", () => {
  const [row] = parseMcpHealth("slot-machine: /home/x/bin/slot-machine-mcp - foo - ✔ Connected");
  assert.equal(row.name, "slot-machine");
  assert.equal(row.ok, true);
  assert.equal(row.detail, "Connected");
});

test("parseMcpHealth returns nothing for the no-servers message", () => {
  assert.deepEqual(parseMcpHealth("No MCP servers configured. Use `claude mcp add` to add a server.\n"), []);
});

test("judgeMcp reports a watched server that is missing as down", () => {
  const [github] = judgeMcp(parseMcpHealth("context7: npx foo - ✔ Connected"));
  assert.equal(github.service, "github-mcp");
  assert.equal(github.ok, false);
  assert.equal(github.detail, "not registered");
});

test("judgeMcp carries the failure detail through for a watched server", () => {
  const [github] = judgeMcp(parseMcpHealth(LIST));
  assert.equal(github.ok, false);
  assert.match(github.detail, /HTTP 400/);
});

test("checkMcpHealth records a failing watched server and logs why", async () => {
  resetReach();
  const logged: string[] = [];
  await checkMcpHealth(async () => LIST, (m) => logged.push(m), 0, 1000);
  assert.deepEqual(unreachable(0), ["github-mcp"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /github-mcp.*HTTP 400/);
});

test("checkMcpHealth clears the warning once the server connects", async () => {
  resetReach();
  await checkMcpHealth(async () => LIST, () => {}, 0, 1000);
  await checkMcpHealth(async () => "plugin:github:github: https://x (HTTP) - ✔ Connected", () => {}, 1, 1000);
  assert.deepEqual(unreachable(1), []);
});

test("checkMcpHealth leaves the state alone and logs when the list itself cannot run", async () => {
  resetReach();
  const logged: string[] = [];
  await checkMcpHealth(
    async () => {
      throw new Error("spawn claude ENOENT");
    },
    (m) => logged.push(m),
    0,
    1000,
  );
  assert.deepEqual(unreachable(0), []);
  assert.match(logged[0], /ENOENT/);
});

test("mcpHealthIntervalMinutes reads the default, the off-words, and rejects a typo", () => {
  assert.equal(mcpHealthIntervalMinutes("30"), 30);
  assert.equal(mcpHealthIntervalMinutes("2.5"), 2.5);
  assert.equal(mcpHealthIntervalMinutes("0"), 0);
  assert.equal(mcpHealthIntervalMinutes(" OFF "), 0);
  assert.equal(mcpHealthIntervalMinutes("30m"), "invalid");
  assert.equal(mcpHealthIntervalMinutes("-1"), "invalid");
});

test("startMcpHealth says whether it is on, and why not when it is off", () => {
  const withEnv = (value: string | undefined): string[] => {
    const prev = process.env.MCP_HEALTH_INTERVAL_MINUTES;
    if (value === undefined) delete process.env.MCP_HEALTH_INTERVAL_MINUTES;
    else process.env.MCP_HEALTH_INTERVAL_MINUTES = value;
    const logged: string[] = [];
    try {
      startMcpHealth((m) => logged.push(m), async () => "")();
    } finally {
      if (prev === undefined) delete process.env.MCP_HEALTH_INTERVAL_MINUTES;
      else process.env.MCP_HEALTH_INTERVAL_MINUTES = prev;
    }
    return logged;
  };
  assert.match(withEnv(undefined)[0], /mcp health ON: probing github-mcp every 30m/);
  assert.match(withEnv("off")[0], /mcp health OFF/);
  assert.match(withEnv("30m")[0], /mcp health OFF.*"30m"/);
});
