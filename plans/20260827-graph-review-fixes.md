# グラフ UI レビュー指摘の修正計画

## 目的

コミット 28934e3 の frontend に対する重大 4 件・軽微 6 件を、計画書 §5 の範囲内で最小限修正する。backend は変更しない。

## 修正範囲

- `graph-view.tsx`: 仮想ノードを `is_head` 行へ接続し、その間の head lane を描画する。8 レーンを超える表示を最終列へ収め、型を `types.ts` から import する。キーボード選択 effect の依存も安定させる。
- `repo-detail.tsx`: コミット詳細取得を短時間デバウンスし、履歴取得の依存から `fetched_at` を外す。表示上限定数と折りたたみ中のマージ済み件数表示を整理する。
- `page.tsx`: グループ切替で `RepoDetail` が再マウントされない DOM 構造にする。
- `api/[...path]/route.ts`: 要件外の API ホワイトリストとパス encode を削除し、backend のルートをそのままプロキシする。

## 検証

型検査、本番 build、backend worktree を向けた API/UI 確認、グループ切替・キーボード選択・多レーン表示を確認し、差分をレビューして日本語コミットを作成する。
