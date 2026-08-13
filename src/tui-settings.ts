// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import {
  commitDraft,
  dirtyKeys,
  draftRows,
  newDraft,
  setEdit,
  validateDraft,
  type Draft,
  type SettingRow,
  type YimbotConfig,
} from "./settings-model.ts";
import type { ApplyResult } from "./settings-apply.ts";

const LABEL_WIDTH = 20;

export function rowsToLines(
  rows: SettingRow[],
  dirty: string[],
  errors: Record<string, string>,
): string[] {
  const dirtySet = new Set(dirty);
  return rows.map((r) => {
    const label = r.label.padEnd(LABEL_WIDTH, " ");
    const error = errors[r.envKey];
    if (error) return `${label}{red-fg}${r.display}  (${error}){/red-fg}`;
    if (dirtySet.has(r.envKey)) return `${label}{yellow-fg}${r.display} *{/yellow-fg}`;
    return `${label}${r.display}`;
  });
}

export function settingsFooterHint(dirty: number, editing: boolean): string {
  if (editing) return "enter accept   esc cancel";
  const write = dirty > 0 ? `   w write + restart (${dirty} changed)` : "";
  return `j/k move   enter edit${write}   esc back`;
}

export function settingsPanelLayout(): Record<string, unknown> {
  return {
    top: 1,
    left: 0,
    width: "100%",
    bottom: 1,
    tags: true,
    keys: true,
    vi: true,
    border: { type: "line" },
    label: " settings ",
    style: { selected: { inverse: true } },
  };
}

export type SettingsDeps = {
  loadConfig: () => YimbotConfig;
  assignee: () => Promise<string>;
  teams: () => Promise<string[]>;
  states: (teamName: string) => Promise<string[]>;
  labels: (teamName: string) => Promise<string[]>;
  apply: (next: YimbotConfig, prev: YimbotConfig) => Promise<ApplyResult>;
};

const LABEL_MODES = ["every ticket", "only tickets labelled", "every ticket except labelled"];

// Strip the leading "!" so a negated filter still seeds the label picker with
// the label the operator is currently filtering on.
function currentLabel(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return v.startsWith("!") ? v.slice(1) : v;
}

