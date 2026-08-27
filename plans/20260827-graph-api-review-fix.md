# graph API レビュー指摘修正計画

## 目的

`backend/app/graph.py` の lane 算出を、`git --graph` の表示列解析ではなく、
元の親追跡アルゴリズムへ戻す。既に入っている ref 分類、既定範囲、空リポジトリ、
`truncated` 判定の修正は維持する。

## 作業範囲

- `_graph_lane` / `_graph_through` と表示列同期・lane 左詰めを削除する
- `lane` / `through` / `in_lanes` / `out_lanes` を親追跡ロジックへ復元する
- 既存 API と ref 分類の回帰を確認する

## 検証

- `/tmp/gd/scan/gtest`、`/tmp/gd/scan/gverify`、`/tmp/gd/random-graph-cases` を
  `all=true` / `all=false` で確認する
- lane の行間接続、`topic/slash`・`origin/*`・タグの分類を確認する
- graph / commit / branches、STATE 外 path、不正 hash の HTTP 応答を確認する
- 空リポジトリ、マージ、ルートコミットを確認する
