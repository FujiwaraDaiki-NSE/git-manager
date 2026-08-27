# gitdash 引き継ぎ計画書

2026-08-27 作成。ここまでの作業は使い捨てサンドボックスで行われた。
以降はローカル環境（Linux）で Claude Code が続行する。

---

## 1. このアプリは何で、なぜ作っているか

PC内に散らばった Git リポジトリを、登録作業なしで一覧する**読み取り専用**の
ダッシュボード。Docker Compose で常駐させ、`localhost:4412` で見る。

### 表のテーマ

「どのリポジトリに手をつけるべきか」を一目で分かるようにする。
コミットし忘れ、push し忘れ、上流と分岐したまま放置、を可視化する。

### 裏のテーマ（これが設計の背骨）

**使っているうちに git コマンドを覚えられること。**

この目的が、いくつかの一見不合理な決定の理由になっている。引き継ぐ側が
これを知らないと「不便だから直そう」として台無しにしてしまうので、最初に書く。

- **独自の記号を作らない。** 一覧の状態表示は `git status -sb` の出力形式
  そのまま（`MM` ` M` `??` `## main...origin/main [ahead 2, behind 4]`）。
  当初 `S3 M2 ?5 ↑1 ↓2` という独自表記を作りかけたが、それを覚えても
  ターミナルでは何の役にも立たないので捨てた。
- **各ビューに、そのビューと等価な人間向けコマンドを表示する。**
  ここで出すのは実際に叩いている `--porcelain=v2` ではなく、人間が同じものを
  見るときの `git status -sb` や `git log --oneline --graph`。機械用の書式を
  覚えても使い道がないため、意図的に「翻訳」している。
- **状態から「次に打つコマンド」を1つだけ提示する。** チートシートを眺めても
  覚えないが、自分のリポジトリが今まさに分岐していて `git pull --rebase` と
  出ていれば覚える。文脈と必要性が揃っているのが効く。
- **pull / push ボタンは作らない。** ここが最重要。ボタン1つで pull できる
  アプリを作ったら `git pull --ff-only` は一生覚えない。行動するには
  ターミナルに行くしかない状態を保つことで、**便利さを少し諦めることが
  そのまま学習装置になっている**。読み取り専用は制約ではなく設計。

将来「pull ボタンが欲しい」という要望が出ても、まず上を読んでから判断すること。

---

## 2. いま何ができていて、何が動作確認済みか

### 完成・検証済み

| 機能 | 検証内容 |
|---|---|
| リポジトリ自動探索 | 除外リストが効く（`node_modules` を拾わない）、3階層下も発見 |
| porcelain v2 パース | XY コードが `git status -sb` 表記に戻る |
| ブランチ行の組み立て | `## master...origin/master [ahead 1]` を再現 |
| 次コマンド判定 | リモート未設定時に push を提案しない（バグ修正済み） |
| SSE 配信 | snapshot / repo / scan / done / removed / fetch |
| 可視優先取得 | `POST /api/refresh` |
| inotify | commit を1件だけ拾う（無限ループ修正後） |
| フロント本番ビルド | `next build` 通過、standalone 出力 |
| API プロキシ | GET / POST / SSE、backend 停止時 502 |
| **グラフのレーン割り当て** | **git 自身の `--graph` と配置が完全一致（マージの `\|/\|` 含む）** |

`app/graph.py` は書き上がって検証も済んでいる。**まだどこからも呼ばれていない**。

### 未実装（今回の残作業）

1. グラフの API エンドポイントとフロント描画
2. コミット詳細（`git show --stat` と diff）
3. ブランチ一覧
4. グルーピング（親フォルダ単位、リモートホスト単位）

---

## 3. 絶対に踏み直してはいけない罠

実装中に踏んで、原因特定に時間を使った2件。コードにコメントも残してあるが、
消さないこと。

### 3.1 inotify の無限ループ（重大）

`git status` は作業ツリーの stat 情報が変わると `.git/index` を書き戻す。
それを inotify が拾って再取得を起こし、また index が書かれる、という自己励起。
**検証環境でアイドル10秒に 1968 イベント**。同時実行で `index.lock` の
奪い合いも起き、リポジトリが操作不能になった。200リポジトリで動かしていたら
CPU が張り付いていた。

3層で塞いである。**どれか1つでも外すと再発する。**

- `watcher.py`: `.lock` で終わるファイルのイベントを捨てる
- `main.py`: 取得完了時刻から 3 秒間（`SUPPRESS_SEC`）はそのリポジトリの
  イベントを無視する（自己発火の抑止）
- `main.py`: `_repo_lock()` でリポジトリ単位の排他。同じリポジトリに対する
  git の並行実行を防ぐ

加えて 1 秒のデバウンス（`DEBOUNCE_SEC`）で複数イベントをまとめる。
修正後はアイドル 0 件、commit 1 回につき 1 件。

