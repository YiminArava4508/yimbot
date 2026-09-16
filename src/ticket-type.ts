// A ticket's type as read off its title. Linear has no type field the board
// can trust (ENG-2259 carries no labels at all), so a research item is one
// whose title uses a research verb. Whole words only: "explore" is research,
// "file explorer" is not.
import { envCsvSet } from "./env.ts";

export type TicketType = "research";

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

export function ticketType(title: string | undefined, words: string[] = researchWords()): TicketType | null {
  if (!title || words.length === 0) return null;
  const re = new RegExp(`\\b(?:${words.map(escapeRegex).join("|")})\\b`, "i");
  return re.test(title) ? "research" : null;
}
