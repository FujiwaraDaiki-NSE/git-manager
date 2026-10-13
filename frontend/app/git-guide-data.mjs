export const GUIDE_FAVORITES_STORAGE_KEY = "gitdash.git-guide.favorites";
export const GUIDE_GROUPS = ["すべて", "変更", "履歴", "ブランチ"];
export const GUIDE_HISTORY_LIMITS = Object.freeze({ min: 1, max: 500 });
export const GUIDE_DEFAULT_HISTORY_COUNTS = Object.freeze({ log: 30, reflog: 20 });

export const gitGuide = [
  { id: "status", group: "変更", title: "変更の全体像", command: "status --short --branch", description: "現在のブランチと変更ファイルを確認します。左の記号はステージ、右は作業ディレクトリの状態です。" },
  { id: "unstaged", group: "変更", title: "未ステージの差分", command: "diff --", description: "作業ディレクトリとステージの差を表示します。未追跡ファイルの内容は含みません。" },
  { id: "staged", group: "変更", title: "次のコミットに含まれる差分", command: "diff --cached --", description: "ステージと直前のコミットを比較します。コミット前の確認に使います。" },
  { id: "conflict", group: "変更", title: "競合ファイルを確認", command: "diff --name-only --diff-filter=U --", description: "未解決の競合があるファイル名を表示します。変更を取り消すコマンドではありません。" },
  { id: "history", group: "履歴", title: "分岐と合流を見る", command: "log --graph --oneline --decorate --all -30", historyKey: "log", description: "ローカルで取得済みの参照から、直近30コミットとブランチの関係を表示します。" },
  { id: "latest", group: "履歴", title: "最新コミットの内容", command: "show --stat HEAD", description: "現在のHEADが指すコミットの説明とファイル別の変更量を確認します。最初のコミット前は利用できません。" },
  { id: "reflog", group: "履歴", title: "HEADの移動履歴", command: "reflog -20", historyKey: "reflog", description: "この作業ディレクトリでのcheckoutやcommitなど、HEADの最近20件の移動を確認します。共有される履歴ではありません。" },
  { id: "branches", group: "ブランチ", title: "追跡先とブランチ", command: "branch -vv", description: "各ローカルブランチの最新コミットと追跡先を表示します。リモートの情報は最終fetch時点です。" },
  { id: "worktrees", group: "ブランチ", title: "作業場所の一覧", command: "worktree list", description: "同じリポジトリを共有するworktreeのパスと、チェックアウトされたブランチを確認します。" },
  { id: "remotes", group: "ブランチ", title: "リモートの接続先", command: "remote -v", description: "fetchとpushに設定された接続先を表示します。通信やpushは実行しません。" },
  { id: "stash", group: "変更", title: "一時退避した変更", command: "stash list", description: "stashに保存した変更の一覧を確認します。退避内容の適用や削除は行いません。" },
];

const guideIds = new Set(gitGuide.map((item) => item.id));

export function validateGuideHistoryCount(raw) {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  if (!/^\d+$/.test(text)) return { valid: false, value: null, message: "1〜500の整数を入力してください。" };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < GUIDE_HISTORY_LIMITS.min || value > GUIDE_HISTORY_LIMITS.max) {
    return { valid: false, value: null, message: "1〜500の整数を入力してください。" };
  }
  return { valid: true, value, message: "" };
}

function historyCountFor(item, historyCounts) {
  if (!item.historyKey) return null;
  const result = validateGuideHistoryCount(historyCounts?.[item.historyKey]);
  if (!result.valid) throw new RangeError(`${item.historyKey}の履歴件数が不正です。`);
  return result.value;
}

export function guideCommandText(item, historyCounts) {
  const count = historyCountFor(item, historyCounts);
  if (count === null) return item.command;
  return item.command.replace(/-\d+$/, `-${count}`);
}

export function guideDescription(item, historyCounts) {
  const count = historyCountFor(item, historyCounts);
  if (item.id === "history") return `ローカルで取得済みの参照から、直近${count}コミットとブランチの関係を表示します。`;
  if (item.id === "reflog") return `この作業ディレクトリでのcheckoutやcommitなど、HEADの最近${count}件の移動を確認します。共有される履歴ではありません。`;
  return item.description;
}

export function guideMatches(item, query, group, historyCounts) {
  return (group === "すべて" || item.group === group) &&
    `${item.title} ${guideCommandText(item, historyCounts)} ${guideDescription(item, historyCounts)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function quoteGuidePath(path) {
  if (path === null) return null;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function guideCommand(path, command) {
  if (path === null) return `git ${command}`;
  return `git -C ${quoteGuidePath(path)} ${command}`;
}

export function guideCommands(path, items, historyCounts) {
  return items.map((item) => guideCommand(path, guideCommandText(item, historyCounts)));
}

export function parseGuideFavorites(raw) {
  if (raw === null) return new Set();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) throw new TypeError("お気に入りの保存データが不正です。");
  return new Set(parsed.filter((id) => guideIds.has(id)));
}

function markdownFence(value) {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function markdownText(value) {
  return value.replace(/[\r\n]+/g, " ");
}

export function guideMarkdown(items, path, historyCounts) {
  const sections = items.map((item) => {
    const command = guideCommand(path, guideCommandText(item, historyCounts));
    const fence = markdownFence(command);
    return `## ${markdownText(item.title)}\n\n${markdownText(guideDescription(item, historyCounts))}\n\n${fence}bash\n${command}\n${fence}`;
  });
  return `# Gitコマンド チートシート\n\n状態確認用のコマンドです。実行前に対象と表示内容を確認してください。\n\n${sections.join("\n\n")}\n`;
}
