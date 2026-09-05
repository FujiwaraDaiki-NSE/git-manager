# gitdash

PC内の Git リポジトリを自動で見つけて状態を一覧する、読み取り専用ダッシュボード。

- **登録作業なし** — ディスクを走査して `.git` があるフォルダを勝手に拾う
- **独自記法なし** — `git status -sb` の表記をそのまま使う
- **pull 可否を判定** — fetch して fast-forward できるか、分岐しているかを区別する
- **pull / push ボタンは無い** — 操作はターミナルで行う（後述）

## 起動

```bash
cp .env.example .env
# GITDASH_SCAN_ROOT に走査したいディレクトリ、UID/GID に `id -u` `id -g` の値を入れる
$EDITOR .env

docker compose up -d --build
```

http://localhost:4412 を開く。

通常の公開ポートは 4412 です。agent integration 用 backend は
`127.0.0.1:${GITDASH_AGENT_PORT}` にだけ bind され、`GITDASH_AGENT_TOKEN` の
Bearer 認証が必須です。ブラウザからの `/api/*` は frontend のルートハンドラ経由で
到達します。

## 表示するもの

| 項目                                                   | 元になる git コマンド                |
| ------------------------------------------------------ | ------------------------------------ |
| ブランチ、upstream、ahead / behind                     | `git status --porcelain=v2 --branch` |
| ファイルごとの XY コード                               | 同上                                 |
| 最終コミット                                           | `git log -1`                         |
| コミットグラフ                                         | `git log --oneline --graph`          |
| 既定ブランチとローカルブランチの分岐関係               | `git log --oneline --graph --all`    |
| コミット詳細（選択コミットの変更ファイルの統計、diff） | `git show <hash>`                    |
| ブランチ一覧                                           | `git branch -vv`                     |
| worktree 一覧と状態                                    | `git worktree list --porcelain`      |
| stash 数                                               | `git stash list`                     |
| リモート URL                                           | `git config --get remote.origin.url` |

一覧には `git status -sb` の 1 行目をそのまま出す。

リポジトリは本体と linked worktree を同じ「プロジェクト」にまとめ、本体、活動順の
worktree の順で表示する。worktree がないリポジトリは単独行のまま表示する。
`worktree`、`merged`、`prunable` などのフィルタでは、一致した行と所属プロジェクトを
残す。上部の集計カードからも対応するフィルタへ移動できる。

行を選ぶと、幅 1200px 以上では右ペイン、未満ではドロワーに詳細を表示する。
詳細は「状態」「グラフ」「ブランチ」のタブに分かれ、選択したタブだけを取得する。
グラフタブでは、既定ブランチを基準に、表示範囲内のローカルブランチ HEAD と
共通祖先からの経路を小さなサマリーグラフでも確認できる。
選択中のリポジトリとタブは URL に同期されるため、そのまま共有・再読込できる。
一覧では上下キーで行を移動し、Enter で選択、Escape で詳細を閉じられる。

```
## feat/search...origin/feat/search [ahead 2, behind 4]
MM  frontend/app/page.tsx
 M  backend/gitinfo.py
??  notes.md
```

XY コードにはツールチップを付け、状態は色だけでなく `ahead`、`behind`、`merged`、
`prunable`、`detached`、`clean` などの文字バッジでも同時に示す。表示はOSの
ライト／ダーク設定に追従する。

## git を覚えるための仕掛け

行を選ぶと、どの詳細タブでも今の状態から導かれる「次に打つコマンド」が
1 つだけ出る。

| 状態                | 提示                          |
| ------------------- | ----------------------------- |
| コンフリクトあり    | `git status`                  |
| 未ステージあり      | `git add -p`                  |
| 未追跡のみ          | `git add -A`                  |
| ステージ済みのみ    | `git commit`                  |
| detached HEAD       | `git switch -`                |
| prunable worktree   | `git worktree prune`          |
| マージ済み worktree | `git worktree remove <path>`  |
| マージ済みブランチ  | `git branch -d <branch>`      |
| upstream なし       | `git push -u origin <branch>` |
| ahead かつ behind   | `git pull --rebase`           |
| behind のみ         | `git pull --ff-only`          |
| ahead のみ          | `git push`                    |

作業ツリーが汚れているときは pull を勧めない（失敗するため）。

**pull ボタンを付けないのは意図的**です。ボタン 1 つで pull できてしまうと
`git pull --ff-only` は一生覚えないままになる。行動するにはターミナルへ行く
必要がある状態を保つことで、アプリ自体が学習装置として働きます。

## 速度

