// src/tui-review.ts
// Review overlay: a plan pane (AI-ordered groups of changed files) and
// a diff pane, over the board the way the settings panel is. Everything that
// can be pure is exported below and unit-tested; the blessed shell stays thin.
import blessed from "neo-blessed";
import { attachClaudeOutput, claudeKeyAction } from "./claude-pane.ts";
import type { ClaudeSession } from "./claude-sessions.ts";
import { escapeTags, parseUnifiedDiff, renderFileDiff, type FileDiff } from "./review-diff.ts";
import { contextMarkdown, contextSignature, toggleContext } from "./review-context.ts";
import { fetchGroups, fileStats, normalizeGroups } from "./review-groups.ts";
import type { ReviewGroup, ReviewGroups } from "./review-groups.ts";
import { layoutGraph, type NodeBox } from "./arch-layout.ts";
import { fetchAnnotation, normalizeAnnotation } from "./arch-annotate.ts";
import { sourcePaths } from "./arch-generate.ts";
import {
  nodeFiles, nodeStates, parseArchMap, renderSet,
  type ArchAnnotation, type ArchMap, type ArchNode, type NodeState,
} from "./arch-map.ts";

export function flattenFiles(groups: ReviewGroup[]): string[] {
  return groups.flatMap((g) => g.files);
}

export function groupOf(groups: ReviewGroup[], path: string): ReviewGroup | null {
  return groups.find((g) => g.files.includes(path)) ?? null;
}

// The next unviewed file after `from`, wrapping; `from` itself when every
// file is viewed so space on the last file does not jump anywhere.
export function nextUnviewed(files: string[], viewed: Set<string>, from: number): number {
  for (let step = 1; step <= files.length; step++) {
    const i = (from + step) % files.length;
    if (!viewed.has(files[i])) return i;
  }
  return from;
}

export function placeholderGroups(paths: string[]): ReviewGroups {
  return { summary: "", groups: [{ title: "organizing review…", context: "", files: paths }] };
}

export function planLines(
  groups: ReviewGroup[],
  viewed: Set<string>,
  context: Set<string>,
  selectedPath: string | null,
): { lines: string[]; selectedLine: number } {
  const lines: string[] = [];
  let selectedLine = -1;
  for (const g of groups) {
    lines.push(`{yellow-fg}{bold}${escapeTags(g.title)}{/bold}{/yellow-fg}`);
    for (const f of g.files) {
      const check = viewed.has(f) ? " {green-fg}✓{/green-fg}" : "  ";
      const plus = context.has(f) ? "{magenta-fg}+{/magenta-fg}" : " ";
      const mark = check + plus;
      const color = viewed.has(f) ? "green-fg" : "cyan-fg";
      const name = `{${color}}${escapeTags(f)}{/${color}}`;
      if (f === selectedPath) {
        selectedLine = lines.length;
        lines.push(`{inverse}${mark}${name}{/inverse}`);
      } else {
        lines.push(`${mark}${name}`);
      }
    }
  }
  return { lines, selectedLine };
}

export function diffPaneLines(fd: FileDiff | null): string[] {
  if (fd) return renderFileDiff(fd);
  return ["{grey-fg}loading diff…{/grey-fg}"];
}

// The guide band's content: the selected file's group context, then the AI's
// PR summary. paint() sizes the band to this content via guideHeight, so
// nothing gets clipped up to the cap.
export function guideLines(s: {
  summary: string;
  group: ReviewGroup | null;
  loaded: boolean;
  usedFallback: boolean;
}): string[] {
  if (!s.loaded) return ["{grey-fg}organizing review…{/grey-fg}"];
  if (s.usedFallback) return ["{red-fg}AI grouping failed, grouped by directory{/red-fg}"];
  const out: string[] = [];
  if (s.group) {
    const title = `{bold}${escapeTags(s.group.title)}{/bold}`;
    out.push(s.group.context ? `${title}: ${escapeTags(s.group.context)}` : title);
  }
  if (s.summary) out.push(`{grey-fg}${escapeTags(s.summary)}{/grey-fg}`);
  return out;
}

