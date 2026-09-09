# plan1 ブランチタイムラインとプロジェクト詳細 実装計画

## 原因

現在のグラフタブは `git log --graph` 由来のコミット DAG で、過去の履歴を読むための表現になっている。
そのため並列エージェント開発で知りたい次の情報が構造的に見えない。

- 時間軸がトポロジカル順で、複数ブランチが「同時に」進んでいることが分からない
- 単位がコミットで、ブランチ（= 1 worktree = 1 エージェント）ごとの状態を持てない
- マージ可能か・ベースから取り残されているかという「先」の情報が無い

「ブランチ関係サマリー」は分岐点を補っているが、分岐した事実しか示さず、
どう開発が進んでいるかは読めない。

## 方針

- 単位を **コミット → ブランチ** に、軸を **トポロジ → 実時間** に変える
- Git への書き込みは行わない。判定は plumbing コマンドの結果だけから導く
- ベースは `origin/HEAD` のみから決め、無ければ推測せず `null` として扱う
- 状態語彙は既存の `stateBadges` と同じトークン体系に載せ、色判定ロジックを増やさない
- スイムレーンはブランチ横断の図なので、置き場所は **プロジェクト詳細のみ** とする

## 受け入れ条件

### タイムライン API

- `GET /api/repo/timeline?path=` はプロジェクト内の任意の checkout パスを受け取り、次を返す。
  - `base`: `{ name, ref, hash }`。`origin/HEAD` が無い場合は `null`
  - `now`: サーバー時刻（epoch 秒）
  - `trunk`: ベースの first-parent コミット列（最古のフォーク点以降、上限付き）
  - `branches[]`: ローカルブランチごとに
    `name, hash, worktree, merge_base, fork_time, ahead, behind, commits[], commits_truncated, merged, merge_hash, merged_at`
  - `command`: 表示用の等価コマンド
- `ahead/behind` は `git rev-list --left-right --count <base>...<branch>` の値そのまま
- `merge_base` / `fork_time` は `git merge-base` と該当コミットの committer 時刻
- `merged` は `git branch --merged <base>` の結果、`merge_hash` / `merged_at` は
  `git log --first-parent --ancestry-path <branch>..<base> --reverse -1` の結果。squash マージは対象外
- ベース名と同名のローカルブランチはレーンに含めない
- `base` が `null` の場合も `branches: []` を含む安定した形で返す
- 未コミット差分の有無は API に含めない。SSE で届く `Repo.entries` を worktree パスで突き合わせる
- 実 Git fixture による pytest で、分岐・マージ済み・`origin/HEAD` 無し・空リポジトリを確認する

### スイムレーン（TimelineView）

- 横軸は壁時計の時間、右端が「いま」。範囲は `24h / 7d / 30d / すべて` から選べる
- ベースを太いトランクとして最上段に置き、各ブランチはフォーク点でトランクから離れ、
  マージ済みなら `merged_at` でトランクへ戻る
- 点はコミット。HEAD は通常 `●`、未コミット差分あり `◉`（脈動）、マージ済み `○`
- レーン右端に状態バッジと `ahead N · behind M` を固定表示。状態は次の優先順で 1 つに決める
  1. merged
  2. 作業中（未コミット差分あり、または直近 30 分以内にコミット）
  3. behind（`behind > 0`）
  4. ready（`ahead > 0` かつ `behind = 0`）
  5. 同期（`ahead = 0` かつ `behind = 0`）
- 状態と幾何の計算は `frontend/app/timeline.mjs` の純粋関数に閉じ、`node --test` で検証する
- `base` が `null` のプロジェクトは「ベース未設定」を表示し、レーン図を出さない
- 既存の「コミットグラフ」タブと `--all` 切替、`GRAPH_LIMIT` の挙動は変えない

### ホバーとコミット表示

- 点にホバーすると API を呼ばずにツールチップを出す。内容は `short · subject · author · 相対時刻`
- フォーク点は「ここから分岐 · ベースより N コミット後方」、HEAD の脈動点は `git status` の件数、
  マージ点はマージコミットを表示する
- 点をクリックすると選択状態になり、レーン図の下に既存の `CommitPane` を表示する
- `CommitPane` と取得ロジックは `commit-pane.tsx` に抽出し、repo 詳細とプロジェクト詳細で共用する
- キーボード操作: ←/→ でレーン内の点を移動、↑/↓ でレーン移動、Enter で確定。
  ツールチップの内容は `aria-label` でも読める

### プロジェクト詳細（ProjectDetail）

- プロジェクト見出しの名前をクリックするとプロジェクト詳細が開く。`▼/▶` は折りたたみのまま
- 構成は上から順に
  1. ヘッダー: プロジェクト名、リモート、common_dir、ベース名
  2. メトリクス: `worktree 数 · 作業中 · Ready · Behind · merged`
  3. ブランチタイムライン
  4. コミット詳細（選択時のみ）
  5. メンバー一覧: 本体と worktree の行。行クリックで既存の repo 詳細へ切り替わる
- repo 詳細のパンくず `project › branch` の project 部分をクリックするとプロジェクト詳細へ戻る
- URL は `?project=<common_dir>` を追加し、`?repo=&tab=` と排他にする。リロードで復元する
- 選択モデルは `repo | project` の union にし、詳細ペイン/ドロワーの表示ルールは既存のまま使う

### 検証

- backend: pytest（実 Git fixture）
- frontend: `npm test`、型チェック、production build
- Compose で起動し、実ブラウザで複数ブランチ・worktree あり・`origin/HEAD` 無しの
  プロジェクトを確認する

## 変更

1. `backend/app/timeline.py` を追加し、`backend/app/main.py` に `/api/repo/timeline` を追加する
2. `backend/tests/test_timeline.py` を追加する
3. `frontend/app/types.ts` にタイムライン型を追加する
4. `frontend/app/timeline.mjs` と `frontend/tests/timeline.test.mjs` を追加する
5. `repo-detail.tsx` から `CommitPane` を `frontend/app/commit-pane.tsx` に抽出する
6. `frontend/app/timeline-view.tsx` を追加する（SVG、ツールチップ、キーボード、選択）
7. `frontend/app/project-detail.tsx` を追加し、`page.tsx` の選択モデルと URL を拡張する
8. `globals.css` にタイムラインとプロジェクト詳細のスタイルを追加する
9. README の「表示するもの」にタイムラインとプロジェクト詳細を追記する

各変更は単独でビルドが通る単位でコミットする。

## 非対象

- Git への書き込み操作
- ファイル重なりの表示、`git merge-tree` による衝突判定、テリトリーマップ（次フェーズ。
  API に `files` を足すだけで載せられる形にしておく）
- リモートブランチのレーン表示
- squash マージの検出
- 「ブランチ関係サマリー」の削除（タイムライン導入後に別途判断する）
- グラフライブラリの追加
