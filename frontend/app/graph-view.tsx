"use client";

import type { CSSProperties, KeyboardEvent } from "react";

export type GraphRefKind = "head" | "branch" | "remote" | "tag";

export type GraphRef = {
  name: string;
  kind: GraphRefKind;
};

export type GraphRow = {
  hash: string;
  short: string;
  parents: string[];
  refs: GraphRef[];
  author: string;
  date: string;
  subject: string;
  lane: number;
  in_lanes: number[];
  through: number[];
  out_lanes: number[];
  is_head: boolean;
  is_merge: boolean;
};

export type GraphVirtualNode = {
  lane: number;
  label: string;
  summary?: string;
};

export type GraphItem = GraphRow | GraphVirtualNode;

export type GraphViewProps = {
  rows: GraphRow[];
  maxLane: number;
  virtualNode?: GraphVirtualNode | null;
  selectedHash?: string | null;
  onSelect?: (hash: string) => void;
  onVirtualSelect?: () => void;
  ariaLabel?: string;
  className?: string;
};

const LANE_WIDTH = 14;
const ROW_HEIGHT = 30;
const NODE_RADIUS = 4;
const NODE_X_OFFSET = 8;
const MAX_VISIBLE_LANES = 8;

const graphWidth = (maxLane: number) =>
  Math.min(maxLane + 1, MAX_VISIBLE_LANES) * LANE_WIDTH + 16;

const laneX = (lane: number) => lane * LANE_WIDTH + NODE_X_OFFSET;

function isGraphRow(item: GraphItem): item is GraphRow {
  return "hash" in item;
}

function rowKey(item: GraphItem) {
  return isGraphRow(item) ? item.hash : "virtual-node";
}

function rowLabel(item: GraphItem) {
  if (!isGraphRow(item)) return item.label;
  return `${item.short}: ${item.subject}`;
}

function connectorPath(fromLane: number, toLane: number, fromY: number, toY: number) {
  const fromX = laneX(fromLane);
  const toX = laneX(toLane);
  if (fromLane === toLane) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }

  const bendY = (fromY + toY) / 2;
  return `M ${fromX} ${fromY} C ${fromX} ${bendY - 3} ${toX} ${bendY + 3} ${toX} ${toY}`;
}

const svgStyle: CSSProperties = {
  display: "block",
  flex: "0 0 auto",
  height: `${ROW_HEIGHT}px`,
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "8px",
  minHeight: `${ROW_HEIGHT}px`,
  textAlign: "left",
  width: "100%",
};

type GraphSvgProps = {
  item: GraphItem;
  width: number;
};

function GraphSvg({ item, width }: GraphSvgProps) {
  const lane = item.lane;
  const nodeX = laneX(lane);
  const lines = isGraphRow(item)
    ? [
        ...item.through.map((lineLane) => ({
          className: "graph-line graph-line-through",
          d: connectorPath(lineLane, lineLane, 0, ROW_HEIGHT),
          key: `through-${lineLane}`,
        })),
        ...item.in_lanes.map((lineLane) => ({
          className: "graph-line graph-line-in",
          d: connectorPath(lineLane, lane, 0, ROW_HEIGHT / 2),
          key: `in-${lineLane}`,
        })),
        ...item.out_lanes.map((lineLane, index) => ({
          className: "graph-line graph-line-out",
          d: connectorPath(lane, lineLane, ROW_HEIGHT / 2, ROW_HEIGHT),
          key: `out-${lineLane}-${index}`,
        })),
      ]
    : [];

  return (
    <svg
      aria-hidden="true"
      className="graph-svg"
      height={ROW_HEIGHT}
      style={svgStyle}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      width={width}
    >
      {lines.map((line) => (
        <path
          className={line.className}
          d={line.d}
          fill="none"
          key={line.key}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      ))}
      <circle
        className={isGraphRow(item) ? "graph-node graph-node-commit" : "graph-node graph-node-virtual"}
        cx={nodeX}
        cy={ROW_HEIGHT / 2}
        fill={isGraphRow(item) ? "currentColor" : "transparent"}
        r={NODE_RADIUS}
        stroke="currentColor"
        strokeDasharray={isGraphRow(item) ? undefined : "3 2"}
        strokeWidth="1.5"
      />
    </svg>
  );
}

function RefBadges({ refs }: { refs: GraphRef[] }) {
  return (
    <span className="graph-refs" aria-label="refs">
      {refs.map((ref) => (
        <span
          className={`graph-ref graph-ref-${ref.kind} ${ref.kind}`}
          key={`${ref.kind}-${ref.name}`}
        >
          {ref.name}
        </span>
      ))}
    </span>
  );
}

type GraphRowViewProps = {
  item: GraphItem;
  selected: boolean;
  width: number;
  onClick?: (item: GraphItem) => void;
};

function GraphRowView({ item, selected, width, onClick }: GraphRowViewProps) {
  const interactive = onClick !== undefined;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onClick || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onClick(item);
  };

  const commit = isGraphRow(item) ? item : null;
  const title = isGraphRow(item) ? item.subject : item.label;
  const meta = isGraphRow(item)
    ? `${item.short} · ${item.author} · ${item.date}`
    : item.summary;
  const classes = [
    "graph-row",
    selected ? "graph-row-selected" : "",
    commit?.is_head ? "graph-row-head" : "",
    commit?.is_merge ? "graph-row-merge" : "",
    !commit ? "graph-row-virtual" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      aria-label={rowLabel(item)}
      aria-current={selected ? "true" : undefined}
      aria-pressed={interactive ? selected : undefined}
      className={classes}
      onClick={onClick ? () => onClick(item) : undefined}
      onKeyDown={handleKeyDown}
      role={interactive ? "button" : "group"}
      style={rowStyle}
      tabIndex={interactive ? 0 : undefined}
    >
      <GraphSvg item={item} width={width} />
      <div className="graph-row-content">
        <div className="graph-row-title">
          {title}
          {commit && <RefBadges refs={commit.refs} />}
        </div>
        <div className="graph-row-meta">{meta}</div>
      </div>
    </div>
  );
}

export function GraphView({
  rows,
  maxLane,
  virtualNode = null,
  selectedHash = null,
  onSelect,
  onVirtualSelect,
  ariaLabel = "Commit graph",
  className,
}: GraphViewProps) {
  const width = graphWidth(maxLane);
  const items: GraphItem[] = virtualNode ? [virtualNode, ...rows] : rows;
  const classes = ["graph-view", className].filter(Boolean).join(" ");

  return (
    <div aria-label={ariaLabel} className={classes} role="group">
      {items.map((item) => (
        <GraphRowView
          item={item}
          key={rowKey(item)}
          onClick={
            isGraphRow(item)
              ? onSelect
                ? () => onSelect(item.hash)
                : undefined
              : onVirtualSelect
                ? onVirtualSelect
                : undefined
          }
          selected={isGraphRow(item) && selectedHash === item.hash}
          width={width}
        />
      ))}
    </div>
  );
}

export default GraphView;