// Greedy word wrap, matching how blessed wraps box content: break at the last
// space that fits, hard-break a single overlong word. Measures visible width,
// so tags are stripped and escapeTags' {open}/{close} count as one char each.
function wrappedRows(line: string, width: number): number {
  let text = line
    .replaceAll("{open}", "\u0000")
    .replaceAll("{close}", "\u0000")
    .replace(/\{[^{}]*\}/g, "");
  if (width <= 0 || text.length <= width) return 1;
  let rows = 0;
  while (text.length > width) {
    let cut = text.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    rows++;
    text = text.slice(cut).replace(/^ +/, "");
  }
  return rows + 1;
}

// Border-inclusive height the guide band needs to show all of `lines` on a
// band `innerWidth` columns wide, floored at 3 (one content row) and clamped
// to maxHeight so a long summary cannot crowd out the plan and diff panes.
export function guideHeight(lines: string[], innerWidth: number, maxHeight: number): number {
  const rows = lines.reduce((n, l) => n + wrappedRows(l, innerWidth), 0);
  return Math.min(maxHeight, Math.max(3, rows + 2));
}

export function reviewHeader(pr: number, title: string, viewedCount: number, total: number): string {
  return `PR #${pr}  ${escapeTags(title)}  |  ${viewedCount}/${total} viewed`;
}

export type ReviewPane = "plan" | "diff" | "claude";

export function nextReviewPane(cur: ReviewPane, hasClaude: boolean): ReviewPane {
  if (cur === "plan") return "diff";
  if (cur === "diff" && hasClaude) return "claude";
  return "plan";
}

export function claudePaneLabel(selected: string | null, contextCount: number): string {
  if (selected === null) return " claude ";
  const ctx = contextCount > 0 ? ` (+${contextCount} in context)` : "";
  return ` claude · ${selected}${ctx} `;
}

export function reviewFooterHint(s: {
  total: number;
  loaded: boolean;
  allViewed: boolean;
  isDraft: boolean;
  focused: ReviewPane;
  contextCount: number;
}): string {
  if (!s.loaded) return "loading…   q back";
  if (s.total === 0) return "no changes in this PR   q back";
  if (s.focused === "claude") return "typing goes to claude   C-q or C-\\ back";
  let done = "";
  if (s.allViewed && s.isDraft) done = "   {green-fg}y mark PR ready{/green-fg}";
  else if (s.allViewed) done = "   {green-fg}review complete{/green-fg}";
  const clear = s.contextCount > 0 ? "   C clear context" : "";
  if (s.focused === "diff") return `j/k scroll   space viewed   c context${clear}   tab claude   1/2/3 pane${done}   q back`;
  return `j/k file   space viewed   c context${clear}   g/G first/last   tab diff   1/2/3 pane${done}   q back`;
}

// Same rule as the board's paneBorderColor: the focused pane turns white so
// the operator can see where their keys land, the rest rest grey.
export function reviewPaneBorderColor(focused: boolean): string {
  return focused ? "white" : "grey";
}

// Fresh object per pane: blessed keeps the passed style by reference, so a
// shared one would repaint every border when paint() recolors the focused one.
const paneStyle = () => ({ border: { fg: "grey" }, label: { fg: "grey" } });

// Same discipline as footerLayout/settingsPanelLayout: exported plain records
// so the layout test exercises these exact objects. keys+vi on the diff pane
// gives blessed's own j/k scrolling when it is focused; the plan pane's keys
// are handled by openReview so headers can be skipped during selection.
export function reviewLayout(): Record<"header" | "guide" | "plan" | "diff" | "claude" | "footer", Record<string, unknown>> {
  return {
    header: { top: 0, left: 0, width: "100%", height: 1, wrap: false, tags: true },
    // guide.height and the panes' top are initial values; paint() re-fits
    // them to the guide's content via guideHeight on every repaint.
    guide: {
      top: 1, left: 0, width: "100%", height: 5, tags: true,
      border: { type: "line" }, label: " guide ", style: paneStyle(),
    },
    plan: {
      top: 6, left: 0, width: "25%", bottom: 1, tags: true,
      scrollable: true, alwaysScroll: true,
      border: { type: "line" }, label: " review plan ", style: paneStyle(),
    },
    diff: {
      top: 6, left: "25%", width: "45%", bottom: 1, tags: true, keys: true, vi: true,
      scrollable: true, alwaysScroll: true,
      border: { type: "line" }, label: " diff ", style: paneStyle(),
      scrollbar: { ch: " ", style: { inverse: true } },
    },
    claude: {
      top: 6, left: "70%", right: 0, bottom: 1, tags: true, wrap: false,
      border: { type: "line" }, label: " claude ", style: paneStyle(),
    },
    footer: { bottom: 0, left: 0, width: "100%", height: 1, wrap: false, tags: true, style: { fg: "white" } },
  };
}