**グラフ機能を足すときの注意**: `git log` は index を書かないので安全だが、
`git show` も同様。新しく git を叩く箇所を足すときは必ず `_repo_lock()` を
経由させること。直接 `gitinfo._run()` を呼ぶと排他が効かない。

### 3.2 Next.js の rewrites はビルド時に固定される

`next.config.mjs` の `rewrites` は `next build` の時点で評価されるため、
compose の `BACKEND_ORIGIN` を実行時に渡しても効かない。環境変数が
何もしない飾りになっていた。Docker 内では偶然 `backend` が名前解決するので
気づかないまま埋まる類の罠。

`app/api/[...path]/route.ts` のルートハンドラに置き換え済み。
**rewrites に戻さないこと。**

---

## 4. 主要な設計判断とその理由

| 判断 | 理由 |
|---|---|
| バインドマウントは **rw** | fetch が `.git` に書き込むため。ro にすると pull 可否を判定できない。アプリは fetch 以外書き込まない |
| backend は **ホストの uid** で動かす | root だと git の `safe.directory` に引っかかる |
| backend は**ポートを公開しない** | 公開は frontend の 4412 のみという要件。`/api/*` は frontend のルートハンドラ経由 |
| 起動時に**探索しない** | `repos.json` のパスを `isdir` 検証して即表示。全体再探索は背景で走らせる |
| 活動順ソートに `.git/logs/refs/HEAD` の **mtime** | `os.stat` 1回で取れるので、git を一度も起動する前に順序が決まる |
| stash 数とリモート URL も **git に聞く** | `.git` を直接読むほうが速いが、Linux ではプロセス生成が安く差は誤差。正確さを取る |
| fetch は**別スレッドプール** | ローカル処理（10〜50ms、ディスク律速）とネットワーク処理（0.3〜5秒）は性質が違う。同じプールに入れると fetch がローカル取得を詰まらせる |
| fetch に `BatchMode=yes` | `GIT_TERMINAL_PROMPT=0` だけでは足りない。SSH 鍵が ssh-agent に無いと ssh 側がパスフレーズ待ちで固まる |

### 承知の上の限界

**作業ツリーの編集は inotify で拾えない。** `vim main.py` で保存しても `.git` は
変化しないため。作業ツリーごと watch するのは `.gitignore` の解釈が要る上に
watch 数が爆発するのでやらない。ブラウザのフォーカス復帰時に画面内の行を
取り直すことで補っている（`page.tsx` の `onFocus`）。他の GUI クライアントも
同様の挙動なので実用上は困らない。

---

## 5. 残作業の詳細仕様

### 5.1 グラフの API とフロント描画

`app/graph.py` の `build(repo, all_refs, limit)` は完成済み。返す構造:

```python
{
  "rows": [{
    "hash": str, "short": str, "parents": [str],
    "refs": [{"name": str, "kind": "head"|"branch"|"remote"|"tag"}],
    "author": str, "date": str, "subject": str,
    "lane": int,          # このコミットが乗るレーン
    "in_lanes": [int],    # 上から降りてきてこのコミットに入る線
    "through": [int],     # 行を素通りする無関係な枝
    "out_lanes": [int],   # 親へ向かって出ていく線（親の順）
    "is_head": bool, "is_merge": bool,
  }],
  "max_lane": int, "head_lane": int, "truncated": bool, "command": str,
}
```

**追加するエンドポイント**（`main.py`）:

```
GET /api/repo/graph?path=<hostパス>&all=true&limit=200
```

`path` は **必ず `STATE` に存在するものだけ許可する**。任意のパスを受けると
コンテナ内の任意ディレクトリで git を実行できてしまう。他の新規エンドポイントも
同様。`_repo_lock()` を経由すること。

**フロントの描画方針**（重要）:

グラフ全体を1枚の巨大 SVG にしないこと。1000コミットで固まり、仮想スクロールと
両立しない。**1行 = 1枚の小さな SVG** にする。各行は自分の行を通過する線分と
丸だけを描く。ジオメトリの目安:

```
レーン幅 W = 14px, 行高 H = 30px
ノード中心 = (lane * W + 8, H / 2), 半径 4
through[i]      : (i*W+8, 0) → (i*W+8, H) の直線
in_lanes[i]     : (i*W+8, 0) → ノード（i == lane なら直線、違えば曲線）
out_lanes[i]    : ノード → (i*W+8, H)（同上）
SVG 幅は全行で固定（min(max_lane+1, 8) * W + 16）にして縦位置を揃える
```

- 未コミットの変更がある場合、**最上部に破線の丸で仮想ノードを1行追加する**。
  レーンは `head_lane`。「今の作業がどのコミットの上に乗っているか」が
  一目で分かるのが狙い。ラベルは `git status -sb` の集計をそのまま出す
- ref はバッジで該当コミットに貼る。`head` は強調、`remote` は淡く、`tag` は別色
- 既定は `all=false`（現在ブランチとその上流）。`--all` は枝が増えて読めなくなる。
  トグルで切り替え、ヘッダに `git log --oneline --graph` を出す（裏テーマ）

### 5.2 コミット詳細

