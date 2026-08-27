"""コミットグラフ。git log の親情報からレーンを割り当てる。

描画はフロント側で「1 行 = 1 枚の小さな SVG」にする前提なので、
ここでは行ごとに「その行を通過する線」「入ってくる線」「出ていく線」を
レーン番号で返す。全体を 1 枚の巨大 SVG にしないので仮想スクロールできる。
"""
from __future__ import annotations

from typing import Any

from app.gitinfo import _run

# %H ハッシュ / %P 親 / %D ref 名 / %an 作者 / %cI 日時 / %s 件名
# --graph の表示用プレフィックスと機械用レコードを分ける。
FORMAT = "%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%cI%x1f%s"


def _parse_refs(raw: str) -> list[dict[str, str]]:
    """%D の ref 表示を、local branch / remote / tag に分類する。"""
    refs: list[dict[str, str]] = []
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        kind = "branch"
        if name.startswith("HEAD -> "):
            name = name[len("HEAD -> "):]
            kind = "head"
        elif name == "HEAD":
            kind = "head"
        elif name.startswith("tag: "):
            name = name[len("tag: "):]
            kind = "tag"

        if name.startswith("refs/heads/"):
            name = name[len("refs/heads/"):]
        elif name.startswith("refs/remotes/"):
            name = name[len("refs/remotes/"):]
            if kind == "branch":
                kind = "remote"
        elif name.startswith("refs/tags/"):
            name = name[len("refs/tags/"):]
            if kind == "branch":
                kind = "tag"
        elif kind == "branch" and "/" in name:
            # --decorate=full を使わない呼び出し元との互換用。
            kind = "remote"
        refs.append({"name": name, "kind": kind})
    return refs


def _graph_lane(prefix: str) -> int:
    star = prefix.find("*")
    return max(star, 0) // 2


def _graph_through(prefix: str) -> list[int]:
    return [index // 2 for index, char in enumerate(prefix) if char == "|" and index % 2 == 0]


def _free_slot(lanes: list[str | None]) -> int:
    for i, v in enumerate(lanes):
        if v is None:
            return i
    lanes.append(None)
    return len(lanes) - 1


def build(repo: str, all_refs: bool = True, limit: int = 200) -> dict[str, Any]:
    args = [
        "log",
        "--date-order",
        "--decorate=full",
        "--graph",
        f"--max-count={limit + 1}",
        f"--format={FORMAT}",
    ]
    if all_refs:
        args.insert(1, "--all")
    else:
        upstream = _run(repo, ["rev-parse", "--symbolic-full-name", "@{upstream}"])
        if upstream:
            args.extend(["HEAD", upstream.strip()])

    out = _run(repo, args)
    if out is None:
        # unborn HEAD の空リポジトリでは、現在ブランチを限定した git log が
        # 終了コード 128 になる。HEAD が解決できない Git 管理下だけを
        # 空グラフとして扱い、timeout や破損した履歴はエラーのまま返す。
        inside = _run(repo, ["rev-parse", "--is-inside-work-tree"])
        head = _run(repo, ["rev-parse", "--verify", "--quiet", "HEAD"])
        if inside == "true\n" and head is None:
            return {
                "rows": [],
                "max_lane": 0,
                "head_lane": 0,
                "truncated": False,
                "command": "git log --oneline --graph" + (" --all" if all_refs else ""),
            }
        return {"rows": [], "max_lane": 0, "head_lane": None, "truncated": False}

    raw_rows: list[dict[str, Any]] = []
    # str.splitlines() は RS (\x1e) も改行として扱うため、LF だけで分ける。
    for line in out.split("\n"):
        marker = line.find("\x1e")
        if marker < 0:
            continue
        fields = line[marker + 1:].split("\x1f")
        if len(fields) != 7:
            continue
        full, short, parents, refs, author, date, subject = fields
        raw_rows.append({
            "hash": full,
            "short": short,
            "parents": parents.split() if parents.strip() else [],
            "refs": _parse_refs(refs),
            "author": author,
            "date": date,
            "subject": subject,
            "_lane": _graph_lane(line[:marker]),
            "_through": _graph_through(line[:marker]),
        })

    truncated = len(raw_rows) > limit
    raw_rows = raw_rows[:limit]

    lanes: list[str | None] = []
    rows: list[dict[str, Any]] = []
    max_lane = 0
    head_lane: int | None = None

    for row in raw_rows:
        visual_lane = row.pop("_lane")
        visual_through = row.pop("_through")
        # Git のグラフは遷移行で列を入れ替えることがある。コミット行の
        # 実列を使って、親ハッシュを現在の表示列へ同期する。
        occupied = [i for i, v in enumerate(lanes) if v == row["hash"]]
        other_targets = [v for v in lanes if v is not None and v != row["hash"]]
        if len(other_targets) == len(visual_through):
            aligned: list[str | None] = [None] * (max([visual_lane, *visual_through], default=0) + 1)
            for position, target in zip(visual_through, other_targets):
                aligned[position] = target
            if occupied:
                aligned[visual_lane] = row["hash"]
                occupied = [visual_lane]
            lanes = aligned
            lane = visual_lane
        else:
            # Git 出力と内部状態が一致しない場合は、レスポンスを壊さず
            # 従来の親追跡を使う。
            lane = occupied[0] if occupied else _free_slot(lanes)

        # このコミットに入ってくる線。上から降りてくるレーン
        in_lanes = occupied[:] if occupied else []

        for i in occupied:
            lanes[i] = None

        out_lanes: list[int] = []
        for index, parent in enumerate(row["parents"]):
            existing = next((i for i, v in enumerate(lanes) if v == parent), None)
            if existing is not None:
                out_lanes.append(existing)
                continue
            if index == 0:
                lanes[lane] = parent
                out_lanes.append(lane)
            else:
                # マージの 2 番目以降の親は新しいレーンに伸ばす
                slot = _free_slot(lanes)
                lanes[slot] = parent
                out_lanes.append(slot)

        # git log --graph は遷移行で内部の空きレーンも左へ詰める。
        # これをしないと、別枝が残るマージ後に `|/|` と lane がずれる。
        lanes = [value for value in lanes if value is not None]

        current_max = max([visual_lane, *visual_through, *in_lanes, *out_lanes], default=0)
        max_lane = max(max_lane, current_max)

        is_head = any(r["kind"] == "head" for r in row["refs"])
        if is_head and head_lane is None:
            head_lane = visual_lane

        rows.append({
            **row,
            "lane": visual_lane,
            "in_lanes": in_lanes,
            "through": visual_through,
            "out_lanes": out_lanes,
            "is_head": is_head,
            "is_merge": len(row["parents"]) > 1,
        })

    return {
        "rows": rows,
        "max_lane": max_lane,
        "head_lane": head_lane if head_lane is not None else 0,
        "truncated": truncated,
        "command": "git log --oneline --graph" + (" --all" if all_refs else ""),
    }
