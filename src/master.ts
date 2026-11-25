export type MasterAccess = { login: string; permission: string; canEdit: boolean };

export const NO_MASTER_ACCESS: MasterAccess = { login: "", permission: "unknown", canEdit: false };

const WRITE_PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function hasWriteAccess(permission: string): boolean {
  return WRITE_PERMISSIONS.has(permission);
}

export function masterStatus(flag: boolean, access: MasterAccess): { master: boolean; reason: string | null } {
  if (!flag) return { master: false, reason: null };
  if (!access.canEdit) return { master: false, reason: "master mode needs write access to the yimbot repo" };
  return { master: true, reason: null };
}

export function masterAuthors(raw: string, viewer: string): Set<string> {
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(names.length > 0 ? names : [viewer.toLowerCase()]);
}