// The flow overlay's two boxes: the chart takes the body, the note band pins
// three content rows above the footer. Both mount hidden and are shown by the
// f toggle, so the three columns keep their own scroll and selection.
export function flowLayout(): Record<"chart" | "note", Record<string, unknown>> {
  return {
    chart: {
      top: 1, left: 0, width: "100%", bottom: 6, tags: true, wrap: false, hidden: true,
      scrollable: true, alwaysScroll: true,
      border: { type: "line" }, label: " flow ", style: paneStyle(),
      scrollbar: { ch: " ", style: { inverse: true } },
    },
    note: {
      bottom: 1, left: 0, width: "100%", height: 5, tags: true, hidden: true,
      border: { type: "line" }, label: " note ", style: paneStyle(),
    },
  };
}

export function nodeOrder(boxes: NodeBox[]): string[] {
  return [...boxes].sort((a, b) => a.row - b.row || a.colStart - b.colStart).map((b) => b.id);
}

export function noteBandLines(s: {
  node: ArchNode | null;
  state: NodeState;
  ann: ArchAnnotation | null;
  stale: number;
}): string[] {
  const out: string[] = [];
  if (s.stale > 0) {
    out.push(`{yellow-fg}map stale: ${s.stale} file${s.stale === 1 ? "" : "s"} unmapped   G regenerate{/yellow-fg}`);
  }
  if (s.ann === null) {
    out.push("{grey-fg}flow annotation unavailable, showing touched nodes only{/grey-fg}");
  }
  if (s.node === null) {
    if (s.ann?.flow) out.push(escapeTags(s.ann.flow));
    return out.length > 0 ? out : ["{grey-fg}j/k to pick a node{/grey-fg}"];
  }
  const head = `{bold}${escapeTags(s.node.label)}{/bold}`;
  out.push(s.node.role ? `${head}: ${escapeTags(s.node.role)}` : head);
  // The band is three content rows and does not scroll, so the at-risk reason
  // goes above the touched note: it is the line the feature exists for, and
  // last place is the first thing the box clips.
  const risk = s.ann?.atRisk.find((r) => r.node === s.node?.id);
  if (risk) out.push(`{red-fg}at risk via ${escapeTags(risk.viaEdge)}: ${escapeTags(risk.why)}{/red-fg}`);
  const note = s.ann?.touched.find((t) => t.node === s.node?.id)?.note;
  if (note) out.push(escapeTags(note));
  if (s.state === "unmapped") out.push("{grey-fg}no node in the map claims these files{/grey-fg}");
  return out;
}

export function flowFooterHint(s: { stale: number; selected: string | null }): string {
  const regen = s.stale > 0 ? "   {yellow-fg}G regenerate{/yellow-fg}" : "";
  const jump = s.selected ? "   enter files" : "";
  return `j/k node${jump}${regen}   f diff   q back`;
}

const NO_ARCH_MAP = "{red-fg}no architecture map in this repo, run pnpm arch-map{/red-fg}";

