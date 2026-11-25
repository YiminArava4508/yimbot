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

export function selfImproveAllowed(autoSelfImprove: boolean, master: boolean): boolean {
  return autoSelfImprove && master;
}

const TRUTHY = new Set(["true", "on", "yes", "1"]);

// Default-off flags that can merge code read only an explicit truthy value as on; a typo stays off.
export function isOn(value: string): boolean {
  return TRUTHY.has(value.trim().toLowerCase());
}

export function masterMergeEnabled(opts: { gh: boolean; master: boolean; flag: string; login: string }): boolean {
  return opts.gh && opts.master && isOn(opts.flag) && opts.login !== "";
}
