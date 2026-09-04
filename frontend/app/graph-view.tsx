"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  COMMON_ANCESTOR_MARKER,
  MAX_BRANCH_NAMES_PER_GROUP,
  buildBranchRelationGeometry,
} from "./branch-relation.mjs";
import type {
  BranchRelationSummary,
  GraphRef,
  GraphRow,
} from "./types";

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

type BranchRelationSummaryProps = {
  summary: BranchRelationSummary;
};

function relationPathLabel(path: GraphRow[] | null) {
  if (!path || path.length === 0) return "表示範囲外のため算出できません";
  const ancestor = path[0];
  const head = path[path.length - 1];
  const endpoint =
    ancestor.hash === head.hash
      ? ancestor.short
      : `${ancestor.short} → ${head.short}`;
  return `${endpoint}（${path.length - 1} コミット）`;
}

function BranchRelationDiagram({ summary }: BranchRelationSummaryProps) {
  const geometry = buildBranchRelationGeometry(summary);
  return (
    <svg
      aria-hidden="true"
      className="branch-relation-svg"
      height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      width={geometry.width}
    >
      {geometry.relations.map(({
        relation,
        branchPoints,
        defaultPoints,
        headPoint,
        branchHead,
        samePath,
        sharedHead,
        hasPath,
        branchLine,
        defaultLine,
        showCommonAncestor,
      }) => {
        const isDefault = relation.names.includes(summary.defaultBranch ?? "");
        return (
          <g key={relation.headHash}>
            {defaultLine && (
              <polyline
                className="branch-relation-line branch-relation-line-default"
                fill="none"
                points={defaultPoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            )}
            {branchLine && (
              <polyline
                className={`branch-relation-line ${
                  isDefault
                    ? "branch-relation-line-default"
                    : "branch-relation-line-branch"
                }`}
                fill="none"
                points={branchPoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            )}
            {showCommonAncestor && (
              <circle
                className="branch-relation-common"
                cx={branchPoints[0].x}
                cy={branchPoints[0].y}
                fill={COMMON_ANCESTOR_MARKER.fill}
                r={COMMON_ANCESTOR_MARKER.radius}
                stroke={COMMON_ANCESTOR_MARKER.stroke}
                strokeWidth={COMMON_ANCESTOR_MARKER.strokeWidth}
              />
            )}
            {hasPath &&
              defaultPoints.slice(1, -1).map((point) => (
                <circle
                  className="branch-relation-node branch-relation-node-default"
                  cx={point.x}
                  cy={point.y}
                  key={`default-${point.hash}`}
                  r="2.5"
                />
              ))}
            {hasPath &&
              !samePath &&
              branchPoints.slice(1, -1).map((point) => (
                <circle
                  className={`branch-relation-node ${
                    isDefault
                      ? "branch-relation-node-default"
                      : "branch-relation-node-branch"
                  }`}
                  cx={point.x}
                  cy={point.y}
                  key={`branch-${point.hash}`}
                  r="2.5"
                />
              ))}
            {branchHead && (
              <circle
                className={
                  isDefault || sharedHead
                    ? "branch-relation-head branch-relation-head-default"
                    : "branch-relation-head"
                }
                cx={branchHead.x}
                cy={branchHead.y}
                fill="currentColor"
                r="4"
              />
            )}
            {hasPath && !samePath && defaultPoints.length > 0 && (
              <circle
                className="branch-relation-head branch-relation-head-default"
                cx={defaultPoints[defaultPoints.length - 1].x}
                cy={defaultPoints[defaultPoints.length - 1].y}
                fill="currentColor"
                r="3"
              />
            )}
            {!hasPath && headPoint && (
              <circle
                className="branch-relation-head branch-relation-head-unavailable"
                cx={headPoint.x}
                cy={headPoint.y}
                fill="none"
                r="4"
                stroke="currentColor"
                strokeDasharray="3 2"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function BranchRelationSummary({
  summary,
}: BranchRelationSummaryProps) {
  return (
    <section
      aria-labelledby="branch-relation-summary-title"
      className="branch-relation-summary"
    >
      <div className="section-head">
        <div>
          <h3 id="branch-relation-summary-title">ブランチ関係</h3>
          <div className="branch-relation-baseline">
            ベースライン: {summary.defaultBranch ? (
              <code>{summary.defaultBranch}</code>
            ) : (
              <span>特定できません</span>
            )}
          </div>
        </div>
        <span className="branch-relation-count">
          {summary.branches.reduce((count, relation) => count + relation.names.length, 0)} ブランチ / {summary.branches.length} 組
        </span>
      </div>
      {summary.unavailableReason && (
        <div className="branch-relation-note" role="status">
          {summary.unavailableReason}
        </div>
      )}
      {summary.omittedGroups > 0 && (
        <div className="branch-relation-note" role="status">
          {summary.omittedGroups} 組（{summary.omittedBranches} ブランチ）を省略しています。
        </div>
      )}
      <div className="branch-relation-diagram" aria-hidden="true">
        <BranchRelationDiagram summary={summary} />
        <div className="branch-relation-diagram-key">
          <span>● ベースライン</span>
          <span>● 各 HEAD</span>
          <span>○ 共通祖先</span>
        </div>
      </div>
      <ol className="branch-relation-list">
        {summary.branches.map((relation) => {
          const names = relation.names.slice(0, MAX_BRANCH_NAMES_PER_GROUP);
          const omittedNames = relation.names.length - names.length;
          const isDefault = relation.names.includes(summary.defaultBranch ?? "");
          const branchLabel = names.join(", ");
          const branchTitle = omittedNames
            ? `${branchLabel}、他 ${omittedNames} ブランチ`
            : branchLabel;
          return (
            <li className="branch-relation-item" key={relation.headHash}>
              <div className="branch-relation-item-head">
                <strong title={branchTitle}>{branchLabel}</strong>
                {isDefault && (
                  <span className="branch-relation-default">既定</span>
                )}
                {omittedNames > 0 && (
                  <span className="branch-relation-group-count">
                    他 {omittedNames} ブランチ
                  </span>
                )}
                <code>{relation.headRow.short} HEAD</code>
              </div>
              {relation.commonAncestorRow ? (
                <div className="branch-relation-detail">
                  <span>
                    共通祖先 <code>{relation.commonAncestorRow.short}</code>
                  </span>
                  <span>
                    基準経路 <code>{relationPathLabel(relation.defaultPath)}</code>
                  </span>
                  <span>
                    {branchLabel} の経路{" "}
                    <code>{relationPathLabel(relation.branchPath)}</code>
                  </span>
                </div>
              ) : (
                <div className="branch-relation-detail">
                  <span>共通祖先と経路は表示範囲内から算出できません。</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
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
