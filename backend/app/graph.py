"""コミットグラフ。git log の親情報からレーンを割り当てる。

描画はフロント側で「1 行 = 1 枚の小さな SVG」にする前提なので、
ここでは行ごとに「その行を通過する線」「入ってくる線」「出ていく線」を
レーン番号で返す。全体を 1 枚の巨大 SVG にしないので仮想スクロールできる。
"""
from __future__ import annotations

from typing import Any

from app.gitinfo import _run

# %H ハッシュ / %P 親 / %D ref 名 / %an 作者 / %cI 日時 / %s 件名
FORMAT = "%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%cI%x1f%s"


def _parse_refs(raw: str) -> list[dict[str, str]]:
    """%D の "HEAD -> main, origin/main, tag: v1" を分解する。"""
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
        elif name.startswith("refs/"):
            continue
        elif "/" in name:
            kind = "remote"
        refs.append({"name": name, "kind": kind})
    return refs


def _free_slot(lanes: list[str | None]) -> int:
    for i, v in enumerate(lanes):
        if v is None:
            return i
    lanes.append(None)
    return len(lanes) - 1


def build(repo: str, all_refs: bool = True, limit: int = 200) -> dict[str, Any]:
    args = ["log", "--date-order", f"--max-count={limit}", f"--format={FORMAT}"]
    if all_refs:
        args.insert(1, "--all")

    out = _run(repo, args)
    if out is None:
        return {"rows": [], "max_lane": 0, "head_lane": None, "truncated": False}

    raw_rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        fields = line.split("\x1f")
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
        })

    lanes: list[str | None] = []
    rows: list[dict[str, Any]] = []
    max_lane = 0
    head_lane: int | None = None

    for row in raw_rows:
        # 同じコミットを指すレーンが複数あることがある（複数の子が同じ親を持つ）
        occupied = [i for i, v in enumerate(lanes) if v == row["hash"]]
        if occupied:
            lane = occupied[0]
            merge_in = occupied[1:]
        else:
            lane = _free_slot(lanes)
            merge_in = []

        # このコミットに入ってくる線。上から降りてくるレーン
        in_lanes = occupied[:] if occupied else []

        # 行全体を素通りするレーン（このコミットと無関係な枝）
        through = [
            i for i, v in enumerate(lanes)
            if v is not None and i != lane and i not in merge_in
        ]

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

        # 末尾の空きレーンを畳んで幅を詰める
        while lanes and lanes[-1] is None:
            lanes.pop()

        current_max = max([lane, *through, *in_lanes, *out_lanes], default=0)
        max_lane = max(max_lane, current_max)

        is_head = any(r["kind"] == "head" for r in row["refs"])
        if is_head and head_lane is None:
            head_lane = lane

        rows.append({
            **row,
            "lane": lane,
            "in_lanes": in_lanes,
            "through": through,
            "out_lanes": out_lanes,
            "is_head": is_head,
            "is_merge": len(row["parents"]) > 1,
        })

    return {
        "rows": rows,
        "max_lane": max_lane,
        "head_lane": head_lane if head_lane is not None else 0,
        "truncated": len(raw_rows) >= limit,
        "command": "git log --oneline --graph" + (" --all" if all_refs else ""),
    }
