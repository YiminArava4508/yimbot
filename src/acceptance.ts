export type AcStatus = "open" | "satisfied" | "skipped";

export type AC = {
  id: string;
  section: string;
  text: string;
  status: AcStatus;
  skipReason?: string;
};

const SECTIONS: [RegExp, string][] = [
  [/pdf/i, "pdf"],
  [/excel/i, "excel"],
  [/shared/i, "shared"],
];

function sectionForHeading(line: string): string | null {
  if (!/acceptance criteria/i.test(line)) return null;
  for (const [re, name] of SECTIONS) if (re.test(line)) return name;
  return null;
}

// Parse numbered acceptance-criteria items grouped under recognized headings.
// Ids are <section>-<ordinal within section>, stable as long as the heading set
// and item order in the description do not change.
export function parseAcceptanceCriteria(description: string): AC[] {
  const acs: AC[] = [];
  let section: string | null = null;
  const counters = new Map<string, number>();
  for (const raw of description.split("\n")) {
    const heading = sectionForHeading(raw);
    if (heading) {
      section = heading;
      continue;
    }
    if (!section) continue;
    const m = /^\s*\d+\.\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const n = (counters.get(section) ?? 0) + 1;
    counters.set(section, n);
    acs.push({ id: `${section}-${n}`, section, text: m[1].trim(), status: "open" });
  }
  return acs;
}

export const AC_COMMENT_MARKER = "<!-- yimbot-ac-tracker -->";

function box(a: AC): string {
  if (a.status === "satisfied") return "[x]";
  if (a.status === "skipped") return "[~]";
  return "[ ]";
}

export function renderAcComment(acs: AC[]): string {
  const satisfied = acs.filter((a) => a.status === "satisfied").length;
  const skipped = acs.filter((a) => a.status === "skipped").length;
  const lines = [
    AC_COMMENT_MARKER,
    `**yimbot acceptance-criteria tracker** (${satisfied}/${acs.length} satisfied, ${skipped} skipped)`,
    "",
  ];
  for (const a of acs) {
    const reason = a.status === "skipped" && a.skipReason ? ` - skipped: ${a.skipReason}` : "";
    lines.push(`- ${box(a)} \`${a.id}\` ${a.text}${reason}`);
  }
  const nonSkipped = acs.filter((a) => a.status !== "skipped");
  if (nonSkipped.length > 0 && nonSkipped.every((a) => a.status === "satisfied")) {
    lines.push("", `**complete (${skipped} skipped)**`);
  }
  return lines.join("\n");
}

const LINE_RE = /^- \[([ x~])\] `([^`]+)` (.*)$/;

export function parseAcComment(body: string): AC[] {
  if (!body.includes(AC_COMMENT_MARKER)) return [];
  const acs: AC[] = [];
  for (const raw of body.split("\n")) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const [, mark, id, rest] = m;
    const section = id.split("-")[0];
    if (mark === "~") {
      const [text, reason] = rest.split(" - skipped: ");
      acs.push({ id, section, text: text.trim(), status: "skipped", skipReason: (reason ?? "").trim() });
    } else {
      acs.push({ id, section, text: rest.trim(), status: mark === "x" ? "satisfied" : "open" });
    }
  }
  return acs;
}

export type Judgment = { satisfied: string[]; skipped: { id: string; reason: string }[] };

export function applyJudgment(acs: AC[], j: Judgment): AC[] {
  const satisfied = new Set(j.satisfied);
  const skipped = new Map(j.skipped.map((s) => [s.id, s.reason]));
  return acs.map((a) => {
    if (skipped.has(a.id)) return { ...a, status: "skipped" as const, skipReason: skipped.get(a.id) };
    if (a.status === "satisfied" || satisfied.has(a.id)) return { ...a, status: "satisfied" as const };
    return a;
  });
}

export function openAcs(acs: AC[]): AC[] {
  return acs.filter((a) => a.status === "open");
}

export function satisfiedCount(acs: AC[]): number {
  return acs.filter((a) => a.status === "satisfied").length;
}

export function isComplete(acs: AC[]): boolean {
  return acs.length > 0 && acs.every((a) => a.status !== "open");
}

export type ContinuationDecision =
  | { kind: "complete" }
  | { kind: "halt"; reason: string }
  | { kind: "continue"; scope: AC[] };

export function selectContinuation(
  acs: AC[],
  prevSatisfied: number,
  round: number,
  maxRounds: number,
): ContinuationDecision {
  if (isComplete(acs)) return { kind: "complete" };
  if (round >= maxRounds) return { kind: "halt", reason: `max continuation rounds (${maxRounds}) reached` };
  if (round > 0 && satisfiedCount(acs) <= prevSatisfied) {
    return { kind: "halt", reason: `no progress: satisfied count stuck at ${satisfiedCount(acs)}` };
  }
  return { kind: "continue", scope: openAcs(acs) };
}
