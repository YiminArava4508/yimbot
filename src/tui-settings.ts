// neo-blessed ships no types; treat as any at the import boundary.
import blessed from "neo-blessed";
import {
  SETTING_CATEGORIES,
  categoryDirtyCounts,
  commitDraft,
  dirtyKeys,
  draftRows,
  newDraft,
  rowsInCategory,
  setEdit,
  validateDraft,
  type Draft,
  type SettingCategory,
  type SettingRow,
  type YimbotConfig,
} from "./settings-model.ts";
import type { ApplyResult } from "./settings-apply.ts";

const LABEL_WIDTH = 20;
const SIDEBAR_WIDTH = 22;
const HELP_HEIGHT = 5;

// Bounds a Linear picker fetch so a hung request cannot trap the operator in
// the panel with no exit but C-c (which quits the board and stops the daemon).
const REMOTE_FETCH_TIMEOUT_MS = 10_000;

export function rowsToLines(
  rows: SettingRow[],
  dirty: string[],
  errors: Record<string, string>,
): string[] {
  const dirtySet = new Set(dirty);
  return rows.map((r) => {
    const label = r.label.padEnd(LABEL_WIDTH, " ");
    const shown = r.editor === "toggle" ? `${r.display === "on" ? "[x]" : "[ ]"} ${r.display}` : r.display;
    const error = errors[r.envKey];
    if (error) return `${label}{red-fg}${shown}  (${error}){/red-fg}`;
    if (dirtySet.has(r.envKey)) return `${label}{yellow-fg}${shown} *{/yellow-fg}`;
    return `${label}${shown}`;
  });
}

export function categoryLines(counts: Record<SettingCategory, number>, active: number): string[] {
  return SETTING_CATEGORIES.map((c, i) => {
    const marker = i === active ? "▸" : " ";
    const dirty = counts[c] > 0 ? ` {yellow-fg}${counts[c]}*{/yellow-fg}` : "";
    return `${marker} ${c}${dirty}`;
  });
}

export function settingsFooterHint(dirty: number, editing: boolean): string {
  if (editing) return "enter accept   esc cancel";
  const write = dirty > 0 ? `   w write + restart (${dirty} changed)` : "";
  return `j/k move   h/l pane   enter edit${write}   esc back`;
}

