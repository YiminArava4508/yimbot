// A ticket's type as read off its title. Linear has no type field the board
// can trust (ENG-2259 carries no labels at all), so a research item is one
// whose title uses a research verb. Whole words only: "explore" is research,
// "file explorer" is not. A release item (a rollout checklist with no code to
// write) is matched the same way and wins over research.
import { envCsvSet } from "./env.ts";
import { isPrKey } from "./events.ts";

export type TicketType = "research" | "release" | "pr";

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

export const DEFAULT_RELEASE_WORDS = ["release checklist", "rollout", "go/no-go"];

export function researchWords(): string[] {
  return [...envCsvSet("RESEARCH_TITLE_WORDS", DEFAULT_RESEARCH_WORDS.join(","))];
}

export function releaseWords(): string[] {
  return [...envCsvSet("RELEASE_TITLE_WORDS", DEFAULT_RELEASE_WORDS.join(","))];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleHas(title: string, words: string[]): boolean {
  if (words.length === 0) return false;
  return new RegExp(`\\b(?:${words.map(escapeRegex).join("|")})\\b`, "i").test(title);
}

export function ticketType(
  title: string | undefined,
  words: string[] = researchWords(),
  release: string[] = releaseWords(),
): "research" | "release" | null {
  if (!title) return null;
  if (titleHas(title, release)) return "release";
  if (titleHas(title, words)) return "research";
  return null;
}

// A row whose key fell back to the PR number has no ticket slug in its branch,
// so the PR is all there is to track. That outranks any title word.
export function rowType(
  row: { key: string; title?: string },
  words: string[] = researchWords(),
  release: string[] = releaseWords(),
): TicketType | null {
  if (isPrKey(row.key)) return "pr";
  return ticketType(row.title, words, release);
}
