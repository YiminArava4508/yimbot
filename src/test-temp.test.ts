import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = fileURLToPath(new URL("./test-temp.ts", import.meta.url));

// Runs `body` in a child node process with tempDir() imported, and returns the
// paths the child printed plus how it exited. The child is the only way to
// observe the exit-time cleanup: it has to actually die.
function runChild(body: string): { paths: string[]; code: number; signal: string | null; stdout: string } {
  const source = `import { tempDir } from ${JSON.stringify(helper)};\n${body}`;
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "--eval", source],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
  );
  const paths = res.stdout.split("\n").filter((l) => l.startsWith(tmpdir()));
  return { paths, code: res.status ?? -1, signal: res.signal, stdout: res.stdout };
}

test("tempDir removes the directory when the process exits normally", () => {
  const { paths, code } = runChild(`console.log(tempDir("yimbot-selftest-"));`);
  assert.equal(code, 0);
  assert.equal(paths.length, 1);
  assert.equal(existsSync(paths[0]), false);
});

test("tempDir removes the directory when the process dies on an uncaught throw", () => {
  const { paths, code } = runChild(
    `console.log(tempDir("yimbot-selftest-"));\nthrow new Error("boom");`,
  );
  assert.equal(code, 1);
  assert.equal(paths.length, 1);
  assert.equal(existsSync(paths[0]), false);
});

test("tempDir removes a directory that still has files in it", () => {
  const { paths, code } = runChild(
    `import { writeFileSync } from "node:fs";
     import { join } from "node:path";
     const d = tempDir("yimbot-selftest-");
     writeFileSync(join(d, "leftover.txt"), "x");
     console.log(d);
     throw new Error("boom");`,
  );
  assert.equal(code, 1);
  assert.equal(paths.length, 1);
  assert.equal(existsSync(paths[0]), false);
});

test("tempDir removes every directory it handed out", () => {
  const { paths, code } = runChild(
    `console.log(tempDir("yimbot-selftest-a-"));
     console.log(tempDir("yimbot-selftest-b-"));
     throw new Error("boom");`,
  );
  assert.equal(code, 1);
  assert.equal(paths.length, 2);
  for (const p of paths) assert.equal(existsSync(p), false);
});

test("tempDir returns a usable directory under tmpdir with the given prefix", () => {
  const { paths, code, stdout } = runChild(
    `import { statSync } from "node:fs";
     const d = tempDir("yimbot-selftest-");
     console.log(d);
     console.log("isdir=" + statSync(d).isDirectory());`,
  );
  assert.equal(code, 0);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].startsWith(join(tmpdir(), "yimbot-selftest-")));
  assert.match(stdout, /isdir=true/);
});

test("tempDir removes the directory when the process is interrupted", () => {
  const { paths, signal } = runChild(
    `console.log(tempDir("yimbot-selftest-"));
     process.kill(process.pid, "SIGINT");
     setTimeout(() => {}, 5_000);`,
  );
  assert.equal(signal, "SIGINT");
  assert.equal(paths.length, 1);
  assert.equal(existsSync(paths[0]), false);
});

test("tempDir leaves signal handlers registered by other modules alone", () => {
  const { stdout, paths } = runChild(
    `console.log(tempDir("yimbot-selftest-"));
     process.on("SIGINT", () => {
       console.log("other-handler-ran");
       process.exit(3);
     });
     process.kill(process.pid, "SIGINT");
     setTimeout(() => {}, 5_000);`,
  );
  assert.match(stdout, /other-handler-ran/);
  assert.equal(existsSync(paths[0]), false);
});

test("tempDir does not fail the process when a directory cannot be removed", () => {
  const { paths, code } = runChild(
    `import { chmodSync, mkdirSync } from "node:fs";
     import { join } from "node:path";
     const d = tempDir("yimbot-selftest-");
     mkdirSync(join(d, "sub"));
     chmodSync(d, 0o500);
     console.log(d);`,
  );
  try {
    assert.equal(code, 0);
  } finally {
    chmodSync(paths[0], 0o700);
    rmSync(paths[0], { recursive: true, force: true });
  }
});
