import { shellQuote } from "./status-file-tools.mjs";

export const submoduleLabels = {
  uninitialized: "未初期化",
  different: "記録と異なるコミットをチェックアウト中",
  same: "一致",
  conflict: "マージ競合",
};

/**
 * @param {keyof typeof submoduleLabels} status
 * @param {string} path
 * @param {string} parentPath
 * @param {string | null} recordedCommit
 * @param {string | null} checkoutCommit
 */
export function submoduleCommands(status, path, parentPath, recordedCommit, checkoutCommit) {
  const quoted = shellQuote(path);
  switch (status) {
    case "uninitialized": return [{ meaning: "記録コミットで初期化します。", command: `git submodule update --init -- ${quoted}` }];
    case "different": {
      const commands = [];
      if (recordedCommit && checkoutCommit) {
        commands.push({
          meaning: "親のindexに記録したコミットと現在のチェックアウトの履歴を比較します。",
          command: `git -C ${shellQuote(`${parentPath}/${path}`)} log --left-right --oneline ${recordedCommit}...${checkoutCommit}`,
        });
      }
      commands.push(
        { meaning: "親リポジトリの記録コミットへ戻します。", command: `git submodule update -- ${quoted}` },
        { meaning: "現在のコミットを親リポジトリの次のコミットに記録するため、ステージします。", command: `git add -- ${quoted}` },
      );
      return commands;
    }
    case "same": return [];
    case "conflict": return [{ meaning: "競合を確認し、サブモジュールで採用するコミットを選んでから git add で解決を記録します。", command: "git status" }, { meaning: "採用するコミットをチェックアウトした後に実行します。", command: `git add -- ${quoted}` }];
  }
  throw new Error(`未対応のサブモジュール状態: ${status}`);
}
