// @ts-check

/**
 * @typedef {import("./types").BranchRelation} BranchRelation
 * @typedef {import("./types").BranchRelationSummary} BranchRelationSummary
 * @typedef {import("./types").GraphResponse} GraphResponse
 * @typedef {import("./types").GraphRow} GraphRow
 */

export const MAX_BRANCH_RELATION_GROUPS = 12;
export const MAX_BRANCH_NAMES_PER_GROUP = 6;
export const SUMMARY_ROW_HEIGHT = 30;
export const MAX_SUMMARY_HEIGHT = 280;
export const COMMON_ANCESTOR_MARKER = Object.freeze({
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  radius: 3,
});

const LANE_WIDTH = 14;
const NODE_X_OFFSET = 8;
const MAX_VISIBLE_LANES = 8;

/** @typedef {{hash: string, x: number, y: number}} SummaryPoint */

/**
 * @typedef {object} BranchRelationGeometry
 * @property {BranchRelation} relation
 * @property {SummaryPoint[]} branchPoints
 * @property {SummaryPoint[]} defaultPoints
 * @property {SummaryPoint|null} headPoint
 * @property {SummaryPoint|null} branchHead
 * @property {boolean} samePath
 * @property {boolean} hasPath
 * @property {boolean} branchLine
 * @property {boolean} defaultLine
 * @property {boolean} showCommonAncestor
 * @property {boolean} sharedHead
 */

/**
 * @typedef {object} BranchRelationGeometryResult
 * @property {number} width
 * @property {number} height
 * @property {number} scaleY
 * @property {number} minIndex
 * @property {number} maxIndex
 * @property {BranchRelationGeometry[]} relations
 */

/** @param {number} maxLane */
function graphWidth(maxLane) {
  return Math.min(maxLane + 1, MAX_VISIBLE_LANES) * LANE_WIDTH + 16;
}

/** @param {number} lane */
function laneX(lane) {
  return Math.min(lane, MAX_VISIBLE_LANES - 1) * LANE_WIDTH + NODE_X_OFFSET;
}

/**
 * @param {string} startHash
 * @param {Map<string, GraphRow>} rowsByHash
 * @returns {Map<string, number>}
 */
function ancestorDistances(startHash, rowsByHash) {
  const distances = new Map([[startHash, 0]]);
  const queue = [startHash];
  for (let index = 0; index < queue.length; index += 1) {
    const hash = queue[index];
    const row = rowsByHash.get(hash);
    if (!row) continue;
    const distance = distances.get(hash);
    if (distance === undefined) continue;
    for (const parent of row.parents) {
      if (!rowsByHash.has(parent) || distances.has(parent)) continue;
      distances.set(parent, distance + 1);
      queue.push(parent);
    }
  }
  return distances;
}

/**
 * @param {string} startHash
 * @param {string} ancestorHash
 * @param {Map<string, GraphRow>} rowsByHash
 * @returns {GraphRow[]|null}
 */
function pathFromAncestor(startHash, ancestorHash, rowsByHash) {
  if (!rowsByHash.has(startHash) || !rowsByHash.has(ancestorHash)) return null;
  const childForParent = new Map();
  const visited = new Set([startHash]);
  const queue = [startHash];
  for (let index = 0; index < queue.length; index += 1) {
    const hash = queue[index];
    if (hash === ancestorHash) break;
    const row = rowsByHash.get(hash);
    if (!row) continue;
    for (const parent of row.parents) {
      if (!rowsByHash.has(parent) || visited.has(parent)) continue;
      visited.add(parent);
      childForParent.set(parent, hash);
      queue.push(parent);
    }
  }
  if (!visited.has(ancestorHash)) return null;

  const path = [];
  let hash = ancestorHash;
  while (true) {
    const row = rowsByHash.get(hash);
    if (!row) return null;
    path.push(row);
    if (hash === startHash) return path;
    const child = childForParent.get(hash);
    if (!child) return null;
    hash = child;
  }
}

/**
 * @param {string} branchHash
 * @param {string} defaultHash
 * @param {Map<string, GraphRow>} rowsByHash
 * @param {Map<string, number>} rowIndex
 * @returns {string|null}
 */
