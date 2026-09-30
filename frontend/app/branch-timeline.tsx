"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MutableRefObject, SetStateAction } from "react";
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
  if (row.remote_ref === `origin/${defaultBranch}`) return ["既定", "lane-state-ok"];
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

type LoadedHistory = { commits: ProjectBranchCommit[]; offset: number | null; loading: boolean; error: string | null };

function edgeCommit(edge: ProjectBranchConnectionEdge & { source_commit?: ProjectBranchCommit | null; target_commit?: ProjectBranchCommit | null }, side: "source" | "target") {
  return side === "source" ? edge.source_commit ?? null : edge.target_commit ?? null;
}

function hasEdgeEvidence(edge: ProjectBranchConnectionEdge & { source_commit_hash?: string | null; target_commit_hash?: string | null; source_commit?: ProjectBranchCommit | null; target_commit?: ProjectBranchCommit | null }) {
  return Boolean(edge.source_commit_hash && edge.target_commit_hash && edge.source_commit?.date && edge.target_commit?.date && Number.isFinite(Date.parse(edge.source_commit.date)) && Number.isFinite(Date.parse(edge.target_commit.date)));
}

export default function BranchTimeline({
  project,
  range,
  timeline,
  selectedKey,
  selectedRowId,
  selectedLane,
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
  showMerged: boolean;
  onTimelineChange: (value: number) => void;
  onRangeChange: (range: TimeRange) => void;
  onShowMergedChange: (value: boolean) => void;
  onOpenGit: (lane: ProjectLane) => void;
  onSelect: (event: ProjectEvent, branchRowId?: string) => void;
  onSelectLane: (lane: ProjectLane) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(timeline < 100);
  const [history, setHistory] = useState<Record<string, LoadedHistory>>({});
  const historyRequestKeys = useRef(new Map<string, string>());
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const eventButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [navigationRow, setNavigationRow] = useState("");
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0);
  const [renderedLabelWidth, setRenderedLabelWidth] = useState(260);
  const firstLabelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (timeline < 100) setHistoryOpen(true); }, [timeline]);
  const rows = useMemo(() => (project.branch_rows ?? []).filter((row) => showMerged || !row.historical), [project.branch_rows, showMerged]);
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
      setRenderedLabelWidth(Math.round(width));
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
  const connectionEdges = (project.branch_connections?.edges ?? []) as (ProjectBranchConnectionEdge & { source_commit_hash?: string | null; target_commit_hash?: string | null; source_commit?: ProjectBranchCommit | null; target_commit?: ProjectBranchCommit | null })[];
  const rangeCutoff = range === "24h" ? now - 86400000 : range === "7d" ? now - 604800000 : null;
  const allTimes = rows.flatMap((row) => rowCommits.get(row.id) ?? []).map(eventDate).filter((value): value is number => value !== null);
  const relationTimes = range === "current" ? [] : connectionEdges.flatMap((edge) => {
    const date = edge.target_commit?.date ? Date.parse(edge.target_commit.date) : NaN;
    return Number.isFinite(date) && date <= now && (rangeCutoff === null || date >= rangeCutoff) ? [date] : [];
  });
  const minTime = Math.min(now - 1, ...(allTimes.length || relationTimes.length ? [...allTimes, ...relationTimes] : [now]));
  const observationTime = minTime + ((now - minTime) * timeline) / 100;
  const positioned = rows.flatMap((row) => (rowCommits.get(row.id) ?? []).flatMap((commit) => {
    const time = eventDate(commit);
    if (time === null || time > observationTime) return [];
    return [{ row: { ...commit, is_head: row.tip_commits.some((tip) => tip.hash === commit.hash), is_merge: commit.parents.length > 1 }, lane: row, x: recentTimePosition(time, minTime, now), hitX: 0, timestampX: 0, pointOffset: 0, id: flowEventKey(row.id, commit.hash) }];
  }));
  const minimumTrackWidth = Math.max(440, ...rows.map((row) => Math.max(1, positioned.filter((event) => event.lane.id === row.id).length) * 44));
  const trackWidth = Math.max(minimumTrackWidth, availableTrackWidth);
  const events = rows.flatMap((row) => layoutFlowEvents(positioned.filter((event) => event.lane.id === row.id), trackWidth));
  const eventsByRow = new Map<string, TimelineEvent[]>();
  events.forEach((event) => eventsByRow.set(event.lane.id, [...(eventsByRow.get(event.lane.id) ?? []), event]));
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
    target && eventButtonRefs.current.get(target.id)?.focus();
  }, [eventsByRow, rows]);
  const eventSelect = useCallback((event: TimelineEvent) => onSelect(commitEvent(project, event.lane, event.row), event.lane.id), [onSelect, project]);
  const routeLinks = useMemo(() => {
    const byRow = new Map(rows.map((row) => [row.id, row]));
    const byHash = new Map<string, TimelineEvent>();
    events.forEach((event) => byHash.set(`${event.lane.id}:${event.row.hash}`, event));
    const links: { kind: "commit" | "merge" | "branch"; path: string; arrow: string | null; outside: boolean; label: string }[] = [];
    rows.forEach((row, rowIndex) => {
      const own = eventsByRow.get(row.id) ?? [];
      const ownByHash = new Map(own.map((event) => [event.row.hash, event]));
      own.forEach((child) => child.row.parents.forEach((parent) => {
        const parentEvent = ownByHash.get(parent);
        if (!parentEvent) return;
        const x1 = parentEvent.x * trackWidth / 100;
        const x2 = child.x * trackWidth / 100;
        const y = (rowIndex + 0.5) * 88;
        links.push({ kind: "commit", path: `M ${x1} ${y} H ${x2}`, arrow: null, outside: false, label: `${shortHash(parent)} → ${shortHash(child.row.hash)}` });
      }));
    });
    connectionEdges.forEach((edge) => {
      if (!hasEdgeEvidence(edge)) return;
      const sourceRow = byRow.get(edge.source_row_id);
      const targetRow = byRow.get(edge.target_row_id);
      if (!sourceRow || !targetRow || sourceRow.id === targetRow.id) return;
      const sourceHash = edge.source_commit_hash ?? edgeCommit(edge, "source")?.hash ?? null;
      const targetHash = edge.target_commit_hash ?? edgeCommit(edge, "target")?.hash ?? null;
      if (!sourceHash || !targetHash) return;
      const sourceEvent = byHash.get(`${sourceRow.id}:${sourceHash}`);
      const targetEvent = byHash.get(`${targetRow.id}:${targetHash}`);
      const sourceDate = Date.parse(edge.source_commit!.date!);
      const targetDate = Date.parse(edge.target_commit!.date!);
      if (!Number.isFinite(sourceDate) || !Number.isFinite(targetDate) || sourceDate > observationTime || targetDate > observationTime) return;
      if (range === "current" && targetDate < minTime) return;
      if (rangeCutoff !== null && targetDate < rangeCutoff) return;
      const sourceX = sourceEvent?.x ?? recentTimePosition(sourceDate, minTime, now);
      const targetX = targetEvent?.x ?? recentTimePosition(targetDate, minTime, now);
      const sourceIndex = rows.findIndex((row) => row.id === sourceRow.id);
      const targetIndex = rows.findIndex((row) => row.id === targetRow.id);
      const x1 = sourceX * trackWidth / 100;
      const x2 = targetX * trackWidth / 100;
      const y1 = (sourceIndex + 0.5) * 88;
      const y2 = (targetIndex + 0.5) * 88;
      const channel = (x1 + x2) / 2;
      const outside = sourceDate < minTime || sourceDate > now || targetDate < minTime || targetDate > now;
      const kind = edge.kind === "merge" ? "merge" : "branch";
      const direction = Math.sign(y2 - y1);
      const horizontalDirection = Math.sign(x2 - channel);
      const arrow = Math.abs(x2 - channel) > 1
        ? `M ${x2 - horizontalDirection * 6} ${y2 - 4} L ${x2} ${y2} L ${x2 - horizontalDirection * 6} ${y2 + 4}`
        : `M ${x2 - 4} ${y2 - direction * 6} L ${x2} ${y2} L ${x2 + 4} ${y2 - direction * 6}`;
      links.push({ kind, path: `M ${x1} ${y1} H ${channel} V ${y2} H ${x2}`, arrow, outside, label: edge.label });
    });
    return links;
  }, [connectionEdges, events, eventsByRow, minTime, now, observationTime, range, rangeCutoff, rows, trackWidth]);
  const mergedCount = (project.branch_rows ?? []).filter((row) => row.historical).length;
  const observationX = recentTimePosition(observationTime, minTime, now);
  return (
    <section className="flow-section" aria-labelledby="flow-map-title">
      <div className="flow-controls">
        <div className="flow-heading"><div><h3 id="flow-map-title">ブランチの分岐と合流</h3><p>ブランチを選ぶと作業の詳細、点を選ぶとコミットの詳細を開けます。</p></div><span className="flow-direction">過去を圧縮 → 直近を詳しく</span></div>
        <div className="flow-toolbar">
          <div className="range-tabs" role="group" aria-label="表示するコミット"><span className="flow-control-label">表示範囲</span>{ranges.map((item) => <button aria-pressed={range === item.id} className="range-tab" key={item.id} type="button" onClick={() => onRangeChange(item.id)}>{item.label}</button>)}</div>
          <div className="flow-control-actions"><label className="flow-branch-jump"><span>ブランチへ移動</span><select aria-label="グラフのブランチへ移動" value={rows.some((row) => row.id === navigationRow) ? navigationRow : ""} onChange={(event) => { setNavigationRow(event.target.value); document.querySelector(`[data-flow-row="${CSS.escape(event.target.value)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}><option value="">ブランチを選択</option>{rows.map((row) => <option key={row.id} value={row.id}>{rowLabel(row)}</option>)}</select></label>{mergedCount > 0 && <button aria-pressed={showMerged} className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "完了ブランチを折り畳む" : `完了ブランチを表示 (${mergedCount})`}</button>}<button className="subtle-button" type="button" onClick={() => flowScrollRef.current?.scrollTo({ left: flowScrollRef.current.scrollWidth, behavior: "smooth" })}>右端へ移動 →</button></div>
        </div>
      </div>
      <details className="flow-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}><summary>履歴をたどる <span>{timeline === 100 ? "最新の観測" : "過去を表示中"} · {exactDate(new Date(observationTime).toISOString())}</span></summary><div className="flow-observation"><label className="timeline-control"><span>表示時点</span><input aria-label="過去の観測時点" max="100" min="0" onChange={(event) => onTimelineChange(100 * (recentTimeAt(Number(event.target.value), minTime, now) - minTime) / (now - minTime))} step="1" type="range" value={observationX} /><output>{timeline === 100 ? "最新の観測" : "選択日時"} · {exactDate(new Date(observationTime).toISOString())}</output></label><button className="subtle-button" disabled={timeline === 100} type="button" onClick={() => onTimelineChange(100)}>最新に戻る</button></div></details>
      {timeline < 100 && <p className="flow-history-note" role="status">選択日時までのコミット・合流・ブランチ作業履歴を表示中。ブランチ名とGit作業状態は現在の情報です。</p>}
      {rows.length === 0 ? <div className="empty-flow">{project.branch_rows === null ? "ブランチ行の取得に失敗しました。" : "表示できるブランチはありません。完了ブランチが折り畳まれている場合は表示を切り替えてください。"}</div> : <div className="flow-scroll" role="region" aria-label="Gitフローマップ（横スクロール可能）" ref={flowScrollRef} style={{ "--flow-popover-space": previewId ? "360px" : "0px" } as CSSProperties} tabIndex={0}>
        <div className="flow-axis" aria-hidden="true" style={{ "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as CSSProperties}><span>ブランチ / 現在の作業状態</span><div className="flow-axis-track">{ticks.map((tick) => <span className={`flow-time-tick${tick.edge ? ` is-${tick.edge}` : ""}`} key={tick.time} style={{ left: `${tick.position}%` }}><span className="flow-tick-date">{tick.dateLabel}</span><span>{tick.timeLabel}</span></span>)}</div></div>
        <div className="flow-rows" style={{ "--flow-row-height": "88px", "--flow-lanes": rows.length, "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as CSSProperties}>
          <svg aria-hidden="true" className="flow-connections" preserveAspectRatio="none" viewBox={`0 0 ${trackWidth} ${rows.length * 88}`}>
            {ticks.map((tick) => <line key={tick.time} className="flow-time-grid" x1={tick.position * trackWidth / 100} x2={tick.position * trackWidth / 100} y1="0" y2={rows.length * 88} />)}<line className="flow-now-line" x1={observationX * trackWidth / 100} x2={observationX * trackWidth / 100} y1="0" y2={rows.length * 88} />
            {routeLinks.map((link, index) => <g className={`flow-merge-route flow-connection-${link.kind}${link.outside ? " is-outside" : ""}`} key={`${link.label}:${index}`}><title>{link.label}</title><path className={`${link.kind === "branch" ? "flow-branch-link" : link.kind === "merge" ? "flow-merge-link" : "flow-lane-line"}${link.outside ? " flow-merge-link-outside" : ""}`} d={link.path} />{link.arrow && <path className={link.kind === "branch" ? "flow-branch-direction" : "flow-merge-direction"} d={link.arrow} />}</g>)}
          </svg>
          {rows.map((row, index) => {
            const laneEvents = eventsByRow.get(row.id) ?? [];
            const [status, statusClass] = rowStatus(row, project.default_branch);
            const local = rowLocal(row);
            const visibleCommits = rowCommits.get(row.id) ?? [];
            const rowEvent = visibleCommits[0];
            return <div className={`flow-row${row.remote_ref === `origin/${project.default_branch}` ? " is-default" : ""}${selectedRowId === row.id ? " is-selected" : ""}`} data-flow-row={row.id} key={row.id}>
              <div className="flow-lane-label" title={row.locals.length > 1 ? `${row.locals.length} local branches` : row.tracking_ref ?? "履歴と親子関係を表示"} ref={index === 0 ? firstLabelRef : undefined}><div className="flow-lane-title"><span className="lane-shape" aria-hidden="true" />{local || rowEvent ? <button className="flow-lane-button" aria-pressed={selectedLane === local?.id || selectedRowId === row.id} type="button" onClick={() => { if (local) onSelectLane(local); else if (rowEvent) onSelect(commitEvent(project, row, rowEvent), row.id); }}>{rowLabel(row)}</button> : <strong className="flow-lane-button">{rowLabel(row)}</strong>}</div><div className="flow-lane-meta"><span className={`lane-state ${statusClass}`}>{status}</span><span>{row.locals.length ? `${row.locals.length} local` : "remote only"}</span></div><div className="flow-lane-actions">{row.locals.length > 0 && <details className="flow-lane-locals"><summary>ローカル {row.locals.length}件</summary><div>{row.locals.map((lane) => <div key={lane.id}><button type="button" className="flow-lane-button" aria-pressed={selectedLane === lane.id} onClick={() => onSelectLane(lane)}>{lane.branch ?? lane.name}</button>{lane.path && <button type="button" className="subtle-button" onClick={() => onOpenGit(lane)}>Git詳細</button>}</div>)}</div></details>}{range !== "current" && history[row.id]?.offset !== null && <button className="flow-history-more" type="button" onClick={() => loadMore(row)} disabled={history[row.id]?.loading}>{history[row.id]?.loading ? "履歴を取得中…" : "さらに履歴"}</button>}{history[row.id]?.error && <span className="flow-history-note" role="alert">履歴取得失敗</span>}</div></div>
              <div className="flow-track">{laneEvents.length === 0 && <span className="flow-track-empty">{history[row.id]?.loading ? "履歴を取得中…" : row.history_available ? "この表示範囲にコミットなし" : "履歴未取得"}</span>}{laneEvents.map((event) => <FlowEventButton event={event} key={event.id} onPreview={setPreviewId} onRegister={register} onNavigate={navigate} onSelect={eventSelect} popoverBelow={index < 2} preview={previewId === event.id} selected={selectedRowId === event.lane.id && selectedKey === event.row.hash} trackWidth={trackWidth} />)}{laneEvents.length > 0 && <div className="flow-latest-visible"><span className="flow-latest-caption">最新</span><span title={laneEvents[laneEvents.length - 1].row.subject}>{laneEvents[laneEvents.length - 1].row.subject}</span><time dateTime={laneEvents[laneEvents.length - 1].row.date ?? undefined}>{exactDate(laneEvents[laneEvents.length - 1].row.date)}</time></div>}</div>
            </div>;
          })}
          <div className="flow-current-label" style={{ left: `${renderedLabelWidth + observationX * trackWidth / 100}px` }} aria-hidden="true">{timeline === 100 ? "最新の観測" : "選択日時"}</div>
        </div>
      </div>}
      <div className="flow-legend" aria-label="フロー凡例"><span><i className="legend-dot legend-dot-head" aria-hidden="true" /> ブランチ先端（HEAD）</span><span><i className="legend-dot legend-dot-commit" aria-hidden="true" /> コミット</span><span><i className="legend-dot legend-dot-merge" aria-hidden="true" /> マージ</span><span><i className="legend-line legend-line-branch" aria-hidden="true" /> 作業経路</span><span><i className="legend-line legend-line-merge" aria-hidden="true" /> 合流元 → 合流先</span><span className="flow-time-direction">時間 →（直近ほど広く）</span></div>
      {((project.branch_connections?.unresolved.length ?? 0) > 0 || connectionEdges.some((edge) => !hasEdgeEvidence(edge))) && <details className="flow-help"><summary>未解決のブランチ関係 ({(project.branch_connections?.unresolved.length ?? 0) + connectionEdges.filter((edge) => !hasEdgeEvidence(edge)).length})</summary>{project.branch_connections?.unresolved.map((item) => <p key={item.id} role="status">{item.source} → {item.target} · {item.reason}</p>)}{connectionEdges.filter((edge) => !hasEdgeEvidence(edge)).map((edge) => <p key={`missing:${edge.id}`} role="status">{edge.label} · 接続元または接続先コミットのハッシュ・日時の証拠が未取得のため、線を描画できません。</p>)}</details>}
      <details className="flow-help"><summary>グラフの見方・キーボード操作</summary><p>ブランチ名で作業詳細、点でコミット詳細を開きます。時間は左から右へ進み、直近ほど広く表示します。左右キーで同じ行のコミット、上下キーで別の行へ移動し、Enterで詳細を開きます。</p><p>線は実際のコミットの親子関係です。紫の線はPRマージ、緑の破線は共通祖先からの分岐推定です。破線は接続元が表示範囲外の関係を含みます。</p></details>
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
