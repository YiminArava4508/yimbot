// src/json-extract.ts
// The one tolerant extraction of a JSON object from headless-claude stdout:
// outermost {...}, null for anything unparseable, so callers can fall back.
// Every parser of model output shares this rule; shape-checking the parsed
// object stays with each caller.
export function extractJsonObject(stdout: string): unknown | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}
