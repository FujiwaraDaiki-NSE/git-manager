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
        elif name.startswith("refs/"):
            continue
        elif kind == "branch" and "/" in name:
            # --decorate=full を使わない呼び出し元との互換用。
            kind = "remote"
        refs.append({"name": name, "kind": kind})
    return refs


def _free_slot(lanes: list[str | None]) -> int:
    for i, v in enumerate(lanes):
        if v is None:
            return i
    lanes.append(None)
    return len(lanes) - 1


def _origin_default(repo: str) -> tuple[str | None, str | None]:
    """Return origin/HEAD's branch name and remote-tracking commit hash."""
    raw = _run(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    if not raw:
        return None, None
    value = raw.strip()
    prefix = "origin/"
    if not value.startswith(prefix):
        return None, None
    name = value[len(prefix):]
    if not name:
        return None, None
    commit_hash = _run(
        repo,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            f"refs/remotes/origin/{name}",
        ],
    )
    return name, commit_hash.strip() if commit_hash else None


def _local_branch_heads(repo: str) -> list[dict[str, str]] | None:
    """Return every local branch and its full HEAD hash.

    Branch decorations in ``git log`` are limited to the displayed history,
    so they cannot describe branches whose tip is outside the graph limit.
    Keep this as a separate ref query and let the frontend decide which tips
    are currently visible.
    """
    raw = _run(
        repo,
        [
            "for-each-ref",
            "--format=%(refname:short)%1f%(objectname)",
            "refs/heads",
        ],
    )
    if raw is None:
        return None
    heads: list[dict[str, str]] = []
    for line in raw.splitlines():
        name, separator, commit_hash = line.partition("\x1f")
        if separator and name and commit_hash:
            heads.append({"name": name, "hash": commit_hash})
    return heads


def _empty_response(
    all_refs: bool,
    default: str | None,
    branch_heads: list[dict[str, str]],
) -> dict[str, Any]:
    """Return the stable graph shape for an empty repository."""
    return {
        "rows": [],
        "max_lane": 0,
        "head_lane": None,
        "default_branch": default,
        "default_lane": None,
        "branch_heads": branch_heads,
        "truncated": False,
        "command": "git log --oneline --graph" + (" --all" if all_refs else ""),
    }


def build(repo: str, all_refs: bool = True, limit: int = 200) -> dict[str, Any] | None:
    default, default_hash = _origin_default(repo)
    branch_heads = _local_branch_heads(repo)
    if branch_heads is None:
        return None

    args = [
        "log",
        "--date-order",
        "--decorate=full",
        f"--max-count={limit + 1}",
        f"--format={FORMAT}",
    ]
    if all_refs:
        args.insert(1, "--all")
    else:
        upstream = _run(repo, ["rev-parse", "--symbolic-full-name", "@{upstream}"])
        if upstream:
            args.extend(["HEAD", upstream.strip(), "--"])

    out = _run(repo, args)
    if out is None:
        # unborn HEAD の空リポジトリでは、現在ブランチを限定した git log が
        # 終了コード 128 になる。HEAD が解決できない Git 管理下だけを
        # 空グラフとして扱い、timeout や破損した履歴はエラーのまま返す。
        inside = _run(repo, ["rev-parse", "--is-inside-work-tree"])
        head = _run(repo, ["rev-parse", "--verify", "--quiet", "HEAD"])
        if inside == "true\n" and head is None:
            return _empty_response(all_refs, default, branch_heads)
        return None

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

    truncated = len(raw_rows) > limit
    raw_rows = raw_rows[:limit]

    lanes: list[str | None] = []
    rows: list[dict[str, Any]] = []
    max_lane = 0
    head_lane: int | None = None

    for row in raw_rows:
        occupied = [i for i, v in enumerate(lanes) if v == row["hash"]]
        if occupied:
            lane = occupied[0]
            # 同じコミットを指すレーンが複数あることがある（複数の子が同じ親を持つ）
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

    default_lane = next(
        (row["lane"] for row in rows if row["hash"] == default_hash),
        None,
    )

    return {
        "rows": rows,
        "max_lane": max_lane,
        "head_lane": head_lane,
        "default_branch": default,
        "default_lane": default_lane,
        "branch_heads": branch_heads,
        "truncated": truncated,
        "command": "git log --oneline --graph" + (" --all" if all_refs else ""),
    }
