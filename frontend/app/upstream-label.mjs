export const missingLocalTrackingRefLabel = "追跡参照がローカルにない";

export function upstreamLabel(lane) {
  if (lane.upstream === null) return "追跡先なし";
  if (!lane.upstream) return "追跡先を取得できませんでした";
  if (lane.upstream_ahead === null || lane.upstream_behind === null) {
    return `upstream ${lane.upstream} · push 状態未取得`;
  }
  return `追跡先 ${lane.upstream} · ahead ${lane.upstream_ahead} · behind ${lane.upstream_behind}`;
}
