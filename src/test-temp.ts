// src/test-temp.ts
// Temp directories for tests. Tests that mkdtemp on their own leak the dir
// whenever an assertion throws first, and a red suite on a retry loop fills
// /tmp within a day. Every dir handed out here is removed when the process
// exits, however it exits.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];
let hooked = false;

function removeAll(): void {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
}

// "exit" also runs after an uncaught throw, which is the case that leaks. A
// signal skips "exit" entirely, so it gets its own handler that drops itself
// before re-raising, letting the default action kill us for real.
function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", removeAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      removeAll();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

export function tempDir(prefix: string): string {
  hook();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
