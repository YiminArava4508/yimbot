import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueStatus, queueRows, readQueueState, QUEUE_PANE_WIDTH } from "./heavy-queue.ts";

test("parseQueueStatus reads a holder and its waiters", () => {
  const state = parseQueueStatus(
    '{"running":{"key":"ENG-1","cmd":"task generate","since":10},"waiting":[{"key":"ENG-2","cmd":"pnpm build","since":20}]}',
  );
  assert.equal(state.running?.key, "ENG-1");
  assert.deepEqual(state.waiting.map((w) => w.key), ["ENG-2"]);
});

test("parseQueueStatus treats an empty queue as idle", () => {
  const state = parseQueueStatus('{"running":null,"waiting":[]}');
  assert.equal(state.running, null);
  assert.deepEqual(state.waiting, []);
});

test("parseQueueStatus survives garbage rather than throwing into the render loop", () => {
  const state = parseQueueStatus("not json at all");
  assert.equal(state.running, null);
  assert.deepEqual(state.waiting, []);
});

test("readQueueState reports an idle queue when the CLI cannot run", () => {
  const state = readQueueState(() => {
    throw new Error("ENOENT");
  });
  assert.equal(state.running, null);
});

test("queueRows marks the holder and lists waiters in order", () => {
  const rows = queueRows({
    running: { key: "ENG-1", cmd: "task generate", since: 10 },
    waiting: [
      { key: "ENG-2", cmd: "pnpm build", since: 20 },
      { key: "ENG-3", cmd: "go test ./...", since: 30 },
    ],
  });
  assert.deepEqual(rows, [["QUEUE"], ["{green-fg}▶ ENG-1{/green-fg}"], ["  ENG-2"], ["  ENG-3"]]);
});

test("queueRows says idle rather than rendering a bare header", () => {
  assert.deepEqual(queueRows({ running: null, waiting: [] }), [["QUEUE"], ["{grey-fg}idle{/grey-fg}"]]);
});

test("queueRows truncates a key that would overflow the pane", () => {
  const rows = queueRows({ running: { key: "ENG-1234567890123", cmd: "task generate", since: 10 }, waiting: [] });
  const visible = rows[1][0].replace(/\{[^{}]*\}/g, "");
  assert.ok(visible.length <= QUEUE_PANE_WIDTH - 4, `"${visible}" fits the pane interior`);
});
