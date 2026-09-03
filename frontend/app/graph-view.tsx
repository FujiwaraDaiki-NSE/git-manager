"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { GraphRef, GraphRow } from "./types";

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

const laneX = (lane: number) =>
  Math.min(lane, MAX_VISIBLE_LANES - 1) * LANE_WIDTH + NODE_X_OFFSET;

function isGraphRow(item: GraphItem): item is GraphRow {
  return "hash" in item;
}

function rowKey(item: GraphItem) {
  return isGraphRow(item) ? item.hash : "virtual-node";
}

function rowId(item: GraphItem) {
  return isGraphRow(item) ? `graph-row-${item.hash}` : "graph-row-virtual";
}

function rowLabel(item: GraphItem) {
  if (!isGraphRow(item)) return item.label;
  const refs = item.refs.map((ref) => ref.name).join(", ");
  return refs
    ? `${item.short}: ${item.subject} (${refs})`
    : `${item.short}: ${item.subject}`;
}

function middleEllipsis(value: string, max: number) {
  if (value.length <= max) return value;
  const parts = value.split("/");
  if (parts.length >= 3) {
    const prefix = `${parts[0]}/…/`;
    const suffix = parts[parts.length - 1];
    return `${prefix}${suffix.slice(-(max - prefix.length))}`;
  }
  const side = Math.floor((max - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

function connectorPath(
  fromLane: number,
  toLane: number,
  fromY: number,
  toY: number,
) {
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
  connectFromVirtualLane?: number;
  throughVirtualLane?: number;
};

function GraphSvg({
  item,
  width,
  connectFromVirtualLane,
  throughVirtualLane,
}: GraphSvgProps) {
  const lane = item.lane;
  const nodeX = laneX(lane);
  const lines = isGraphRow(item)
    ? [
        ...(connectFromVirtualLane === undefined
          ? []
          : [
              {
                className: "graph-line graph-line-virtual",
                d: connectorPath(
                  connectFromVirtualLane,
                  lane,
                  0,
                  ROW_HEIGHT / 2,
                ),
                key: "virtual-in",
              },
            ]),
        ...(throughVirtualLane === undefined
          ? []
          : [
              {
                className: "graph-line graph-line-through",
                d: connectorPath(
                  throughVirtualLane,
                  throughVirtualLane,
                  0,
                  ROW_HEIGHT,
                ),
                key: "virtual-through",
              },
            ]),
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
    : [
        {
          className: "graph-line graph-line-virtual",
          d: connectorPath(lane, lane, ROW_HEIGHT / 2, ROW_HEIGHT),
          key: "virtual-out",
        },
      ];

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
        className={
          isGraphRow(item)
            ? "graph-node graph-node-commit"
            : "graph-node graph-node-virtual"
        }
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
          title={ref.name}
        >
          {middleEllipsis(ref.name, 34)}
        </span>
      ))}
    </span>
  );
}

type GraphRowViewProps = {
  item: GraphItem;
  selected: boolean;
  active: boolean;
  width: number;
  onClick?: (item: GraphItem) => void;
  onMove?: (item: GraphItem, direction: -1 | 1) => void;
  connectFromVirtualLane?: number;
  throughVirtualLane?: number;
};

function GraphRowView({
  item,
  selected,
  active,
  width,
  onClick,
  onMove,
  connectFromVirtualLane,
  throughVirtualLane,
}: GraphRowViewProps) {
  const interactive = onClick !== undefined;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onClick) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      onMove?.(item, event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick(item);
    }
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
      id={rowId(item)}
      onClick={onClick ? () => onClick(item) : undefined}
      onKeyDown={handleKeyDown}
      role={interactive ? "button" : "group"}
      style={rowStyle}
      tabIndex={interactive ? (active ? 0 : -1) : undefined}
    >
      <GraphSvg
        item={item}
        width={width}
        connectFromVirtualLane={connectFromVirtualLane}
        throughVirtualLane={throughVirtualLane}
      />
      <div className="graph-row-content">
        <div className="graph-row-title">
          <span className="graph-row-subject">{title}</span>
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
  ariaLabel = "コミットグラフ",
  className,
}: GraphViewProps) {
  const width = graphWidth(maxLane);
  const items: GraphItem[] = virtualNode ? [virtualNode, ...rows] : rows;
  const virtualKey = "virtual-node";
  const isInteractive = (item: GraphItem) =>
    isGraphRow(item) ? onSelect !== undefined : onVirtualSelect !== undefined;
  const firstHash = rows[0]?.hash ?? null;
  const firstKey = virtualNode && onVirtualSelect ? virtualKey : firstHash;
  const [activeKey, setActiveKey] = useState<string | null>(
    selectedHash ?? firstKey,
  );
  useEffect(() => {
    setActiveKey((current) => {
      if (selectedHash && rows.some((row) => row.hash === selectedHash))
        return selectedHash;
      if (
        current &&
        ((current === virtualKey && firstKey === virtualKey) ||
          (onSelect !== undefined && rows.some((row) => row.hash === current)))
      ) {
        return current;
      }
      return firstKey;
    });
  }, [firstKey, onSelect, onVirtualSelect, rows, selectedHash]);

  const select = (hash: string) => {
    setActiveKey(hash);
    onSelect?.(hash);
  };
  const selectVirtual = () => {
    setActiveKey(virtualKey);
    onVirtualSelect?.();
  };
  const move = (item: GraphItem, direction: -1 | 1) => {
    const index = items.findIndex(
      (candidate) => rowKey(candidate) === rowKey(item),
    );
    let nextIndex = index + direction;
    while (
      nextIndex >= 0 &&
      nextIndex < items.length &&
      !isInteractive(items[nextIndex])
    ) {
      nextIndex += direction;
    }
    const next = items[nextIndex];
    if (!next) return;
    const nextKey = rowKey(next);
    setActiveKey(nextKey);
    if (isGraphRow(next)) {
      select(next.hash);
    } else {
      selectVirtual();
    }
    document.getElementById(rowId(next))?.focus();
  };
  const classes = ["graph-view", className].filter(Boolean).join(" ");
  const headIndex = virtualNode ? rows.findIndex((row) => row.is_head) : -1;

  return (
    <div aria-label={ariaLabel} className={classes} role="group">
      {items.map((item, index) => {
        const commit = isGraphRow(item);
        const isVirtualHeadRow =
          Boolean(virtualNode) && commit && index === headIndex + 1;
        const isVirtualHeadIntermediate =
          Boolean(virtualNode) && commit && index > 0 && index < headIndex + 1;
        const interactive = isInteractive(item);
        return (
          <GraphRowView
            active={interactive && rowKey(item) === activeKey}
            connectFromVirtualLane={
              isVirtualHeadRow ? virtualNode?.lane : undefined
            }
            item={item}
            key={rowKey(item)}
            onClick={
              commit
                ? onSelect
                  ? () => select(item.hash)
                  : undefined
                : onVirtualSelect
                  ? selectVirtual
                  : undefined
            }
            onMove={interactive ? move : undefined}
            selected={commit && selectedHash === item.hash}
            throughVirtualLane={
              isVirtualHeadIntermediate ? virtualNode?.lane : undefined
            }
            width={width}
          />
        );
      })}
    </div>
  );
}

export default GraphView;
