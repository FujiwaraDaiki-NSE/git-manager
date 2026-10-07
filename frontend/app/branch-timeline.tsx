"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  aggregateTimelineConnectionChips,
  groupTimelineEventsByRow,
  routeTimelineConnections,
  selectDefaultTimelineConnectionEdges,
  selectTimelineConnectionEdges,
  selectTimelineRows,
  timelineConnectionDisplay,
} from "./timeline-layout.mjs";
import { createPortal } from "react-dom";
import {
  eventLeaderGeometry,
  flowEventKey,
  flowKeyboardAction,
  flowPopoverPlacement,
  graphTimeTicks,
  layoutFlowEvents,
  mobileEventAction,
  recentTimeAt,
  recentTimePosition,
} from "./project-flow.mjs";
import { agentStateLabel, agentTaskState } from "./agent-overview.mjs";
import { uniqueLocalForCommit } from "./project-flow.mjs";
import BranchRelations from "./branch-relations";
import { connectionEventTime, edgeDisplayLabel, evidenceLabel, operationLabel, referenceDisplayName } from "./branch-relations-tools.mjs";
import type {
  ProjectBranchCommit,
  ProjectBranchConnectionEdge,
  ProjectBranchRow,
  ProjectEvent,
  ProjectLane,
  ProjectResponse,
} from "./types";

type TimeRange = "current" | "24h" | "7d" | "all";
type TimelineRow = ProjectBranchRow;
type TimelineCommit = ProjectBranchCommit & { is_head: boolean; is_merge: boolean };
type TimelineEvent = {
  row: TimelineCommit;
  lane: TimelineRow;
  x: number;
  hitX: number;
  timestampX: number;
  pointOffset: number;
  id: string;
};

type TimelineRoute = {
  id: string;
  endpoints: string;
  kind: "merge" | "branch";
  evidence: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  outside: boolean;
  label: string;
  targetAnchor: boolean;
  sourceRowId: string;
  targetRowId: string;
  sourceName: string;
  targetName: string;
  sourceIndex: number;
  targetIndex: number;
  rowDistance: number;
  defaultVisible: boolean;
  path: string | null;
  arrow: string | null;
  sourceStubPath: string | null;
  targetStubPath: string | null;
  reversed: boolean;
  drawn: boolean;
  stub: boolean;
  reason: string | null;
};

type TimelineChipItem = {
  type: "single" | "aggregate";
  id: string;
  rowId: string;
  rowIndex: number;
  side: "source" | "target";
  routeIds: string[];
  count: number;
  kind: "merge" | "branch" | "mixed";
  glyph: string;
  label: string;
  routeId?: string;
};

const DENSE_EVENT_THRESHOLD = 5000;
const EMPTY_CONNECTION_EDGES: ProjectBranchConnectionEdge[] = [];
const EMPTY_CONNECTION_REFS: { id: string; name: string; kind: "local" | "remote" | "detached"; row_id: string | null; hash: string | null }[] = [];

const ranges: { id: TimeRange; label: string }[] = [
  { id: "current", label: "各ブランチの先端" },
  { id: "24h", label: "24時間" },
  { id: "7d", label: "7日" },
  { id: "all", label: "全期間" },
];

function exactDate(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}

function shortHash(hash: string | null | undefined) {
  return hash ? hash.slice(0, 8) : "未取得";
}

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

function rowLabel(row: TimelineRow) {
  return row.name || row.remote_branch || "ブランチ名未取得";
}

function rowLocal(row: TimelineRow) {
  return row.locals.length === 1 ? row.locals[0] : null;
}

function rowStatus(row: TimelineRow, defaultBranch: string | null) {
  const labels: Record<string, [string, string]> = {
    synchronized: ["同期済み", "lane-state-ok"],
    local_ahead: ["ローカル先行（未push）", "lane-state-warn"],
    remote_ahead: ["リモート先行（未pull）", "lane-state-warn"],
    diverged: ["分岐", "lane-state-danger"],
    remote_only: ["リモートのみ", "lane-state-muted"],
    remote_unavailable: ["リモート参照未取得", "lane-state-warn"],
    tracking_unavailable: ["追跡状態未取得", "lane-state-warn"],
    tracking_inconsistent: ["追跡状態不整合", "lane-state-warn"],
    mixed: ["ローカル混在", "lane-state-warn"],
    local_only: ["ローカルのみ", "lane-state-muted"],
    upstream_deleted: ["追跡先削除済み", "lane-state-danger"],
    detached: ["detached HEAD", "lane-state-muted"],
    historical_deleted: ["削除済み・PR履歴", "lane-state-muted"],
  };
  if (labels[row.status]) return labels[row.status];
  if (row.historical) return ["履歴", "lane-state-muted"];
  return ["状態未取得", "lane-state-muted"];
}

function isDefaultRow(row: TimelineRow, defaultBranch: string | null) {
  return Boolean(defaultBranch) && row.name === defaultBranch;
}

function commitEvent(project: ProjectResponse, row: TimelineRow, commit: ProjectBranchCommit): ProjectEvent {
  const local = uniqueLocalForCommit(row.locals, commit.hash);
  const existing = project.events.find((event) => event.type === "commit" && event.commit_hash === commit.hash);
  return {
    ...(existing ?? {}),
    id: existing?.id ?? `branch-row:${row.id}:${commit.hash}`,
    occurred_at: commit.date ?? existing?.occurred_at ?? null,
    observed_at: existing?.observed_at ?? project.observed_at,
    type: "commit",
    source: "git",
    project_id: project.id,
    worktree: local?.path ?? null,
    branch: local?.branch ?? row.name,
    lane_id: local?.id ?? null,
    lane_names: [row.name, ...(local?.branch ? [local.branch] : [])],
    commit_hash: commit.hash,
    subject: commit.subject ?? existing?.subject ?? null,
    author: commit.author ?? existing?.author ?? null,
    parents: commit.parents,
    stats: existing?.stats ?? null,
  };
}

function eventDate(commit: ProjectBranchCommit) {
  const value = Date.parse(commit.date ?? "");
  return Number.isFinite(value) ? value : null;
}

function flowPopoverId(eventId: string) {
  return `flow-popover-${encodeURIComponent(eventId)}`;
}

