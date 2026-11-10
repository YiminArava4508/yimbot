import {
  fixCommandFor,
  installHint,
  type CheckResult,
  type PackageManager,
  type Prerequisite,
} from "./setup-core.ts";

export type FixEvent =
  | { kind: "start"; pr: Prerequisite; argv: string[] }
  | { kind: "manual"; pr: Prerequisite; hint: string }
  | { kind: "ok"; pr: Prerequisite }
  | { kind: "failed"; pr: Prerequisite; code: number | undefined };

export type FixDeps = {
  pm: PackageManager | null;
  run: (argv: string[]) => Promise<number | undefined>;
  recheck: (pr: Prerequisite) => Promise<boolean>;
  emit: (e: FixEvent) => void;
};

// Walks unsatisfied prerequisites in order, fixing each; stops at the first
// failure so later items (which may depend on it) are not attempted.
export async function walkFixes(
  items: CheckResult[],
  deps: FixDeps,
): Promise<{ stoppedAt: Prerequisite | null }> {
  for (const { pr, ok } of items) {
    if (ok) continue;
    const argv = fixCommandFor(pr, deps.pm);
    if (!argv) {
      deps.emit({ kind: "manual", pr, hint: installHint(pr.key, deps.pm) });
      continue;
    }
    deps.emit({ kind: "start", pr, argv });
    const code = await deps.run(argv);
    if (code !== 0 || !(await deps.recheck(pr))) {
      deps.emit({ kind: "failed", pr, code });
      return { stoppedAt: pr };
    }
    deps.emit({ kind: "ok", pr });
  }
  return { stoppedAt: null };
}
