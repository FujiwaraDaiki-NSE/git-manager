export const validCodeSize = value => typeof value === "string" && ["small", "medium", "large"].includes(value);
export const validPaneWidth = value => typeof value === "number" && Number.isFinite(value) && value >= 280 && value <= 900;
export const validCommitColumns = value => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === "boolean");
export function clampPaneWidth(value, minimum) { return Math.max(minimum, Math.min(900, value)); }
export function scrollEdges(left, width, total) { return {left:left > 1, right:left + width < total - 1}; }
