"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  buildTimelineGeometry,
  relativeTime,
} from "./timeline.mjs";
import type { Repo, TimelineBranch, TimelineResponse } from "./types";

export type TimelineRange = "24h" | "7d" | "30d" | "all";

type TimelinePoint = {
  id: string;
  kind: "commit" | "fork" | "merge";
  hash: string | null;
  lane?: string;
  x: number;
  y: number;
  timestamp: number | null;
  commit?: {
    short: string;
    subject: string;
    author: string;
  };
  marker?: string;
  isHead?: boolean;
  behind?: number;
  branch?: TimelineBranch;
};

type TimelineGeometry = {
  width: number;
  height: number;
  start: number;
  end: number;
  trunkY: number;
  trunk: { points: TimelinePoint[]; line: string };
  lanes: Array<{
    branch: TimelineBranch;
    y: number;
    status: { key: string; label: string; token: string };
    dirty: boolean;
    dirtyCount: number;
    points: TimelinePoint[];
    line: string;
  }>;
  points: TimelinePoint[];
  ticks: Array<{ timestamp: number; label: string; x: number }>;
};

export type TimelineViewProps = {
  data: TimelineResponse;
  range: TimelineRange;
  onRangeChange: (range: TimelineRange) => void;
  dirtyWorktrees?: Map<string, Repo>;
  selectedHash?: string | null;
  onSelect?: (hash: string) => void;
};

const RANGES: Array<{ value: TimelineRange; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "すべて" },
];

function shortHash(hash: string | null | undefined) {
  return hash ? hash.slice(0, 7) : "不明";
}

function pointLabel(point: TimelinePoint, now: number, dirtyCount: number) {
  if (point.kind === "fork") {
    return `ここから分岐 · ベースより ${point.behind ?? 0} コミット後方`;
  }
  if (point.kind === "merge") {
    return `マージコミット ${shortHash(point.hash)} · ${relativeTime(point.timestamp, now)}`;
  }
  const commit = point.commit;
  const summary = `${shortHash(point.hash)} · ${commit?.subject ?? "コミット"} · ${commit?.author ?? "作者不明"} · ${relativeTime(point.timestamp, now)}`;
  if (point.marker === "dirty-head") return `${summary} · git status ${dirtyCount} 件`;
  if (point.marker === "merged-head") return `${summary} · merged`;
  return summary;
}

function PointGlyph({ point }: { point: TimelinePoint }) {
  if (point.kind === "fork") return <circle className="timeline-point timeline-point-fork" r="5" />;
  if (point.kind === "merge" || point.marker === "merged-head") {
    return <circle className="timeline-point timeline-point-merged" r="6" />;
  }
  if (point.marker === "dirty-head") {
    return <circle className="timeline-point timeline-point-dirty" r="7" />;
  }
  return <circle className="timeline-point timeline-point-commit" r={point.isHead ? 6 : 4.5} />;
}

function laneIndex(point: TimelinePoint, geometry: TimelineGeometry) {
  if (point.lane === "trunk") return 0;
  const index = geometry.lanes.findIndex((lane) => lane.branch.name === point.lane);
  return index < 0 ? 0 : index + 1;
}

function lanePoints(index: number, geometry: TimelineGeometry) {
  return index === 0 ? geometry.trunk.points : geometry.lanes[index - 1]?.points ?? [];
}

function nearestPoint(points: TimelinePoint[], source: TimelinePoint) {
  return points.reduce<TimelinePoint | null>((closest, point) => {
    if (!closest) return point;
    return Math.abs(point.x - source.x) < Math.abs(closest.x - source.x) ? point : closest;
  }, null);
}

function TimelineTooltip({ point, data, dirtyCount, geometry }: { point: TimelinePoint; data: TimelineResponse; dirtyCount: number; geometry: TimelineGeometry }) {
  const width = Math.min(320, Math.max(0, geometry.width - 16));
  const half = width / 2;
  const left = Math.max(8 + half, Math.min(geometry.width - 8 - half, point.x));
  const top = `${Math.max(34, point.y - 8)}px`;
  return (
    <div className="timeline-tooltip" role="status" style={{ left: `${left}px`, top, width: `${width}px` }}>
      <strong>{pointLabel(point, data.now, dirtyCount)}</strong>
    </div>
  );
}