export function settingsLayout(): {
  sidebar: Record<string, unknown>;
  detail: Record<string, unknown>;
  help: Record<string, unknown>;
} {
  const pane = { keys: true, vi: true, tags: true, border: { type: "line" } };
  return {
    sidebar: {
      ...pane,
      top: 1,
      left: 0,
      width: SIDEBAR_WIDTH,
      bottom: 1,
      label: " settings ",
      style: { selected: { inverse: true }, border: { fg: "gray" } },
    },
    detail: {
      ...pane,
      top: 1,
      left: SIDEBAR_WIDTH,
      width: `100%-${SIDEBAR_WIDTH}`,
      bottom: 1 + HELP_HEIGHT,
      style: { selected: { inverse: true }, border: { fg: "cyan" } },
    },
    help: {
      tags: true,
      left: SIDEBAR_WIDTH,
      width: `100%-${SIDEBAR_WIDTH}`,
      bottom: 1,
      height: HELP_HEIGHT,
      border: { type: "line" },
      label: " about ",
      style: { border: { fg: "gray" } },
    },
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

export function openSettings(
  screen: unknown,
  deps: SettingsDeps,
  onClose: (daemonStopped: boolean) => void,
  initialDaemonStopped = false,
): void {
  const s: any = screen;

  const layout = settingsLayout();
  // Attached first so the detail list is the screen's first list child.
  const list: any = blessed.list({ parent: s, items: [], ...layout.detail });
  const sidebar: any = blessed.list({ parent: s, items: [], ...layout.sidebar });
  const help: any = blessed.box({ parent: s, ...layout.help });
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
  let category = 0;
  let pane: "sidebar" | "detail" = "detail";
  let escArmed = false;
  // Blocks re-entrant edits/writes/escapes while a write is in flight: the
  // list stays focused during that await (no widget steals focus the way an
  // editor does), so without this a second `w` or `esc` could race the apply.
  let applying = false;
  // True once an apply has failed and the daemon could not be rolled back
  // onto its old config. Seeded from the board's own record of this (a
  // previous session's failure survives a reopen with no apply at all,
  // rather than being silently cleared by closing with a fresh, clean
  // draft), cleared by the next successful apply, and surfaced to onClose
  // so the board's status line keeps showing it after the panel closes.
  let daemonStopped = initialDaemonStopped;
  // True once the panel has been detached and onClose() called. Guards async
  // work (remote fetches, the initial assignee lookup) that can resolve after
  // the operator already left: without it, a late resolution would repaint a
  // detached list/footer or attach a fresh, focused picker to a screen the
  // panel no longer owns.
  let closed = false;
  // setItems/select re-emit "select item" while paint rebuilds the lists;
  // without this the sidebar handler would treat that as the operator moving.
  let painting = false;

  function visibleRows(): SettingRow[] {
    return rowsInCategory(draftRows(draft, assigneeName), SETTING_CATEGORIES[category]);
  }

  function paintHelp(): void {
    const row = visibleRows()[list.selected];
    help.setContent(row ? `${row.help}\n{gray-fg}${row.envKey}{/gray-fg}` : "");
  }

  function focusPane(): void {
    (pane === "sidebar" ? sidebar : list).focus();
    list.style.border.fg = pane === "detail" ? "cyan" : "gray";
    sidebar.style.border.fg = pane === "sidebar" ? "cyan" : "gray";
  }

  function paint(footerOverride?: string): void {
    if (closed) return;
    const dirty = dirtyKeys(draft);
    const errors = validateDraft(draft);
    painting = true;
    list.setItems(rowsToLines(visibleRows(), dirty, errors));
    sidebar.setItems(categoryLines(categoryDirtyCounts(draft, assigneeName), category));
    sidebar.select(category);
    painting = false;
    list.setLabel(` ${SETTING_CATEGORIES[category].toLowerCase()} `);
    paintHelp();
    footer.setContent(footerOverride ?? settingsFooterHint(dirty.length, editing));
    s.render();
  }

  function switchPane(next: "sidebar" | "detail"): void {
    if (applying || editing) return;
    pane = next;
    focusPane();
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
    focusPane();
    paint();
  }

  function currentTeamName(): string {
    const row = draftRows(draft, assigneeName).find((r) => r.envKey === "LINEAR_TEAM_NAME");
    return row ? row.value : base.teamName;
  }

  function closePanel(): void {
    closed = true;
    list.detach();
    sidebar.detach();
    help.detach();
    footer.detach();
    s.render();
    onClose(daemonStopped);
  }

  function openPicker(items: string[], seed: string | null, onPick: (value: string) => void): void {
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
    // The prepend below only covers a seed Linear's list is missing; when the
    // current value is present (the common case), the cursor still needs to
    // be moved onto it, or it silently defaults to Linear's first item.
    if (seed) {
      const index = items.indexOf(seed);
      if (index >= 0) picker.select(index);
    }
    picker.focus();
    s.render();
    picker.on("select", (_item: unknown, index: number) => {
      picker.detach();
      // neo-blessed's enterSelected emits select with items[0] === undefined
      // on an empty list; openRemotePicker never attaches an empty picker,
      // but this stays as a second line of defence for any other caller.
      if (items[index] !== undefined) onPick(items[index]);
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
  // the panel no longer owns. `settled` guards the same race against a
  // timeout: once one fires, the other's result is abandoned.
  function openRemotePicker(
    fetch: () => Promise<string[]>,
    seed: string | null,
    onPick: (value: string) => void,
    emptyLabel: string,
  ): void {
    beginEdit();
    paint("loading...");
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (closed) return;
      endEdit();
      paint("linear timed out");
    }, REMOTE_FETCH_TIMEOUT_MS);
    fetch()
      .then((items) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (closed) return;
        if (items.length === 0) {
          endEdit();
          paint(`no ${emptyLabel} found`);
          return;
        }
        const seeded = seed && !items.includes(seed) ? [seed, ...items] : items;
        openPicker(seeded, seed, onPick);
        // openPicker moves focus to the new list; reflect that in the
        // footer instead of leaving the stale "loading..." message up.
        paint();
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
    openRemotePicker(
      deps.teams,
      row.value,
      (value) => {
        draft = setEdit(draft, row.envKey, value);
      },
      "teams",
    );
  }

  function editPickState(row: SettingRow): void {
    const team = currentTeamName();
    openRemotePicker(
      () => deps.states(team),
      row.value,
      (value) => {
        draft = setEdit(draft, row.envKey, value);
      },
      "states",
    );
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
      openRemotePicker(
        () => deps.labels(team),
        seed,
        (label) => {
          // Defence in depth: openPicker already refuses to call onPick with
          // an undefined item, and openRemotePicker never attaches an empty
          // picker, so this should be unreachable, but a filter must never
          // become the literal string "!undefined".
          if (!label) return;
          draft = setEdit(draft, row.envKey, index === 1 ? label : `!${label}`);
        },
        "labels",
      );
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
    const firstError = Object.keys(errors)[0];
    if (firstError) {
      const rows = draftRows(draft, assigneeName);
      const bad = rows.find((r) => r.envKey === firstError);
      if (bad) {
        category = SETTING_CATEGORIES.indexOf(bad.category);
        paint();
        list.select(rowsInCategory(rows, bad.category).indexOf(bad));
        paintHelp();
        s.render();
        return;
      }
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
          daemonStopped = false;
          paint("saved, daemon restarted");
          return;
        }
        daemonStopped = !result.rolledBack;
        const suffix = result.rolledBack ? "" : ", daemon stopped";
        paint(`${result.error}${suffix}`);
      })
      .catch((err) => {
        // A rejection, not a resolved { ok: false }: same footer contract
        // (error text, "daemon stopped" since we cannot know it rolled
        // back), and applying must still clear or the panel freezes for
        // good, since dispatchEdit/onWrite/onEscape all gate on it.
        applying = false;
        daemonStopped = true;
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
    const row = visibleRows()[list.selected];
    if (row) dispatchEdit(row);
  });

  list.on("select item", () => {
    if (!closed && !painting) {
      paintHelp();
      s.render();
    }
  });

  sidebar.on("select", () => switchPane("detail"));

  sidebar.on("select item", (_item: unknown, index: number) => {
    if (closed || painting || index === category) return;
    category = index;
    list.select(0);
    paint();
  });

  list.on("cancel", onEscape);
  sidebar.on("cancel", onEscape);

  function onKeypress(target: "sidebar" | "detail", key: any): void {
    if (key.full === "w") {
      onWrite();
      return;
    }
    if (key.name === "tab") {
      switchPane(target === "detail" ? "sidebar" : "detail");
      return;
    }
    if (target === "detail" && (key.name === "h" || key.name === "left")) switchPane("sidebar");
    if (target === "sidebar" && (key.name === "l" || key.name === "right")) switchPane("detail");
    // escape/q drive the double-esc discard prompt themselves (via the
    // "cancel" event below); any other key means the operator moved on,
    // so a stale arm must not silently discard on the next plain esc.
    if (key.name !== "escape" && key.name !== "q") resetEscArm();
  }

  list.on("keypress", (_ch: string, key: any) => onKeypress("detail", key));
  sidebar.on("keypress", (_ch: string, key: any) => onKeypress("sidebar", key));

  focusPane();
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