| 時刻   | 画面                                     |
| ------ | ---------------------------------------- |
| 〜10ms | キャッシュから全行が並ぶ（前回値、淡色） |
| 〜1s   | 画面内の行が最新値に置き換わる           |
| 〜数秒 | 残りが埋まる。活動が新しい順             |
| 背景   | 再探索と fetch                           |

効かせている仕掛け:

- 起動時は探索しない。`repos.json` のパスを検証して即表示する
- `.git/logs/HEAD` の mtime で活動順にソート。linked worktree は `.git` ファイルから
  実体を解決するので、commit や checkout の時刻がそのまま反映される
- `IntersectionObserver` が画面内の行を `POST /api/refresh` に送り、優先処理する
- 探索で見つけ次第 SSE でパスを流し、状態は後から埋める
- inotify で `.git` を監視。以降は変化したリポジトリだけ再取得する
- fetch は `common_dir` ごとに 1 回だけ実行し、同じプロジェクトの worktree で共有する

## 設定

`.env` で調整する。

| 変数                          | 既定 | 意味                                 |
| ----------------------------- | ---- | ------------------------------------ |
| `GITDASH_SCAN_ROOT`           | —    | 走査するホスト側ディレクトリ（必須） |
| `GITDASH_UID` / `GITDASH_GID` | —    | コンテナを動かす uid/gid（必須）     |
| `GITDASH_MAX_DEPTH`           | 8    | 何階層まで潜るか                     |
| `GITDASH_WORKERS`             | 16   | ローカル処理の並列数                 |
| `GITDASH_FETCH`               | true | fetch するか                         |
| `GITDASH_FETCH_WORKERS`       | 4    | fetch の並列数                       |
| `GITDASH_FETCH_INTERVAL_SEC`  | 300  | 同一リポジトリの fetch 間隔          |
| `GITDASH_WATCH`               | true | inotify を使うか                     |
| `GITDASH_AGENT_PORT`           | —    | agent REST/MCP を bind する localhost ポート（必須） |
| `GITDASH_AGENT_TOKEN`          | —    | agent REST/MCP の Bearer token（必須。未設定なら integration unavailable） |

除外ディレクトリは `backend/app/scanner.py` の `SKIP_NAMES`。
`node_modules` `.venv` `.cargo` `go/pkg` などは登録済み。
`/proc` `/sys` とネットワークマウント（NFS、sshfs 等）も自動で弾く。
ドットディレクトリ自体は走査対象外だが、本体で `git worktree list` を実行して
`.cursor/worktrees` や `.claude/worktrees` にある linked worktree も補完する。

## 承知しておくべきこと

**作業ツリーの編集は inotify で拾えません。** `vim main.py` で保存しても `.git` は
変化しないためです。作業ツリーごと監視するのは `.gitignore` の解釈が要る上に
watch 数が爆発するのでやっていません。ブラウザにフォーカスが戻ったときに
画面内の行を取り直すことで補っています。

**マウントは読み書き可です。** fetch が `.git` に書き込むため。fetch 以外の
書き込みはしません。`GITDASH_FETCH=false` にすれば behind の判定は
できなくなりますが、git への書き込みは完全にゼロになります。

**fetch は認証待ちで固まりません。** `GIT_TERMINAL_PROMPT=0` と
`ssh -oBatchMode=yes` を渡してあるため、鍵が ssh-agent に載っていない
リポジトリは即座に失敗します（ハングしません）。

**コミットグラフは既定で 200 件です。** それを超える履歴は切り詰めて表示します。

**大きなリポジトリで `git status` が遅い場合**、対象リポジトリで一度だけ
`git config core.untrackedCache true` を実行すると数倍速くなります。
アプリ側から設定を書き換えることはしません。

## agent event integration

agent status は `POST /api/agent-events` または localhost の Streamable HTTP MCP
`/mcp` の `report_agent_status` で明示的に送信します。lifecycle event は
`run_state` のみを変更し、semantic status は `phase`、`attention`、`outcome`、
`summary` を必ず明示します（値を消す場合は `null`）。イベントは `/data` の
append-only SQLite に保存され、`.codex/hooks.json` が SessionStart、SubagentStart、
Interrupt、SubagentStop、SessionEnd を command hook として送信します。SessionEnd
は終了時に MCP が利用できないため command hook を使用します。

## 開発

```bash
# backend
cd backend
uv venv && uv pip install -r requirements.txt
GITDASH_SCAN_ROOT=$HOME GITDASH_HOST_PREFIX=$HOME GITDASH_DATA_DIR=/tmp/gitdash \
  uv run uvicorn app.main:app --port 8000

# frontend
cd frontend
npm install
BACKEND_ORIGIN=http://127.0.0.1:8000 npm run dev
```
