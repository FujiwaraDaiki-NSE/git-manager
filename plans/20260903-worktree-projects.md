# worktree / project 表示の実装計画

## 対象

- Issue #2: worktree を本体リポジトリに紐付けて認識する
- Issue #3: プロジェクト単位でブランチの所在と次の手を示す
- Issue #4: 同一リモートの複数クローンを束ねる
- Issue #1 は上記 3 件の完了で受け入れ条件を満たす親 issue

## 原因

- API の状態がディレクトリ単位で、本体リポジトリを示す `common_dir` を持たない。
- scanner と watcher が `.git` ファイルの `gitdir:` を解決しない。
- 走査範囲外の worktree を `git worktree list --porcelain` から補完していない。
- ブランチ API が `%(worktreepath)` を取得せず、次コマンド判定も worktree の状態を受け取らない。
- UI の集計とグルーピングが行単位で、remote は host 名だけを比較している。

## API 契約

`Repo` に次を追加する。

```text
common_dir: string
is_worktree: boolean
worktree_state: "ok" | "prunable" | "locked" | null
```

ブランチ一覧の各要素に次を追加する。

```text
worktree: string | null
```

## 実装

1. `.git` ディレクトリまたは `.git` ファイルから実体の git dir を解決し、活動時刻と監視先に使う。
2. 発見した各 common repository について、同一リポジトリロック内で `git worktree list --porcelain` を実行し、範囲外 worktree も状態へ登録する。
3. branch の worktree path と repository の worktree state を API に反映し、削除・prune・branch 削除の候補コマンドを既存の安全優先順位の後で判定する。
4. プロジェクトを既定グループとし、本体の下に worktree を表示する。remote repository は host + path を正規化して比較する。
5. カードをプロジェクト、作業中ブランチ、merged 未削除、prunable に置換し、変更あり / ahead / behind はフィルタとして維持する。
6. backend の一時 Git リポジトリテスト、frontend build、Compose 上の API とブラウザ操作で検証する。

## 受け入れ条件

- main repository と linked worktree が同じ `common_dir` を返し、走査範囲外の worktree も列挙される。
- linked worktree の活動時刻が実体の `logs/HEAD` に一致し、commit 後の watcher 通知が debounce 後に 1 回となる。
- branch API に worktree path が入り、prunable / detached / locked が失われない。
- merged worktree、prunable、merged branch の順に該当する次コマンドが表示され、detached の既存動作を維持する。
- プロジェクト階層、remote repository 単位のグループ、4 種類の集計と既存フィルタを画面から確認できる。
- SSH URL と HTTPS URL の同一 repository は同じグループになり、owner が異なる fork は分かれる。
