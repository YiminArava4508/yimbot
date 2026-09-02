// src/claude-sessions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { CONTEXT_RELPATH } from "./review-context.ts";
import {
  claudeArgs,
  ensureContextScaffold,
  makeSessionRegistry,
  seedPrompt,
  type PtyLike,
} from "./claude-sessions.ts";

function fakePty(): PtyLike & { killed: boolean; emitData(d: string): void; emitExit(): void } {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: (() => void) | null = null;
  return {
    killed: false,
    write() {},
    resize() {},
    kill() {
      this.killed = true;
    },
    onData(cb) {
      dataCb = cb;
      return { dispose: () => {} };
    },
    onExit(cb) {
      exitCb = cb;
      return { dispose: () => {} };
    },
    emitData(d: string) {
      dataCb?.(d);
    },
    emitExit() {
      exitCb?.();
    },
  };
}

test("seedPrompt names the PR and the context file claude must read", () => {
  const p = seedPrompt(42);
  assert.ok(p.includes("#42"));
  assert.ok(p.includes(CONTEXT_RELPATH));
});

test("claudeArgs runs permission-mode auto with the seed as the trailing arg", () => {
  const args = claudeArgs(42);
  assert.deepEqual(args.slice(0, 2), ["--permission-mode", "auto"]);
  assert.equal(args.at(-1), seedPrompt(42));
});

test("ensureContextScaffold creates a self-ignoring .yimbot dir", () => {
  const cwd = tempDir("yimbot-ctx-");
  ensureContextScaffold(cwd);
  assert.equal(readFileSync(join(cwd, ".yimbot/.gitignore"), "utf8"), "*\n");
  ensureContextScaffold(cwd);
  assert.ok(existsSync(join(cwd, ".yimbot")));
});

test("getOrSpawn reuses a live session and respawns after exit", () => {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const reg = makeSessionRegistry(
    () => {
      const p = fakePty();
      spawned.push(p);
      return p;
    },
    () => {},
  );
  const a = reg.getOrSpawn(1, "/tmp/x");
  assert.equal(reg.getOrSpawn(1, "/tmp/x"), a);
  assert.equal(spawned.length, 1);
  assert.notEqual(reg.getOrSpawn(2, "/tmp/y"), a);
  spawned[0].emitExit();
  assert.ok(a.exited);
  const a2 = reg.getOrSpawn(1, "/tmp/x");
  assert.notEqual(a2, a);
  assert.equal(spawned.length, 3);
});

test("pty output lands in the session's terminal buffer", async () => {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const reg = makeSessionRegistry(
    () => {
      const p = fakePty();
      spawned.push(p);
      return p;
    },
    () => {},
  );
  const s = reg.getOrSpawn(3, "/tmp/z");
  spawned[0].emitData("hello");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(s.term.buffer.active.getLine(0)?.translateToString(true).includes("hello"));
});

test("killAll kills live sessions and forgets them", () => {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const reg = makeSessionRegistry(
    () => {
      const p = fakePty();
      spawned.push(p);
      return p;
    },
    () => {},
  );
  reg.getOrSpawn(1, "/tmp/x");
  reg.getOrSpawn(2, "/tmp/y");
  spawned[1].emitExit();
  reg.killAll();
  assert.equal(spawned[0].killed, true);
  assert.equal(spawned[1].killed, false);
  reg.getOrSpawn(1, "/tmp/x");
  assert.equal(spawned.length, 3);
});
