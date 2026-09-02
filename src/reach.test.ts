import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, observeReach, recordReach, resetReach, unreachable } from "./reach.ts";

// An execFile-shaped rejection: the message carries the whole argv (prompt
// included), stderr carries what the tool actually said.
function execErr(opts: { message?: string; stderr?: string; code?: number | null; killed?: boolean }): Error {
  const err = new Error(opts.message ?? "Command failed: gh pr view 1");
  Object.assign(err, { stderr: opts.stderr ?? "", code: opts.code ?? 1, killed: opts.killed ?? false });
  return err;
}

test("nothing is reported unreachable until a call actually fails", () => {
  resetReach();
  assert.deepEqual(unreachable(), []);
});

test("a network failure marks the service, a success clears it", () => {
  resetReach();
  recordReach("github", false, 0);
  assert.deepEqual(unreachable(0), ["github"]);
  recordReach("github", true, 1);
  assert.deepEqual(unreachable(1), []);
});

test("services are reported in a fixed order, not the order they failed", () => {
  resetReach();
  recordReach("claude", false, 0);
  recordReach("github", false, 0);
  recordReach("linear", false, 0);
  assert.deepEqual(unreachable(0), ["github", "linear", "claude"]);
});

test("a failure expires so a one-off on a rarely-called service does not stick", () => {
  resetReach();
  recordReach("claude", false, 0, 1000);
  assert.deepEqual(unreachable(999), ["claude"]);
  assert.deepEqual(unreachable(1001), []);
});

test("classifyError reads the node fetch shape off cause.code", () => {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
  assert.equal(classifyError(err), "unreachable");
});

test("classifyError recognizes the Go dial error gh passes through", () => {
  assert.equal(
    classifyError(
      execErr({ stderr: 'Post "https://api.github.com/graphql": dial tcp 1.2.3.4:443: connect: no route to host' }),
    ),
    "unreachable",
  );
});

test("classifyError recognizes gh's own connection wrapper", () => {
  // gh swallows the dial error for some commands and prints only this, so
  // matching the Go text alone misses the outage the warning exists for.
  assert.equal(
    classifyError(execErr({ stderr: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com" })),
    "unreachable",
  );
});

test("classifyError treats an exit code with no network sign as the service answering", () => {
  assert.equal(classifyError(execErr({ stderr: "could not resolve to a PullRequest with the number 99" })), "reached");
  assert.equal(classifyError(new Error("Linear GraphQL: Entity not found")), "reached");
  assert.equal(classifyError(new Error("claude exited 1: invalid model")), "reached");
});

test("classifyError ignores the argv in the message, so a prompt cannot fake an outage", () => {
  // promisify(execFile) puts the full command line in the message, and the
  // daemon's judge passes the ticket description as an argv entry. A ticket
  // that happens to say "connection refused" must not take claude down.
  const err = execErr({
    message: 'Command failed: claude -p "the API returns connection refused when..."',
    stderr: "",
    code: 1,
  });
  assert.equal(classifyError(err), "reached");
});

test("classifyError calls a killed process's failure unproven, not an answer", () => {
  // claude retries a transport failure internally rather than exiting, so a
  // real outage only ever reaches us as our own deadline. Neither "reached"
  // nor "unreachable" is knowable from the error alone.
  assert.equal(classifyError(execErr({ code: null, killed: true, message: "Command failed: claude -p x" })), "timeout");
  assert.equal(classifyError(new Error("claude timed out after 120000ms")), "timeout");
});

test("classifyError leaves an unrecognized failure unknown", () => {
  assert.equal(classifyError(new Error("something nobody predicted")), "unknown");
});

test("classifyError ignores a missing binary: a setup problem, not a network one", () => {
  const err = new Error("spawn claude ENOENT");
  Object.assign(err, { code: "ENOENT" });
  assert.equal(classifyError(err), "unknown");
});

test("observeReach records a success and passes the value through", async () => {
  resetReach();
  assert.equal(await observeReach("github", async () => 7), 7);
  assert.deepEqual(unreachable(), []);
});

test("observeReach marks the service on a network failure and rethrows", async () => {
  resetReach();
  await assert.rejects(
    observeReach("github", async () => {
      throw execErr({ stderr: "dial tcp 1.2.3.4:443: connect: no route to host" });
    }),
    /Command failed/,
  );
  assert.deepEqual(unreachable(), ["github"]);
});

test("observeReach counts a non-network failure as reached, since it answered", async () => {
  resetReach();
  recordReach("linear", false);
  await assert.rejects(
    observeReach("linear", async () => {
      throw new Error("Linear GraphQL: Entity not found");
    }),
  );
  assert.deepEqual(unreachable(), []);
});

test("observeReach leaves the state alone when it cannot classify the failure", async () => {
  // A live warning must survive an unrecognized rejection: during an outage the
  // phrasings vary, and treating the odd one out as proof of health would blink
  // the warning off mid-outage.
  resetReach();
  recordReach("github", false);
  await assert.rejects(
    observeReach("github", async () => {
      throw new Error("something nobody predicted");
    }),
  );
  assert.deepEqual(unreachable(), ["github"]);
});

test("observeReach probes the host on a killed call, marking it down when the probe fails", async () => {
  resetReach();
  await assert.rejects(
    observeReach("claude", async () => {
      throw new Error("claude timed out after 120000ms");
    }, async () => false),
  );
  assert.deepEqual(unreachable(), ["claude"]);
});

test("observeReach clears the warning on a killed call whose host answers the probe", async () => {
  // A slow prompt hitting the deadline is not an unreachable API.
  resetReach();
  recordReach("claude", false);
  await assert.rejects(
    observeReach("claude", async () => {
      throw new Error("claude timed out after 120000ms");
    }, async () => true),
  );
  assert.deepEqual(unreachable(), []);
});
