"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RepoDetail, { type DetailTab } from "./repo-detail";
import { agentSnapshotAt, agentStateLabel, agentTaskState, laneAgentSnapshotAt, mergeAgentSnapshot } from "./agent-overview.mjs";
import { ancestryRows, eventLeaderGeometry, flowEventKey, flowKeyboardAction, flowPopoverPlacement, layoutFlowEvents, mergeBasePosition, mergeRelationInWindow, mergeRelationLinks, mergeRelationTimes, mobileEventAction, parseProjectUrl, shouldFoldMergedLane, updateProjectUrl } from "./project-flow.mjs";
import { useRepoStream } from "./repo-stream";
import type {
  CommitDetail,
  GraphRow,
  ProjectEvent,
  ProjectLane,
  ProjectMergeRelation,
  ProjectResponse,
  Repo,
  AgentTask,
} from "./types";

type ControlTab = "flow" | "lanes" | "activity" | "info";
type TimeRange = "current" | "24h" | "7d" | "all";
type ActivityFilter = "all" | "commit" | "edit" | "test" | "review" | "input";
type LoadState = "idle" | "loading" | "ready" | "error";
type ProjectUrlChanges = Record<string, string | number | boolean | null | undefined>;

const tabs: { id: ControlTab; label: string; short: string }[] = [
  { id: "flow", label: "グラフ", short: "FLOW" },
  { id: "lanes", label: "作業一覧", short: "LANES" },
  { id: "activity", label: "アクティビティ", short: "ACTIVITY" },
  { id: "info", label: "プロジェクト情報", short: "INFO" },
];

const ranges: { id: TimeRange; label: string }[] = [
  { id: "current", label: "各ブランチの先端" },
  { id: "24h", label: "24時間" },
  { id: "7d", label: "7日" },
  { id: "all", label: "取得済み履歴" },
];

const activityFilters: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "commit", label: "コミット" },
  { id: "edit", label: "編集" },
  { id: "test", label: "テスト" },
  { id: "review", label: "レビュー" },
  { id: "input", label: "入力待ち" },
];

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) return "未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間前`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}日前`;
  return `${Math.floor(seconds / 2_592_000)}ヶ月前`;
}

function exactDate(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}

function shortHash(hash: string | null | undefined) {
  return hash ? hash.slice(0, 8) : "未取得";
}

function laneLabel(lane: ProjectLane) {
  return lane.branch || "detached HEAD";
}

function laneMergeSummary(lane: ProjectLane) {
  const outgoing = lane.merge_sources.map((relation) => `→ ${relation.target_branch ?? "不明"}`);
  const incoming = lane.merge_targets.map((relation) => `${relation.source_branch ?? "不明"} →`);
  return [...outgoing, ...incoming].join(" / ") || "合流関係なし / 不明";
}

function laneState(lane: ProjectLane, defaultBranch: string | null = null) {
  if (lane.conflict === true) return "conflict";
  if (lane.dirty === true) return "変更あり";
  if (lane.worktree_state === "prunable") return "prunable";
  if (lane.worktree_state === "locked") return "locked";
  if (defaultBranch && lane.branch === defaultBranch) return "既定";
  if (lane.merged === true) return "merged";
  if (lane.detached === true) return "detached";
  if (lane.error) return "Git情報未取得";
  return "clean";
}

function laneStateClass(lane: ProjectLane, defaultBranch: string | null = null) {
  if (lane.conflict === true) return "lane-state-danger";
  if (lane.dirty === true || lane.worktree_state === "prunable" || lane.worktree_state === "locked")
    return "lane-state-warn";
  if (defaultBranch && lane.branch === defaultBranch) return "lane-state-ok";
  if (lane.merged === true) return "lane-state-muted";
  return "lane-state-ok";
}

function isFoldedMerged(lane: ProjectLane) {
  // A branch tip can be reachable from HEAD while its linked worktree still
  // contains uncommitted/conflicting Git facts. Prunable worktrees are the
  // exception: Git has explicitly reported that their checkout is gone, so
  // they belong in the completed/default folded group even if is_worktree is
  // still true in the stale snapshot.
  return shouldFoldMergedLane(lane);
}

function currentLaneAgent(lane: ProjectLane) {
  return lane.agent;
}

function upstreamLabel(lane: ProjectLane) {
  if (!lane.upstream) return "upstream 未取得";
  if (lane.upstream_ahead === null || lane.upstream_behind === null) {
    return `upstream ${lane.upstream} · push 状態未取得`;
  }
  const pushState = lane.upstream_ahead > 0 ? `未push ${lane.upstream_ahead}` : "push済み";
  return `upstream ${lane.upstream} · ${pushState} · behind ${lane.upstream_behind}`;
}

function agentElapsed(occurredAt: string | null | undefined) {
  if (!occurredAt) return "経過時間 未取得";
  const time = new Date(occurredAt).getTime();
  if (Number.isNaN(time)) return "経過時間 未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "経過 1分未満";
  if (seconds < 3600) return `経過 ${Math.floor(seconds / 60)}分`;
  if (seconds < 86400) return `経過 ${Math.floor(seconds / 3600)}時間`;
  return `経過 ${Math.floor(seconds / 86400)}日`;
}

function AgentFact({ task }: { task: AgentTask | null | undefined }) {
  if (!task) return <span className="agent-unknown">agent 状態不明</span>;
  return (
    <span className="agent-fact">
      <strong>{agentStateLabel(agentTaskState(task))}</strong>
      <span>{task.agent_id || task.task_id || "担当未取得"}</span>
      <span>{task.phase || "工程未取得"}</span>
      <span>{task.summary || "報告内容なし"}</span>
      <time dateTime={task.occurred_at ?? undefined}>{agentElapsed(task.occurred_at)}</time>
      {task.attention && <em>{task.attention}</em>}
    </span>
  );
}

function valueOrUnknown(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "未取得" : String(value);
}

function agentCount(project: ProjectResponse, key: keyof ProjectResponse["agent_priority_counts"]) {
  const value = project.agent_priority_counts?.[key];
  return value === null || value === undefined ? "?" : value;
}

function projectFromUrl() {
  return projectFromSearch(typeof window === "undefined" ? "" : window.location.search);
}

function projectFromSearch(search: string) {
  const parsed = parseProjectUrl(search);
  return {
    path: parsed.path,
    tab: parsed.tab as ControlTab,
    range: parsed.range as TimeRange,
    merged: parsed.merged,
    event: parsed.event,
    lane: parsed.lane,
    at: parsed.at,
  };
}

function useProjectUrl() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [state, setState] = useState(projectFromUrl);
  useEffect(() => {
    const sync = () => setState(projectFromUrl());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    // Next's soft navigation updates searchParams without dispatching a
    // browser popstate event.  Subscribe to the router-owned URL as well as
    // the native history event so a Link always supplies its path on mount.
    setState(projectFromSearch(search));
  }, [search]);
  const update = useCallback((changes: ProjectUrlChanges) => {
    const nextHref = updateProjectUrl(window.location.href, changes);
    // Keep tab/range/selection navigable with browser back/forward. Slider
    // drags are the high-frequency exception and replace only the observation
    // point until the user chooses another URL-level control.
    const replace = Object.keys(changes).length === 1 && Object.prototype.hasOwnProperty.call(changes, "at");
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextHref);
    setState(projectFromSearch(new URL(nextHref, window.location.origin).search));
  }, []);
  return { state, update };
}

type FlowEvent = {
  row: GraphRow;
  lane: ProjectLane;
  x: number;
  hitX: number;
  timestampX: number;
  pointOffset: number;
  id: string;
};

function eventDate(row: GraphRow) {
  const value = new Date(row.date).getTime();
  return Number.isNaN(value) ? null : value;
}

