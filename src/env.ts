// Node's --env-file assigns `VAR=` lines as empty strings, not undefined, so a
// plain `process.env[name] ?? fallback` never falls back for the documented
// "leave it blank to use the default" setup path. Treat empty/whitespace-only
// the same as unset.
export function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}
