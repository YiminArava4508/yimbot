// src/arch-generate.ts
// The map generator's pure half: which paths are worth showing the model, the
// prompt that asks for the map, and the parse that stamps it with the commit
// it describes.
import { parseArchMap, type ArchMap } from "./arch-map.ts";

const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage)\//;
const SKIP_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|sh)$/;
const TEST = /(^|\/)(__tests__|tests?)\/|[._-](test|spec)\.[^/]+$/;

export function sourcePaths(all: string[]): string[] {
  return all.filter((p) => !SKIP_DIR.test(p) && !SKIP_FILE.test(p) && SOURCE.test(p) && !TEST.test(p));
}

export function mapPrompt(paths: string[]): string {
  return [
    "You are mapping a codebase's runtime so a reviewer can see where a change lands.",
    "Source files (tests and generated files already removed):",
    paths.join("\n"),
    "",
    "Group these files into 8 to 20 nodes. A node is a subsystem a reviewer would",
    "name out loud, not a directory and not a file. Draw an edge wherever one node",
    "hands data to another at runtime, and say what it carries.",
    "Give every node a files list of globs that claim its files, using * inside a",
    "path segment and ** across segments. Every source file above must be claimed",
    "by exactly one node.",
    "Reply with ONLY a JSON object, no prose:",
    '{"nodes": [{"id": "<short id>", "label": "<short name>", "role": "<one sentence>", "files": ["<glob>"]}],',
    ' "edges": [{"from": "<id>", "to": "<id>", "carries": "<what moves>"}]}',
  ].join("\n");
}

export function parseGeneratedMap(stdout: string, commit: string): ArchMap | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const map = parseArchMap(stdout.slice(start, end + 1));
  if (!map) return null;
  return { ...map, generatedAt: new Date().toISOString(), commit };
}
