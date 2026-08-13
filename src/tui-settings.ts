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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
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
  // True once the panel has been detached and onClose() called. Guards async
  // work (remote fetches, the initial assignee lookup) that can resolve after
  // the operator already left: without it, a late resolution would repaint a
  // detached list/footer or attach a fresh, focused picker to a screen the
  // panel no longer owns.
  let closed = false;

  function paint(footerOverride?: string): void {
    if (closed) return;
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
    if (closed) return;
    editing = false;
    list.focus();
    paint();
  }

  function currentTeamName(): string {
    const row = draftRows(draft, assigneeName).find((r) => r.envKey === "LINEAR_TEAM_NAME");
    return row ? row.value : base.teamName;
  }

  function closePanel(): void {
    closed = true;
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
  // Both branches bail out if the panel was closed while the fetch was
  // in flight, so a late resolution never attaches a widget to a screen
  // the panel no longer owns.
  function openRemotePicker(fetch: () => Promise<string[]>, seed: string | null, onPick: (value: string) => void): void {
    beginEdit();
    paint("loading...");
    fetch()
      .then((items) => {
        if (closed) return;
        const seeded = seed && !items.includes(seed) ? [seed, ...items] : items;
        openPicker(seeded, onPick);
        // openPicker moves focus to the new list; reflect that in the
        // footer instead of leaving the stale "loading..." message up.
        paint();
      })
      .catch(() => {
        if (closed) return;
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
    });
    if (!censor) box.setValue(row.value);
    box.focus();
    s.render();
    // Not `inputOnFocus`: that option makes the textbox call its own
    // readInput(null) the moment focus() fires above, which wins the
    // widget's `_reading` guard and silently discards the callback we
    // register on the next line (readInput no-ops once `_reading` is set).
    // Calling readInput ourselves, once, with our own callback, is what
    // actually captures the submitted value into the draft.
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
    if (applying || editing) return;
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
    if (applying || editing) return;
    resetEscArm();
    const errors = validateDraft(draft);
    if (Object.keys(errors).length > 0) {
      paint();
      return;
    }
    applying = true;
    paint("applying...");
    const next = commitDraft(draft);
    deps
      .apply(next, base)
      .then((result) => {
        applying = false;
        if (result.ok) {
          base = next;
          draft = newDraft(base);
          paint("saved, daemon restarted");
          return;
        }
        const suffix = result.rolledBack ? "" : ", daemon stopped";
        paint(`${result.error}${suffix}`);
      })
      .catch((err) => {
        // A rejection, not a resolved { ok: false }: same footer contract
        // (error text, "daemon stopped" since we cannot know it rolled
        // back), and applying must still clear or the panel freezes for
        // good, since dispatchEdit/onWrite/onEscape all gate on it.
        applying = false;
        paint(`${errMessage(err)}, daemon stopped`);
      });
  }

  function onEscape(): void {
    if (applying || editing) return;
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
      if (closed) return;
      assigneeName = name;
      paint();
    })
    .catch(() => {
      if (closed) return;
      assigneeName = "unknown (linear unreachable)";
      paint();
    });
}
