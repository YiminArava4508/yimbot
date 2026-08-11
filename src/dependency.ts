const IDENTIFIER_RE = /\b[A-Z]{2,}-\d+\b/;
const EXACT_IDENTIFIER_RE = /^[A-Z]{2,}-\d+$/;

// "blocks" is deliberately included so the reverse direction ("Blocks ENG-1132")
// reaches adjudication and is rejected there rather than passing silently.
const KEYWORD_RE =
  /\b(blocked|blocker|depends|requires|prereq|after|before|first|until|once|lands|ships|merges|blocks|gated)\b/i;

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;

const MAX_BLOCKERS = 5;

// Linear embeds each identifier twice, once as the link label and once inside a
// slugged URL whose words otherwise match dependency keywords.
export function normalizeDescription(description: string): string {
  return description.replace(MARKDOWN_LINK_RE, "$1");
}

export function candidateLines(normalized: string): string[] {
  return normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => IDENTIFIER_RE.test(l) && KEYWORD_RE.test(l));
}

export function buildDependencyPrompt(identifier: string, lines: string[]): string {
  return [
    `You are reading the description of Linear ticket ${identifier}.`,
    `Decide which OTHER tickets named below must be COMPLETED BEFORE ${identifier}`,
    "can be started. Those, and only those, are its blockers.",
    "",
    "Reject a ticket that is merely referenced, related, split from, a follow-up,",
    "or the place something was discovered.",
    `Reject any ticket that ${identifier} itself blocks: "Blocks ENG-1: ..." means`,
    `ENG-1 depends on ${identifier}, not the reverse.`,
    "When the wording is ambiguous, reject it.",
    "",
    'Reply with ONLY a JSON object, no prose: {"blockedBy": ["ENG-1"]}',
    'Use {"blockedBy": []} when nothing qualifies.',
    "",
    "Lines:",
    ...lines.map((l) => `- ${l}`),
  ].join("\n");
}

export function parseDependencies(stdout: string, self: string, normalized: string): string[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  const raw = (obj as { blockedBy?: unknown }).blockedBy;
  if (!Array.isArray(raw)) return [];

  const haystack = normalized.toUpperCase();
  const found = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = entry.trim().toUpperCase();
    if (!EXACT_IDENTIFIER_RE.test(id)) continue;
    if (id === self.trim().toUpperCase()) continue;
    // Whole-identifier match only: a substring test would let ENG-13 through on
    // a description that only ever mentions ENG-1319.
    if (!new RegExp(`\\b${id}\\b`).test(haystack)) continue;
    found.add(id);
  }
  // A description naming this many hard prerequisites is a misfire, not reality.
  return found.size > MAX_BLOCKERS ? [] : [...found];
}

export type DependencyRunner = (prompt: string) => Promise<string>;

export async function scanDescription(
  run: DependencyRunner,
  identifier: string,
  description: string,
): Promise<string[]> {
  const normalized = normalizeDescription(description);
  const lines = candidateLines(normalized);
  if (lines.length === 0) return [];
  return parseDependencies(await run(buildDependencyPrompt(identifier, lines)), identifier, normalized);
}

export const DEPENDENCY_COMMENT_MARKER = "<!-- yimbot-dependency-scan -->";

export function renderDependencyComment(
  identifier: string,
  blockers: string[],
  lines: string[],
): string {
  const plural = blockers.length > 1 ? "s" : "";
  return [
    DEPENDENCY_COMMENT_MARKER,
    `**yimbot dependency scan**: inferred from the description that ${identifier} is blocked by ${blockers.join(", ")}, and created the matching Linear \`blocks\` relation${plural}.`,
    "",
    "Source:",
    ...lines.map((l) => `> ${l}`),
    "",
    "Delete the relation if this is wrong. yimbot will not re-add it: this comment marks the ticket as already scanned.",
  ].join("\n");
}