export function openSettings(screen: unknown, deps: SettingsDeps, onClose: () => void): void {
  const s: any = screen;

  const list: any = blessed.list({ parent: s, items: [], ...settingsPanelLayout() });
  const footer: any = blessed.text({
    parent: s,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    wrap: false,
    tags: true,
    style: { fg: "white" },
  });

  let base = deps.loadConfig();
  let draft: Draft = newDraft(base);
  let assigneeName = "resolving...";
  let editing = false;
  let escArmed = false;
  // Blocks re-entrant edits/writes/escapes while a write is in flight: the
  // list stays focused during that await (no widget steals focus the way an
  // editor does), so without this a second `w` or `esc` could race the apply.
  let applying = false;

  function paint(footerOverride?: string): void {
    const rows = draftRows(draft, assigneeName);
    const dirty = dirtyKeys(draft);
    const errors = validateDraft(draft);
    list.setItems(rowsToLines(rows, dirty, errors));
    footer.setContent(footerOverride ?? settingsFooterHint(dirty.length, editing));
    s.render();
  }

  function resetEscArm(): void {
    escArmed = false;
  }

  function beginEdit(): void {
    editing = true;
    paint();
  }

  function endEdit(): void {
    editing = false;
    list.focus();
    paint();
  }

  function currentTeamName(): string {
    const row = draftRows(draft, assigneeName).find((r) => r.envKey === "LINEAR_TEAM_NAME");
    return row ? row.value : base.teamName;
  }

  function closePanel(): void {
    list.detach();
    footer.detach();
    s.render();
    onClose();
  }

  function openPicker(items: string[], onPick: (value: string) => void): void {
    const picker: any = blessed.list({
      parent: s,
      top: "center",
      left: "center",
      width: "60%",
      height: Math.min(items.length + 2, 14),
      border: { type: "line" },
      keys: true,
      vi: true,
      items,
      style: { selected: { inverse: true } },
    });
    picker.focus();
    s.render();
    picker.on("select", (_item: unknown, index: number) => {
      picker.detach();
      onPick(items[index]);
      endEdit();
    });
    picker.on("cancel", () => {
      picker.detach();
      endEdit();
    });
  }

  // A picker whose items come from Linear. Shows "loading..." while in
  // flight and "linear unreachable" on failure, leaving the row unchanged.
  function openRemotePicker(fetch: () => Promise<string[]>, seed: string | null, onPick: (value: string) => void): void {
    beginEdit();
    paint("loading...");
    fetch()
      .then((items) => {
        const seeded = seed && !items.includes(seed) ? [seed, ...items] : items;
        openPicker(seeded, onPick);
      })
      .catch(() => {
        endEdit();
        paint("linear unreachable");
      });
  }

  function editTextLike(row: SettingRow, censor: boolean): void {
    beginEdit();
    const box: any = blessed.textbox({
      parent: s,
      top: "center",
      left: "center",
      width: "60%",
      height: 3,
      border: { type: "line" },
      label: ` ${row.label} `,
      tags: true,
      censor,
      inputOnFocus: true,
    });
    if (!censor) box.setValue(row.value);
    box.focus();
    s.render();
    box.readInput((_err: unknown, value: string | null) => {
      box.detach();
      if (value != null) draft = setEdit(draft, row.envKey, value);
      endEdit();
    });
  }

  function editToggle(row: SettingRow): void {
    draft = setEdit(draft, row.envKey, row.value === "true" ? "false" : "true");
    paint();
  }

  function editPickTeam(row: SettingRow): void {
    openRemotePicker(deps.teams, null, (value) => {
      draft = setEdit(draft, row.envKey, value);
    });
  }

  function editPickState(row: SettingRow): void {
    const team = currentTeamName();
    openRemotePicker(() => deps.states(team), null, (value) => {
      draft = setEdit(draft, row.envKey, value);
    });
  }

  function editLabelFilter(row: SettingRow): void {
    beginEdit();
    const modePicker: any = blessed.list({
      parent: s,
      top: "center",
      left: "center",
      width: "60%",
      height: LABEL_MODES.length + 2,
      border: { type: "line" },
      keys: true,
      vi: true,
      items: LABEL_MODES,
      style: { selected: { inverse: true } },
    });
    modePicker.focus();
    s.render();
    modePicker.on("select", (_item: unknown, index: number) => {
      modePicker.detach();
      if (index === 0) {
        draft = setEdit(draft, row.envKey, "");
        endEdit();
        return;
      }
      const team = currentTeamName();
      const seed = currentLabel(row.value);
      openRemotePicker(() => deps.labels(team), seed, (label) => {
        draft = setEdit(draft, row.envKey, index === 1 ? label : `!${label}`);
      });
    });
    modePicker.on("cancel", () => {
      modePicker.detach();
      endEdit();
    });
  }

  function dispatchEdit(row: SettingRow): void {
    if (applying) return;
    resetEscArm();
    switch (row.editor) {
      case "text":
      case "number":
      case "list":
        editTextLike(row, false);
        break;
      case "secret":
        editTextLike(row, true);
        break;
      case "toggle":
        editToggle(row);
        break;
      case "pickTeam":
        editPickTeam(row);
        break;
      case "pickState":
        editPickState(row);
        break;
      case "labelFilter":
        editLabelFilter(row);
        break;
      case "readonly":
        break;
    }
  }

  function onWrite(): void {
    if (applying) return;
    resetEscArm();
    const errors = validateDraft(draft);
    if (Object.keys(errors).length > 0) {
      paint();
      return;
    }
    applying = true;
    paint("applying...");
    const next = commitDraft(draft);
    deps.apply(next, base).then((result) => {
      applying = false;
      if (result.ok) {
        base = next;
        draft = newDraft(base);
        paint("saved, daemon restarted");
        return;
      }
      const suffix = result.rolledBack ? "" : ", daemon stopped";
      paint(`${result.error}${suffix}`);
    });
  }

  function onEscape(): void {
    if (applying) return;
    if (dirtyKeys(draft).length === 0) {
      closePanel();
      return;
    }
    if (!escArmed) {
      escArmed = true;
      paint("unsaved changes: esc again discards");
      return;
    }
    draft = newDraft(base);
    escArmed = false;
    closePanel();
  }

  list.on("select", () => {
    const row = draftRows(draft, assigneeName)[list.selected];
    if (row) dispatchEdit(row);
  });

  list.on("cancel", onEscape);

  list.on("keypress", (_ch: string, key: any) => {
    if (key.full === "w") onWrite();
  });

  list.focus();
  paint();

  deps
    .assignee()
    .then((name) => {
      assigneeName = name;
      paint();
    })
    .catch(() => {
      assigneeName = "unknown (linear unreachable)";
      paint();
    });
}
