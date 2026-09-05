"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RepoDetail, { type DetailTab } from "./repo-detail";
import { agentSnapshotAt, agentStateLabel, agentTaskState, laneAgentSnapshotAt } from "./agent-overview.mjs";
import { ancestryRows, eventLeaderGeometry, flowEventKey, flowKeyboardAction, layoutFlowEvents, mergeBasePosition, mobileEventAction, parseProjectUrl, popoverPlacement, shouldFoldMergedLane, updateProjectUrl } from "./project-flow.mjs";
import { useRepoStream } from "./repo-stream";
import type {
  CommitDetail,
  GraphRow,
  ProjectEvent,
  ProjectLane,
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
  { id: "flow", label: "フロー", short: "FLOW" },
  { id: "lanes", label: "作業一覧", short: "LANES" },
  { id: "activity", label: "アクティビティ", short: "ACTIVITY" },
  { id: "info", label: "プロジェクト情報", short: "INFO" },
];

const ranges: { id: TimeRange; label: string }[] = [
  { id: "current", label: "現在" },
  { id: "24h", label: "24時間" },
  { id: "7d", label: "7日" },
  { id: "all", label: "全履歴" },
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

type FlowViewport = {
  left: number;
  right: number;
  scrollLeft: number;
};

function eventDate(row: GraphRow) {
  const value = new Date(row.date).getTime();
  return Number.isNaN(value) ? null : value;
}

function eventsByLaneCount(events: { lane: ProjectLane }[], laneId: string) {
  return events.reduce((count, event) => count + (event.lane.id === laneId ? 1 : 0), 0);
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
  popoverShift,
  popoverWidth,
}: {
  event: FlowEvent;
  selected: boolean;
  preview: boolean;
  popoverBelow: boolean;
  onNavigate: (event: FlowEvent, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") => void;
  onRegister: (id: string, node: HTMLButtonElement | null) => void;
  onPreview: (id: string | null) => void;
  onSelect: (event: FlowEvent) => void;
  trackWidth: number;
  popoverShift: number;
  popoverWidth: number;
}) {
  const touchPreviewRef = useRef(false);
  const touchPointerRef = useRef(false);
  const touchPreviewOpenRef = useRef(false);
  const xClass = event.hitX < 24 ? "flow-event-left" : event.hitX > 76 ? "flow-event-right" : "";
  const leader = eventLeaderGeometry(event.timestampX, event.hitX, trackWidth);
  const hasLeader = leader.width > 0.5;
  const select = () => {
    touchPreviewOpenRef.current = false;
    onPreview(null);
    onSelect(event);
  };
  return (
    <div
      className={`flow-event-hit ${xClass}`}
      data-flow-event-key={event.id}
      style={{ left: `${event.hitX}%`, "--flow-point-offset": `${event.pointOffset}px` } as React.CSSProperties}
      onMouseEnter={() => onPreview(event.id)}
      onMouseLeave={() => { if (!touchPreviewOpenRef.current) onPreview(null); }}
    >
      {hasLeader && <span className="flow-event-leader" aria-hidden="true" style={{ left: `calc(50% + ${leader.left}px)`, width: `${leader.width}px` }} />}
      <button
        aria-label={`${laneLabel(event.lane)} ${shortHash(event.row.hash)} ${event.row.subject}`}
        className={`flow-event-button${selected ? " is-selected" : ""}`}
        data-flow-event-key={event.id}
        ref={(node) => onRegister(event.id, node)}
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
        onFocus={() => onPreview(event.id)}
        onBlur={(focusEvent) => {
          if (touchPreviewOpenRef.current) return;
          const next = focusEvent.relatedTarget;
          if (!(next instanceof Node) || !focusEvent.currentTarget.parentElement?.contains(next)) onPreview(null);
        }}
        type="button"
      >
        <span
          className={`flow-event-point${event.row.is_merge ? " is-merge" : ""}${event.row.is_head ? " is-head" : ""}`}
          aria-hidden="true"
        />
      </button>
      {preview && (
        <div
          className={`flow-event-popover${popoverBelow ? " flow-event-popover-below" : ""}`}
          role="tooltip"
          style={{ "--flow-popover-shift": `${popoverShift}px`, "--flow-popover-width": `${popoverWidth}px` } as React.CSSProperties}
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
          <button type="button" onClick={select}>詳細を開く</button>
        </div>
      )}
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
  showMerged,
  onShowMergedChange,
}: {
  project: ProjectResponse;
  range: TimeRange;
  timeline: number;
  selectedKey: string | null;
  onTimelineChange: (value: number) => void;
  onSelect: (event: FlowEvent) => void;
  showMerged: boolean;
  onShowMergedChange: (value: boolean) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const flowScrollRef = useRef<HTMLDivElement>(null);
  const firstLaneLabelRef = useRef<HTMLDivElement>(null);
  const eventButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [availableTrackWidth, setAvailableTrackWidth] = useState(0);
  const [renderedLabelWidth, setRenderedLabelWidth] = useState(220);
  const [flowViewport, setFlowViewport] = useState<FlowViewport | null>(null);
  const graphRows = project.graph?.rows ?? [];
  const lanes = useMemo(() => {
    const source = project.lanes.filter((lane) => showMerged || lane.branch === project.default_branch || !isFoldedMerged(lane));
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
  }, [project.default_branch, project.lanes, showMerged]);

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
  const measureFlowViewport = useCallback(() => {
    const scroll = flowScrollRef.current;
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    const nextViewport = { left: rect.left, right: rect.right, scrollLeft: scroll.scrollLeft };
    setFlowViewport((current) => (
      current
      && current.left === nextViewport.left
      && current.right === nextViewport.right
      && current.scrollLeft === nextViewport.scrollLeft
        ? current
        : nextViewport
    ));
  }, []);
  useEffect(() => {
    const scroll = flowScrollRef.current;
    const label = firstLaneLabelRef.current;
    if (!scroll || !label) return;
    const updateWidth = () => {
      const labelWidth = Math.round(label.getBoundingClientRect().width);
      setRenderedLabelWidth((current) => current === labelWidth ? current : labelWidth);
      const next = Math.max(0, Math.round(scroll.clientWidth - labelWidth));
      setAvailableTrackWidth((current) => current === next ? current : next);
      measureFlowViewport();
    };
    updateWidth();
    scroll.addEventListener("scroll", updateWidth, { passive: true });
    window.addEventListener("resize", updateWidth);
    window.addEventListener("scroll", updateWidth, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        scroll.removeEventListener("scroll", updateWidth);
        window.removeEventListener("resize", updateWidth);
        window.removeEventListener("scroll", updateWidth);
      };
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scroll);
    observer.observe(label);
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", updateWidth);
      window.removeEventListener("resize", updateWidth);
      window.removeEventListener("scroll", updateWidth);
    };
  }, [lanes.length, measureFlowViewport]);
  const allTimes = allEvents.map(({ row }) => eventDate(row)).filter((value): value is number => value !== null);
  const now = Date.now();
  const rangeCutoff = range === "24h" ? now - 86_400_000 : range === "7d" ? now - 604_800_000 : null;
  const rangeEvents = allEvents.filter(({ row, lane }) => {
    if (range === "current") {
      return row.hash === lane.head;
    }
    const value = eventDate(row);
    return value !== null && (rangeCutoff === null || value >= rangeCutoff);
  });
  const rangeTimes = rangeEvents.map(({ row }) => eventDate(row)).filter((value): value is number => value !== null);
  const minTime = Math.min(...(rangeTimes.length ? rangeTimes : allTimes.length ? allTimes : [now]));
  const maxCandidate = Math.max(...(rangeTimes.length ? rangeTimes : [now]));
  const maxTime = Math.max(minTime + 3_600_000, maxCandidate);
  const observationTime = minTime + ((maxTime - minTime) * timeline) / 100;
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
    }];
  }));
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
      // Focusing an offscreen target may synchronously scroll the map. Measure
      // that new scrollLeft in the same key event and once after the browser's
      // focus scroll has settled, so the preview never uses stale geometry.
      button.focus();
      measureFlowViewport();
      window.requestAnimationFrame(measureFlowViewport);
    }
  }, [eventsByLane, lanes, measureFlowViewport]);
  const defaultIndex = lanes.findIndex((lane) => lane.branch === project.default_branch);
  const rowHeight = 72;
  const mergedCount = project.lanes.filter((lane) => lane.branch !== project.default_branch && isFoldedMerged(lane)).length;
  const nowX = Math.min(100, Math.max(0, ((now - minTime) / (maxTime - minTime)) * 100));

  return (
    <section className="flow-section" aria-labelledby="flow-map-title">
      <div className="flow-controls">
        <div>
          <p className="eyebrow">DEVELOPMENT FLOW</p>
          <h3 id="flow-map-title">Git から観測した作業レーン</h3>
          <p className="section-copy">分岐点は実際の merge-base、イベントはコミットです。agent の工程は推測しません。</p>
        </div>
        <div className="flow-control-actions">
          {mergedCount > 0 && (
            <button className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>
              {showMerged ? "merged を折り畳む" : `merged・完了を表示 (${mergedCount})`}
            </button>
          )}
          <label className="timeline-control">
            <span>観測時点</span>
            <input
              aria-label="過去の観測時点"
              max="100"
              min="0"
              onChange={(event) => onTimelineChange(Number(event.target.value))}
              step="1"
              type="range"
              value={timeline}
            />
            <output>{timeline === 100 ? "現在" : `${timeline}%`}</output>
          </label>
        </div>
      </div>
      {!project.graph && <div className="inline-note">コミットグラフは未取得です。</div>}
      <div className="flow-legend" aria-label="フロー凡例">
        <span><i className="legend-dot legend-dot-head" aria-hidden="true" /> HEAD</span>
        <span><i className="legend-dot legend-dot-commit" aria-hidden="true" /> コミット</span>
        <span><i className="legend-dot legend-dot-merge" aria-hidden="true" /> merge</span>
        <span><i className="legend-line legend-line-branch" aria-hidden="true" /> 作業経路</span>
        <span><i className="legend-line legend-line-base" aria-hidden="true" /> 既定ブランチ</span>
        <span><i className="legend-dot legend-dot-unknown" aria-hidden="true" /> agent 状態不明</span>
      </div>
      {lanes.length === 0 ? (
        <div className="empty-flow">表示できる作業レーンはありません。merged・完了を表示すると確認できます。</div>
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
            <span>分岐関係 / 作業先端</span>
            <div className="flow-axis-track">
              <span>{new Date(minTime).toLocaleDateString("ja-JP")}</span>
              <span>{new Date(minTime + (maxTime - minTime) / 2).toLocaleDateString("ja-JP")}</span>
              <span>{new Date(maxTime).toLocaleDateString("ja-JP")}</span>
            </div>
          </div>
          <div className="flow-rows" style={{ "--flow-row-height": `${rowHeight}px`, "--flow-lanes": lanes.length, "--flow-track-min-width": `${trackWidth}px`, "--flow-track-width": `${trackWidth}px` } as React.CSSProperties}>
          <svg
            aria-hidden="true"
            className="flow-connections"
            preserveAspectRatio="none"
            viewBox={`0 0 1000 ${lanes.length * rowHeight}`}
          >
            <line className="flow-now-line" x1={nowX * 10} x2={nowX * 10} y1="0" y2={lanes.length * rowHeight} />
            {lanes.map((lane, index) => {
              const laneEvents = eventsByLane.get(lane.id) ?? [];
              const last = laneEvents.at(-1);
              const baseline = defaultIndex >= 0 ? defaultIndex * rowHeight + rowHeight / 2 : null;
              const y = index * rowHeight + rowHeight / 2;
              const mergeBase = mergeBasePositions.get(lane.id);
              const startX = mergeBase?.available ? mergeBase.x * 10 : 0;
              const endX = last ? last.x * 10 : startX;
              const isDefault = lane.branch === project.default_branch;
              return (
                <g key={lane.id}>
                  <line className={isDefault ? "flow-base-line" : "flow-lane-line"} x1={isDefault ? 0 : startX} x2={isDefault ? 1000 : endX} y1={y} y2={y} />
                  {!isDefault && baseline !== null && (
                    <line className={lane.merge_base ? "flow-branch-link" : "flow-branch-link flow-branch-link-unknown"} x1={startX} x2={startX} y1={baseline} y2={y} />
                  )}
                </g>
              );
            })}
          </svg>
          {lanes.map((lane, index) => {
            const laneEvents = eventsByLane.get(lane.id) ?? [];
            const mergeBase = mergeBasePositions.get(lane.id);
            const snapshot = laneAgentSnapshotAt(lane, observedAgentEvents, observationTime)[0]
              ?? (timeline === 100 ? currentLaneAgent(lane) : null);
            return (
              <div className="flow-row" key={lane.id}>
                <div className="flow-lane-label" ref={index === 0 ? firstLaneLabelRef : undefined}>
                  <div className="flow-lane-title">
                    <span className="lane-shape" aria-hidden="true" />
                    <strong title={laneLabel(lane)}>{laneLabel(lane)}</strong>
                    {lane.branch === project.default_branch && <span className="baseline-tag">既定</span>}
                  </div>
                  <div className="flow-lane-meta">
                    <span className={`lane-state ${laneStateClass(lane, project.default_branch)}`}>{laneState(lane, project.default_branch)}</span>
                    <AgentFact task={snapshot} />
                    <span title={lane.path ?? undefined}>{lane.path ?? "パス未取得"}</span>
                    <span className={mergeBase?.outside ? "flow-range-note" : undefined}>{!lane.merge_base ? "分岐点 未取得" : !mergeBase?.available ? "分岐点 未取得" : mergeBase.outside ? "分岐点 表示範囲外" : "分岐点 表示中"}</span>
                  </div>
                </div>
                <div className="flow-track">
                  {laneEvents.length === 0 && <span className="flow-track-empty">イベント未取得</span>}
                  {laneEvents.map((event) => {
                    const popover = flowViewport
                      ? popoverPlacement({
                        pointX: flowViewport.left + renderedLabelWidth + (event.hitX * trackWidth) / 100 - flowViewport.scrollLeft,
                        viewportLeft: flowViewport.left,
                        viewportRight: flowViewport.right,
                      })
                      : { width: 290, offset: 0 };
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
                        popoverShift={popover.offset}
                        popoverWidth={popover.width}
                      />
                    );
                  })}
                  <span className="flow-lane-end" style={{ left: `${laneEvents.at(-1)?.x ?? 0}%` }} aria-hidden="true" />
                  <span className={`flow-lane-end-label${(laneEvents.at(-1)?.x ?? 0) < 24 ? " flow-lane-end-label-left" : (laneEvents.at(-1)?.x ?? 0) > 76 ? " flow-lane-end-label-right" : ""}`} style={(laneEvents.at(-1)?.x ?? 0) >= 24 && (laneEvents.at(-1)?.x ?? 0) <= 76 ? { left: `${laneEvents.at(-1)?.x ?? 0}%` } : undefined}>
                    <span>Git 最終</span>
                    <time dateTime={lane.last_commit?.date ?? undefined}>{relativeTime(lane.last_commit?.date)} · {exactDate(lane.last_commit?.date)}</time>
                  </span>
                </div>
              </div>
            );
          })}
          <div className="flow-current-label" style={{ left: `${renderedLabelWidth + (nowX * trackWidth) / 100}px` }} aria-hidden="true">
            {timeline === 100 ? "現在" : "観測時点"}
          </div>
          </div>
        </div>
      )}
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
  const lanes = project.lanes.filter((lane) => showMerged || lane.branch === project.default_branch || !isFoldedMerged(lane));
  const mergedCount = project.lanes.filter((lane) => lane.branch !== project.default_branch && isFoldedMerged(lane)).length;
  return (
    <section className="lanes-section" aria-labelledby="lanes-title">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">LANE REGISTER</p>
          <h3 id="lanes-title">作業一覧</h3>
          <p className="section-copy">Git の状態と agent の明示した現在地、次の判断を一覧します。</p>
        </div>
        {mergedCount > 0 && <button className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "merged を折り畳む" : `merged・完了を表示 (${mergedCount})`}</button>}
      </div>
      <div className="lane-table-wrap">
        <table className="lane-table">
          <thead>
            <tr><th>作業</th><th>状態 / agent</th><th>最終活動</th><th>既定ブランチとの差</th><th>最新メッセージ</th><th>合流先</th><th>次の工程 / 注意</th><th aria-label="操作" /></tr>
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
                <td className="unknown-cell">{lane.merge_target || "合流先不明"}</td>
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
        <div><p className="eyebrow">EVENT STREAM</p><h3 id="activity-title">アクティビティ</h3><p className="section-copy">Git と agent のイベントを絶対時刻順に表示します。発生元と状態は文字でも確認できます。</p></div>
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
      <div className="section-heading-row"><div><p className="eyebrow">PROJECT RECORD</p><h3 id="info-title">プロジェクト情報</h3><p className="section-copy">Git と明示的に取得できた保守情報だけを表示します。</p></div></div>
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
        <div><dt>作業先端</dt><dd><code>{lane.head ?? "未取得"}</code></dd></div>
        <div><dt>分岐点 (merge-base)</dt><dd><code>{lane.merge_base ?? "未取得"}</code></dd></div>
        <div><dt>最終イベント</dt><dd>{lane.last_commit?.subject ?? "未取得"}<small>{exactDate(lane.last_commit?.date)}</small></dd></div>
        <div><dt>既定ブランチとの差</dt><dd>{lane.default_ahead === null || lane.default_behind === null ? "未取得" : `ahead ${lane.default_ahead} · behind ${lane.default_behind}`}</dd></div>
        <div><dt>担当 agent</dt><dd>{currentLaneAgent(lane)?.agent_id || "未関連付け"}</dd></div>
        <div><dt>合流先</dt><dd>{lane.merge_target || "合流先不明"}</dd></div>
        <div><dt>次の工程 / 注意</dt><dd>{lane.next_phase || currentLaneAgent(lane)?.attention || "未取得"}</dd></div>
      </dl>
      {lane.next_command && <div className="selection-command"><span>Git 次コマンド</span><code>{lane.next_command.command}</code><small>{lane.next_command.reason}</small></div>}
      <button className="primary-action" type="button" onClick={() => onOpenGit(lane)}>既存の Git 詳細を開く</button>
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
) {
  useEffect(() => {
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
  }, [closeRef, onClose, rootRef]);
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
  useDialogKeyboard(panelRef, closeRef, onClose);
  const lane = project.lanes.find((item) => item.id === selectedLane) ?? (selectedEvent && "lane" in selectedEvent ? selectedEvent.lane : null);
  return (
    <aside ref={panelRef} className="control-selection" aria-label="選択詳細" aria-modal="true" role="dialog" tabIndex={-1}>
      <div className="selection-head"><span className="eyebrow">DETAIL</span><button ref={closeRef} className="icon-close" type="button" aria-label="詳細を閉じる" onClick={onClose}>×</button></div>
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
  const { repos, scanning, connected, agentEventVersion } = useRepoStream();
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
  }, [agentEventVersion, projectSnapshotKey, scanning, urlState.path, urlState.range]);

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
        <div className="control-hero-main"><p className="eyebrow">PROJECT CONTROL / GIT FACTS</p><h1 id="project-title">{project.name}</h1><p className="control-description">{project.description || "説明なし"}</p><div className="control-identifiers"><code title={project.remote ?? undefined}>{project.remote ?? "リモート未取得"}</code><span>既定 <strong>{project.default_branch ?? "未取得"}</strong></span><code title={project.main_path}>{project.main_path}</code></div><div className="control-latest-git" aria-label="Git最終イベント"><span className="eyebrow">LATEST GIT FACT</span>{project.latest_event ? <><strong>{project.latest_event.subject || "(no subject)"}</strong><time dateTime={project.latest_event.occurred_at ?? undefined}>{relativeTime(project.latest_event.occurred_at)} · {exactDate(project.latest_event.occurred_at)}</time><span>Git · コミット · {shortHash(project.latest_event.commit_hash)}</span></> : <span>Git · 最終イベント 未取得</span>}</div></div>
        <div className="control-metrics" aria-label="プロジェクト集計"><div><strong>{agentCount(project, "waiting_for_user")}</strong><span>入力待ち</span></div><div><strong>{agentCount(project, "blocked")}</strong><span>問題あり</span></div><div><strong>{agentCount(project, "active")}</strong><span>実行中</span></div><div><strong>{agentCount(project, "review_required")}</strong><span>レビュー待ち</span></div><div><strong>{agentCount(project, "merge_ready")}</strong><span>統合可能</span></div><div><strong>{project.lanes.length}</strong><span>Gitレーン</span></div></div>
      </section>
      <nav className="control-tabs" role="tablist" aria-label="プロジェクト管制画面">
        {tabs.map((tab) => <button aria-selected={urlState.tab === tab.id} className="control-tab" key={tab.id} role="tab" type="button" onClick={() => updateUrl({ tab: tab.id })}><span>{tab.label}</span><small>{tab.short}</small></button>)}
      </nav>
      {urlState.tab === "flow" && <div className="range-tabs" role="toolbar" aria-label="時間範囲">{ranges.map((range) => <button aria-pressed={urlState.range === range.id} className="range-tab" key={range.id} type="button" onClick={() => updateUrl({ range: range.id, at: 100 })}>{range.label}</button>)}</div>}
      <div className={`control-layout${selectedEvent || selectedLane ? " has-selection" : ""}`}>
        <section className="control-main">
          {urlState.tab === "flow" && <FlowMap onSelect={selectEvent} onShowMergedChange={setShowMerged} onTimelineChange={(value) => updateUrl({ at: value })} project={project} range={urlState.range} selectedKey={selectedKey} showMerged={urlState.merged} timeline={urlState.at} />}
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
