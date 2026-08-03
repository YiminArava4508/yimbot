import type { AC, Judgment } from "./acceptance.ts";

export type JudgeRunner = (prompt: string) => Promise<string>;

export function buildJudgePrompt(open: AC[]): string {
  const list = open.map((a) => `- ${a.id}: ${a.text}`).join("\n");
  return [
    "You are auditing whether acceptance criteria are met by the code on the current branch (main).",
    "Inspect the working tree as needed. For each criterion below decide one of:",
    "satisfied (the code fully meets it), skipped (not code-satisfiable: manual/external/inherently met), or neither.",
    "Reply with ONLY a JSON object, no prose:",
    '{"satisfied": ["<id>", ...], "skipped": [{"id": "<id>", "reason": "<why>"}, ...]}',
    "",
    "Open criteria:",
    list,
  ].join("\n");
}

export function parseJudgment(stdout: string): Judgment {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return { satisfied: [], skipped: [] };
  let obj: unknown;
  try {
    obj = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return { satisfied: [], skipped: [] };
  }
  const o = obj as { satisfied?: unknown; skipped?: unknown };
  const satisfied = Array.isArray(o.satisfied) ? o.satisfied.filter((x): x is string => typeof x === "string") : [];
  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .filter((x): x is { id: string; reason: string } =>
          !!x && typeof (x as { id: unknown }).id === "string")
        .map((x) => ({ id: x.id, reason: typeof x.reason === "string" ? x.reason : "" }))
    : [];
  return { satisfied, skipped };
}

export async function judgeAcceptance(run: JudgeRunner, open: AC[]): Promise<Judgment> {
  if (open.length === 0) return { satisfied: [], skipped: [] };
  return parseJudgment(await run(buildJudgePrompt(open)));
}
