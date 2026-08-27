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

公開ポートは 4412 だけ。backend は `expose` のみで、ブラウザからの `/api/*` は
frontend のルートハンドラ経由でしか到達できない。

## 表示するもの

| 項目 | 元になる git コマンド |
|---|---|
| ブランチ、upstream、ahead / behind | `git status --porcelain=v2 --branch` |
| ファイルごとの XY コード | 同上 |
| 最終コミット | `git log -1` |
| stash 数 | `git stash list` |
| リモート URL | `git config --get remote.origin.url` |

一覧には `git status -sb` の 1 行目をそのまま出す。

```
## feat/search...origin/feat/search [ahead 2, behind 4]
MM  frontend/app/page.tsx
 M  backend/gitinfo.py
??  notes.md
```

左列が index、右列が worktree。`??` は未追跡。

## git を覚えるための仕掛け

行を開くと、今の状態から導かれる「次に打つコマンド」が 1 つだけ出る。

| 状態 | 提示 |
|---|---|
| コンフリクトあり | `git status` |
| 未ステージあり | `git add -p` |
| 未追跡のみ | `git add -A` |
| ステージ済みのみ | `git commit` |
| upstream なし | `git push -u origin <branch>` |
| ahead かつ behind | `git pull --rebase` |
| behind のみ | `git pull --ff-only` |
| ahead のみ | `git push` |

作業ツリーが汚れているときは pull を勧めない（失敗するため）。

**pull ボタンを付けないのは意図的**です。ボタン 1 つで pull できてしまうと
`git pull --ff-only` は一生覚えないままになる。行動するにはターミナルへ行く
必要がある状態を保つことで、アプリ自体が学習装置として働きます。

## 速度

| 時刻 | 画面 |
|---|---|
| 〜10ms | キャッシュから全行が並ぶ（前回値、淡色） |
| 〜1s | 画面内の行が最新値に置き換わる |
| 〜数秒 | 残りが埋まる。活動が新しい順 |
| 背景 | 再探索と fetch |

効かせている仕掛け:

- 起動時は探索しない。`repos.json` のパスを検証して即表示する
- `.git/logs/refs/HEAD` の mtime で活動順にソート。`os.stat` 1 回で決まるので
  git を一度も起動する前に順序が決まっている
- `IntersectionObserver` が画面内の行を `POST /api/refresh` に送り、優先処理する
- 探索で見つけ次第 SSE でパスを流し、状態は後から埋める
- inotify で `.git` を監視。以降は変化したリポジトリだけ再取得する

## 設定

`.env` で調整する。

| 変数 | 既定 | 意味 |
|---|---|---|
| `GITDASH_SCAN_ROOT` | — | 走査するホスト側ディレクトリ（必須） |
| `GITDASH_UID` / `GITDASH_GID` | — | コンテナを動かす uid/gid（必須） |
| `GITDASH_MAX_DEPTH` | 8 | 何階層まで潜るか |
| `GITDASH_WORKERS` | 16 | ローカル処理の並列数 |
| `GITDASH_FETCH` | true | fetch するか |
| `GITDASH_FETCH_WORKERS` | 4 | fetch の並列数 |
| `GITDASH_FETCH_INTERVAL_SEC` | 300 | 同一リポジトリの fetch 間隔 |
| `GITDASH_WATCH` | true | inotify を使うか |

除外ディレクトリは `backend/app/scanner.py` の `SKIP_NAMES`。
`node_modules` `.venv` `.cargo` `go/pkg` などは登録済み。
`/proc` `/sys` とネットワークマウント（NFS、sshfs 等）も自動で弾く。

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

**大きなリポジトリで `git status` が遅い場合**、対象リポジトリで一度だけ
`git config core.untrackedCache true` を実行すると数倍速くなります。
アプリ側から設定を書き換えることはしません。

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

## 拡張するなら

- コミットグラフ（`git log --all --date-order --parents` でレーン割り当て、
  行ごとに小さな SVG を描くと仮想スクロールと両立する）
- 選択コミットの `git show --stat` と diff
- 親フォルダ単位、リモートホスト単位のグルーピング