export default function TimelineView({
  data,
  range,
  onRangeChange,
  dirtyWorktrees,
  selectedHash,
  onSelect,
}: TimelineViewProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(960);
  const visualRef = useRef<HTMLDivElement>(null);
  const pointRefs = useRef<Map<string, SVGGElement>>(new Map());
  useEffect(() => {
    const node = visualRef.current;
    if (!node) return;
    const updateWidth = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setViewportWidth(next);
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(
    () => buildTimelineGeometry(data, { range, width: viewportWidth, dirtyWorktrees }) as TimelineGeometry,
    [data, dirtyWorktrees, range, viewportWidth],
  );

  useEffect(() => {
    if (!geometry.points.length) {
      setActiveId(null);
      return;
    }
    if (!activeId || !geometry.points.some((point) => point.id === activeId)) {
      setActiveId(geometry.points[0].id);
    }
  }, [activeId, geometry.points]);

  const focusPoint = (point: TimelinePoint | null) => {
    if (!point) return;
    setActiveId(point.id);
    window.setTimeout(() => pointRefs.current.get(point.id)?.focus(), 0);
  };

  const moveWithinLane = (point: TimelinePoint, direction: -1 | 1) => {
    const points = lanePoints(laneIndex(point, geometry), geometry);
    const index = points.findIndex((candidate) => candidate.id === point.id);
    focusPoint(points[index + direction] ?? point);
  };

  const moveAcrossLanes = (point: TimelinePoint, direction: -1 | 1) => {
    const index = laneIndex(point, geometry);
    const targetIndex = Math.max(0, Math.min(geometry.lanes.length, index + direction));
    focusPoint(nearestPoint(lanePoints(targetIndex, geometry), point));
  };

  const handlePointKeyDown = (event: ReactKeyboardEvent<SVGGElement>, point: TimelinePoint) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveWithinLane(point, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveAcrossLanes(point, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && point.hash && onSelect) {
      event.preventDefault();
      onSelect(point.hash);
    }
  };

  const hovered = hoveredId ? geometry.points.find((point) => point.id === hoveredId) ?? null : null;
  const hoveredLane = hovered?.branch;
  const hoveredDirtyCount = hoveredLane ? geometry.lanes.find((lane) => lane.branch.name === hoveredLane.name)?.dirtyCount ?? 0 : 0;

  return (
    <div className="timeline-view">
      <div className="timeline-toolbar">
        <div className="timeline-range" role="group" aria-label="タイムラインの範囲">
          {RANGES.map((item) => (
            <button
              className="timeline-range-button"
              type="button"
              key={item.value}
              aria-pressed={range === item.value}
              onClick={() => onRangeChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="timeline-legend" aria-label="タイムライン記号">
          <span>● commit</span>
          <span>◉ 変更あり</span>
          <span>○ merged</span>
        </div>
      </div>
      <div className="timeline-visual" ref={visualRef} style={{ minHeight: geometry.height }}>
        <svg
          aria-label="ブランチタイムライン"
          className="timeline-svg"
          role="img"
          style={{ height: `${geometry.height}px` }}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="none"
        >
          <line className="timeline-axis" x1="0" x2={geometry.width} y1="22" y2="22" />
          {geometry.ticks.map((tick) => (
            <g key={tick.timestamp}>
              <line className="timeline-tick" x1={tick.x} x2={tick.x} y1="22" y2={geometry.height} />
              <text className="timeline-tick-label" x={tick.x} y="15" textAnchor="middle">
                {tick.label}
              </text>
            </g>
          ))}
          <polyline className="timeline-trunk" fill="none" points={geometry.trunk.line} />
          {geometry.lanes.map((lane) => (
            <polyline
              className={`timeline-branch-line timeline-branch-line-${lane.status.token}`}
              fill="none"
              key={lane.branch.name}
              points={lane.line}
            />
          ))}
          {geometry.points.map((point) => {
            const lane = point.branch ? geometry.lanes.find((item) => item.branch.name === point.branch?.name) : null;
            const count = lane?.dirtyCount ?? 0;
            const label = pointLabel(point, data.now, count);
            const interactive = Boolean(point.hash && onSelect);
            return (
              <g
                aria-label={label}
                aria-current={selectedHash && point.hash === selectedHash ? "true" : undefined}
                className={`timeline-point-group${selectedHash && point.hash === selectedHash ? " timeline-point-selected" : ""}`}
                key={point.id}
                onClick={interactive ? () => onSelect?.(point.hash as string) : undefined}
                onFocus={() => setActiveId(point.id)}
                onKeyDown={(event) => handlePointKeyDown(event, point)}
                onMouseEnter={() => setHoveredId(point.id)}
                onMouseLeave={() => setHoveredId(null)}
                ref={(node) => {
                  if (node) pointRefs.current.set(point.id, node);
                  else pointRefs.current.delete(point.id);
                }}
                role={interactive ? "button" : undefined}
                tabIndex={interactive && activeId === point.id ? 0 : -1}
                transform={`translate(${point.x} ${point.y})`}
              >
                <circle className="timeline-point-hit" r="24" />
                <PointGlyph point={point} />
              </g>
            );
          })}
        </svg>
        <div className="timeline-label-layer" aria-hidden="true">
          <div className="timeline-lane-label timeline-lane-label-trunk" style={{ top: geometry.trunkY - 15 }}>
            <strong>base</strong>
            <span>{data.base?.name}</span>
          </div>
          {geometry.lanes.map((lane) => (
            <div className="timeline-lane-label" key={lane.branch.name} style={{ top: lane.y - 15 }}>
              <strong>{lane.branch.name}</strong>
              {lane.branch.worktree && <span title={lane.branch.worktree}>worktree</span>}
            </div>
          ))}
        </div>
        <div className="timeline-status-layer" aria-label="ブランチ状態">
          <div className="timeline-status timeline-status-trunk">現在</div>
          {geometry.lanes.map((lane) => (
            <div className="timeline-status" key={lane.branch.name} style={{ top: lane.y - 22 }}>
              <span className={`state-badge token-${lane.status.token}`}>{lane.status.label}</span>
              <span className="timeline-ahead-behind">
                ahead {lane.branch.ahead} · behind {lane.branch.behind}
              </span>
            </div>
          ))}
        </div>
        {hovered && <TimelineTooltip point={hovered} data={data} dirtyCount={hoveredDirtyCount} geometry={geometry} />}
      </div>
    </div>
  );
}