export type ReviewDeps = {
  pr: number;
  fetchDiff: () => Promise<string>;
  fetchMeta: () => Promise<{ title: string; body: string; isDraft: boolean; headSha: string }>;
  runGrouping: (prompt: string) => Promise<string>;
  markReady: () => Promise<void>;
  loadViewed: (headSha: string) => Set<string>;
  saveViewed: (headSha: string, viewed: Set<string>) => void;
  // The plan cached for this head SHA, still unvalidated (null when there is
  // none). A hit skips the grouping model entirely, so reopening a review is
  // instant and reads the same as when it was left.
  loadGroups: (headSha: string) => unknown;
  saveGroups: (headSha: string, groups: ReviewGroups) => void;
  claudeSession: () => ClaudeSession | null;
  // Returns false when the write failed so the overlay retries on the next
  // keystroke instead of marking the signature clean over a stale file.
  writeContext: (content: string) => boolean;
  // The architecture map's raw contents from the reviewed repo, or null when
  // the repo has none. Read through a function so a regenerate lands without
  // reopening the overlay.
  loadArchMap: () => string | null;
  runAnnotation: (prompt: string) => Promise<string>;
  loadFlow: (headSha: string) => unknown;
  saveFlow: (headSha: string, flow: ArchAnnotation) => void;
  regenerateArchMap: () => Promise<void>;
};

