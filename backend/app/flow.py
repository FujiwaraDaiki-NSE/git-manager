"""Partition the current commit DAG into display lanes, independent of reflogs.

Lane ownership is a layout choice, not an assertion of historical branch
membership. Every edge is a Git parent edge; PR annotations require matching
commit identities. No state is written or remembered between builds.
"""
from __future__ import annotations

from typing import Any


def build(rows: list[dict[str, Any]], lanes: list[dict[str, Any]], default_branch: str | None,
          default_hash: str | None, github: dict[str, Any], local_relations: list[dict[str, Any]]) -> dict[str, Any]:
    by_hash = {row["hash"]: row for row in rows}
    output = {lane["id"]: {**lane, "flow_hashes": [], "historical": False, "merge_sources": [], "merge_targets": []} for lane in lanes}
    by_branch = {lane["branch"]: lane["id"] for lane in lanes if lane["branch"] is not None}
    owners: dict[str, str] = {}
    anchors: dict[str, str] = {}
    # Only normal merges whose source SHA matches are annotated as Git merges.
    verified = {}
    integrations = []
    for pr in github["pulls"]:
        row = by_hash.get(pr["merge"])
        if row is None or pr["base_repo"].lower() != str(github["repository"]).lower():
            continue
        if len(row["parents"]) == 2 and row["parents"][1] == pr["head_sha"]:
            verified[pr["merge"]] = pr
        elif len(row["parents"]) == 1:
            integrations.append({"number": pr["number"], "url": pr["url"], "source": pr["head"], "target": pr["base"], "commit_hash": pr["merge"]})

    def historical(lane_id: str, name: str, head: str, branch: str | None) -> str:
        if lane_id not in output:
            output[lane_id] = {key: None for key in (
                "path", "worktree_state", "merge_base", "default_ahead", "default_behind", "merged", "dirty", "conflict", "upstream", "upstream_ahead", "upstream_behind", "branch_line", "next_command", "error", "agent", "merge_target", "next_phase")}
            output[lane_id].update(id=lane_id, name=name, branch=branch, head=head, is_worktree=False,
                                   detached=False, last_commit=by_hash.get(head), historical=True,
                                   flow_hashes=[], merge_sources=[], merge_targets=[])
        return lane_id

    def claim(head: str | None, lane_id: str) -> None:
        current = head
        while current in by_hash and current not in owners:
            if current in anchors and anchors[current] != lane_id:
                break
            owners[current] = lane_id
            output[lane_id]["flow_hashes"].append(current)
            parents = by_hash[current]["parents"]
            current = parents[0] if parents else None

    def pr_lane(pr: dict[str, Any], side: str) -> str:
        branch = pr[side]
        head = pr["head_sha"] if side == "head" else pr["merge"]
        # A fork's branch name is not the same ref as a same-named local branch.
        same_repo = side == "base" or (pr["head_repo"] is not None and pr["head_repo"].lower() == pr["base_repo"].lower())
        lane_id = by_branch.get(branch) if same_repo else None
        if lane_id is not None:
            return lane_id
        label = branch if same_repo else f'{pr["head_repo"] or "削除済みfork"}:{branch}'
        return historical(f'pr:{pr["number"]}:{side}', label, head, branch if same_repo else None)

    if default_branch in by_branch:
        default_id = by_branch[default_branch]
        claim(output[default_id]["head"], default_id)
        claim(default_hash, default_id)
    elif default_hash in by_hash:
        default_id = historical("history:default", f"origin/{default_branch}", default_hash, default_branch)
        claim(default_hash, default_id)

    # Protect explicit source tips before walking descendant branches. A
    # stacked branch must start at its parent's tip, not absorb its history.
    for row in rows:
        pr = verified.get(row["hash"])
        if pr is not None and pr["head_sha"] not in owners:
            anchors.setdefault(pr["head_sha"], pr_lane(pr, "head"))
    for lane in lanes:
        if lane["head"] in by_hash and lane["head"] not in owners:
            anchors.setdefault(lane["head"], lane["id"])
    # Explicit local merge targets can also retain their own historical row.
    for relation in local_relations:
        if relation["target_lane_id"] in output and relation["commit_hash"] not in owners:
            anchors[relation["commit_hash"]] = relation["target_lane_id"]
    # Establish PR target paths before source paths, including stacked PRs.
    for row in rows:
        pr = verified.get(row["hash"])
        if pr is not None:
            claim(pr["merge"], pr_lane(pr, "base"))
    # Existing local evidence names merges; edges never depend on it.
    for relation in local_relations:
        if relation["target_lane_id"] in output:
            claim(relation["commit_hash"], relation["target_lane_id"])
    # PR identities precede unrelated aliases of the same historical tip.
    for row in rows:
        pr = verified.get(row["hash"])
        if pr is not None:
            lane_id = pr_lane(pr, "head")
            claim(output[lane_id]["head"], lane_id)
            claim(pr["head_sha"], lane_id)
    # Claim current tips first so post-merge development stays on the same row.
    rank = {row["hash"]: index for index, row in enumerate(rows)}
    for lane in sorted(lanes, key=lambda lane: (-rank.get(lane["head"], len(rows)), lane["id"])):
        claim(lane["head"], lane["id"])
    for head, lane_id in anchors.items():
        claim(head, lane_id)
    for row in rows:
        if row["hash"] not in owners:
            lane_id = historical(f'history:{row["hash"]}', f'履歴 {row["short"]}（ブランチ名不明）', row["hash"], None)
            claim(row["hash"], lane_id)

    connections = []
    for row in rows:
        target_id = owners[row["hash"]]
        for index, parent in enumerate(row["parents"]):
            source_id = owners.get(parent)
            if source_id is None:
                continue  # acquisition boundary, never invent a parent
            pr = verified.get(row["hash"]) if index > 0 else None
            relation = {
                "commit_hash": row["hash"], "occurred_at": row["date"], "target_parent": row["parents"][0],
                "source_parent": parent, "source_branch": output[source_id]["name"], "source_lane_id": source_id,
                "target_branch": output[target_id]["name"], "target_lane_id": target_id,
                "kind": "merge" if index > 0 else "branch" if source_id != target_id else "commit",
                "pr_number": pr["number"] if pr else None, "pr_url": pr["url"] if pr else None,
            }
            connections.append(relation)
            if index > 0:
                output[source_id]["merge_sources"].append(relation)
                output[target_id]["merge_targets"].append(relation)
    for lane in output.values():
        lane["flow_hashes"].sort(key=lambda hash_value: -rank[hash_value])
        # Identical tips are aliases of one graph point, not fictitious forks.
        lane["alias_lane_id"] = owners.get(lane["head"]) if not lane["flow_hashes"] else None
    return {"lanes": list(output.values()), "connections": connections, "integrations": integrations}
