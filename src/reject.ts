const SCALE = [1, 2, 3, 5, 8, 13, 21];
const REJECT_STEPS = 2;

function stepIndex(points: number): number {
  const index = SCALE.findIndex((s) => s >= points);
  return index === -1 ? SCALE.length - 1 : index;
}

export function parseRejectLabel(raw: string | undefined): string {
  return raw?.trim() || "rejected";
}

export function shouldReject(estimate: number | null, planned: number): boolean {
  if (estimate === null || estimate <= 0) return false;
  return stepIndex(planned) - stepIndex(estimate) >= REJECT_STEPS;
}

export type RejectDeps = {
  fetchTicket: (
    id: string,
  ) => Promise<{ id: string; teamId: string; identifier: string; estimate: number | null }>;
  comment: (issueId: string, body: string) => Promise<void>;
  addLabel: (issueId: string, teamId: string, label: string) => Promise<void>;
  moveToTodo: (identifier: string) => Promise<void>;
};

export type RejectResult = { rejected: boolean; identifier: string; estimate: number | null };

export async function rejectTicket(
  deps: RejectDeps,
  label: string,
  ticket: string,
  planned: number,
  reason: string,
): Promise<RejectResult> {
  const t = await deps.fetchTicket(ticket);
  const result = { rejected: false, identifier: t.identifier, estimate: t.estimate };
  if (!shouldReject(t.estimate, planned)) return result;
  await deps.comment(t.id, `${reason.trim()}\n\nEstimate: ${t.estimate}, planned: ${planned}`);
  await deps.addLabel(t.id, t.teamId, label);
  await deps.moveToTodo(t.identifier);
  return { ...result, rejected: true };
}