function mergeBase(branchHash, defaultHash, rowsByHash, rowIndex) {
  const branchDistances = ancestorDistances(branchHash, rowsByHash);
  const defaultDistances = ancestorDistances(defaultHash, rowsByHash);
  const common = [...branchDistances.keys()].filter((hash) =>
    defaultDistances.has(hash),
  );
  if (common.length === 0) return null;

  // Git merge-base keeps common ancestors that are not ancestors of another
  // common ancestor.  Distances only use rows in the displayed DAG, so a
  // candidate is rejected when the displayed history proves it is older than
  // another common candidate; an unavailable parent is never invented.
  const candidateAncestors = new Map(
    common.map((hash) => [hash, ancestorDistances(hash, rowsByHash)]),
  );
  const mergeBases = common.filter(
    (candidate) =>
      !common.some(
        (other) =>
          other !== candidate && candidateAncestors.get(other)?.has(candidate),
      ),
  );
  const candidates = mergeBases.length > 0 ? mergeBases : common;
  candidates.sort((left, right) => {
    const leftBranchDistance = branchDistances.get(left) ?? 0;
    const leftDefaultDistance = defaultDistances.get(left) ?? 0;
    const rightBranchDistance = branchDistances.get(right) ?? 0;
    const rightDefaultDistance = defaultDistances.get(right) ?? 0;
    const leftDistance = leftBranchDistance + leftDefaultDistance;
    const rightDistance = rightBranchDistance + rightDefaultDistance;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    const leftMax = Math.max(
      leftBranchDistance,
      leftDefaultDistance,
    );
    const rightMax = Math.max(
      rightBranchDistance,
      rightDefaultDistance,
    );
    if (leftMax !== rightMax) return leftMax - rightMax;
    return (
      (rowIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (rowIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return candidates[0] ?? null;
}

/** @param {GraphResponse} graph */
function defaultHeadRow(graph) {
  if (!graph.default_hash || graph.default_lane === null) return null;
  return graph.rows.find((row) => row.hash === graph.default_hash) ?? null;
}

/**
 * @param {GraphRow[]|null} path
 * @param {BranchRelationSummary} summary
 * @param {number} minIndex
 * @param {number} scaleY
 * @param {boolean} useDefaultLane
 * @returns {SummaryPoint[]}
 */
function pathPoints(path, summary, minIndex, scaleY, useDefaultLane) {
  if (!path) return [];
  const terminalHash = path[path.length - 1]?.hash;
  return path.flatMap((row) => {
    const index = summary.rowIndex[row.hash];
    if (index === undefined) return [];
    const lane =
      useDefaultLane &&
      row.hash === terminalHash &&
      summary.defaultLane !== null
        ? summary.defaultLane
        : row.lane;
    return [
      {
        hash: row.hash,
        x: laneX(lane),
        y:
          ((index - minIndex) * SUMMARY_ROW_HEIGHT + SUMMARY_ROW_HEIGHT / 2) *
          scaleY,
      },
    ];
  });
}

/**
 * @param {SummaryPoint[]} left
 * @param {SummaryPoint[]} right
 */
function samePathPoints(left, right) {
  return (
    left.length === right.length &&
    left.every((point, index) => point.hash === right[index].hash)
  );
}

/**
 * Calculate the SVG geometry used by BranchRelationSummary.
 *
 * All vertical coordinates come from the displayed row index.  The default
 * lane correction is applied only to the terminal point of the default path;
 * branch paths always retain their GraphRow lane, including local main when
 * it is ahead of origin/main.
 *
 * @param {BranchRelationSummary} summary
 * @returns {BranchRelationGeometryResult}
 */
export function buildBranchRelationGeometry(summary) {
  const rows = summary.branches.flatMap((relation) => [
    relation.headRow,
    ...(relation.branchPath ?? []),
    ...(relation.defaultPath ?? []),
  ]);
  const rowIndices = rows
    .map((row) => summary.rowIndex[row.hash])
    .filter((index) => index !== undefined);
  const minIndex = rowIndices.length ? Math.min(...rowIndices) : 0;
  const maxIndex = rowIndices.length ? Math.max(...rowIndices) : 0;
  const fullHeight = Math.max(
    (maxIndex - minIndex + 1) * SUMMARY_ROW_HEIGHT,
    SUMMARY_ROW_HEIGHT,
  );
  const height = Math.min(fullHeight, MAX_SUMMARY_HEIGHT);
  const scaleY = height / fullHeight;
  const relations = summary.branches.map((relation) => {
    const branchPoints = pathPoints(
      relation.branchPath,
      summary,
      minIndex,
      scaleY,
      false,
    );
    const defaultPoints = pathPoints(
      relation.defaultPath,
      summary,
      minIndex,
      scaleY,
      true,
    );
    const samePath = samePathPoints(branchPoints, defaultPoints);
    const hasPath = branchPoints.length > 0 && defaultPoints.length > 0;
    const branchLine = hasPath && !samePath && branchPoints.length > 1;
    const defaultLine = hasPath && defaultPoints.length > 1;
    const headPoint =
      pathPoints([relation.headRow], summary, minIndex, scaleY, false)[0] ??
      null;
    return {
      relation,
      branchPoints,
      defaultPoints,
      headPoint,
      branchHead: hasPath
        ? branchPoints[branchPoints.length - 1]
        : headPoint,
      samePath,
      hasPath,
      branchLine,
      defaultLine,
      showCommonAncestor: hasPath && relation.commonAncestorRow !== null,
      sharedHead: samePath && hasPath,
    };
  });
  return {
    width: graphWidth(summary.maxLane),
    height,
    scaleY,
    minIndex,
    maxIndex,
    relations,
  };
}

/**
 * @param {GraphResponse} graph
 * @returns {BranchRelationSummary|null}
 */
export function buildBranchRelationSummary(graph) {
  const rowsByHash = new Map(graph.rows.map((row) => [row.hash, row]));
  const rowIndex = new Map(graph.rows.map((row, index) => [row.hash, index]));
  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  for (const { name, hash } of graph.branch_heads) {
    if (!rowsByHash.has(hash)) continue;
    const names = grouped.get(hash);
    if (names) names.push(name);
    else grouped.set(hash, [name]);
  }
  const visibleGroups = [...grouped.entries()].map(([headHash, names]) => ({
    headHash,
    names: names.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  }));
  if (visibleGroups.reduce((count, group) => count + group.names.length, 0) < 2)
    return null;

  const defaultHead = defaultHeadRow(graph);
  let unavailableReason = null;
  if (!graph.default_branch) {
    unavailableReason = "origin/HEAD がないため、既定ブランチを特定できません。";
  } else if (!defaultHead) {
    unavailableReason =
      "既定ブランチの HEAD が表示範囲外のため、経路を算出できません。";
  }
  const orderedGroups = visibleGroups.sort((left, right) => {
    const leftDefault = left.names.includes(graph.default_branch ?? "");
    const rightDefault = right.names.includes(graph.default_branch ?? "");
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    const leftName = left.names[0];
    const rightName = right.names[0];
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  const displayedGroups = orderedGroups.slice(0, MAX_BRANCH_RELATION_GROUPS);
  const omittedGroups = orderedGroups.length - displayedGroups.length;
  const omittedBranches = orderedGroups
    .slice(MAX_BRANCH_RELATION_GROUPS)
    .reduce((count, group) => count + group.names.length, 0);

  const branches = displayedGroups.map(({ headHash, names }) => {
    const headRow = /** @type {GraphRow} */ (rowsByHash.get(headHash));
    if (!defaultHead) {
      return {
        names,
        headHash,
        headRow,
        commonAncestorHash: null,
        commonAncestorRow: null,
        branchPath: null,
        defaultPath: null,
      };
    }
    const ancestorHash = mergeBase(
      headHash,
      defaultHead.hash,
      rowsByHash,
      rowIndex,
    );
    if (!ancestorHash) {
      return {
        names,
        headHash,
        headRow,
        commonAncestorHash: null,
        commonAncestorRow: null,
        branchPath: null,
        defaultPath: null,
      };
    }
    return {
      names,
      headHash,
      headRow,
      commonAncestorHash: ancestorHash,
      commonAncestorRow: rowsByHash.get(ancestorHash) ?? null,
      branchPath: pathFromAncestor(headHash, ancestorHash, rowsByHash),
      defaultPath: pathFromAncestor(defaultHead.hash, ancestorHash, rowsByHash),
    };
  }).filter(Boolean);

  return {
    defaultBranch: graph.default_branch,
    defaultLane: graph.default_lane,
    branches,
    rowIndex: Object.fromEntries(rowIndex),
    maxLane: graph.max_lane,
    omittedGroups,
    omittedBranches,
    unavailableReason,
  };
}
