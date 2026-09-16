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

// Best effort: a dir a child still holds open, or one under an unwritable
// parent, throws here. Letting that escape an "exit" listener would fail a
// suite that already passed.
function removeAll(): void {
  while (created.length > 0) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // Leave it for the next sweep.
    }
  }
}

// "exit" also runs after an uncaught throw, which is the case that leaks. A
// signal skips "exit" entirely, so it gets its own handler that drops only
// itself before re-raising: with no listener left the default action kills us,
// and any handler another module registered still gets its turn.
function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", removeAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = (): void => {
      removeAll();
      process.off(sig, onSignal);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

export function tempDir(prefix: string): string {
  hook();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