function eventsByLaneCount(events: { lane: ProjectLane }[], laneId: string) {
  return events.reduce((count, event) => count + (event.lane.id === laneId ? 1 : 0), 0);
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
  buttonRef: React.MutableRefObject<HTMLButtonElement | null>;
  event: FlowEvent;
  onPreviewEnter: () => void;
  onPreviewLeave: () => void;
  onSelect: () => void;
  popoverBelow: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof flowPopoverPlacement> | null>(null);
  const updatePlacement = useCallback(() => {
    if (typeof window === "undefined") return;
    const button = buttonRef.current;
    const popover = popoverRef.current;
    if (!button || !popover) return;
    const anchor = button.getBoundingClientRect();
    const next = flowPopoverPlacement({
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredWidth: popover.offsetWidth,
      preferredHeight: popover.offsetHeight,
      margin: 8,
      gap: 12,
      preferBelow: popoverBelow,
    });
    setPlacement((current) => current
      && current.left === next.left
      && current.top === next.top
      && current.width === next.width
      && current.height === next.height
      && current.side === next.side
      ? current
      : next);
  }, [buttonRef, popoverBelow]);
  useLayoutEffect(() => {
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [buttonRef, updatePlacement]);
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
      style={{
        "--flow-popover-width": `${width}px`,
        left: `${placement?.left ?? 0}px`,
        maxHeight: placement ? `${placement.height}px` : undefined,
        top: `${placement?.top ?? 0}px`,
        visibility: placement ? "visible" : "hidden",
        width: `${width}px`,
      } as React.CSSProperties}
    >
      <span className="flow-popover-type">Git · コミット</span>
      <strong>{event.row.subject || "(no subject)"}</strong>
      <span>{shortHash(event.row.hash)} · {event.row.author}</span>
      <time dateTime={event.row.date}>{relativeTime(event.row.date)} · {exactDate(event.row.date)}</time>
      <span>
        変更 {event.row.stats ? `${event.row.stats.files} ファイル · +${event.row.stats.additions ?? "?"} / -${event.row.stats.deletions ?? "?"}` : "未取得"}
      </span>
      <span>
        {event.row.stats?.paths.length ? `変更ファイル ${event.row.stats.paths.join(" · ")}` : "変更ファイル 未取得"}
      </span>
      <span>
        branch {event.lane.branch ?? "未取得"} · {event.row.is_head ? "HEAD" : "HEAD ではない"}
      </span>
      <span>
        refs {event.row.refs.length ? event.row.refs.map((ref) => `${ref.kind}:${ref.name}`).join(", ") : "未取得"}
      </span>
      <span>
        {upstreamLabel(event.lane)}
      </span>
      {event.row.is_merge && <span>親 {event.row.parents.length ? event.row.parents.map(shortHash).join(", ") : "未取得"}</span>}
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
  event: FlowEvent;
  selected: boolean;
  preview: boolean;
  popoverBelow: boolean;
  onNavigate: (event: FlowEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => void;
  onRegister: (id: string, node: HTMLButtonElement | null) => void;
  onPreview: React.Dispatch<React.SetStateAction<string | null>>;
  onSelect: (event: FlowEvent) => void;
  trackWidth: number;
}) {
  const touchPreviewRef = useRef(false);
  const touchPointerRef = useRef(false);
  const touchPreviewOpenRef = useRef(false);
  const previewCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const xClass = event.hitX < 24 ? "flow-event-left" : event.hitX > 76 ? "flow-event-right" : "";
  const leader = eventLeaderGeometry(event.timestampX, event.hitX, trackWidth);
  const hasLeader = leader.width > 0.5;
  useEffect(() => () => {
    if (previewCloseTimerRef.current) clearTimeout(previewCloseTimerRef.current);
  }, []);
  const keepPreview = () => {
    if (previewCloseTimerRef.current) clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = null;
    onPreview(event.id);
  };
  const schedulePreviewClose = () => {
    if (touchPreviewOpenRef.current) return;
    if (previewCloseTimerRef.current) clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = setTimeout(() => {
      previewCloseTimerRef.current = null;
      onPreview((current) => current === event.id ? null : current);
    }, 160);
  };
  const select = () => {
    if (previewCloseTimerRef.current) clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = null;
    touchPreviewOpenRef.current = false;
    onPreview(null);
    onSelect(event);
  };
  return (
    <div
      className={`flow-event-hit ${xClass}`}
      data-flow-event-key={event.id}
      style={{ left: `${event.hitX}%`, "--flow-point-offset": `${event.pointOffset}px` } as React.CSSProperties}
      onMouseEnter={keepPreview}
      onMouseLeave={schedulePreviewClose}
    >
      {hasLeader && <span className="flow-event-leader" aria-hidden="true" style={{ left: `calc(50% + ${leader.left}px)`, width: `${leader.width}px` }} />}
      <button
        aria-label={`${laneLabel(event.lane)} ${shortHash(event.row.hash)} ${event.row.subject}`}
        aria-pressed={selected}
        aria-describedby={preview ? flowPopoverId(event.id) : undefined}
        className={`flow-event-button${selected ? " is-selected" : ""}`}
        data-flow-event-key={event.id}
        ref={(node) => {
          buttonRef.current = node;
          onRegister(event.id, node);
        }}
        onPointerDown={(pointerEvent) => {
          if (pointerEvent.pointerType !== "touch") return;
          touchPointerRef.current = true;
          touchPreviewRef.current = preview;
          touchPreviewOpenRef.current = preview;
        }}
        onClick={() => {
          // On a narrow viewport the first tap exposes the same lightweight
          // summary as hover/focus; the popover's explicit action opens the
          // full commit detail drawer.
          const wasTouch = touchPointerRef.current;
          const wasPreview = touchPreviewRef.current;
          touchPointerRef.current = false;
          touchPreviewRef.current = false;
          const action = mobileEventAction({
            isMobile: typeof window !== "undefined" && window.matchMedia("(max-width: 1199px)").matches,
            isTouch: wasTouch,
            previewAtPointerDown: wasPreview,
          });
          if (action === "preview") {
            touchPreviewOpenRef.current = true;
            onPreview(event.id);
            return;
          }
          select();
        }}
        onKeyDown={(keyboardEvent) => {
          const action = flowKeyboardAction(keyboardEvent.key);
          if (action === "move") {
            keyboardEvent.preventDefault();
            onNavigate(event, keyboardEvent.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown");
            return;
          }
          if (action === "select") {
            keyboardEvent.preventDefault();
            select();
          }
        }}
        onFocus={keepPreview}
        onBlur={(focusEvent) => {
          if (touchPreviewOpenRef.current) return;
          const next = focusEvent.relatedTarget;
          const popover = typeof document === "undefined" ? null : document.getElementById(flowPopoverId(event.id));
          if (!(next instanceof Node) || (!focusEvent.currentTarget.parentElement?.contains(next) && !popover?.contains(next))) schedulePreviewClose();
        }}
        type="button"
      >
        <span
          className={`flow-event-point${event.row.is_merge ? " is-merge" : ""}${event.row.is_head ? " is-head" : ""}`}
          aria-hidden="true"
        />
      </button>
      {preview && <FlowEventPopover buttonRef={buttonRef} event={event} onPreviewEnter={keepPreview} onPreviewLeave={schedulePreviewClose} onSelect={select} popoverBelow={popoverBelow} />}
    </div>
  );
}

function FlowMap({
  project,
  range,
  timeline,
  selectedKey,
  onTimelineChange,
  onSelect,
  selectedLane,
  onSelectLane,
  onRangeChange,
  showMerged,
  onShowMergedChange,
}: {
  project: ProjectResponse;
  range: TimeRange;
  timeline: number;
  selectedKey: string | null;
  onTimelineChange: (value: number) => void;
  onSelect: (event: FlowEvent) => void;
  selectedLane: string | null;
  onSelectLane: (lane: ProjectLane) => void;
  onRangeChange: (range: TimeRange) => void;
  showMerged: boolean;
  onShowMergedChange: (value: boolean) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(timeline < 100);
  useEffect(() => {
    if (timeline < 100) setHistoryOpen(true);
  }, [timeline]);
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const firstLaneLabelRef = useRef<HTMLDivElement>(null);
  const eventButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0);
  const [renderedLabelWidth, setRenderedLabelWidth] = useState(220);
  const graphRows = project.graph?.rows ?? [];
  const relationLaneIds = useMemo(() => new Set(project.merge_relations.flatMap((relation) => (
    [relation.source_lane_id, relation.target_lane_id].filter((id): id is string => id !== null)
  ))), [project.merge_relations]);
  const lanes = useMemo(() => {
    const source = project.lanes.filter((lane) => showMerged || relationLaneIds.has(lane.id) || lane.branch === project.default_branch || !isFoldedMerged(lane));
    const defaultBranch = project.default_branch;
    return [...source].sort((a, b) => {
      if (a.branch === defaultBranch && b.branch !== defaultBranch) return -1;
      if (b.branch === defaultBranch && a.branch !== defaultBranch) return 1;
      if (isFoldedMerged(a) !== isFoldedMerged(b)) return isFoldedMerged(a) ? 1 : -1;
      if ((a.conflict === true) !== (b.conflict === true)) return a.conflict === true ? -1 : 1;
      if ((a.dirty === true) !== (b.dirty === true)) return a.dirty === true ? -1 : 1;
      const aDate = a.last_commit?.date ?? "";
      const bDate = b.last_commit?.date ?? "";
      return bDate.localeCompare(aDate);
    });
  }, [project.default_branch, project.lanes, relationLaneIds, showMerged]);

  const laneRows = useMemo(
    () => new Map(lanes.map((lane) => [lane.id, ancestryRows(graphRows, lane.head, lane.merge_base)])),
    [graphRows, lanes],
  );
  const visibleEventHashes = useMemo(
    () => new Set(project.events.filter((event) => event.type === "commit" && event.commit_hash).map((event) => event.commit_hash as string)),
    [project.events],
  );
  const allEvents = useMemo(() => {
    const events: { row: GraphRow; lane: ProjectLane }[] = [];
    for (const lane of lanes) {
      for (const row of laneRows.get(lane.id) ?? []) {
        // The API supplies graph rows needed to draw the merge-base route, but
        // only events inside the requested range receive hover stats/points.
        if (visibleEventHashes.has(row.hash)) events.push({ row, lane });
      }
    }
    return events;
  }, [laneRows, lanes, visibleEventHashes]);
  useEffect(() => {
    const scroll = flowScrollRef.current;
    const label = firstLaneLabelRef.current;
    if (!scroll || !label) return;
    const updateWidth = () => {
      const labelWidth = Math.round(label.getBoundingClientRect().width);
      setRenderedLabelWidth((current) => current === labelWidth ? current : labelWidth);
      const next = Math.max(0, Math.round(scroll.clientWidth - labelWidth));
      setAvailableTrackWidth((current) => current === next ? current : next);
    };
    updateWidth();
    window.addEventListener("resize", updateWidth);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scroll);
    observer.observe(label);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [lanes.length]);
  const allTimes = allEvents.map(({ row }) => eventDate(row)).filter((value): value is number => value !== null);
  const now = project.observed_at * 1000;
  const rangeCutoff = range === "24h" ? now - 86_400_000 : range === "7d" ? now - 604_800_000 : null;
  const rangeEvents = allEvents.filter(({ row, lane }) => {
    if (range === "current") {
      return row.hash === lane.head;
    }
    const value = eventDate(row);
    return value !== null && (rangeCutoff === null || value >= rangeCutoff);
  });
  const rangeTimes = rangeEvents.map(({ row }) => eventDate(row)).filter((value): value is number => value !== null);
  const relationTimes = mergeRelationTimes(project.merge_relations, range, now);
  const displayedTimes = [...rangeTimes, ...relationTimes];
  const minTime = Math.min(...(displayedTimes.length ? displayedTimes : allTimes.length ? allTimes : [now]));
  const maxCandidate = Math.max(now, ...(displayedTimes.length ? displayedTimes : [now]));
  const maxTime = Math.max(minTime + 3_600_000, maxCandidate);
  const observationTime = minTime + ((now - minTime) * timeline) / 100;
  const observationX = ((observationTime - minTime) / (maxTime - minTime)) * 100;
  const observationLabel = exactDate(new Date(observationTime).toISOString());
  const axisLabel = (time: number) => new Date(time).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  // Agent history is resolved against the same observation point as the Git
  // flow. A historical slider value must never show the current task state.
  const observedAgentEvents = useMemo(
    () => agentSnapshotAt(project.agent_events, observationTime),
    [observationTime, project.agent_events],
  );
  const positionedEvents = rangeEvents
    .filter(({ row }) => {
      const value = eventDate(row);
      return value !== null && value <= observationTime;
    })
    .map(({ row, lane }) => ({
      row,
      lane,
      x: Math.min(100, Math.max(0, ((eventDate(row)! - minTime) / (maxTime - minTime)) * 100)),
      hitX: 0,
      pointOffset: 0,
      id: flowEventKey(lane.id, row.hash),
    }));
  const minimumTrackWidth = Math.max(440, ...lanes.map((lane) => (eventsByLaneCount(positionedEvents, lane.id) || 1) * 44));
  // A track grows to the available viewport width when it fits, and becomes
  // horizontally scrollable when 44px hit areas need more room.  The same
  // resolved width is passed to the per-lane layout and rendered as the
  // explicit track width, keeping point/offset/popover geometry aligned.
  const trackWidth = Math.max(minimumTrackWidth, availableTrackWidth);
  const events = lanes.flatMap((lane) => layoutFlowEvents(
    positionedEvents.filter((event) => event.lane.id === lane.id),
    trackWidth,
  ));
  const eventsByLane = new Map<string, FlowEvent[]>();
  for (const event of events) eventsByLane.set(event.lane.id, [...(eventsByLane.get(event.lane.id) ?? []), event]);
  const mergeBasePositions = new Map(lanes.map((lane) => {
    const mergeBaseRow = lane.merge_base ? graphRows.find((row) => row.hash === lane.merge_base) : undefined;
    return [lane.id, {
      ...mergeBasePosition(mergeBaseRow?.date ?? null, minTime, maxTime),
      date: mergeBaseRow?.date ?? null,
      afterObservation: mergeBaseRow !== undefined && eventDate(mergeBaseRow) !== null && eventDate(mergeBaseRow)! > observationTime,
    }];
  }));
  const mergeLinks = mergeRelationLinks(project.merge_relations, lanes, minTime, maxTime, observationTime);
  const visibleMergeKeys = new Set(project.merge_relations
    .filter((relation) => mergeRelationInWindow(relation, minTime, maxTime, observationTime))
    .map((relation) => `${relation.commit_hash}:${relation.source_parent}`));
  const unresolvedMergeCount = project.merge_relations.filter((relation) => (
    mergeRelationInWindow(relation, minTime, maxTime, observationTime)
    && (!relation.source_lane_id || !relation.target_lane_id)
  )).length;
  const registerEventButton = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) eventButtonRefs.current.set(id, node);
    else eventButtonRefs.current.delete(id);
  }, []);
  const navigateEvent = useCallback((current: FlowEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => {
    const laneIndex = lanes.findIndex((lane) => lane.id === current.lane.id);
    if (laneIndex < 0) return;
    // eventsByLane is produced from the ancestry/display path. Preserve that
    // order for equal timestamps and keyboard traversal (parent → child).
    const laneEvents = [...(eventsByLane.get(current.lane.id) ?? [])];
    let target: FlowEvent | undefined;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const currentIndex = laneEvents.findIndex((item) => item.row.hash === current.row.hash);
      const nextIndex = currentIndex + (key === "ArrowLeft" ? -1 : 1);
      target = laneEvents[nextIndex];
    } else {
      const nextLane = lanes[laneIndex + (key === "ArrowUp" ? -1 : 1)];
      const candidates = nextLane ? [...(eventsByLane.get(nextLane.id) ?? [])] : [];
      target = candidates.sort((a, b) => Math.abs(a.x - current.x) - Math.abs(b.x - current.x))[0];
    }
    if (target) {
      const button = eventButtonRefs.current.get(target.id);
      if (!button) return;
      button.focus();
    }
  }, [eventsByLane, lanes]);
  const defaultIndex = lanes.findIndex((lane) => lane.branch === project.default_branch);
  const rowHeight = 88;
  const mergedCount = project.lanes.filter((lane) => lane.branch !== project.default_branch && !relationLaneIds.has(lane.id) && isFoldedMerged(lane)).length;

  return (
    <section className="flow-section" aria-labelledby="flow-map-title">
      <div className="flow-controls">
        <div className="flow-heading"><div><h3 id="flow-map-title">ブランチの分岐と合流</h3><p>ブランチ名で作業詳細、点でコミット詳細を開きます。</p></div><span className="flow-direction">過去 → 現在</span></div>
        <div className="flow-toolbar">
          <div className="range-tabs" role="group" aria-label="表示するコミット">
            <span className="flow-control-label">表示範囲</span>
            {ranges.map((item) => <button aria-pressed={range === item.id} className="range-tab" key={item.id} type="button" onClick={() => onRangeChange(item.id)}>{item.label}</button>)}
          </div>
          <div className="flow-control-actions">
            {mergedCount > 0 && <button aria-pressed={showMerged} className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "完了ブランチを折り畳む" : `完了ブランチを表示 (${mergedCount})`}</button>}
            <button className="subtle-button" type="button" onClick={() => flowScrollRef.current?.scrollTo({ left: flowScrollRef.current.scrollWidth, behavior: "smooth" })}>右端へ移動 →</button>
          </div>
        </div>
      </div>
      <details className="flow-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>履歴をたどる <span>{timeline === 100 ? "最新の観測" : "過去を表示中"} · {observationLabel}</span></summary>
        <div className="flow-observation">
          <label className="timeline-control">
            <span>表示時点</span>
            <input aria-label="過去の観測時点" aria-valuetext={observationLabel} max="100" min="0" onChange={(event) => onTimelineChange(Number(event.target.value))} step="1" type="range" value={timeline} />
            <output>{timeline === 100 ? "最新の観測" : "選択日時"} · {observationLabel}</output>
          </label>
          <button className="subtle-button" disabled={timeline === 100} type="button" onClick={() => onTimelineChange(100)}>最新に戻る</button>
        </div>
      </details>
      {timeline < 100 && <p className="flow-history-note" role="status">選択日時までのコミット・合流・agent履歴を表示中。ブランチ名とGit作業状態、作業詳細は現在の情報です。</p>}
      {lanes.length === 0 ? (
        <div className="empty-flow">表示できるブランチはありません。完了ブランチが折り畳まれている場合は表示を切り替えてください。</div>
      ) : (
        <div
          className="flow-scroll"
          role="region"
          aria-label="Gitフローマップ（横スクロール可能）"
          ref={flowScrollRef}
          style={{ "--flow-popover-space": previewId ? "360px" : "0px" } as React.CSSProperties}
          tabIndex={0}
        >
          <div className="flow-axis" aria-hidden="true" style={{ "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as React.CSSProperties}>
            <span>ブランチ / 現在の作業状態</span>
            <div className="flow-axis-track">
              <span>{axisLabel(minTime)}</span>
              <span>{axisLabel(minTime + (maxTime - minTime) / 2)}</span>
              <span>{axisLabel(maxTime)}</span>
            </div>
          </div>
          <div className="flow-rows" style={{ "--flow-row-height": `${rowHeight}px`, "--flow-lanes": lanes.length, "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as React.CSSProperties}>
          <svg
            aria-hidden="true"
            className="flow-connections"
            preserveAspectRatio="none"
            viewBox={`0 0 1000 ${lanes.length * rowHeight}`}
          >
            <defs>
              <marker id="flow-merge-arrow" markerHeight="6" markerWidth="7" orient="auto" refX="6" refY="3" viewBox="0 0 7 6">
                <path className="flow-merge-arrow" d="M 0 0 L 7 3 L 0 6 z" />
              </marker>
            </defs>
            <line className="flow-now-line" x1={observationX * 10} x2={observationX * 10} y1="0" y2={lanes.length * rowHeight} />
            {lanes.map((lane, index) => {
              const laneEvents = eventsByLane.get(lane.id) ?? [];
              const last = laneEvents.at(-1);
              const baseline = defaultIndex >= 0 ? defaultIndex * rowHeight + rowHeight / 2 : null;
              const y = index * rowHeight + rowHeight / 2;
              const mergeBase = mergeBasePositions.get(lane.id);
              const startX = mergeBase?.available ? mergeBase.x * 10 : 0;
              const endX = last ? last.x * 10 : startX;
              const isDefault = lane.branch === project.default_branch;
              if (!isDefault && mergeBase?.afterObservation) return null;
              return (
                <g key={lane.id}>
                  <line className={isDefault ? "flow-base-line" : "flow-lane-line"} x1={isDefault ? 0 : startX} x2={isDefault ? 1000 : endX} y1={y} y2={y} />
                  {!isDefault && baseline !== null && (
                    <line className={lane.merge_base ? "flow-branch-link" : "flow-branch-link flow-branch-link-unknown"} x1={startX} x2={startX} y1={baseline} y2={y} />
                  )}
                </g>
              );
            })}
            {mergeLinks.map((link: ProjectMergeRelation & { x: number; outside: boolean; sourceIndex: number; targetIndex: number }) => {
              const x = link.x * 10;
              const sourceY = link.sourceIndex * rowHeight + rowHeight / 2;
              const targetY = link.targetIndex * rowHeight + rowHeight / 2;
              const approachX = Math.max(0, x - 24);
              return (
                <path
                  className={`flow-merge-link${link.outside ? " flow-merge-link-outside" : ""}`}
                  d={`M ${approachX} ${sourceY} L ${x} ${targetY}`}
                  key={`${link.commit_hash}:${link.source_parent}`}
                  markerEnd="url(#flow-merge-arrow)"
                >
                  <title>{`${link.source_branch} → ${link.target_branch} · ${shortHash(link.commit_hash)}`}</title>
                </path>
              );
            })}
          </svg>
          {lanes.map((lane, index) => {
            const laneEvents = eventsByLane.get(lane.id) ?? [];
            const mergeBase = mergeBasePositions.get(lane.id);
            const visibleRelations = [
              ...lane.merge_sources.filter((relation) => visibleMergeKeys.has(`${relation.commit_hash}:${relation.source_parent}`)).map((relation) => `→ ${relation.target_branch ?? "不明"}`),
              ...lane.merge_targets.filter((relation) => visibleMergeKeys.has(`${relation.commit_hash}:${relation.source_parent}`)).map((relation) => `${relation.source_branch ?? "不明"} →`),
            ].join(" / ");
            const snapshot = laneAgentSnapshotAt(lane, observedAgentEvents, observationTime)[0]
              ?? (timeline === 100 ? currentLaneAgent(lane) : null);
            return (
              <div className={`flow-row${lane.branch === project.default_branch ? " is-default" : ""}${selectedLane === lane.id ? " is-selected" : ""}`} key={lane.id}>
                <div className="flow-lane-label" ref={index === 0 ? firstLaneLabelRef : undefined}>
                  <div className="flow-lane-title">
                    <span className="lane-shape" aria-hidden="true" />
                    <button className="flow-lane-button" aria-pressed={selectedLane === lane.id} title={laneLabel(lane)} type="button" onClick={() => onSelectLane(lane)}>{laneLabel(lane)}</button>
                  </div>
                  <div className="flow-lane-meta">
                    <span className={`lane-state ${laneStateClass(lane, project.default_branch)}`}>{laneState(lane, project.default_branch)}</span>
                    <span title={snapshot?.summary ?? undefined}>{snapshot ? agentStateLabel(agentTaskState(snapshot)) : "agent 状態不明"}</span>
                  </div>
                  <div className="flow-lane-relation" title={visibleRelations}>
                    {visibleRelations ? visibleRelations : mergeBase?.afterObservation ? "分岐点は選択日時より後" : !mergeBase?.available ? "分岐点 未取得" : mergeBase.outside ? "分岐点は表示範囲外" : "分岐点を表示中"}
                  </div>
                </div>
                <div className="flow-track">
                  {laneEvents.length === 0 && <span className="flow-track-empty">{!project.graph ? "履歴未取得" : timeline < 100 ? "選択日時までの表示対象コミットなし" : "この表示範囲にコミットなし"}</span>}
                  {laneEvents.map((event) => {
                    return (
                      <FlowEventButton
                        event={event}
                        key={event.id}
                        onPreview={setPreviewId}
                        onRegister={registerEventButton}
                        onNavigate={navigateEvent}
                        onSelect={onSelect}
                        popoverBelow={index < 2}
                        preview={previewId === event.id}
                        selected={selectedKey === event.id}
                        trackWidth={trackWidth}
                      />
                    );
                  })}
                  {laneEvents.length > 0 && <div className="flow-latest-visible">
                    <span className="flow-latest-caption">最新</span><span title={laneEvents[laneEvents.length - 1].row.subject}>{laneEvents[laneEvents.length - 1].row.subject}</span>
                    <time dateTime={laneEvents[laneEvents.length - 1].row.date}>{axisLabel(eventDate(laneEvents[laneEvents.length - 1].row)!)}</time>
                  </div>}
                </div>
              </div>
            );
          })}
          <div className="flow-current-label" style={{ left: `${renderedLabelWidth + (observationX * trackWidth) / 100}px` }} aria-hidden="true">
            {timeline === 100 ? "最新の観測" : "選択日時"}
          </div>
          </div>
        </div>
      )}
      <div className="flow-legend" aria-label="フロー凡例">
        <span><i className="legend-dot legend-dot-head" aria-hidden="true" /> ブランチ先端（HEAD）</span>
        <span><i className="legend-dot legend-dot-commit" aria-hidden="true" /> コミット</span>
        <span><i className="legend-dot legend-dot-merge" aria-hidden="true" /> マージ</span>
        <span><i className="legend-line legend-line-branch" aria-hidden="true" /> 作業経路</span>
        <span><i className="legend-line legend-line-base" aria-hidden="true" /> 既定ブランチ</span>
        <span><i className="legend-line legend-line-merge" aria-hidden="true" /> 合流元 → 合流先</span>
        <span className="flow-time-direction">時間 →</span>
      </div>
      {!project.graph && <div className="inline-note">コミットグラフは未取得です。</div>}
      {unresolvedMergeCount > 0 && (
        <div className="inline-note" role="status">
          {`合流関係 ${unresolvedMergeCount} 件はブランチを特定できないため、線を表示していません。`}
        </div>
      )}
      <details className="flow-help">
        <summary>グラフの見方・キーボード操作</summary>
        <p>ブランチ名で作業詳細、点でコミット詳細を開きます。時間は左から右へ進みます。</p>
        <p>点にフォーカスすると概要を表示。左右キーで前後のコミット、上下キーで別ブランチへ移動し、Enterで詳細を開きます。タッチ操作では点をタップして概要を開けます。</p>
        <p>分岐点は既定ブランチとの共通祖先（merge-base）です。矢印はGitの履歴から特定できた合流関係のみ表示します。agent状態は明示された報告を表示します。</p>
      </details>
      {project.graph?.truncated && <div className="inline-note">全履歴の取得上限は 200 件です。表示範囲外の履歴は未取得です。</div>}
    </section>
  );
}

function LaneSummary({ lane, defaultBranch }: { lane: ProjectLane; defaultBranch: string | null }) {
  const ahead = lane.default_ahead;
  const behind = lane.default_behind;
  return (
    <>
      <span className={`lane-state ${laneStateClass(lane, defaultBranch)}`}>{laneState(lane, defaultBranch)}</span>
      <AgentFact task={currentLaneAgent(lane)} />
      <span className="lane-diff">
        {ahead === null || behind === null ? "既定差分 未取得" : `既定差分 +${ahead} / -${behind}`}
      </span>
    </>
  );
}

function WorkLanes({
  project,
  selectedLane,
  onSelectLane,
  onOpenGit,
  showMerged,
  onShowMergedChange,
}: {
  project: ProjectResponse;
  selectedLane: string | null;
  onSelectLane: (lane: ProjectLane) => void;
  onOpenGit: (lane: ProjectLane) => void;
  showMerged: boolean;
  onShowMergedChange: (value: boolean) => void;
}) {
  const relationLaneIds = new Set(project.merge_relations.flatMap((relation) => (
    [relation.source_lane_id, relation.target_lane_id].filter((id): id is string => id !== null)
  )));
  const lanes = project.lanes.filter((lane) => showMerged || relationLaneIds.has(lane.id) || lane.branch === project.default_branch || !isFoldedMerged(lane));
  const mergedCount = project.lanes.filter((lane) => lane.branch !== project.default_branch && !relationLaneIds.has(lane.id) && isFoldedMerged(lane)).length;
  return (
    <section className="lanes-section" aria-labelledby="lanes-title">
      <div className="section-heading-row">
        <div>

          <h3 id="lanes-title">作業一覧</h3>
          <p className="section-copy">Git の状態と agent の明示した現在地、次の判断を一覧します。</p>
        </div>
        {mergedCount > 0 && <button className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "merged を折り畳む" : `merged・完了を表示 (${mergedCount})`}</button>}
      </div>
      <div className="lane-table-wrap">
        <table className="lane-table">
          <thead>
            <tr><th>作業</th><th>状態 / agent</th><th>最終活動</th><th>既定ブランチとの差</th><th>最新メッセージ</th><th>合流関係</th><th>次の工程 / 注意</th><th aria-label="操作" /></tr>
          </thead>
          <tbody>
            {lanes.map((lane) => (
              <tr className={selectedLane === lane.id ? "is-selected" : ""} key={lane.id}>
                <td>
                  <button className="lane-name-button" type="button" onClick={() => onSelectLane(lane)}>
                    <strong>{laneLabel(lane)}</strong>
                    <code>{shortHash(lane.head)}</code>
                    <span title={lane.path ?? undefined}>{lane.path ?? "パス未取得"}</span>
                  </button>
                </td>
                <td><LaneSummary defaultBranch={project.default_branch} lane={lane} /></td>
                <td>
                  <time dateTime={lane.last_commit?.date ?? undefined} title={exactDate(lane.last_commit?.date)}>{relativeTime(lane.last_commit?.date)}</time>
                  <span className="table-subvalue">{exactDate(lane.last_commit?.date)}</span>
                </td>
                <td className="mono-cell">{lane.default_ahead === null || lane.default_behind === null ? "未取得" : `ahead ${lane.default_ahead} · behind ${lane.default_behind}`}</td>
                <td className="unknown-cell">{currentLaneAgent(lane)?.summary || "報告内容なし"}</td>
                <td className="unknown-cell">{laneMergeSummary(lane)}</td>
                <td className="unknown-cell">{lane.next_phase || currentLaneAgent(lane)?.attention || "未取得"}</td>
                <td><button className="table-action" type="button" onClick={() => onOpenGit(lane)}>Git詳細</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lanes.length === 0 && <div className="empty-flow">表示できる作業レーンはありません。</div>}
    </section>
  );
}

function ActivityView({
  project,
  filter,
  onFilter,
  onSelect,
}: {
  project: ProjectResponse;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
  onSelect: (event: ProjectEvent) => void;
}) {
  const unifiedEvents = useMemo(() => project.events.map((event) => ({
    ...event,
    commit_hash: event.commit_hash ?? null,
    subject: event.source === "agent" ? event.summary ?? null : event.subject ?? null,
    author: event.source === "agent" ? event.agent_id ?? null : event.author ?? null,
    agent_state: event.source === "agent" ? agentTaskState(event) : null,
    task_id: event.source === "agent" ? event.task_id ?? null : null,
    agent_phase: event.source === "agent" ? event.phase ?? null : null,
    attention: event.source === "agent" ? event.attention ?? null : null,
  })), [project.events]);
  const events = useMemo(() => {
    const filtered = unifiedEvents.filter((event) => {
      if (filter === "all") return true;
      if (filter === "commit") return event.type === "commit";
      if (filter === "edit") return event.agent_phase === "implementing";
      if (filter === "test") return event.agent_phase === "testing";
      if (filter === "review") return event.agent_state === "review_required" || event.agent_state === "reviewing";
      return event.agent_state === "waiting_for_user";
    });
    return [...filtered].sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? "") || b.observed_at - a.observed_at);
  }, [filter, unifiedEvents]);
  return (
    <section className="activity-section" aria-labelledby="activity-title">
      <div className="section-heading-row">
        <div><h3 id="activity-title">アクティビティ</h3><p className="section-copy">Git と agent のイベントを絶対時刻順に表示します。発生元と状態は文字でも確認できます。</p></div>
      </div>
      <div className="activity-filters" role="toolbar" aria-label="イベント種別">
        {activityFilters.map((item) => (
          <button className="filter-button" aria-pressed={filter === item.id} type="button" key={item.id} onClick={() => onFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {events.length === 0 ? (
        <div className="empty-activity">この種別のイベントは未取得です。</div>
      ) : (
        <ol className="activity-list">
          {events.map((event) => (
            <li key={event.id}>
              <div className="activity-time"><time dateTime={event.occurred_at ?? undefined}>{exactDate(event.occurred_at)}</time><span>{relativeTime(event.occurred_at)}</span></div>
              <span className="activity-source"><i aria-hidden="true" />{event.source === "agent" ? "agent" : event.source} · {event.type === "commit" ? "コミット" : event.agent_state ? agentStateLabel(event.agent_state) : event.type}</span>
              <div className="activity-content"><strong>{event.subject || (event.type === "agent" ? "報告内容なし" : "(no subject)")}</strong><span>{event.lane_names?.length ? event.lane_names.join(" / ") : event.branch ?? "対象レーン未取得"} · {event.author ?? "author 未取得"}{event.task_id ? ` · task ${event.task_id}` : ""}</span>{event.attention && <span className="activity-attention">注意: {event.attention}</span>}</div>
              {event.commit_hash && <button className="activity-commit" type="button" onClick={() => onSelect(event)}>{shortHash(event.commit_hash)} 詳細</button>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ProjectInfo({ project }: { project: ProjectResponse }) {
  return (
    <section className="info-section" aria-labelledby="info-title">
      <div className="section-heading-row"><div><h3 id="info-title">プロジェクト情報</h3><p className="section-copy">Git と明示的に取得できた保守情報だけを表示します。</p></div></div>
      <div className="info-grid">
        <div className="info-card info-card-wide"><span className="eyebrow">説明</span><p>{project.description || "説明なし"}</p></div>
        <InfoField label="リモート URL" value={project.remote} code />
        <InfoField label="既定ブランチ" value={project.default_branch} code />
        <InfoField label="main checkout" value={project.main_path} code />
        <InfoField label="最終 fetch" value={project.fetched_at ? exactDate(new Date(project.fetched_at * 1000).toISOString()) : null} />
        <InfoField label="ローカルブランチ" value={project.branch_counts.local} />
        <InfoField label="リモートブランチ" value={project.branch_counts.remote} />
        <InfoField label="merged" value={project.maintenance.merged} />
        <InfoField label="prunable" value={project.maintenance.prunable} />
        <InfoField label="locked worktree" value={project.maintenance.locked} />
        <InfoField label="使用言語" value={project.languages ? project.languages.join(", ") : null} />
        <InfoField label="主要ディレクトリ" value={project.directories ? project.directories.join(", ") : null} />
        <InfoField label="テストコマンド" value={project.test_commands ? project.test_commands.join(" / ") : null} />
        <InfoField label="関連 agent タスク" value={`${project.agent_tasks.length} 件`} />
      </div>
      <div className="info-subsection"><h4>関連 Codex タスク</h4>{project.agent_tasks.length ? <div className="related-agent-tasks">{project.agent_tasks.map((task) => <div className="related-agent-task" key={task.task_id}><div><strong>{task.task_id}</strong><span>{task.agent_id || "agent 未取得"} · {agentStateLabel(agentTaskState(task))}</span></div><p>{task.summary || "報告内容なし"}</p><time dateTime={task.occurred_at ?? undefined}>{exactDate(task.occurred_at)} · {agentElapsed(task.occurred_at)}</time></div>)}</div> : <div className="info-unavailable" role="status">agent 状態不明（関連タスク未取得）</div>}</div>
      <div className="info-subsection"><h4>worktree 一覧</h4><div className="worktree-records">{project.worktrees.map((item) => <div className="worktree-record" key={item.path}><span className="worktree-shape" aria-hidden="true" /><strong>{item.branch ?? "detached HEAD"}</strong><code title={item.path}>{item.path}</code><span className={`lane-state ${item.state === "prunable" || item.state === "locked" ? "lane-state-warn" : "lane-state-ok"}`}>{item.state ?? "未取得"}</span></div>)}</div></div>
      <div className="info-unavailable" role="status">PR・レビュー・CI の情報は、明示された値のみ表示します。</div>
    </section>
  );
}

function InfoField({ label, value, code = false }: { label: string; value: string | number | null | undefined; code?: boolean }) {
  return <div className="info-field"><span>{label}</span>{code ? <code title={valueOrUnknown(value)}>{valueOrUnknown(value)}</code> : <strong>{valueOrUnknown(value)}</strong>}</div>;
}

function LaneDetail({ lane, defaultBranch, onOpenGit }: { lane: ProjectLane; defaultBranch: string | null; onOpenGit: (lane: ProjectLane) => void }) {
  return (
    <div className="selection-content">
      <div className="selection-kicker">作業レーン</div>
      <h3>{laneLabel(lane)}</h3>
      <div className="selection-badges"><span className={`lane-state ${laneStateClass(lane, defaultBranch)}`}>{laneState(lane, defaultBranch)}</span><AgentFact task={currentLaneAgent(lane)} /></div>
      <dl className="selection-list">
        <div><dt>作業パス</dt><dd><code>{lane.path ?? "未取得"}</code></dd></div>
        <div><dt>作業先端</dt><dd><code>{lane.head ?? "未取得"}</code></dd></div>
        <div><dt>分岐点 (merge-base)</dt><dd><code>{lane.merge_base ?? "未取得"}</code></dd></div>
        <div><dt>最終イベント</dt><dd>{lane.last_commit?.subject ?? "未取得"}<small>{exactDate(lane.last_commit?.date)}</small></dd></div>
        <div><dt>既定ブランチとの差</dt><dd>{lane.default_ahead === null || lane.default_behind === null ? "未取得" : `ahead ${lane.default_ahead} · behind ${lane.default_behind}`}</dd></div>
        <div><dt>担当 agent</dt><dd>{currentLaneAgent(lane)?.agent_id || "未関連付け"}</dd></div>
        <div><dt>このブランチからの合流</dt><dd>{lane.merge_sources.length ? lane.merge_sources.map((relation) => `${relation.target_branch ?? "不明"} (${shortHash(relation.commit_hash)})`).join(" / ") : "なし / 不明"}</dd></div>
        <div><dt>このブランチへの合流</dt><dd>{lane.merge_targets.length ? lane.merge_targets.map((relation) => `${relation.source_branch ?? "不明"} (${shortHash(relation.commit_hash)})`).join(" / ") : "なし / 不明"}</dd></div>
        <div><dt>次の工程 / 注意</dt><dd>{lane.next_phase || currentLaneAgent(lane)?.attention || "未取得"}</dd></div>
      </dl>
      {lane.next_command && <div className="selection-command"><span>Git 次コマンド</span><code>{lane.next_command.command}</code><small>{lane.next_command.reason}</small></div>}
      <button className="primary-action" type="button" onClick={() => onOpenGit(lane)}>Git 詳細を開く</button>
    </div>
  );
}

function CommitDetail({
  project,
  event,
  lane,
  onOpenGit,
}: {
  project: ProjectResponse;
  event: FlowEvent | ProjectEvent;
  lane: ProjectLane | null;
  onOpenGit: (lane: ProjectLane) => void;
}) {
  const hash = "row" in event ? event.row.hash : event.commit_hash;
  const path = lane?.path ?? project.main_path;
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  useEffect(() => {
    if (!hash || !path) {
      setState("error");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    setDetail(null);
    const timer = window.setTimeout(() => {
      void fetch(`/api/repo/commit?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json()) as CommitDetail; })
        .then((value) => { setDetail(value); setState("ready"); })
        .catch((reason: unknown) => { if (reason instanceof DOMException && reason.name === "AbortError") return; setState("error"); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [hash, path]);
  return (
    <div className="selection-content">
      <div className="selection-kicker">Git コミット</div>
      <h3>{detail?.subject ?? ("row" in event ? event.row.subject : event.subject) ?? "コミット詳細"}</h3>
      <div className="selection-commit-meta"><code>{hash ?? "未取得"}</code><span>{"row" in event ? event.row.author : event.author ?? "author 未取得"}</span><time dateTime={"row" in event ? event.row.date ?? undefined : event.occurred_at ?? undefined}>{exactDate("row" in event ? event.row.date : event.occurred_at)}</time></div>
      {state === "loading" && <div className="selection-loading" role="status">完全なコミット詳細を取得中…</div>}
      {state === "error" && <div className="selection-error" role="alert">コミット詳細を取得できませんでした。</div>}
      {state === "ready" && detail && <>
        <div className="selection-numstat"><span>変更ファイル {detail.files.length}</span><span className="additions">+{detail.files.reduce((sum, file) => sum + (typeof file.additions === "number" ? file.additions : 0), 0)}</span><span className="deletions">-{detail.files.reduce((sum, file) => sum + (typeof file.deletions === "number" ? file.deletions : 0), 0)}</span></div>
        <div className="selection-files">{detail.files.map((file) => <div key={file.path}><span>{file.additions}</span><span>{file.deletions}</span><code>{file.path}</code></div>)}</div>
        <pre className="selection-patch">{detail.patch}</pre>
      </>}
      {lane && <button className="secondary-action" type="button" onClick={() => onOpenGit(lane)}>このレーンの Git 詳細</button>}
    </div>
  );
}

function dialogFocusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

type DialogEntry = { root: HTMLElement; onClose: () => void };
const dialogStack: DialogEntry[] = [];

function useDialogKeyboard(
  rootRef: React.RefObject<HTMLElement>,
  closeRef: React.RefObject<HTMLElement>,
  onClose: () => void,
  modal = true,
) {
  useEffect(() => {
    if (!modal) return;
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const entry: DialogEntry = { root, onClose };
    dialogStack.push(entry);
    const onKeyDown = (event: KeyboardEvent) => {
      // Nested Git details share the document listener. Only the topmost
      // dialog may consume Escape or trap Tab; lower selection state and its
      // URL remain intact until the nested dialog is closed.
      if (dialogStack.at(-1) !== entry) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusables = dialogFocusables(rootRef.current);
      if (!focusables.length) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const index = dialogStack.indexOf(entry);
      if (index >= 0) dialogStack.splice(index, 1);
      if (previous?.isConnected && !rootRef.current?.contains(previous)) previous.focus();
    };
  }, [closeRef, onClose, rootRef, modal]);
}

function SelectionPane({
  project,
  selectedHash,
  selectedLane,
  selectedEvent,
  onClose,
  onOpenGit,
}: {
  project: ProjectResponse;
  selectedHash: string | null;
  selectedLane: string | null;
  selectedEvent: FlowEvent | ProjectEvent | null;
  onClose: () => void;
  onOpenGit: (lane: ProjectLane) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const sync = () => setModal(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useDialogKeyboard(panelRef, closeRef, onClose, modal);
  const lane = project.lanes.find((item) => item.id === selectedLane) ?? (selectedEvent && "lane" in selectedEvent ? selectedEvent.lane : null);
  return (
    <aside ref={panelRef} className="control-selection" aria-label="選択詳細" aria-modal={modal ? true : undefined} role={modal ? "dialog" : "complementary"} tabIndex={-1}>
      <div className="selection-head"><span className="selection-title">選択した項目の詳細</span><button ref={closeRef} className="icon-close" type="button" aria-label="詳細を閉じる" onClick={onClose}>×</button></div>
      {selectedEvent && selectedHash ? <CommitDetail event={selectedEvent} lane={lane} onOpenGit={onOpenGit} project={project} /> : lane ? <LaneDetail defaultBranch={project.default_branch} lane={lane} onOpenGit={onOpenGit} /> : <div className="selection-content"><p>選択対象はありません。</p></div>}
    </aside>
  );
}

function LegacyGitModal({
  repo,
  tab,
  copied,
  onClose,
  onCopy,
  onTabChange,
}: {
  repo: Repo;
  tab: DetailTab;
  copied: string | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onTabChange: (tab: DetailTab) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(panelRef, closeRef, onClose);
  return (
    <div className="legacy-overlay">
      <div ref={panelRef} className="legacy-panel" role="dialog" aria-modal="true" aria-label="既存Git詳細" tabIndex={-1}>
        <div className="legacy-panel-head">
          <div><span className="eyebrow">EXISTING GIT DETAIL</span><strong>{repo.branch ?? repo.name}</strong></div>
          <button ref={closeRef} className="icon-close" type="button" aria-label="Git詳細を閉じる" onClick={onClose}>×</button>
        </div>
        <RepoDetail activeTab={tab} copied={copied} onCopy={onCopy} onTabChange={onTabChange} repo={repo} />
      </div>
    </div>
  );
}

function LegacyUnavailableModal({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(panelRef, closeRef, onClose);
  return (
    <div className="legacy-overlay">
      <div ref={panelRef} className="legacy-panel legacy-unavailable" role="dialog" aria-modal="true" aria-label="既存Git詳細" tabIndex={-1}>
        <button ref={closeRef} className="icon-close" type="button" aria-label="Git詳細を閉じる" onClick={onClose}>×</button>
        <p>この Git checkout の状態は未取得です。</p>
      </div>
    </div>
  );
}

export default function ProjectControl() {
  const { repos, scanning, connected, latestAgentEvent } = useRepoStream();
  const { state: urlState, update: updateUrl } = useProjectUrl();
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [projectState, setProjectState] = useState<LoadState>("idle");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [gitPath, setGitPath] = useState<string | null>(null);
  const [gitTab, setGitTab] = useState<DetailTab>("status");
  const [copied, setCopied] = useState<string | null>(null);
  const setShowMerged = useCallback((value: boolean) => updateUrl({ merged: value ? true : null }), [updateUrl]);

  const projectSnapshotKey = useMemo(() => {
    if (!urlState.path) return "";
    const selected = repos.get(urlState.path);
    const common = selected?.common_dir;
    return [...repos.values()]
      .filter((repo) => repo.path === urlState.path || (common && repo.common_dir === common))
      .map((repo) => `${repo.path}:${repo.checked_at ?? repo.activity ?? 0}:${repo.branch ?? ""}:${repo.worktree_state ?? ""}`)
      .sort()
      .join("|");
  }, [repos, urlState.path]);

  useEffect(() => {
    if (!urlState.path) {
      setProject(null);
      setProjectState("error");
      setProjectError("プロジェクトの path がありません");
      return;
    }
    const controller = new AbortController();
    setProjectState("loading");
    setProjectError(null);
    void fetch(`/api/project?path=${encodeURIComponent(urlState.path)}&range=${encodeURIComponent(urlState.range)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json()) as ProjectResponse; })
      .then((value) => { setProject(value); setProjectState("ready"); })
      .catch((reason: unknown) => { if (reason instanceof DOMException && reason.name === "AbortError") return; setProjectState("error"); setProjectError(reason instanceof Error ? reason.message : "unknown error"); });
    return () => controller.abort();
  }, [projectSnapshotKey, scanning, urlState.path, urlState.range]);

  useEffect(() => {
    if (!project || !latestAgentEvent) return;
    const matches = (latestAgentEvent.project_id && latestAgentEvent.project_id === project.id)
      || latestAgentEvent.worktree === project.main_path
      || project.lanes.some((lane) => lane.path === latestAgentEvent.worktree || lane.branch === latestAgentEvent.branch);
    if (!matches) return;
    setProject((current) => {
      if (!current) return current;
      const summary = mergeAgentSnapshot(current, latestAgentEvent);
      const lane = current.lanes.find((item) => item.path === latestAgentEvent.worktree || item.branch === latestAgentEvent.branch);
      const activity = {
        id: `agent:${latestAgentEvent.event_id}`,
        occurred_at: latestAgentEvent.occurred_at,
        observed_at: latestAgentEvent.observed_at,
        type: "agent",
        source: "agent",
        project_id: latestAgentEvent.project_id ?? current.id,
        worktree: latestAgentEvent.worktree,
        branch: latestAgentEvent.branch,
        lane_id: lane?.id ?? null,
        task_id: latestAgentEvent.task_id,
        agent_id: latestAgentEvent.agent_id,
        run_state: latestAgentEvent.run_state,
        phase: latestAgentEvent.phase,
        attention: latestAgentEvent.attention,
        outcome: latestAgentEvent.outcome,
        summary: latestAgentEvent.summary,
      } as ProjectEvent;
      return {
        ...current,
        agent_tasks: summary.agent_tasks,
        agent_priority_counts: summary.agent_priority_counts,
        agent_state: summary.agent_state,
        agent_latest_event: latestAgentEvent,
        agent_events: current.agent_events.some((item) => item.event_id === latestAgentEvent.event_id)
          ? current.agent_events
          : [...current.agent_events, latestAgentEvent],
        events: current.events.some((item) => item.id === activity.id) ? current.events : [...current.events, activity],
        lanes: current.lanes.map((item) => (
          item.path === latestAgentEvent.worktree || item.branch === latestAgentEvent.branch
            ? { ...item, agent: latestAgentEvent }
            : item
        )),
      };
    });
  }, [latestAgentEvent, project?.id]);

  const selectedHash = urlState.event;
  const selectedLane = urlState.lane;
  useEffect(() => {
    if (!selectedHash && !selectedLane) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      updateUrl({ event: null, lane: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedHash, selectedLane, updateUrl]);
  const selectedEvent = useMemo(() => {
    if (!project || !selectedHash) return null;
    const lane = project.lanes.find((item) => item.id === selectedLane);
    const row = project.graph?.rows.find((item) => item.hash === selectedHash);
    if (row && lane) return { row, lane, x: 0, hitX: 0, timestampX: 0, pointOffset: 0, id: flowEventKey(lane.id, row.hash) } as FlowEvent;
    return project.events.find((event) => event.commit_hash === selectedHash) ?? null;
  }, [project, selectedHash, selectedLane]);
  const copy = useCallback((value: string) => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(value); window.setTimeout(() => setCopied(null), 1500); });
  }, []);
  const legacyRepo = gitPath ? repos.get(gitPath) ?? null : null;

  const selectEvent = useCallback((event: FlowEvent | ProjectEvent) => {
    const hash = "row" in event ? event.row.hash : event.commit_hash;
    if (!hash) return;
    const lane = "lane" in event ? event.lane : project?.lanes.find((item) => item.branch === event.branch || item.id === event.lane_id);
    updateUrl({ event: hash, lane: lane?.id ?? null });
  }, [project?.lanes, updateUrl]);
  const selectLane = useCallback((lane: ProjectLane) => updateUrl({ lane: lane.id, event: null }), [updateUrl]);
  const openGit = useCallback((lane: ProjectLane) => {
    if (lane.path) setGitPath(lane.path);
    else if (project?.main_path) setGitPath(project.main_path);
  }, [project?.main_path]);
  const closeGit = useCallback(() => setGitPath(null), []);
  const closeSelection = useCallback(() => updateUrl({ event: null, lane: null }), [updateUrl]);
  const selectedKey = selectedHash && selectedLane ? flowEventKey(selectedLane, selectedHash) : null;

  if (projectState === "loading" || !project) {
    return (
      <main className="control-shell"><header className="control-topbar"><a className="back-link" href="/">← プロジェクト一覧</a><span className="connection-state"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "同期中" : "接続待ち"}</span></header><div className="control-state" role="status">{projectState === "loading" ? "プロジェクト管制画面を取得中…" : projectError ?? "プロジェクトを選択してください"}</div></main>
    );
  }
  if (projectState === "error") {
    return <main className="control-shell"><header className="control-topbar"><a className="back-link" href="/">← プロジェクト一覧</a></header><div className="control-state control-state-error" role="alert">プロジェクト情報を取得できませんでした。<span className="sr-only">{projectError}</span></div></main>;
  }

  return (
    <main className="control-shell">
      <header className="control-topbar">
        <a className="back-link" href="/">← プロジェクト一覧</a>
        <div className="control-status"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "Git同期中" : "接続待ち"}{scanning && " · 走査中"}</div>
        <button className="rescan-button" disabled={scanning} type="button" onClick={() => void fetch("/api/rescan", { method: "POST" })}>{scanning ? "走査中…" : "再走査"}</button>
      </header>
      <section className="control-hero" aria-labelledby="project-title">
        <div className="control-hero-main"><div className="project-identity"><h1 id="project-title">{project.name}</h1><span className="project-baseline">既定 <strong>{project.default_branch ?? "未取得"}</strong></span><span className="project-lane-count">{project.lanes.length} ブランチ</span></div><details className="project-context"><summary>プロジェクトの概要・集計</summary><p className="control-description">{project.description || "説明なし"}</p><div className="control-identifiers"><code title={project.remote ?? undefined}>{project.remote ?? "リモート未取得"}</code><span>既定 <strong>{project.default_branch ?? "未取得"}</strong></span><code title={project.main_path}>{project.main_path}</code></div><div className="control-latest-git" aria-label="Git最終イベント"><span className="eyebrow">最新コミット</span>{project.latest_event ? <><strong>{project.latest_event.subject || "(no subject)"}</strong><time dateTime={project.latest_event.occurred_at ?? undefined}>{relativeTime(project.latest_event.occurred_at)} · {exactDate(project.latest_event.occurred_at)}</time><span>Git · コミット · {shortHash(project.latest_event.commit_hash)}</span></> : <span>Git · 最終イベント 未取得</span>}</div>
        <div className="control-metrics" aria-label="プロジェクト集計"><div><strong>{agentCount(project, "waiting_for_user")}</strong><span>入力待ち</span></div><div><strong>{agentCount(project, "blocked")}</strong><span>問題あり</span></div><div><strong>{agentCount(project, "active")}</strong><span>実行中</span></div><div><strong>{agentCount(project, "review_required")}</strong><span>レビュー待ち</span></div><div><strong>{agentCount(project, "merge_ready")}</strong><span>統合可能</span></div><div><strong>{project.lanes.length}</strong><span>Gitレーン</span></div></div></details></div>
      </section>
      <nav className="control-tabs" role="tablist" aria-label="プロジェクト管制画面">
        {tabs.map((tab) => <button aria-selected={urlState.tab === tab.id} className="control-tab" key={tab.id} role="tab" id={`project-tab-${tab.id}`} aria-controls={`project-panel-${tab.id}`} tabIndex={urlState.tab === tab.id ? 0 : -1} type="button" onKeyDown={(event) => {
          const index = tabs.findIndex((item) => item.id === tab.id);
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          updateUrl({ tab: tabs[next].id });
          document.getElementById(`project-tab-${tabs[next].id}`)?.focus();
        }} onClick={() => updateUrl({ tab: tab.id })}><span>{tab.label}</span></button>)}
      </nav>
      <div className={`control-layout${selectedEvent || selectedLane ? " has-selection" : ""}`}>
        <section className="control-main" role="tabpanel" id={`project-panel-${urlState.tab}`} aria-labelledby={`project-tab-${urlState.tab}`} tabIndex={0}>
          {urlState.tab === "flow" && <FlowMap selectedLane={selectedLane} onSelectLane={selectLane} onRangeChange={(range) => updateUrl({ range, at: 100 })} onSelect={selectEvent} onShowMergedChange={setShowMerged} onTimelineChange={(value) => updateUrl({ at: value })} project={project} range={urlState.range} selectedKey={selectedKey} showMerged={urlState.merged} timeline={urlState.at} />}
          {urlState.tab === "lanes" && <WorkLanes onOpenGit={openGit} onSelectLane={selectLane} onShowMergedChange={setShowMerged} project={project} selectedLane={selectedLane} showMerged={urlState.merged} />}
          {urlState.tab === "activity" && <><div className="activity-toolbar-spacer" /> <ActivityView filter={activityFilter} onFilter={(filter) => { setActivityFilter(filter); updateUrl({ event: null }); }} onSelect={selectEvent} project={project} /></>}
          {urlState.tab === "info" && <ProjectInfo project={project} />}
        </section>
        {(selectedEvent || selectedLane) && <SelectionPane onClose={closeSelection} onOpenGit={openGit} project={project} selectedEvent={selectedEvent} selectedHash={selectedHash} selectedLane={selectedLane} />}
      </div>
      {gitPath && legacyRepo && <LegacyGitModal copied={copied} onClose={closeGit} onCopy={copy} onTabChange={setGitTab} repo={legacyRepo} tab={gitTab} />}
      {gitPath && !legacyRepo && <LegacyUnavailableModal onClose={closeGit} />}
    </main>
  );
}
