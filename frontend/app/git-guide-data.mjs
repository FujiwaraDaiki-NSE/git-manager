export const gitGuide = [
  { id: "status", group: "変更", title: "変更の全体像", command: "status --short --branch", description: "現在のブランチと変更ファイルを確認します。左の記号はステージ、右は作業ディレクトリの状態です。" },
  { id: "unstaged", group: "変更", title: "未ステージの差分", command: "diff --", description: "作業ディレクトリとステージの差を表示します。未追跡ファイルの内容は含みません。" },
  { id: "staged", group: "変更", title: "次のコミットに含まれる差分", command: "diff --cached --", description: "ステージと直前のコミットを比較します。コミット前の確認に使います。" },
  { id: "conflict", group: "変更", title: "競合ファイルを確認", command: "diff --name-only --diff-filter=U --", description: "未解決の競合があるファイル名を表示します。変更を取り消すコマンドではありません。" },
  { id: "history", group: "履歴", title: "分岐と合流を見る", command: "log --graph --oneline --decorate --all -30", description: "ローカルで取得済みの参照から、直近30コミットとブランチの関係を表示します。" },
  { id: "latest", group: "履歴", title: "最新コミットの内容", command: "show --stat HEAD", description: "現在のHEADが指すコミットの説明とファイル別の変更量を確認します。最初のコミット前は利用できません。" },
  { id: "reflog", group: "履歴", title: "HEADの移動履歴", command: "reflog -20", description: "この作業ディレクトリでのcheckoutやcommitなど、HEADの最近の移動を確認します。共有される履歴ではありません。" },
  { id: "branches", group: "ブランチ", title: "追跡先とブランチ", command: "branch -vv", description: "各ローカルブランチの最新コミットと追跡先を表示します。リモートの情報は最終fetch時点です。" },
  { id: "worktrees", group: "ブランチ", title: "作業場所の一覧", command: "worktree list", description: "同じリポジトリを共有するworktreeのパスと、チェックアウトされたブランチを確認します。" },
  { id: "remotes", group: "ブランチ", title: "リモートの接続先", command: "remote -v", description: "fetchとpushに設定された接続先を表示します。通信やpushは実行しません。" },
  { id: "stash", group: "変更", title: "一時退避した変更", command: "stash list", description: "stashに保存した変更の一覧を確認します。退避内容の適用や削除は行いません。" },
];

export function guideMatches(item, query, group) {
  return (group === "すべて" || item.group === group) &&
    `${item.title} ${item.command} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function guideCommand(path, command) {
  if (path === null) return `git ${command}`;
  return `git -C '${path.replace(/'/g, "'\\''")}' ${command}`;
}
