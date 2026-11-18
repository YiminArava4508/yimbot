// src/claude-sessions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-temp.ts";
import { contextFilePath } from "./review-context.ts";
import {
  claudeArgs,
  ensureContextScaffold,
  makeSessionRegistry,
  reviewSessionName,
  reviewTmuxArgv,
  seedPrompt,
  sessionCwd,
  spawnPty,
  tmuxClientEnv,
  type PtyLike,
} from "./claude-sessions.ts";

function fakeTmux(sessions: string[] = []): { listSessions(): string[]; killSession(name: string): void; killed: string[] } {
  const killed: string[] = [];
  return {
    killed,
    listSessions: () => sessions,
    killSession: (name) => {
      killed.push(name);
    },
  };
}

function fakePty(): PtyLike & { killed: boolean; emitData(d: string): void; emitExit(): void } {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((code: number | undefined) => void) | null = null;
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
      exitCb?.(0);
    },
  };
}

test("sessionCwd is a .yimbot subdir so claude --continue in the worktree never resumes it", () => {
  assert.equal(sessionCwd("/wt"), "/wt/.yimbot/review");
});

test("seedPrompt names the PR and the absolute context file claude must read", () => {
  const p = seedPrompt(42, "/wt");
  assert.ok(p.includes("PR #42"));
  assert.ok(p.includes(contextFilePath("/wt")));
});

test("claudeArgs runs permission-mode auto with the seed as the trailing arg", () => {
  const args = claudeArgs(42, "/wt");
  assert.deepEqual(args.slice(0, 2), ["--permission-mode", "auto"]);
  assert.equal(args.at(-1), seedPrompt(42, "/wt"));
});

test("ensureContextScaffold creates a self-ignoring .yimbot dir with the session cwd inside", () => {
  const cwd = tempDir("yimbot-ctx-");
  ensureContextScaffold(cwd);
  assert.equal(readFileSync(join(cwd, ".yimbot/.gitignore"), "utf8"), "*\n");
  assert.ok(existsSync(sessionCwd(cwd)));
  ensureContextScaffold(cwd);
  assert.ok(existsSync(join(cwd, ".yimbot")));
});

test("reviewSessionName is yimbot-review-<pr>", () => {
  assert.equal(reviewSessionName(42), "yimbot-review-42");
});

test("reviewTmuxArgv attaches or creates the PR session", () => {
  assert.deepEqual(reviewTmuxArgv(42, "/wt"), [
    "new-session",
    "-A",
    "-s",
    "yimbot-review-42",
    "-c",
    sessionCwd("/wt"),
    "claude",
    ...claudeArgs(42, "/wt"),
    ";",
    "set-option",
    "-t",
    "yimbot-review-42",
    "status",
    "off",
    ";",
    "set-option",
    "-t",
    "yimbot-review-42",
    "key-table",
    "yimbot-review",
    ";",
    "set-option",
    "-t",
    "yimbot-review-42",
    "prefix",
    "None",
    ";",
    "set-option",
    "-t",
    "yimbot-review-42",
    "prefix2",
    "None",
  ]);
});

test("getOrSpawn spawns tmux client args for the PR", () => {
  let spawnedArgs: string[] = [];
  const reg = makeSessionRegistry(
    (_cwd, args) => {
      spawnedArgs = args;
      return fakePty();
    },
    () => {},
    fakeTmux(),
  );
  reg.getOrSpawn(7, "/wt");
  assert.deepEqual(spawnedArgs, reviewTmuxArgv(7, "/wt"));
});

test("getOrSpawn after a fresh registry reattaches with the same argv", () => {
  const argvs: string[][] = [];
  const spawn = (_cwd: string, args: string[]) => {
    argvs.push(args);
    return fakePty();
  };
  makeSessionRegistry(spawn, () => {}, fakeTmux()).getOrSpawn(9, "/wt");
  makeSessionRegistry(spawn, () => {}, fakeTmux()).getOrSpawn(9, "/wt");
  assert.equal(argvs.length, 2);
  assert.deepEqual(argvs[0], argvs[1]);
});

test("detachAll kills client ptys and no tmux sessions", () => {
  const spawned: ReturnType<typeof fakePty>[] = [];
  const tmux = fakeTmux(["yimbot-review-1"]);
  const reg = makeSessionRegistry(
    () => {
      const p = fakePty();
      spawned.push(p);
      return p;
    },
    () => {},
    tmux,
  );
  reg.getOrSpawn(1, "/tmp/x");
  reg.detachAll();
  assert.equal(spawned[0].killed, true);
  assert.deepEqual(tmux.killed, []);
  reg.getOrSpawn(1, "/tmp/x");
  assert.equal(spawned.length, 2);
});

test("killAll kills every yimbot-review session, including ones this process never spawned", () => {
  const tmux = fakeTmux(["yimbot-review-7", "eng-1-x"]);
  const reg = makeSessionRegistry(() => fakePty(), () => {}, tmux);
  reg.killAll();
  assert.deepEqual(tmux.killed, ["yimbot-review-7"]);
});

test("spawn env drops TMUX", () => {
  const env = tmuxClientEnv({ TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3", PATH: "/bin", UNSET: undefined });
  assert.equal("TMUX" in env, false);
  assert.equal("TMUX_PANE" in env, false);
  assert.equal(env.PATH, "/bin");
  assert.equal("UNSET" in env, false);
});

test("getOrSpawn spawns the pty in the session cwd but records the worktree", () => {
  let spawnedCwd = "";
  const reg = makeSessionRegistry(
    (cwd) => {
      spawnedCwd = cwd;
      return fakePty();
    },
    () => {},
    fakeTmux(),
  );
  const s = reg.getOrSpawn(7, "/wt");
  assert.equal(spawnedCwd, sessionCwd("/wt"));
  assert.equal(s.cwd, "/wt");
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
    fakeTmux(),
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
    fakeTmux(),
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
    fakeTmux(),
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

test("spawnPty reports output and exit code", async () => {
  const pty = spawnPty("sh", ["-c", "echo hi; exit 3"], process.cwd(), 80, 24);
  let out = "";
  pty.onData((d) => {
    out += d;
  });
  const code = await new Promise<number | undefined>((resolve) => {
    pty.onExit(resolve);
  });
  assert.match(out, /hi/);
  assert.equal(code, 3);
});