function FlowEventPopover({
  buttonRef,
  event,
  onPreviewEnter,
  onPreviewLeave,
  onSelect,
  popoverBelow,
}: {
  buttonRef: MutableRefObject<HTMLButtonElement | null>;
  event: TimelineEvent;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  onSelect: () => void;
  popoverBelow: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof flowPopoverPlacement> | null>(null);
  const updatePlacement = useCallback(() => {
    if (typeof window === "undefined" || !buttonRef.current || !popoverRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const next = flowPopoverPlacement({
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredWidth: popoverRef.current.offsetWidth,
      preferredHeight: popoverRef.current.offsetHeight,
      margin: 8,
      gap: 12,
      preferBelow: popoverBelow,
    });
    setPlacement(next);
  }, [buttonRef, popoverBelow]);
  useEffect(() => {
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [updatePlacement]);
  if (typeof document === "undefined") return null;
  const side = placement?.side ?? (popoverBelow ? "below" : "above");
  const width = placement?.width ?? 290;
  return createPortal(
    <div
      className={`flow-event-popover${side === "below" ? " flow-event-popover-below" : ""}`}
      id={flowPopoverId(event.id)}
      onFocus={onPreviewEnter}
      onBlur={(focusEvent) => {
        const next = focusEvent.relatedTarget;
        if (!(next instanceof Node) || !focusEvent.currentTarget.contains(next)) onPreviewLeave();
      }}
      onMouseEnter={onPreviewEnter}
      onMouseLeave={onPreviewLeave}
      ref={popoverRef}
      role="tooltip"
      style={{ left: `${placement?.left ?? 0}px`, maxHeight: placement ? `${placement.height}px` : undefined, top: `${placement?.top ?? 0}px`, visibility: placement ? "visible" : "hidden", width: `${width}px` }}
    >
      <span className="flow-popover-type">Git · コミット</span>
      <strong>{event.row.subject || "(no subject)"}</strong>
      <span>{shortHash(event.row.hash)} · {event.row.author || "作成者未取得"}</span>
      <time dateTime={event.row.date ?? undefined}>{relativeTime(event.row.date)} · {exactDate(event.row.date)}</time>
      <span>branch {rowLabel(event.lane)} · {event.row.is_head ? "HEAD" : "履歴"}</span>
      <span>親 {event.row.parents.length ? event.row.parents.map(shortHash).join(", ") : "未取得"}</span>
      <button type="button" onClick={onSelect}>詳細を開く</button>
    </div>,
    document.body,
  );
}

function FlowEventButton({
  event,
  selected,
  preview,
  popoverBelow,
  onNavigate,
  onRegister,
  onPreview,
  onSelect,
  trackWidth,
}: {
  event: TimelineEvent;
  selected: boolean;
  preview: boolean;
  popoverBelow: boolean;
  onNavigate: (event: TimelineEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => void;
  onRegister: (id: string, node: HTMLButtonElement | null) => void;
  onPreview: Dispatch<SetStateAction<string | null>>;
  onSelect: (event: TimelineEvent) => void;
  trackWidth: number;
}) {
  const pointerRef = useRef(false);
  const previewAtPointerRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const leader = eventLeaderGeometry(event.timestampX, event.hitX, trackWidth);
  const keepPreview = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    onPreview(event.id);
  };
  const closePreview = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => onPreview((current) => current === event.id ? null : current), 160);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const select = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    onPreview(null);
    onSelect(event);
  };
  return (
    <div className={`flow-event-hit${event.hitX < 24 ? " flow-event-left" : event.hitX > 76 ? " flow-event-right" : ""}`} data-flow-event-key={event.id} style={{ left: `${event.hitX}%`, "--flow-point-offset": `${event.pointOffset}px` } as CSSProperties} onMouseEnter={keepPreview} onMouseLeave={closePreview}>
      {leader.width > 0.5 && <span className="flow-event-leader" aria-hidden="true" style={{ left: `calc(50% + ${leader.left}px)`, width: `${leader.width}px` }} />}
      <button
        aria-label={`${rowLabel(event.lane)} ${shortHash(event.row.hash)} ${event.row.subject}`}
        aria-pressed={selected}
        aria-describedby={preview ? flowPopoverId(event.id) : undefined}
        className={`flow-event-button${selected ? " is-selected" : ""}`}
        data-flow-event-key={event.id}
        ref={(node) => { buttonRef.current = node; onRegister(event.id, node); }}
        onPointerDown={(pointerEvent) => { if (pointerEvent.pointerType === "touch") { pointerRef.current = true; previewAtPointerRef.current = preview; } }}
        onClick={() => {
          const action = mobileEventAction({ isMobile: typeof window !== "undefined" && window.matchMedia("(max-width: 1199px)").matches, isTouch: pointerRef.current, previewAtPointerDown: previewAtPointerRef.current });
          pointerRef.current = false;
          previewAtPointerRef.current = false;
          if (action === "preview") onPreview(event.id); else select();
        }}
        onKeyDown={(keyboardEvent) => {
          const action = flowKeyboardAction(keyboardEvent.key);
          if (action === "move") { keyboardEvent.preventDefault(); onNavigate(event, keyboardEvent.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"); }
          else if (action === "select") { keyboardEvent.preventDefault(); select(); }
        }}
        onFocus={keepPreview}
        onBlur={(focusEvent) => { const next = focusEvent.relatedTarget; const popover = typeof document === "undefined" ? null : document.getElementById(flowPopoverId(event.id)); if (!(next instanceof Node) || (!focusEvent.currentTarget.parentElement?.contains(next) && !popover?.contains(next))) closePreview(); }}
        type="button"
      >
        <span className={`flow-event-point${event.row.is_merge ? " is-merge" : ""}${event.row.is_head ? " is-head" : ""}`} aria-hidden="true" />
      </button>
      {preview && <FlowEventPopover buttonRef={buttonRef} event={event} onPreviewEnter={keepPreview} onPreviewLeave={closePreview} onSelect={select} popoverBelow={popoverBelow} />}
    </div>
  );
}

// The full-history view can contain every commit in a repository.  Keep every
// point and its keyboard/click target, but avoid one timer and effect cleanup
// per point.  The active point still uses the same preview popover as the
// normal view; the close timer is shared by the parent.
function FlowDenseEventButton({
  event,
  selected,
  preview,
  popoverBelow,
  onNavigate,
  onRegister,
  onPreview,
  onClosePreview,
  onSelect,
  trackWidth,
}: {
  event: TimelineEvent;
  selected: boolean;
  preview: boolean;
  popoverBelow: boolean;
  onNavigate: (event: TimelineEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => void;
  onRegister: (id: string, node: HTMLButtonElement | null) => void;
  onPreview: (id: string | null) => void;
  onClosePreview: (id: string) => void;
  onSelect: (event: TimelineEvent) => void;
  trackWidth: number;
}) {
  const pointerRef = useRef(false);
  const previewAtPointerRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const leader = eventLeaderGeometry(event.timestampX, event.hitX, trackWidth);
  const keepPreview = () => onPreview(event.id);
  const closePreview = () => onClosePreview(event.id);
  const select = () => {
    onPreview(null);
    onSelect(event);
  };
  return (
    <div className={`flow-event-hit${event.hitX < 24 ? " flow-event-left" : event.hitX > 76 ? " flow-event-right" : ""}`} data-flow-event-key={event.id} style={{ left: `${event.hitX}%`, "--flow-point-offset": `${event.pointOffset}px` } as CSSProperties} onMouseEnter={keepPreview} onMouseLeave={closePreview}>
      {leader.width > 0.5 && <span className="flow-event-leader" aria-hidden="true" style={{ left: `calc(50% + ${leader.left}px)`, width: `${leader.width}px` }} />}
      <button
        aria-label={`${rowLabel(event.lane)} ${shortHash(event.row.hash)} ${event.row.subject}`}
        aria-pressed={selected}
        aria-describedby={preview ? flowPopoverId(event.id) : undefined}
        className={`flow-event-button${selected ? " is-selected" : ""}`}
        data-flow-event-key={event.id}
        ref={(node) => { buttonRef.current = node; onRegister(event.id, node); }}
        onPointerDown={(pointerEvent) => { if (pointerEvent.pointerType === "touch") { pointerRef.current = true; previewAtPointerRef.current = preview; } }}
        onClick={() => {
          const action = mobileEventAction({ isMobile: typeof window !== "undefined" && window.matchMedia("(max-width: 1199px)").matches, isTouch: pointerRef.current, previewAtPointerDown: previewAtPointerRef.current });
          pointerRef.current = false;
          previewAtPointerRef.current = false;
          if (action === "preview") onPreview(event.id); else select();
        }}
        onKeyDown={(keyboardEvent) => {
          const action = flowKeyboardAction(keyboardEvent.key);
          if (action === "move") { keyboardEvent.preventDefault(); onNavigate(event, keyboardEvent.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"); }
          else if (action === "select") { keyboardEvent.preventDefault(); select(); }
        }}
        onFocus={keepPreview}
        onBlur={(focusEvent) => { const next = focusEvent.relatedTarget; const popover = typeof document === "undefined" ? null : document.getElementById(flowPopoverId(event.id)); if (!(next instanceof Node) || (!focusEvent.currentTarget.parentElement?.contains(next) && !popover?.contains(next))) closePreview(); }}
        title={`${shortHash(event.row.hash)} · ${event.row.subject || "コミット"}`}
        type="button"
      >
        <span className={`flow-event-point${event.row.is_merge ? " is-merge" : ""}${event.row.is_head ? " is-head" : ""}`} aria-hidden="true" />
      </button>
      {preview && <FlowEventPopover buttonRef={buttonRef} event={event} onPreviewEnter={keepPreview} onPreviewLeave={closePreview} onSelect={select} popoverBelow={popoverBelow} />}
    </div>
  );
}

type LoadedHistory = { commits: ProjectBranchCommit[]; offset: number | null; loading: boolean; error: string | null };

function edgeCommit(edge: ProjectBranchConnectionEdge & { source_commit?: ProjectBranchCommit | null; target_commit?: ProjectBranchCommit | null }, side: "source" | "target") {
  return side === "source" ? edge.source_commit ?? null : edge.target_commit ?? null;
}

function hasEdgeEvidence(edge: ProjectBranchConnectionEdge) {
  const operationTime = edge.occurred_at ? Date.parse(edge.occurred_at) : NaN;
  if (edge.operation) return Number.isFinite(operationTime);
  if (Number.isFinite(operationTime)) return true;
  return Boolean(
    edge.source_commit_hash
    && edge.target_commit_hash
    && edge.source_commit?.date
    && edge.target_commit?.date
    && Number.isFinite(Date.parse(edge.source_commit.date))
    && Number.isFinite(Date.parse(edge.target_commit.date)),
  );
}

function tipRefLabel(ref: { id: string; name: string; kind: string }) {
  const kind = ref.kind === "local" ? "local" : ref.kind === "remote" ? "remote" : "detached";
  return `${kind}: ${referenceDisplayName(ref)}`;
}

function connectionChipGlyph(route: TimelineRoute, side: "source" | "target") {
  const pointsDown = route.targetIndex > route.sourceIndex;
  return side === "source" ? pointsDown ? "↘" : "↗" : pointsDown ? "↖" : "↙";
}

function connectionChipLabel(route: TimelineRoute, side: "source" | "target") {
  const glyph = connectionChipGlyph(route, side);
  const other = side === "source" ? route.targetName : route.sourceName;
  const relation = route.kind === "merge" ? side === "source" ? "へマージ" : "からマージ" : side === "source" ? "へ分岐" : "から分岐";
  return `${glyph} ${other} ${relation}`;
}

export default function BranchTimeline({
  project,
  range,
  timeline,
  selectedKey,
  selectedRowId,
  selectedLane,
  relationRef,
  showMerged,
  onTimelineChange,
  onRangeChange,
  onShowMergedChange,
  onOpenGit,
  onSelect,
  onSelectLane,
}: {
  project: ProjectResponse;
  range: TimeRange;
  timeline: number;
  selectedKey: string | null;
  selectedRowId: string | null;
  selectedLane: string | null;
  relationRef: string | null;
  showMerged: boolean;
  onTimelineChange: (value: number) => void;
  onRangeChange: (range: TimeRange) => void;
  onShowMergedChange: (value: boolean) => void;
  onOpenGit: (lane: ProjectLane) => void;
  onSelect: (event: ProjectEvent, branchRowId?: string) => void;
  onSelectLane: (lane: ProjectLane) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const densePreviewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepDensePreview = useCallback((id: string | null) => {
    if (densePreviewCloseTimer.current) clearTimeout(densePreviewCloseTimer.current);
    setPreviewId(id);
  }, []);
  const closeDensePreview = useCallback((id: string) => {
    if (densePreviewCloseTimer.current) clearTimeout(densePreviewCloseTimer.current);
    densePreviewCloseTimer.current = setTimeout(() => setPreviewId((current) => current === id ? null : current), 160);
  }, []);
  useEffect(() => () => {
    if (densePreviewCloseTimer.current) clearTimeout(densePreviewCloseTimer.current);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(timeline < 100);
  const [history, setHistory] = useState<Record<string, LoadedHistory>>({});
  const historyRequestKeys = useRef(new Map<string, string>());
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const eventButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // The relation panel always keeps every ref/pair.  The graph may still be
  // narrowed by the user, but its initial state must not hide connections
  // simply because the old default was five rows.
  const [branchLimit, setBranchLimit] = useState<number | null>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem("gitdash.timeline.branchLimit");
    if (saved === "all") setBranchLimit(null);
    else if (saved === "5" || saved === "10" || saved === "20") setBranchLimit(Number(saved));
  }, []);
  const changeBranchLimit = (limit: number | null) => {
    setBranchLimit(limit);
    window.localStorage.setItem("gitdash.timeline.branchLimit", limit === null ? "all" : String(limit));
  };
  const [navigationRow, setNavigationRow] = useState("");
  const [focusedConnection, setFocusedConnection] = useState<string | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [rowOrder, setRowOrder] = useState<"parent" | "updated">("parent");
  useEffect(() => {
    setFocusedConnection(null);
    setActiveRowId(null);
    setPinnedRowId(null);
  }, [project.id]);
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0);
  const firstLabelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (timeline < 100) setHistoryOpen(true); }, [timeline]);
  const connectionEdges = useMemo(
    () => project.branch_connections === null ? EMPTY_CONNECTION_EDGES : project.branch_connections.edges,
    [project.branch_connections],
  );
  const selection = useMemo(() => selectTimelineRows(project.branch_rows ?? [], project.default_branch, branchLimit, showMerged, rowOrder, connectionEdges), [project.branch_rows, project.default_branch, branchLimit, showMerged, rowOrder, connectionEdges]);
  const rows: TimelineRow[] = selection.rows;
  useEffect(() => {
    const visibleRowIds = new Set(rows.map((row) => row.id));
    setActiveRowId((current) => current !== null && visibleRowIds.has(current) ? current : null);
    setPinnedRowId((current) => current !== null && visibleRowIds.has(current) ? current : null);
  }, [rows]);
  useEffect(() => {
    setHistory((current) => Object.fromEntries(rows.map((row) => {
      const identity = `${project.main_path}:${row.id}:${row.history_heads.join(",")}`;
      const previous = current[row.id];
      if (previous && historyRequestKeys.current.get(row.id) === identity) return [row.id, previous];
      historyRequestKeys.current.set(row.id, identity);
      return [row.id, { commits: [], offset: row.history_cursor, loading: false, error: null }];
    })));
  }, [project.main_path, rows]);
  const loadMore = useCallback((row: TimelineRow) => {
    const current = history[row.id] ?? { commits: [], offset: row.history_cursor, loading: false, error: null };
    if (range === "current" || current.loading || current.offset === null || row.history_heads.length === 0) return;
    const offset = current.offset;
    const requestKey = `${project.main_path}:${row.id}:${row.history_heads.join(",")}`;
    historyRequestKeys.current.set(row.id, requestKey);
    setHistory((value) => ({ ...value, [row.id]: { ...current, loading: true, error: null } }));
    const params = new URLSearchParams({ path: project.main_path, offset: String(offset) });
    row.history_heads.forEach((head) => params.append("heads", head));
    void fetch(`/api/repo/branch-history?${params.toString()}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as { commits: ProjectBranchCommit[]; next_offset: number | null };
    }).then((page) => {
      if (historyRequestKeys.current.get(row.id) !== requestKey) return;
      setHistory((value) => {
      const latest = value[row.id] ?? current;
      const seen = new Set(latest.commits.map((commit) => commit.hash));
      return { ...value, [row.id]: { commits: [...latest.commits, ...page.commits.filter((commit) => !seen.has(commit.hash))], offset: page.next_offset, loading: false, error: null } };
      });
    }).catch(() => {
      if (historyRequestKeys.current.get(row.id) === requestKey) setHistory((value) => ({ ...value, [row.id]: { ...(value[row.id] ?? current), loading: false, error: "履歴を取得できませんでした。" } }));
    });
  }, [history, project.main_path, range]);
  useEffect(() => {
    const scroll = flowScrollRef.current;
    const label = firstLabelRef.current;
    if (!scroll || !label) return;
    const update = () => {
      const width = label.getBoundingClientRect().width;
      const styles = getComputedStyle(scroll);
      setAvailableTrackWidth(Math.max(0, Math.round(scroll.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - width)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [rows.length]);
  const now = project.observed_at * 1000;
  const rowCommits = useMemo(() => new Map(rows.map((row) => {
    const loaded = history[row.id]?.commits ?? [];
    const source = range === "current" ? row.tip_commits : [...row.commits, ...loaded];
    const unique = new Map(source.map((commit) => [commit.hash, commit]));
    const cutoff = range === "24h" ? now - 86400000 : range === "7d" ? now - 604800000 : null;
    const commits = [...unique.values()].filter((commit) => range === "current" || cutoff === null || (eventDate(commit) ?? -Infinity) >= cutoff);
    return [row.id, commits] as const;
  })), [history, now, range, rows]);
  // Keep all edges in memory.  The SVG only draws endpoints that are present
  // in the current row window; the relation panel remains the complete index
  // for hidden rows and deleted/ambiguous refs.
  const connectionSelection = useMemo(() => selectTimelineConnectionEdges(connectionEdges, new Set(rows.map((row) => row.id))), [connectionEdges, rows]);
  const sameRowConnectionEdges = connectionEdges.filter((edge) => (
    typeof edge.source_row_id === "string"
    && typeof edge.target_row_id === "string"
    && edge.source_row_id === edge.target_row_id
  ));
  const rangeCutoff = range === "24h" ? now - 86400000 : range === "7d" ? now - 604800000 : null;
  const allTimes = rows.flatMap((row) => rowCommits.get(row.id) ?? []).map(eventDate).filter((value): value is number => value !== null);
  const relationTimes = connectionEdges.flatMap((edge) => {
    const date = connectionEventTime(edge, now);
    return date === null ? [] : [date];
  });
  // A time-range cutoff controls commit points.  Relation events are retained
  // even when older and use an outside anchor at the left edge.
  const minTime = rangeCutoff ?? Math.min(now - 1, ...(allTimes.length ? allTimes : relationTimes.length ? relationTimes : [now]));
  const observationTime = minTime + ((now - minTime) * timeline) / 100;
  const positioned = rows.flatMap((row) => (rowCommits.get(row.id) ?? []).flatMap((commit) => {
    const time = eventDate(commit);
    if (time === null || time > observationTime) return [];
    return [{ row: { ...commit, is_head: row.tip_commits.some((tip) => tip.hash === commit.hash), is_merge: commit.parents.length > 1 }, lane: row, x: recentTimePosition(time, minTime, now), hitX: 0, timestampX: 0, pointOffset: 0, id: flowEventKey(row.id, commit.hash) }];
  }));
  const positionedByRow = new Map<string, typeof positioned>();
  positioned.forEach((event) => {
    const current = positionedByRow.get(event.lane.id);
    if (current) current.push(event);
    else positionedByRow.set(event.lane.id, [event]);
  });
  const minimumTrackWidth = Math.max(440, ...rows.map((row) => Math.max(1, positionedByRow.get(row.id)?.length ?? 0) * 44));
  const trackWidth = Math.max(minimumTrackWidth, availableTrackWidth);
  const events = rows.flatMap((row) => layoutFlowEvents(positionedByRow.get(row.id) ?? [], trackWidth));
  const eventsByRow = groupTimelineEventsByRow(events) as Map<string, TimelineEvent[]>;
  const denseEventMode = events.length > DENSE_EVENT_THRESHOLD;
  const refs = useMemo(
    () => project.branch_connections?.refs ?? EMPTY_CONNECTION_REFS,
    [project.branch_connections],
  );
  const tipRefsByRow = useMemo(() => new Map(rows.map((row) => {
    const hashes = new Set([
      ...row.tip_commits.map((commit) => commit.hash),
      ...(row.remote_hash ? [row.remote_hash] : []),
    ]);
    return [row.id, refs.filter((ref) => ref.row_id === row.id && (ref.hash === null || hashes.has(ref.hash)))] as const;
  })), [refs, rows]);
  const ticks = graphTimeTicks(minTime, now, trackWidth);
  const register = useCallback((id: string, node: HTMLButtonElement | null) => { if (node) eventButtonRefs.current.set(id, node); else eventButtonRefs.current.delete(id); }, []);
  const navigate = useCallback((current: TimelineEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => {
    const rowIndex = rows.findIndex((row) => row.id === current.lane.id);
    const own = eventsByRow.get(current.lane.id) ?? [];
    let target: TimelineEvent | undefined;
    if (key === "ArrowLeft" || key === "ArrowRight") target = own[own.findIndex((item) => item.row.hash === current.row.hash) + (key === "ArrowLeft" ? -1 : 1)];
    else {
      const next = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
      target = next ? [...(eventsByRow.get(next.id) ?? [])].sort((a, b) => Math.abs(a.x - current.x) - Math.abs(b.x - current.x))[0] : undefined;
    }
    if (target) {
      setActiveRowId(target.lane.id);
      eventButtonRefs.current.get(target.id)?.focus();
    }
  }, [eventsByRow, rows]);
  const eventSelect = useCallback((event: TimelineEvent) => onSelect(commitEvent(project, event.lane, event.row), event.lane.id), [onSelect, project]);
  const routeLinks = useMemo(() => {
    const byRow = new Map(rows.map((row) => [row.id, row]));
    const rowIndexById = new Map(rows.map((row, index) => [row.id, index]));
    const byHash = new Map<string, TimelineEvent>();
    events.forEach((event) => byHash.set(`${event.lane.id}:${event.row.hash}`, event));
    const defaultEdgeIds = new Set(selectDefaultTimelineConnectionEdges(connectionSelection.visible as ProjectBranchConnectionEdge[]).map((edge) => edge.id));
    const routes: Omit<TimelineRoute, "path" | "arrow" | "sourceStubPath" | "targetStubPath" | "reversed" | "drawn" | "stub" | "reason">[] = [];
    const links: { kind: "commit" | "merge" | "branch"; path: string; arrow: string | null; outside: boolean; label: string }[] = [];
    rows.forEach((row, rowIndex) => {
      const own = eventsByRow.get(row.id) ?? [];
      const ownByHash = new Map(own.map((event) => [event.row.hash, event]));
      own.forEach((child) => child.row.parents.forEach((parent) => {
        const parentEvent = ownByHash.get(parent);
        if (!parentEvent) return;
        const x1 = parentEvent.hitX * trackWidth / 100;
        const x2 = child.hitX * trackWidth / 100;
        if (x1 > x2) return;
        const y = (rowIndex + 0.5) * 88;
        links.push({ kind: "commit", path: `M ${x1} ${y} H ${x2}`, arrow: null, outside: false, label: `${shortHash(parent)} → ${shortHash(child.row.hash)}` });
      }));
    });
    (connectionSelection.visible as ProjectBranchConnectionEdge[]).forEach((edge) => {
      const sourceRow = edge.source_row_id ? byRow.get(edge.source_row_id) : undefined;
      const targetRow = edge.target_row_id ? byRow.get(edge.target_row_id) : undefined;
      if (!sourceRow || !targetRow || sourceRow.id === targetRow.id) return;
      const sourceHash = edge.source_commit_hash ?? edgeCommit(edge, "source")?.hash ?? null;
      const targetHash = edge.target_commit_hash ?? edgeCommit(edge, "target")?.hash ?? null;
      const sourceEvent = byHash.get(`${sourceRow.id}:${sourceHash}`);
      const targetEvent = byHash.get(`${targetRow.id}:${targetHash}`);
      const operationTime = connectionEventTime(edge, now);
      if (operationTime === null || operationTime > observationTime) return;
      const sourceDate = edge.source_commit?.date ? Date.parse(edge.source_commit.date) : operationTime;
      const targetDate = edge.target_commit?.date ? Date.parse(edge.target_commit.date) : operationTime;
      const sourceTime = Number.isFinite(sourceDate) ? sourceDate : operationTime;
      const targetTime = Number.isFinite(targetDate) ? targetDate : operationTime;
      const sourceX = sourceEvent?.hitX ?? Math.max(8 / trackWidth * 100, recentTimePosition(sourceTime, minTime, now));
      const targetX = targetEvent?.hitX ?? Math.max(8 / trackWidth * 100, recentTimePosition(targetTime, minTime, now));
      const sourceIndex = rowIndexById.get(sourceRow.id);
      const targetIndex = rowIndexById.get(targetRow.id);
      if (sourceIndex === undefined || targetIndex === undefined) return;
      const x1 = sourceX * trackWidth / 100;
      const x2 = targetX * trackWidth / 100;
      const y1 = (sourceIndex + 0.5) * 88;
      const y2 = (targetIndex + 0.5) * 88;
      const outside = operationTime < minTime || sourceTime < minTime || targetTime < minTime;
      const kind = edge.kind === "merge" ? "merge" : "branch";
      const rowDistance = Math.abs(targetIndex - sourceIndex);
      if (![x1, x2, y1, y2, rowDistance].every(Number.isFinite)) return;
      routes.push({
        id: edge.id,
        endpoints: edgeDisplayLabel(edge, refs),
        kind,
        evidence: edge.evidence,
        x1,
        x2,
        y1,
        y2,
        outside,
        targetAnchor: !targetEvent,
        sourceRowId: sourceRow.id,
        targetRowId: targetRow.id,
        sourceName: rowLabel(sourceRow),
        targetName: rowLabel(targetRow),
        sourceIndex,
        targetIndex,
        rowDistance,
        defaultVisible: defaultEdgeIds.has(edge.id),
        label: `${edgeDisplayLabel(edge, refs)} · ${edge.label || "関係イベント"} · ${evidenceLabel(edge.evidence)}${edge.operation ? ` · ${operationLabel(edge.operation)}` : ""}${outside ? " · 表示期間より前の接続" : ""}`,
      });
    });
    const routed = routeTimelineConnections(routes) as TimelineRoute[];
    return {
      links,
      routes: routed.map((route) => ({
        ...route,
        label: route.reason ? `${route.label} · ${route.reason}` : route.label,
      })),
    };

  }, [connectionEdges, connectionSelection.visible, events, eventsByRow, minTime, now, observationTime, project.default_branch, refs, rows, trackWidth]);
  const focusedRoute = routeLinks.routes.find((route: TimelineRoute) => route.id === focusedConnection);
  const focusedIndex = routeLinks.routes.findIndex((route: TimelineRoute) => route.id === focusedConnection);
  const focusedRouteId = focusedRoute?.id ?? null;
  useEffect(() => {
    if (focusedConnection !== null && focusedRouteId === null) setFocusedConnection(null);
  }, [focusedConnection, focusedRouteId]);
  const defaultVisibleConnectionCount = routeLinks.routes.filter((route: TimelineRoute) => route.defaultVisible).length;
  const hiddenRelationCount = routeLinks.routes.filter((route: TimelineRoute) => !route.defaultVisible).length;
  const activeRowIds = new Set([activeRowId, pinnedRowId, selectedRowId].filter((rowId): rowId is string => rowId !== null));
  const isRouteActive = (route: TimelineRoute) => Boolean(
    [activeRowId, pinnedRowId, selectedRowId].some((rowId) => rowId !== null && (route.sourceRowId === rowId || route.targetRowId === rowId)),
  );
  const isRouteContextActive = (route: TimelineRoute) => Boolean(showAllConnections || focusedRouteId === route.id || isRouteActive(route));
  const routeDisplay = (route: TimelineRoute) => timelineConnectionDisplay(route, { showAll: showAllConnections, focusedRouteId, activeRowIds });
  const isRouteFullyVisible = (route: TimelineRoute) => routeDisplay(route) === "full";
  const isRoutePresented = (route: TimelineRoute) => routeDisplay(route) !== "hidden";
  const connectionChipCandidates = useMemo(() => routeLinks.routes.flatMap((route: TimelineRoute) => {
    if (!route.drawn || !route.stub || !route.defaultVisible) return [];
    return (["source", "target"] as const).map((side) => {
      const label = connectionChipLabel(route, side);
      return {
        id: route.id,
        routeId: route.id,
        rowId: side === "source" ? route.sourceRowId : route.targetRowId,
        rowIndex: side === "source" ? route.sourceIndex : route.targetIndex,
        side,
        kind: route.kind,
        glyph: connectionChipGlyph(route, side),
        label,
        defaultVisible: route.defaultVisible,
        stub: route.stub,
        left: side === "source" ? route.x1 : route.x2,
        width: Math.min(210, 20 + label.length * 8),
      };
    });
  }), [routeLinks.routes]);
  const connectionChips = useMemo(() => aggregateTimelineConnectionChips(connectionChipCandidates) as TimelineChipItem[], [connectionChipCandidates]);
  const hasRowEmphasis = Boolean(focusedRoute || activeRowId || pinnedRowId || selectedRowId);
  const pinnedRow = pinnedRowId === null ? null : rows.find((row) => row.id === pinnedRowId) ?? null;
  const pinnedConnectionCount = pinnedRowId === null ? 0 : routeLinks.routes.filter((route: TimelineRoute) => route.sourceRowId === pinnedRowId || route.targetRowId === pinnedRowId).length;
  const stepConnection = (step: number) => {
    const count = routeLinks.routes.length;
    if (count) setFocusedConnection(routeLinks.routes[(focusedIndex + step + count) % count].id);
  };
  const mergedCount = (project.branch_rows ?? []).filter((row) => row.historical).length;
  const hiddenConnectionCount = connectionSelection.hidden.length;
  const observationX = recentTimePosition(observationTime, minTime, now);
  return (
    <section className="flow-section" aria-labelledby="flow-map-title">
      <div className="flow-controls">
        <div className="flow-heading"><div><h3 id="flow-map-title">ブランチの分岐と合流</h3><p>ブランチを選ぶと作業の詳細、点を選ぶとコミットの詳細を開けます。</p></div><span className="flow-direction">過去を圧縮 → 直近を詳しく</span></div>
        <div className="flow-toolbar">
          <div className="range-tabs" role="group" aria-label="表示するコミット"><span className="flow-control-label">表示範囲</span>{ranges.map((item) => <button aria-pressed={range === item.id} className="range-tab" key={item.id} type="button" onClick={() => onRangeChange(item.id)}>{item.label}</button>)}</div>
          <div className="flow-branch-count" role="group" aria-label="表示するブランチ数"><span>表示行数</span>{[5, 10, 20, null].map(limit => <button key={limit ?? "all"} type="button" className="range-tab" aria-pressed={branchLimit === limit} onClick={() => changeBranchLimit(limit)}>{limit === null ? "すべて" : `${limit}件`}</button>)}<span>＋既定ブランチ · {rows.length}/{selection.total}行</span></div>
          <div className="flow-row-order" role="group" aria-label="行の並び順"><span>行の並び</span><button type="button" className="range-tab" aria-pressed={rowOrder === "parent"} onClick={() => setRowOrder("parent")}>親子順</button><button type="button" className="range-tab" aria-pressed={rowOrder === "updated"} onClick={() => setRowOrder("updated")}>更新順</button></div>
          <div className="flow-control-actions"><label className="flow-branch-jump"><span>ブランチへ移動</span><select aria-label="グラフのブランチへ移動" value={rows.some((row) => row.id === navigationRow) ? navigationRow : ""} onChange={(event) => { setNavigationRow(event.target.value); document.querySelector(`[data-flow-row="${CSS.escape(event.target.value)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}><option value="">ブランチを選択</option>{rows.map((row) => <option key={row.id} value={row.id}>{rowLabel(row)}</option>)}</select></label>{mergedCount > 0 && <button aria-pressed={showMerged} className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "完了ブランチを折り畳む" : `完了ブランチを表示 (${mergedCount})`}</button>}<button className="subtle-button" type="button" onClick={() => flowScrollRef.current?.scrollTo({ left: flowScrollRef.current.scrollWidth, behavior: "smooth" })}>右端へ移動 →</button></div>
        </div>
      </div>
      <details className="flow-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>履歴をたどる <span>{timeline === 100 ? "最新の観測" : "過去を表示中"} · {exactDate(new Date(observationTime).toISOString())}</span></summary><div className="flow-observation"><label className="timeline-control"><span>表示時点</span><input aria-label="過去の観測時点" max="100" min="0" onChange={(event) => onTimelineChange(100 * (recentTimeAt(Number(event.target.value), minTime, now) - minTime) / (now - minTime))} step="1" type="range" value={observationX} /><output>{timeline === 100 ? "最新の観測" : "選択日時"} · {exactDate(new Date(observationTime).toISOString())}</output></label><button className="subtle-button" disabled={timeline === 100} type="button" onClick={() => onTimelineChange(100)}>最新に戻る</button></div></details>
      {timeline < 100 && <p className="flow-history-note" role="status">選択日時までのコミット・合流・ブランチ作業履歴を表示中。ブランチ名とGit作業状態は現在の情報です。</p>}
      {routeLinks.routes.length > 0 && <div className="flow-connection-controls">
        <label><span>接続を1本ずつ確認</span><select aria-label="強調する接続" value={focusedRoute?.id ?? ""} onChange={event => setFocusedConnection(event.target.value || null)}>
          <option value="">すべての接続 ({routeLinks.routes.length}件)</option>
          {routeLinks.routes.map((route: TimelineRoute, index: number) => <option key={route.id} value={route.id}>{index + 1}. {route.label}</option>)}
        </select></label>
        <div className="flow-connection-buttons"><button type="button" className="subtle-button" onClick={() => stepConnection(-1)} disabled={!focusedRoute}>前の接続</button><button type="button" className="subtle-button" onClick={() => stepConnection(1)}>次の接続</button><button type="button" className="subtle-button" onClick={() => setFocusedConnection(null)} disabled={!focusedRoute}>選択を解除</button><button type="button" className="subtle-button" onClick={() => setPinnedRowId(null)} disabled={pinnedRowId === null}>固定を解除</button></div>
        <div className="flow-connection-toggle"><button aria-pressed={showAllConnections} className="subtle-button" type="button" onClick={() => setShowAllConnections((current) => !current)}>{showAllConnections ? "既定の線だけ表示" : "すべての線を表示"}</button><span>既定表示 {defaultVisibleConnectionCount}/{routeLinks.routes.length}件</span></div>
        <p className="flow-connection-status" role="status">{pinnedRow ? `${rowLabel(pinnedRow)} の関係を固定表示中（${pinnedConnectionCount}件）。チップを再クリックまたは Esc で解除` : focusedRoute ? <><strong>{focusedIndex + 1} / {routeLinks.routes.length} · {focusedRoute.endpoints}</strong><span>{focusedRoute.label}</span></> : showAllConnections ? "すべての関係を表示中です。時刻が逆転した関係は理由付きで線を描きません。○ が元、▶ が先です。" : "○ が元、▶ が先。時間の左から右へ進むS字で表示し、実線は操作の記録、破線は推定です。遠い行の関係はスタブとチップで示します。"}</p>
      </div>}
      {rows.length === 0 ? <div className="empty-flow">{project.branch_rows === null ? "ブランチ行の取得に失敗しました。" : "表示できるブランチはありません。完了ブランチが折り畳まれている場合は表示を切り替えてください。"}</div> : <div className="flow-scroll" role="region" aria-label="Gitフローマップ（横スクロール可能）" ref={flowScrollRef} style={{ "--flow-popover-space": previewId ? "360px" : "0px" } as CSSProperties} tabIndex={0} onKeyDown={(event) => { if (event.key === "Escape") setPinnedRowId(null); }}>
        <div className="flow-axis" aria-hidden="true" style={{ "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as CSSProperties}><span>ブランチ / 現在の作業状態</span><div className="flow-axis-track">{ticks.map((tick) => <span className={`flow-time-tick${tick.edge ? ` is-${tick.edge}` : ""}`} key={tick.time} style={{ left: `${tick.position}%` }}><span className="flow-tick-date">{tick.dateLabel}</span><span>{tick.timeLabel}</span></span>)}<span className="flow-current-label" style={{ left: `${observationX * trackWidth / 100}px` }}>{timeline === 100 ? "最新の観測" : "選択日時"}</span></div></div>
        <div className="flow-rows" style={{ "--flow-row-height": "88px", "--flow-lanes": rows.length, "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as CSSProperties}>
          <svg aria-hidden="true" className="flow-connections" preserveAspectRatio="none" viewBox={`0 0 ${trackWidth} ${rows.length * 88}`}>
            {ticks.map((tick) => <line key={tick.time} className="flow-time-grid" x1={tick.position * trackWidth / 100} x2={tick.position * trackWidth / 100} y1="0" y2={rows.length * 88} />)}<line className="flow-now-line" x1={observationX * trackWidth / 100} x2={observationX * trackWidth / 100} y1="0" y2={rows.length * 88} />
            {rows.map((row, index) => <line key={`guide:${row.id}`} className={`flow-row-guide${row.name === project.default_branch ? " is-default" : ""}`} x1="0" x2={trackWidth} y1={(index + .5) * 88} y2={(index + .5) * 88}><title>{row.name} · ブランチ行のガイド（コミットの親子関係ではありません）</title></line>)}
            {routeLinks.links.map((link, index) => <path key={index} className="flow-lane-line" d={link.path}><title>{link.label}</title></path>)}
            {[...routeLinks.routes]
              .filter((route) => isRoutePresented(route))
              .sort((left, right) => Number(left.id === focusedRouteId) - Number(right.id === focusedRouteId))
              .map((route) => {
                const full = isRouteFullyVisible(route);
                const showPath = full && route.drawn && route.path !== null;
                const showStubs = !full && route.drawn && route.stub;
                const muted = Boolean(hasRowEmphasis && !showAllConnections && route.id !== focusedRouteId && !isRouteActive(route));
                return <g className={`flow-readable-route flow-connection-${route.kind} flow-connection-evidence-${route.evidence}${muted ? " is-muted" : ""}${full ? " is-emphasized" : ""}${showStubs ? " is-stub" : ""}${route.reversed ? " is-reversed" : ""}`} key={route.id}>
                  <title>{route.label}</title>
                  {showPath && <><path className="flow-route-halo" d={route.path ?? undefined} /><path className="flow-route-line" d={route.path ?? undefined} /></>}
                  {showStubs && <><path className="flow-route-stub" d={route.sourceStubPath ?? undefined} /><path className="flow-route-stub" d={route.targetStubPath ?? undefined} /></>}
                  <circle className="flow-route-source" cx={route.x1} cy={route.y1} r="4" />
                  {route.reversed && isRouteContextActive(route) ? <circle className="flow-route-invalid-target" cx={route.x2} cy={route.y2} r="4" /> : route.arrow && (showPath || showStubs) && <path className="flow-route-arrow" d={route.arrow} />}
                  {route.targetAnchor && !route.reversed && <circle className="flow-route-anchor" cx={route.x2} cy={route.y2} r="4" />}
                </g>;
              })}
          </svg>
          <div className="flow-connection-stub-layer" role="group" aria-label="遠いブランチ関係">
            {rows.map((row, index) => {
              const rowChips = connectionChips.filter((chip) => chip.rowId === row.id);
              if (!rowChips.length) return null;
              return <div className="flow-connection-chip-row" key={`chips:${row.id}`} style={{ top: `${index * 88}px` }}>
                {(["source", "target"] as const).map((side) => {
                  const sideChips = rowChips.filter((chip) => chip.side === side);
                  return <div className={`flow-connection-chip-side is-${side}`} key={`${row.id}:${side}`}>
                    {sideChips.map((chip) => {
                      const routeEmphasized = chip.routeIds.some((routeId) => {
                        const route = routeLinks.routes.find((item: TimelineRoute) => item.id === routeId);
                        return route ? route.id === focusedRouteId || isRouteActive(route) : false;
                      });
                      const muted = Boolean(hasRowEmphasis && !showAllConnections && !routeEmphasized);
                      const label = chip.label;
                      const selected = chip.routeIds.includes(focusedRouteId ?? "");
                      return <button
                        aria-label={`${label} · ${chip.type === "aggregate" ? "行の関係を固定" : "接続を選択"}`}
                        aria-pressed={chip.type === "aggregate" ? pinnedRowId === chip.rowId || selected : selected}
                        className={`flow-connection-stub-chip flow-connection-chip-kind-${chip.kind}${muted ? " is-muted" : ""}${selected ? " is-selected" : ""}`}
                        key={chip.id}
                        onClick={() => chip.type === "aggregate" ? setPinnedRowId((current) => current === chip.rowId ? null : chip.rowId) : setFocusedConnection(chip.routeId as string)}
                        title={chip.type === "aggregate" ? `${label} · クリックでこの行の関係を固定` : `${label} · 接続を選択`}
                        type="button"
                      >{label}</button>;
                    })}
                  </div>;
                })}
              </div>;
            })}
          </div>
          {rows.map((row, index) => {
            const laneEvents = eventsByRow.get(row.id) ?? [];
            const [status, statusClass] = rowStatus(row, project.default_branch);
            const defaultRow = isDefaultRow(row, project.default_branch);
            const local = rowLocal(row);
            const visibleCommits = rowCommits.get(row.id) ?? [];
            const rowEvent = visibleCommits[0];
            const tipRefs = tipRefsByRow.get(row.id) ?? [];
            return <article
              aria-labelledby={`flow-row-label-${row.id}`}
              className={`flow-row${defaultRow ? " is-default" : ""}${selectedRowId === row.id ? " is-selected" : ""}${activeRowId === row.id || pinnedRowId === row.id ? " is-connection-active" : ""}`}
              data-flow-row={row.id}
              key={row.id}
              onMouseEnter={() => setActiveRowId(row.id)}
              onMouseLeave={(event) => {
                const focused = typeof document === "undefined" ? null : document.activeElement;
                if (!(focused instanceof Node) || !event.currentTarget.contains(focused)) setActiveRowId((current) => current === row.id ? null : current);
              }}
            >
              <div className="flow-lane-label" title={row.locals.length > 1 ? `ローカルブランチ ${row.locals.length}件` : row.tracking_ref ?? "履歴と親子関係を表示"} ref={index === 0 ? firstLabelRef : undefined}><div className="flow-lane-title" id={`flow-row-label-${row.id}`}><span className="lane-shape" aria-hidden="true" />{local || rowEvent ? <button className="flow-lane-button" aria-pressed={selectedLane === local?.id || selectedRowId === row.id} type="button" onClick={() => { if (local) onSelectLane(local); else if (rowEvent) onSelect(commitEvent(project, row, rowEvent), row.id); }}>{rowLabel(row)}</button> : <strong className="flow-lane-button">{rowLabel(row)}</strong>}</div><div className="flow-lane-meta"><span className={`lane-state ${statusClass}`}>{status}</span>{defaultRow && <span className="lane-state lane-state-default">既定</span>}<span>{row.locals.length ? `ローカル ${row.locals.length}件` : "リモートのみ"}</span></div><div className="flow-lane-refs" role="group" aria-label="現在のref"><span>現在の先端:</span>{tipRefs.length ? tipRefs.map((ref) => <code key={ref.id} title={ref.hash ?? undefined}>{tipRefLabel(ref)}</code>) : <span>ローカル / リモート ref 未取得</span>}</div><div className="flow-lane-actions">{row.locals.length > 0 && <details className="flow-lane-locals"><summary>ローカル {row.locals.length}件</summary><div>{row.locals.map((lane) => <div key={lane.id}><button type="button" className="flow-lane-button" aria-pressed={selectedLane === lane.id} onClick={() => onSelectLane(lane)}>{lane.branch ?? lane.name}</button>{lane.path && <button type="button" className="subtle-button" onClick={() => onOpenGit(lane)}>Git詳細</button>}</div>)}</div></details>}{range !== "current" && history[row.id]?.offset !== null && <button className="flow-history-more" type="button" onClick={() => loadMore(row)} disabled={history[row.id]?.loading}>{history[row.id]?.loading ? "履歴を取得中…" : "さらに履歴"}</button>}{history[row.id]?.error && <span className="flow-history-note" role="alert">履歴取得失敗</span>}</div></div>
              <div className="flow-track">{laneEvents.length === 0 && <span className="flow-track-empty">{history[row.id]?.loading ? "履歴を取得中…" : row.history_available ? "この表示範囲にコミットなし" : "履歴未取得"}</span>}{laneEvents.map((event) => denseEventMode ? <FlowDenseEventButton event={event} key={event.id} onClosePreview={closeDensePreview} onNavigate={navigate} onPreview={keepDensePreview} onRegister={register} onSelect={eventSelect} popoverBelow={index < 2} preview={previewId === event.id} selected={selectedRowId === event.lane.id && selectedKey === event.row.hash} trackWidth={trackWidth} /> : <FlowEventButton event={event} key={event.id} onPreview={setPreviewId} onRegister={register} onNavigate={navigate} onSelect={eventSelect} popoverBelow={index < 2} preview={previewId === event.id} selected={selectedRowId === event.lane.id && selectedKey === event.row.hash} trackWidth={trackWidth} />)}{laneEvents.length > 0 && <div className="flow-latest-visible"><span className="flow-latest-caption">最新</span><span title={laneEvents[laneEvents.length - 1].row.subject}>{laneEvents[laneEvents.length - 1].row.subject}</span><time dateTime={laneEvents[laneEvents.length - 1].row.date ?? undefined}>{exactDate(laneEvents[laneEvents.length - 1].row.date)}</time></div>}</div>
            </article>;
          })}
        </div>
      </div>}
      {selection.total > rows.length && <p className="flow-pr-status">更新が新しいブランチを表示中。{hiddenConnectionCount > 0 ? `表示行の外に ${hiddenConnectionCount} 件の関係があります。` : "関係線は表示中の行同士を結びます。"}全関係は下の一覧で確認できます。「すべて」で他の行も表示します。</p>}
      {selection.total <= rows.length && hiddenConnectionCount > 0 && <p className="flow-pr-status">{hiddenConnectionCount} 件の関係は表示行の外にあります。参照を選んだ全関係一覧で確認できます。</p>}
      {hiddenRelationCount > 0 && <p className="flow-pr-status">{showAllConnections ? "すべての関係を表示しています。" : `既定では ${defaultVisibleConnectionCount}/${routeLinks.routes.length} 件の関係を表示しています。行間が遠い関係はスタブです。残りは行にカーソルを合わせる・キーボードで行をフォーカスする・接続を選ぶ、または「すべての線を表示」で確認できます。`}</p>}
      {sameRowConnectionEdges.length > 0 && <details className="flow-help flow-connection-note"><summary>同じブランチ行にある参照間イベント ({sameRowConnectionEdges.length}件)</summary><p>取り込み元と取り込み先が同じ行に重なるため、グラフ上で矢印を分けて描画できません。下の全関係一覧ではローカル・リモートなどの参照 ID を分けて確認できます。</p><ul>{sameRowConnectionEdges.map((edge) => <li key={`same-row:${edge.id}`}>{edgeDisplayLabel(edge, refs)} · {edge.label || "関係イベント"} · {evidenceLabel(edge.evidence)}{edge.operation ? ` · ${operationLabel(edge.operation)}` : ""} · グラフ未描画（同一行）</li>)}</ul></details>}
      <BranchRelations project={project} relationRef={relationRef} selectedLane={selectedLane} selectedRowId={selectedRowId} />
      <div className="flow-legend" role="group" aria-label="フロー凡例"><span><i className="legend-line legend-line-guide" aria-hidden="true" /> ブランチ行（ガイド）</span><span><i className="legend-dot legend-dot-head" aria-hidden="true" /> ブランチ先端（HEAD）</span><span><i className="legend-dot legend-dot-commit" aria-hidden="true" /> コミット</span><span><i className="legend-dot legend-dot-merge" aria-hidden="true" /> マージコミット</span><span><i className="legend-line legend-line-branch" aria-hidden="true" /> 青=分岐</span><span><i className="legend-line legend-line-merge" aria-hidden="true" /> 緑=マージ</span><span><i className="legend-line legend-line-estimate" aria-hidden="true" /> 推定の関係（破線）</span><span className="flow-time-direction">時間 →（直近ほど広く）</span></div>
      {((project.branch_connections?.unresolved.length ?? 0) > 0 || connectionEdges.some((edge) => !hasEdgeEvidence(edge))) && <details className="flow-help"><summary>未解決のブランチ関係 ({(project.branch_connections?.unresolved.length ?? 0) + connectionEdges.filter((edge) => !hasEdgeEvidence(edge)).length})</summary><p role="status">未解決の操作と関係は、上の「ブランチ・参照の全関係と関連履歴」で対象の参照ごとに確認できます。取得できない参照を含む全件表示にも切り替えられます。</p><a href="#branch-relations-title">全関係一覧を開く</a>{connectionEdges.filter((edge) => !hasEdgeEvidence(edge)).map((edge) => <p key={`missing:${edge.id}`} role="status">{edge.label || "関係イベント"} · 接続元または接続先コミットのハッシュ・日時の証拠が未取得のため、線を描画できません。</p>)}</details>}
      <details className="flow-help"><summary>グラフの見方・キーボード操作</summary><p>ブランチ名で作業詳細、点でコミット詳細を開きます。時間は左から右へ進み、直近ほど広く表示します。左右キーで同じ行のコミット、上下キーで別の行へ移動し、Enterで詳細を開きます。</p><p>薄い横線はブランチ行のガイドです。コミット間の線は実際の親子関係を表します。関係線は分岐を青、マージを緑で表示し、操作の記録は実線、推定は破線です。接続元は白抜きの丸、接続先は塗りつぶした矢印です。関係線は時間を逆走しないS字で描き、時刻が逆転した関係は線を描かず端点と理由を表示します。行間が遠い関係は短いスタブと相手名のチップで示し、チップまたは上の選択欄から1本ずつ確認できます。複数のチップは行上部で集約され、集約チップを押すとその行を固定できます。</p></details>
      <div className="branch-row-notes" role="status">
        {project.branch_rows === null && <span>ブランチ行の取得に失敗しました。再走査してから再試行してください。</span>}
        {project.branch_connections?.status === "unavailable" && <span>ブランチ関係情報を取得できませんでした。</span>}
        {project.branch_connections?.status === "partial" && <span>ブランチ関係情報は一部のみ取得されています。未解決の関係を確認してください。</span>}
        <span>Git最終成功fetch: {project.fetched_at === null ? "未取得" : exactDate(new Date(project.fetched_at * 1000).toISOString())}</span>
        {project.github.status === "available" && <span>PR情報: GitHubから取得済み · {exactDate(project.github.checked_at === null ? null : new Date(project.github.checked_at * 1000).toISOString())}</span>}
        {project.github.status === "unavailable" && <span>PR情報は取得できませんでした。{project.github.reason ?? "GitHubの認証または接続を確認してください。"}</span>}
      </div>
    </section>
  );
}
