# gitdash 残作業: グラフ / コミット詳細 / ブランチ一覧 / グルーピング

2026-08-27。引き継ぎ計画書 `plans/20260827-graph-handoff.md` の §5 を実装する。

## 方針

裏テーマ（使ううちに git を覚える）を壊さない。
- pull / push ボタンは作らない。読み取り専用を維持する
- 各ビューに等価な人間向けコマンドを表示する（`git log --oneline --graph` 等）
- 独自記号を作らない

## 分割

| ブランチ | 範囲 |
|---|---|
| `feat/graph-api` | backend: `/api/repo/graph` `/api/repo/commit` `/api/repo/branches` |
| `feat/graph-ui` | frontend: グラフ描画、コミット詳細ペイン、ブランチ一覧、グルーピング |

backend と frontend でファイルが重ならないので並列で進める。
レスポンス形状は引き継ぎ計画書 §5 の定義を契約として双方が従う。

## 不変条件（レビュー観点）

1. 新規エンドポイントの `path` は `STATE` に存在するものだけ許可する。
   任意パスを受けるとコンテナ内の任意ディレクトリで git を実行できてしまう
2. 新しく足す git 実行は必ず `_repo_lock()` を経由する（inotify 無限ループの再発防止）
3. `next.config.mjs` の `rewrites` に戻さない
4. グラフは 1 行 = 1 枚の小さな SVG。全体を 1 枚の巨大 SVG にしない
5. 同期 git 実行はイベントループを塞がないよう `run_in_executor` に載せる

## 検証

- 引き継ぎ計画書 §6 の fixture でグラフのレーン列を `git log --graph` と突き合わせる
- inotify 回帰テスト（アイドル 10 秒で 0 件、commit 1 回で 1 件）
- `npm run build` の通過と UI の実表示確認
