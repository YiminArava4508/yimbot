export type EventKind =
  | "task_started"
  | "review_started"
  | "ci_fix_started"
  | "conflict_fix_started"
  | "ready_to_test"
  | "ready_to_merge"
  | "ready_regressed"
  | "merged";

export type YimbotEvent = {
  ts: number;
  kind: EventKind;
  key: string;
  label: string;
  title?: string;
};

const TICKET = /^(eng|sc)-(\d+)/i;

export function deriveKey(opts: { identifier?: string; branch?: string; pr?: number }): {
  key: string;
  label: string;
} {
  if (opts.identifier) {
    const key = opts.identifier.toUpperCase();
    return { key, label: key };
  }
  if (opts.branch) {
    const m = TICKET.exec(opts.branch);
    if (m) {
      const key = `${m[1].toUpperCase()}-${m[2]}`;
      return { key, label: key };
    }
  }
  if (opts.pr != null) return { key: `pr:${opts.pr}`, label: `PR #${opts.pr}` };
  const key = opts.branch ?? "unknown";
  return { key, label: key };
}

export function titleFromBranch(branch: string): string {
  return branch
    .replace(TICKET, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
}

const STATUS: Record<EventKind, { status: string; terminal: boolean }> = {
  task_started: { status: "working", terminal: false },
  review_started: { status: "addressing review", terminal: false },
  ci_fix_started: { status: "fixing CI", terminal: false },
  conflict_fix_started: { status: "resolving conflict", terminal: false },
  ready_to_test: { status: "ready to test", terminal: false },
  ready_to_merge: { status: "ready to merge", terminal: false },
  ready_regressed: { status: "working", terminal: false },
  merged: { status: "merged", terminal: true },
};

export function statusFor(kind: EventKind): { status: string; terminal: boolean } {
  return STATUS[kind];
}
