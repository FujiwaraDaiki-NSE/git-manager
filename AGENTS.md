# gitdash

## 目指すゴール

- わかりやすいUIで、複数プロジェクト・ブランチ・worktreeを統一的に管理できるアプリにする。
- 使っているうちに、Gitの状態と操作の意味、対応するコマンドを理解できるようにする。

## 起動方法

Docker / Docker Compose を使用し、リポジトリのルートで実行する。

現在のホストではユーザー共通hooksの設定を使用するため、起動・再作成・変更反映は
`/home/solution2024/.local/bin/gitdash-compose up -d --build` を使用する（実行ディレクトリは任意）。
このコマンドはホストの `gh auth token --hostname github.com` を `GH_TOKEN` にexportし、
リポジトリの `.env` と `~/.config/gitdash/agent.env` を順に読み込む。
agent APIは認証不要。GitHub PR情報にはホスト環境変数GH_TOKEN / GITHUB_TOKENをそのまま渡す（README参照）。
稼働確認・ログ確認・停止も同じコマンドの `ps`、`logs --tail=100 backend frontend`、`down` を使用する。

別のホストで初めて起動する場合:

1. 初回のみ `.env.example` を `.env` にコピーする。既存の `.env` は上書きしない。
2. `.env` に以下を設定する。
   - `GITDASH_SCAN_ROOT`: 探索するホスト側ディレクトリの絶対パス。
   - `GITDASH_UID` / `GITDASH_GID`: `id -u` / `id -g` の値。
   - `GITDASH_AGENT_PORT`: agent API用の空きポート。
   - `GITDASH_AGENT_TOKEN`: ランダムな秘密値。
   - `GITDASH_AGENT_ENDPOINT`: `http://127.0.0.1:<GITDASH_AGENT_PORT>/api/agent-events`。
3. 起動・変更反映: `docker compose up -d --build`
4. ブラウザで http://localhost:4412 を開く。

- 稼働確認: `docker compose ps`
- ログ確認: `docker compose logs --tail=100 backend frontend`
- 停止: `docker compose down`
- 永続データは `gitdash-data` ボリュームの `/data` に保存する。

## 構成・確認

- `frontend/`: Next.js / React / TypeScript。画面と `/api/*` の中継。
- `backend/app/`: Python / FastAPI。Git探索・状態取得・agentイベント保存。Python環境は `uv` を使う。
- `docker-compose.yml`: 起動・マウント・環境変数の定義。linked worktreeの参照を保つため、探索先はホストと同じ絶対パスへマウントする。
- frontend確認: `cd frontend && npm ci && npm test && npm run build`
- backendテスト: `cd backend && uv run --with pytest python -m pytest`
- UI変更のE2E確認はブラウザでの実画面確認まで行う。

## 現在の動作と参照先

- 現在は状態確認とコマンド提示が中心。自動fetchは行うが、pull / pushはユーザーがターミナルで実行する。
- 原因不明の問題は、再現・ログ・API・保存状態・実効設定・稼働環境から調べる。
- 変更時はソース・テスト・Compose・コンテナへの反映を一つの作業として扱う。
- 詳細な仕様・設定・コンテナを使わない開発起動は `README.md` を参照する。
- 現在のホストのagent連携は `~/.codex/hooks.json` のユーザー共通command hooksで行う。開始・終了の履歴はhooks、作業状態はユーザー共通MCP `gitdash` から報告する。
- 共通送信スクリプトは `~/.codex/hooks/git_manager_agent_event.py`、共通設定は `~/.config/gitdash/agent.env`（権限 `600`）。全プロジェクトに適用し、gitdashが認識するGitリポジトリ／worktreeのイベントを保存する。
- 共通hooksとリポジトリ内hooksの同じ送信処理を重複して有効化しない。認証情報はコミットしない。

## gitdashへの作業状況の報告

- `gitdash` の `report_agent_status` が利用可能な場合、Gitリポジトリでの作業開始時、工程変更時、ユーザーの確認が必要になった時、最終回答前に実際の状態を報告する。同じ状態・説明の繰り返し送信は不要。
- `worktree` は実際に作業するGitルートの絶対パス、`status` は明示的な状態、`summary` は短い説明（不要なら `null`）。worktreeへ移動した後は、そのworktreeを指定する。
- 調査は `investigating`、実装は `implementing`、テストは `testing`、レビューは `reviewing`。回答・判断を待つ場合は `waiting_for_user`、作業を進められない場合は `blocked` とし、何を確認・解決すべきか説明する。
- レビュー依頼は `review_required`、必要な確認が済んでマージ判断を待つ場合は `merge_ready`、依頼を完了した場合は `completed`、作業を中断する場合は `stopped`。最終回答するという理由だけで、レビュー待ち・入力待ちを完了に置き換えない。
- 同じブランチを分担するサブエージェントの報告は親がまとめる。別ブランチで作業する場合は各担当がそのブランチを報告する。
- hooksは開始・終了などの履歴を記録するだけで、判断状態の報告を代行しない。未接続や未登録worktreeなどで送信に失敗した場合は成功と扱わず、作業を続けて最後に未送信を伝える。パスの推測やRESTへの自動切り替えはしない。