// The returned claudeFocused getter feeds tui.ts's C-c gate: while the claude
// pane is focused the screen-level hard quit stands down so the interrupt
// reaches the pane's keypress handler and forwards to the embedded claude.
export function openReview(
  screen: unknown,
  deps: ReviewDeps,
  onClose: (notice: string | null, isError: boolean) => void,
): { claudeFocused: () => boolean } {
  const s: any = screen;
  const layout = reviewLayout();
  const header: any = blessed.text({ parent: s, ...layout.header, content: `PR #${deps.pr}  loading…` });
  const guide: any = blessed.box({ parent: s, ...layout.guide });
  const plan: any = blessed.box({ parent: s, ...layout.plan });
  const diff: any = blessed.box({ parent: s, ...layout.diff });
  const claude: any = blessed.box({ parent: s, ...layout.claude });
  const footer: any = blessed.text({ parent: s, ...layout.footer });
  const flow = flowLayout();
  const chart: any = blessed.box({ parent: s, ...flow.chart });
  const note: any = blessed.box({ parent: s, ...flow.note });
  plan.focus();

  let meta: { title: string; body: string; isDraft: boolean; headSha: string } | null = null;
  let fileDiffs: FileDiff[] = [];
  let groups: ReviewGroups | null = null;
  let viewed = new Set<string>();
  let selectedPath: string | null = null;
  // True once the operator has navigated or toggled a file (set inside
  // select(), whose only callers are the plan keypress handler and
  // toggleViewed's advance). Once true, a fresh group load must not snap the
  // selection back to the new order's first file out from under them.
  let userSelected = false;
  let focused: ReviewPane = "plan";
  let diffLoaded = false;
  let usedFallback = false;
  let readying = false;
  // Guards late async resolutions (grouping, markReady) after close, same as
  // the settings panel's `closed` flag.
  let closed = false;
  let contextFiles = new Set<string>();
  let lastCtxSig: string | null = null;
  let flowOpen = false;
  let archMap: ArchMap | null = null;
  let annotation: ArchAnnotation | null = null;
  let selectedNode: string | null = null;
  let chartBoxes: NodeBox[] = [];
  let regenerating = false;
  const session = deps.claudeSession();
  let claudeExited = false;
  const hasClaude = () => session !== null && !claudeExited;
  let claudeOut: { repaint(): void; resize(c: number, r: number): void; dispose(): void } | null = null;
  let exitSub: { dispose(): void } | null = null;
  if (session) {
    claudeOut = attachClaudeOutput(claude, session, () => focused === "claude", () => {
      if (!closed) s.render();
    });
    // A dead pty must not strand the pane: drop the output attachment (so a
    // pending repaint cannot overwrite the notice), surface the exit, and hand
    // focus back to plan. Reopening the overlay respawns via the registry.
    exitSub = session.pty.onExit(() => {
      if (closed) return;
      claudeExited = true;
      claudeOut?.dispose();
      claudeOut = null;
      claude.setContent("{red-fg}claude exited, close and reopen to restart{/red-fg}");
      if (focused === "claude") {
        focused = "plan";
        plan.focus();
      }
      paint();
    });
  } else {
    claude.setContent("{grey-fg}claude unavailable{/grey-fg}");
  }

  const loadMap = (): ArchMap | null => {
    const raw = deps.loadArchMap();
    return raw === null ? null : parseArchMap(raw);
  };
  archMap = loadMap();

  const currentGroups = (): ReviewGroups => {
    if (groups) return groups;
    return placeholderGroups(fileDiffs.map((f) => f.path));
  };
  const files = () => flattenFiles(currentGroups().groups);
  const allViewed = () => {
    const fs = files();
    return fs.length > 0 && fs.every((f) => viewed.has(f));
  };
  // The chart's file universe, narrowed by the same predicate the generator
  // feeds its prompt: a node can only ever claim a source file, so counting a
  // test or a lockfile as unmapped would nag on every review with a regenerate
  // that provably cannot help. The plan, diff, viewed marks and files() all
  // still cover the whole diff.
  const chartPaths = () => sourcePaths(fileDiffs.map((f) => f.path));
  // One glob sweep per paint rather than one per reader.
  let rendered: { map: ArchMap | null; unmapped: string[] } | null = null;
  const renderState = (): { map: ArchMap | null; unmapped: string[] } => {
    if (rendered === null) {
      rendered = archMap ? renderSet(archMap, annotation, chartPaths()) : { map: null, unmapped: [] };
    }
    return rendered;
  };

  function paint(footerOverride?: string): void {
    if (closed) return;
    rendered = null;
    const g = currentGroups();
    const fs = files();
    if (selectedPath === null || !fs.includes(selectedPath)) selectedPath = fs[0] ?? null;
    const title = meta ? meta.title : "loading…";
    header.setContent(reviewHeader(deps.pr, title, fs.filter((f) => viewed.has(f)).length, fs.length));
    const { lines, selectedLine } = planLines(g.groups, viewed, contextFiles, selectedPath);
    plan.setContent(lines.join("\n"));
    if (selectedLine >= 0) plan.scrollTo(selectedLine);
    const fd = fileDiffs.find((f) => f.path === selectedPath) ?? null;
    const gl = guideLines({
      summary: g.summary,
      group: selectedPath ? groupOf(g.groups, selectedPath) : null,
      loaded: groups !== null,
      usedFallback,
    });
    guide.setContent(gl.join("\n"));
    // Grow the band to fit the whole guide (cap: half the screen), and keep
    // the plan and diff panes pinned right under it.
    const gh = guideHeight(gl, s.width - 2, Math.max(5, Math.floor(s.height / 2)));
    guide.height = gh;
    plan.top = 1 + gh;
    diff.top = 1 + gh;
    claude.top = 1 + gh;
    diff.setContent(diffPaneLines(fd).join("\n"));
    plan.style.border.fg = reviewPaneBorderColor(focused === "plan");
    diff.style.border.fg = reviewPaneBorderColor(focused === "diff");
    claude.style.border.fg = reviewPaneBorderColor(focused === "claude");
    claude.setLabel(claudePaneLabel(selectedPath, contextFiles.size));
    // While the flow chart covers the columns the claude box sits hidden with
    // whatever stale dimensions it last had; re-fitting the pty to them would
    // resize it against a box nobody sees.
    if (claudeOut && !flowOpen) {
      claudeOut.resize(Math.max(2, claude.width - 2), Math.max(2, claude.height - 2));
      claudeOut.repaint();
    }
    if (flowOpen) {
      const { map: m, unmapped } = renderState();
      if (m) {
        const states = nodeStates(m, annotation, chartPaths());
        const drawn = layoutGraph(m, states, Math.max(12, chart.width - 2));
        chartBoxes = drawn.boxes;
        chart.setContent(drawn.lines.join("\n"));
        const node = m.nodes.find((n) => n.id === selectedNode) ?? null;
        note.setContent(noteBandLines({
          node,
          state: node ? states.get(node.id) ?? "idle" : "idle",
          ann: annotation,
          stale: unmapped.length,
        }).join("\n"));
      } else {
        // A regenerate that wrote a file we cannot parse drops the map; without
        // this the chart would keep showing the one it replaced.
        chartBoxes = [];
        chart.setContent(NO_ARCH_MAP);
        note.setContent(NO_ARCH_MAP);
      }
      chart.style.border.fg = reviewPaneBorderColor(true);
    }
    let hint = footerOverride;
    if (hint === undefined && flowOpen) {
      hint = flowFooterHint({ stale: renderState().unmapped.length, selected: selectedNode });
    }
    if (hint === undefined) {
      hint = reviewFooterHint({
        total: fs.length,
        loaded: diffLoaded,
        allViewed: allViewed(),
        isDraft: meta?.isDraft ?? false,
        focused,
        contextCount: contextFiles.size,
      });
    }
    footer.setContent(hint);
    s.render();
  }

  function close(notice: string | null, isError: boolean): void {
    if (closed) return;
    closed = true;
    if (meta) deps.saveViewed(meta.headSha, viewed);
    s.removeListener("resize", onScreenResize);
    exitSub?.dispose();
    claudeOut?.dispose();
    header.detach();
    guide.detach();
    plan.detach();
    diff.detach();
    claude.detach();
    footer.detach();
    chart.detach();
    note.detach();
    s.render();
    onClose(notice, isError);
  }

  function select(idx: number): void {
    const fs = files();
    if (fs.length === 0) return;
    const clamped = Math.max(0, Math.min(fs.length - 1, idx));
    selectedPath = fs[clamped];
    userSelected = true;
    diff.scrollTo(0);
    paint();
  }

  function selectedIndex(): number {
    return selectedPath === null ? 0 : Math.max(0, files().indexOf(selectedPath));
  }

  function toggleViewed(): void {
    if (selectedPath === null) return;
    if (viewed.has(selectedPath)) viewed.delete(selectedPath);
    else viewed.add(selectedPath);
    if (meta) deps.saveViewed(meta.headSha, viewed);
    select(nextUnviewed(files(), viewed, selectedIndex()));
  }

  function markReady(): void {
    if (readying || !allViewed() || !meta?.isDraft) return;
    readying = true;
    paint(`marking #${deps.pr} ready…`);
    deps.markReady().then(
      () => close(`{green-fg}#${deps.pr} marked ready{/green-fg}`, false),
      (err: unknown) => {
        readying = false;
        const msg = err instanceof Error ? err.message : String(err);
        paint(`{red-fg}mark ready failed: ${msg}{/red-fg}`);
      },
    );
  }

  function maybeWriteContext(): void {
    const sig = contextSignature(selectedPath, contextFiles);
    if (sig === lastCtxSig) return;
    const ok = deps.writeContext(contextMarkdown(deps.pr, selectedPath, contextFiles, fileDiffs));
    if (ok) lastCtxSig = sig;
  }

  function toggleContextSelected(): void {
    if (selectedPath === null) return;
    contextFiles = toggleContext(contextFiles, selectedPath);
    paint();
  }

  function clearContext(): void {
    if (contextFiles.size === 0) return;
    contextFiles = new Set();
    paint();
  }

  const focusPane = (p: ReviewPane) => {
    focused = p;
    if (p === "plan") plan.focus();
    else if (p === "diff") diff.focus();
    else claude.focus();
    paint();
  };

  const setFlow = (open: boolean): void => {
    flowOpen = open;
    for (const w of [guide, plan, diff, claude]) w.hidden = open;
    chart.hidden = !open;
    note.hidden = !open;
    if (open) chart.focus();
    else focusPane(focused);
    paint();
  };

  const openFlow = (): void => {
    if (archMap === null) {
      paint(NO_ARCH_MAP);
      return;
    }
    setFlow(true);
  };

  const moveNode = (delta: number): void => {
    const order = nodeOrder(chartBoxes);
    if (order.length === 0) return;
    const cur = selectedNode === null ? -1 : order.indexOf(selectedNode);
    selectedNode = order[Math.max(0, Math.min(order.length - 1, cur + delta))];
    paint();
  };

  // The chart's payoff: pick the hop, land in its diff. A node whose files are
  // all viewed goes to its first file rather than nowhere.
  const jumpToNode = (): void => {
    const m = renderState().map;
    if (!m || selectedNode === null) return;
    const owned = nodeFiles(m, selectedNode, files());
    // A node can own nothing in this diff: its globs claim files the PR never
    // touched, or only the ones the chart's source filter drops. Say so rather
    // than swallow the keystroke.
    if (owned.length === 0) {
      paint(`{grey-fg}${escapeTags(selectedNode)} owns no file in this PR{/grey-fg}`);
      return;
    }
    const target = owned.find((f) => !viewed.has(f)) ?? owned[0];
    setFlow(false);
    select(files().indexOf(target));
  };

  // The one path to the flow annotation, for the initial load and for the
  // refetch a regenerate forces. useCache is off in the second case: the copy
  // saved under this head SHA describes the topology that was just replaced.
  async function loadAnnotation(useCache: boolean): Promise<void> {
    const m = meta;
    const map = archMap;
    if (map === null || m === null) return;
    if (useCache) {
      const cached = normalizeAnnotation(deps.loadFlow(m.headSha), map);
      if (cached) {
        annotation = cached;
        paint();
        return;
      }
    }
    const fresh = await fetchAnnotation(
      deps.runAnnotation,
      map,
      { number: deps.pr, title: m.title, body: m.body },
      fileStats(fileDiffs),
    );
    if (closed) return;
    // A null is a transient model failure, never something to remember:
    // caching it would freeze the fallback in until the next push.
    if (fresh) {
      annotation = fresh;
      deps.saveFlow(m.headSha, fresh);
    }
    paint();
  }

  const regenerate = (): void => {
    if (regenerating || renderState().unmapped.length === 0) return;
    regenerating = true;
    paint("regenerating the architecture map…");
    void (async () => {
      try {
        await deps.regenerateArchMap();
        if (closed) return;
        archMap = loadMap();
        // The annotation was built against the topology that just went away,
        // and the copy cached under this SHA with it, so both are dropped and
        // the fetch runs past the cache instead of reading its own stale write.
        annotation = null;
        paint();
        await loadAnnotation(false);
      } catch (err: unknown) {
        if (closed) return;
        paint(`{red-fg}map regenerate failed: ${err instanceof Error ? err.message : String(err)}{/red-fg}`);
      } finally {
        regenerating = false;
      }
    })();
  };

  chart.on("keypress", (ch: string, key: { name: string; shift?: boolean }) => {
    if (key.name === "j" || key.name === "down") moveNode(1);
    else if (key.name === "k" || key.name === "up") moveNode(-1);
    else if (key.name === "enter" || key.name === "return") jumpToNode();
    else if (key.name === "g" && key.shift) regenerate();
    else if (key.name === "f" || key.name === "escape") setFlow(false);
    else if (key.name === "q") close(null, false);
  });

  chart.on("click", () => {
    if (!flowOpen) return;
    chart.focus();
  });

  // Direct pane jumps; matched on ch because blessed leaves key.name unset
  // for digit keys. The claude pane never sees these: its keypress forwards
  // everything to the pty.
  const jumpPane = (ch: string): boolean => {
    if (ch === "1") focusPane("plan");
    else if (ch === "2") focusPane("diff");
    else if (ch === "3" && hasClaude()) focusPane("claude");
    else return false;
    return true;
  };

  plan.on("keypress", (ch: string, key: { name: string; full?: string; shift?: boolean }) => {
    if (jumpPane(ch)) return;
    if (key.name === "j" || key.name === "down") select(selectedIndex() + 1);
    else if (key.name === "k" || key.name === "up") select(selectedIndex() - 1);
    else if (key.name === "g" && key.shift) select(files().length - 1);
    else if (key.name === "g") select(0);
    else if (key.name === "space") toggleViewed();
    else if (key.name === "y") markReady();
    else if (key.name === "c" && key.shift) clearContext();
    else if (key.name === "c") toggleContextSelected();
    else if (key.name === "tab") focusPane(nextReviewPane("plan", hasClaude()));
    else if (key.name === "f") openFlow();
    else if (key.name === "q" || key.name === "escape") close(null, false);
  });

  diff.on("keypress", (ch: string, key: { name: string; shift?: boolean }) => {
    if (jumpPane(ch)) return;
    if (key.name === "tab") focusPane(nextReviewPane("diff", hasClaude()));
    else if (key.name === "space") toggleViewed();
    else if (key.name === "y") markReady();
    else if (key.name === "c" && key.shift) clearContext();
    else if (key.name === "c") toggleContextSelected();
    else if (key.name === "f") openFlow();
    else if (key.name === "q" || key.name === "escape") close(null, false);
  });

  claude.on("keypress", (ch: string, key: { sequence?: string }) => {
    if (!session || claudeExited) {
      focused = "plan";
      plan.focus();
      paint();
      return;
    }
    if (claudeKeyAction(key) === "unfocus") {
      focused = "plan";
      plan.focus();
      paint();
      return;
    }
    maybeWriteContext();
    session.pty.write(key.sequence ?? ch ?? "");
  });

  plan.on("click", () => focusPane("plan"));
  diff.on("click", () => focusPane("diff"));
  claude.on("click", () => {
    if (hasClaude()) focusPane("claude");
  });

  // paint() is where the pty/term get re-fit to the pane, and its other
  // callers only run on plan/diff activity; without this a terminal resize
  // while the operator sits in the claude pane leaves stale dimensions.
  const onScreenResize = () => paint();
  s.on("resize", onScreenResize);

  paint();

  const metaP = deps.fetchMeta();
  const diffP = deps.fetchDiff();
  metaP.then(
    (m) => {
      if (closed) return;
      meta = m;
      const hadUnsaved = viewed.size > 0;
      viewed = new Set([...deps.loadViewed(m.headSha), ...viewed]);
      if (hadUnsaved) deps.saveViewed(m.headSha, viewed);
      paint();
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      close(`{red-fg}PR #${deps.pr} metadata failed: ${msg}{/red-fg}`, true);
    },
  );
  diffP.then(
    (raw) => {
      if (closed) return;
      fileDiffs = parseUnifiedDiff(raw);
      diffLoaded = true;
      paint();
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      close(`{red-fg}diff for #${deps.pr} failed: ${msg}{/red-fg}`, true);
    },
  );
  // Grouping needs the diff's file list and the PR title/body, so it starts
  // once both land; the placeholder group keeps the diff readable meanwhile.
  Promise.all([metaP, diffP.catch(() => null)]).then(async ([m, rawDiff]) => {
    if (closed || rawDiff === null) return;
    if (fileDiffs.length === 0) {
      groups = { summary: "", groups: [] };
      paint();
      return;
    }
    // The placeholder shown while grouping was in flight may have already
    // auto-selected its first file; once the real order lands, re-pick the
    // first file under that order, but only if the operator has not already
    // navigated or toggled a file, or a live selection would get yanked out
    // from under them.
    const applyGroups = (g: ReviewGroups, fallback: boolean): void => {
      groups = g;
      usedFallback = fallback;
      if (!userSelected) selectedPath = null;
      paint();
    };
    // The cache is validated against the diff we just fetched, so a plan that
    // no longer names a real file is discarded rather than shown.
    const cached = normalizeGroups(deps.loadGroups(m.headSha), fileDiffs.map((f) => f.path));
    if (cached) {
      applyGroups(cached, false);
    } else {
      const res = await fetchGroups(deps.runGrouping, { number: deps.pr, title: m.title, body: m.body }, fileStats(fileDiffs));
      if (closed) return;
      // A fallback is what we show when the model was unreachable, never what we
      // remember: caching it would freeze a transient failure in until the next push.
      if (!res.usedFallback) deps.saveGroups(m.headSha, res.groups);
      applyGroups(res.groups, res.usedFallback);
    }
    await loadAnnotation(true);
  }).catch(() => {
    // metaP rejection: already reported and closed by metaP.then's own
    // rejection handler above.
  });

  return { claudeFocused: () => !closed && focused === "claude" };
}