```
GET /api/repo/commit?path=<hostパス>&hash=<hash>
```

```
git show --numstat --format=%H%x1f%s%x1f%an%x1f%cI%x1f%P <hash>
git show --format= --patch --unified=3 <hash>
```

`--numstat` は `追加\t削除\tパス`。バイナリは `-\t-`。
patch は大きくなるので行数か bytes で truncate し、切ったことをフラグで返す。
グラフの行をクリックしたら下ペインに出す。ここでも
「同じものを見るコマンド」として `git show <hash>` を表示する。

### 5.3 ブランチ一覧

```
GET /api/repo/branches?path=<hostパス>
```

```
git for-each-ref --format='%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso-strict)%1f%(HEAD)' refs/heads refs/remotes
git branch --merged HEAD --format='%(refname:short)'
```

ローカルとリモートを分け、マージ済みは既定で折りたたむ。
放置ブランチの掃除判断に使えるようにするのが目的。
等価コマンドは `git branch -vv`。

### 5.4 グルーピング

**フロント側だけで完結する。バックエンドの変更は不要。**

- 親フォルダ単位: `path` の最後の `/` より前。`/home/you/work` 配下、など
- リモートホスト単位: `remote` をパースしてホスト名を取る。
  `git@github.com:x/y.git` と `https://github.com/x/y.git` の両形式に対応。
  リモート無しは「ローカルのみ」に束ねる

ツールバーにセレクタを置き、「なし / 親フォルダ / リモート」を切り替える。
どちらもパスと URL から自動で決まるので、設定は不要（登録ゼロの方針を保つ）。

---

## 6. 検証環境の再現手順

サンドボックスで使っていた fixture。ローカルでも同じものを作れる。

```bash
# 基本（clean / dirty / 上流あり）
mkdir -p /tmp/gd/scan/proj/{a,b} /tmp/gd/scan/deep/nested
mkdir -p /tmp/gd/scan/proj/a/node_modules/junk   # 除外されることの確認用
for d in /tmp/gd/scan/proj/a /tmp/gd/scan/proj/b /tmp/gd/scan/deep/nested; do
  (cd $d && git init -q && git config user.email a@b.c && git config user.name t \
   && echo hi > f.txt && git add . && git commit -qm "初期コミット")
done
(cd /tmp/gd/scan/proj/b && echo x >> f.txt && echo new > untracked.md \
 && echo s > s.txt && git add s.txt)   # MM / .M / ?? を作る
git init -q --bare /tmp/gd/origin.git
(cd /tmp/gd/scan/proj/a && git remote add origin /tmp/gd/origin.git \
 && git push -q -u origin HEAD && echo e >> f.txt && git commit -qam "ローカルだけ")

# グラフ用（マージと分岐）
mkdir /tmp/gd/gtest && cd /tmp/gd/gtest && git init -q
git config user.email a@b.c && git config user.name t
c(){ echo "$1" > "$1.txt"; git add -A; git commit -qm "$1"; }
c base; c second; git checkout -q -b feat; c feat1; c feat2
git checkout -q master; c main1; git merge -q --no-ff feat -m "feat をマージ"
c after; git checkout -q -b side HEAD~3; c side1; git checkout -q master
```

`git log --all --date-order --oneline --graph` の出力と `graph.build()` の
`lane` 列を突き合わせれば、レーン割り当ての正しさを確認できる。

inotify ループの回帰テストはこれ。**グラフ実装後にも必ず回すこと。**

```
SSE を購読 → 10秒何もしない → repo イベントが 0 件であること
→ commit を1回 → repo イベントがちょうど 1 件増えること
```

---

## 7. 引き継ぎ手順

```bash
cd gitdash
git init
git add -A
git commit -m "初期実装: 走査、SSE、inotify、Docker Compose"
```

`.gitignore` がまだ無いので作ること（`node_modules`, `.next`, `__pycache__`,
`.env`, `frontend/public/.gitkeep` は残す）。`.env` は絶対にコミットしない。

以降の機能追加は worktree を切って進めるのが安全。グラフはフロントの
描画ジオメトリの試行錯誤が要るので、`git worktree add ../gitdash-graph feat/graph`
のように分けると main を壊さずに済む。

実装後は独立した目で一度レビューを通すこと。特に見てほしい観点は、
新規エンドポイントの `path` 検証（`STATE` に無いパスを弾いているか）と、
新しく足した git 実行が `_repo_lock()` を経由しているか。

---

## 8. まだ決めていないこと

- グラフの既定件数。200 で切っているが、実リポジトリで足りるか未検証
- `truncated` のときの「さらに読む」の UX。ページングか無限スクロールか
- diff のシンタックスハイライト。依存を増やす価値があるか
- グラフを俯瞰ビューにも出すか（現状はリポジトリ詳細のみの想定）
- `core.untrackedCache` の有効化提案をどこに置くか。`git status` が遅い
  リポジトリを検出して、コマンドをコピーさせる形にしたい（裏テーマと合う）
