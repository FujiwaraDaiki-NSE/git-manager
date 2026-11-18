export function fetchProgressLabel(progress) {
  if (progress === null || !progress.active) return null;
  return `fetch中 ${progress.done}/${progress.total}リポジトリ完了${progress.failed > 0 ? `・失敗${progress.failed}リポジトリ` : ""}`;
}
