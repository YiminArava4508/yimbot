// A ticket's type as read off its title. Linear has no type field the board
// can trust (ENG-2259 carries no labels at all), so a research item is one
// whose title uses a research verb. Whole words only: "explore" is research,
// "file explorer" is not.
import { envCsvSet } from "./env.ts";
import { isPrKey } from "./events.ts";

export type TicketType = "research" | "pr";

export const DEFAULT_RESEARCH_WORDS = [
  "research",
  "investigate",
  "investigation",
  "spike",
  "decide",
  "decision",
  "evaluate",
  "evaluation",
  "explore",
  "exploration",
  "assess",
  "assessment",
];

export function researchWords(): string[] {
  return [...envCsvSet("RESEARCH_TITLE_WORDS", DEFAULT_RESEARCH_WORDS.join(","))];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ticketType(title: string | undefined, words: string[] = researchWords()): "research" | null {
  if (!title || words.length === 0) return null;
  const re = new RegExp(`\\b(?:${words.map(escapeRegex).join("|")})\\b`, "i");
  return re.test(title) ? "research" : null;
}

// A row whose key fell back to the PR number has no ticket slug in its branch,
// so the PR is all there is to track. That outranks any title word.
export function rowType(row: { key: string; title?: string }, words: string[] = researchWords()): TicketType | null {
  if (isPrKey(row.key)) return "pr";
  return ticketType(row.title, words);
}
