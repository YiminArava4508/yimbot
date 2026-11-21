// Node's --env-file assigns `VAR=` lines as empty strings, not undefined, so a
// plain `process.env[name] ?? fallback` never falls back for the documented
// "leave it blank to use the default" setup path. Treat empty/whitespace-only
// the same as unset.
export function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

// A comma-separated env list as a lowercased set, for case-insensitive
// membership checks (check names, reviewer logins).
export function envCsvSet(name: string, fallback: string): Set<string> {
  return new Set(
    envOr(name, fallback)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// The repo worktrees are cut from. No built-in default: it is machine specific,
// so an unset value is a setup problem, not something to guess.
export function codebasePath(): string {
  const value = envOr("CODEBASE_PATH", "");
  if (!value) throw new Error("CODEBASE_PATH is not set; run `pnpm onboard` or set it in .env");
  return value;
}
