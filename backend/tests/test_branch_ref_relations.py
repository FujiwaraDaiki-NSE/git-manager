from __future__ import annotations

import subprocess
from pathlib import Path

from app import branch_ref_relations


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def init_repo(repo: Path) -> None:
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")


def commit(repo: Path, subject: str) -> str:
    git(repo, "commit", "--allow-empty", "-qm", subject)
    return git(repo, "rev-parse", "HEAD")


def local_row(row_id: str, branch: str, head: str) -> dict:
    return {
        "id": row_id,
        "name": branch,
        "remote_ref": None,
        "remote_hash": None,
        "locals": [{"branch": branch, "name": branch, "head": head}],
    }


def pair(result: dict, left: str, right: str) -> dict:
    return next(
        item
        for item in result["pairs"]
        if item["left_ref_id"] == left and item["right_ref_id"] == right
    )


def test_none_and_empty_rows_are_distinct_success_states(tmp_path: Path) -> None:
    assert branch_ref_relations.build(str(tmp_path), None) == {
        "refs": [],
        "pairs": [],
        "ancestry_status": "unavailable",
    }
    assert branch_ref_relations.build(str(tmp_path), []) == {
        "refs": [],
        "pairs": [],
        "ancestry_status": "complete",
    }


def test_expands_remote_local_and_detached_refs_and_all_pairs(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = commit(repo, "base")
    git(repo, "switch", "-q", "-c", "feature")
    feature = commit(repo, "feature")
    rows = [
        {
            "id": "row-main",
            "name": "main",
            "remote_ref": "origin/main",
            "remote_hash": base,
            "locals": [{"branch": "main", "name": "main", "head": base}],
        },
        {
            "id": "row-feature",
            "name": "feature",
            "remote_ref": None,
            "remote_hash": None,
            "locals": [
                {"branch": "feature", "name": "feature", "head": feature},
                {
                    "branch": None,
                    "name": "detached HEAD",
                    "path": str(tmp_path / "detached"),
                    "head": feature,
                    "detached": True,
                },
            ],
        },
    ]

    result = branch_ref_relations.build(str(repo), rows)
    assert [item["id"] for item in result["refs"]] == [
        "refs/remotes/origin/main",
        "refs/heads/main",
        "refs/heads/feature",
        f"detached:{tmp_path / 'detached'}",
    ]
    assert [item["kind"] for item in result["refs"]] == [
        "remote",
        "local",
        "local",
        "detached",
    ]
    assert len(result["pairs"]) == 6
    assert pair(result, "refs/remotes/origin/main", "refs/heads/main")["relation"] == "equal"
    assert pair(result, "refs/remotes/origin/main", "refs/heads/feature")["relation"] == "behind"
    assert pair(result, "refs/heads/feature", f"detached:{tmp_path / 'detached'}")["relation"] == "equal"


def test_remote_ahead_local_ahead_and_diverged_use_snapshot_hashes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = commit(repo, "base")
    git(repo, "switch", "-q", "-c", "ahead")
    ahead = commit(repo, "ahead")
    git(repo, "switch", "-q", "main")
    remote_ahead = commit(repo, "remote ahead")
    git(repo, "switch", "-q", "-c", "other", base)
    other = commit(repo, "other")

    rows = [
        {
            "id": "row-ahead",
            "name": "ahead",
            "remote_ref": "origin/ahead",
            "remote_hash": remote_ahead,
            "locals": [{"branch": "ahead", "head": ahead}],
        },
        local_row("row-other", "other", other),
    ]
    result = branch_ref_relations.build(str(repo), rows)
    remote_local = pair(result, "refs/remotes/origin/ahead", "refs/heads/ahead")
    assert remote_local["relation"] == "diverged"
    assert remote_local["left_only"] == 1
    assert remote_local["right_only"] == 1
    assert remote_local["merge_bases"] == [base]

    rows[0]["remote_hash"] = ahead
    result = branch_ref_relations.build(str(repo), rows)
    assert pair(result, "refs/remotes/origin/ahead", "refs/heads/ahead")["relation"] == "equal"

    rows[0]["remote_hash"] = remote_ahead
    rows[0]["locals"][0]["head"] = base
    result = branch_ref_relations.build(str(repo), rows)
    assert pair(result, "refs/remotes/origin/ahead", "refs/heads/ahead")["relation"] == "ahead"


def test_multiple_best_merge_bases_are_preserved_for_criss_cross_history(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    root = commit(repo, "root")
    git(repo, "switch", "-q", "-c", "left")
    left_base = commit(repo, "left base")
    git(repo, "switch", "-q", "-c", "right", root)
    right_base = commit(repo, "right base")

    git(repo, "switch", "-q", "left")
    left_tip = commit(repo, "left tip")
    git(repo, "merge", "--no-ff", "-q", "right", "-m", "merge right into left")
    left_merge = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "right")
    git(repo, "merge", "--no-ff", "-q", left_base, "-m", "merge left base into right")
    right_merge = git(repo, "rev-parse", "HEAD")

    result = branch_ref_relations.build(
        str(repo),
        [local_row("left", "left", left_merge), local_row("right", "right", right_merge)],
    )
    relation = pair(result, "refs/heads/left", "refs/heads/right")
    assert relation["relation"] == "diverged"
    assert set(relation["merge_bases"]) == {left_base, right_base}
    assert relation["left_only"] == 2
    assert relation["right_only"] == 1
    assert left_tip not in relation["merge_bases"]


def test_invalid_and_missing_hashes_are_unknown_without_false_unrelated(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    base = commit(repo, "base")
    child = commit(repo, "child")
    missing = "f" * 40
    result = branch_ref_relations.build(
        str(repo),
        [
            local_row("base", "base", base),
            local_row("child", "child", child),
            local_row("missing", "missing", missing),
            local_row("invalid", "invalid", "short"),
        ],
    )
    assert pair(result, "refs/heads/base", "refs/heads/child")["relation"] == "behind"
    missing_pair = pair(result, "refs/heads/base", "refs/heads/missing")
    assert missing_pair["relation"] == "unknown"
    assert missing_pair["left_only"] is None
    assert missing_pair["right_only"] is None
    assert missing_pair["merge_bases"] is None
    assert missing_pair["reason"] == "missing_object"
    assert pair(result, "refs/heads/base", "refs/heads/invalid")["reason"] == "invalid_hash"
    assert result["ancestry_status"] == "partial"


def test_duplicate_ref_snapshots_are_coalesced_and_conflicts_stay_unknown(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    head = commit(repo, "head")
    other = commit(repo, "other")
    rows = [local_row("first", "same", head), local_row("second", "same", head)]
    result = branch_ref_relations.build(str(repo), rows)
    assert [item["id"] for item in result["refs"]] == ["refs/heads/same"]
    assert result["pairs"] == []

    rows[1]["locals"][0]["head"] = other
    result = branch_ref_relations.build(str(repo), rows)
    assert len(result["refs"]) == 1
    assert result["refs"][0]["hash"] is None


def test_shallow_shared_boundary_proves_pair_but_different_boundary_stays_unknown(tmp_path: Path) -> None:
    source = tmp_path / "source"
    init_repo(source)
    commit(source, "first")
    commit(source, "second")
    third = commit(source, "third")
    shallow = tmp_path / "shallow"
    subprocess.run(
        ["git", "clone", "-q", "--depth=1", f"file://{source}", str(shallow)],
        check=True,
    )
    git(shallow, "config", "user.name", "Test")
    git(shallow, "config", "user.email", "test@example.com")
    git(shallow, "switch", "-q", "-c", "left")
    left = commit(shallow, "left")
    git(shallow, "switch", "-q", "main")
    git(shallow, "switch", "-q", "-c", "right")
    right = commit(shallow, "right")
    result = branch_ref_relations.build(
        str(shallow),
        [local_row("left", "left", left), local_row("right", "right", right)],
    )
    relation = pair(result, "refs/heads/left", "refs/heads/right")
    assert relation["relation"] == "diverged"
    assert relation["left_only"] == 1
    assert relation["right_only"] == 1
    assert relation["merge_bases"] == [third]
    assert relation["reason"] is None

    git(shallow, "switch", "-q", "--orphan", "orphan")
    orphan = commit(shallow, "orphan")
    result = branch_ref_relations.build(
        str(shallow),
        [local_row("left", "left", left), local_row("orphan", "orphan", orphan)],
    )
    relation = pair(result, "refs/heads/left", "refs/heads/orphan")
    assert relation["relation"] == "unknown"
    assert relation["left_only"] is None
    assert relation["right_only"] is None
    assert relation["merge_bases"] is None
    assert relation["reason"] == "shallow_history"
    assert result["ancestry_status"] == "shallow"


def test_large_dag_is_not_truncated_at_history_page_size(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    root = commit(repo, "root")
    for index in range(250):
        tip = commit(repo, f"commit {index}")
    result = branch_ref_relations.build(
        str(repo),
        [local_row("root", "root", root), local_row("tip", "main", tip)],
    )
    relation = pair(result, "refs/heads/root", "refs/heads/main")
    assert relation["relation"] == "behind"
    assert relation["right_only"] == 250
    assert relation["merge_bases"] == [root]


def test_every_pair_matches_git_oracle_on_small_fixture(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    root = commit(repo, "root")
    git(repo, "switch", "-q", "-c", "left")
    left = commit(repo, "left")
    git(repo, "switch", "-q", "main")
    main = commit(repo, "main")
    git(repo, "switch", "-q", "-c", "merged", "left")
    git(repo, "merge", "--no-ff", "-q", "main", "-m", "merge main")
    merged = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "--orphan", "unrelated")
    unrelated = commit(repo, "unrelated")

    rows = [
        local_row("left", "left", left),
        local_row("main", "main", main),
        local_row("merged", "merged", merged),
        local_row("unrelated", "unrelated", unrelated),
    ]
    result = branch_ref_relations.build(str(repo), rows)
    hashes = {
        ref["id"]: ref["hash"]
        for ref in result["refs"]
        if ref["kind"] == "local"
    }
    assert len(result["pairs"]) == 6
    for relation in result["pairs"]:
        left_id = relation["left_ref_id"]
        right_id = relation["right_ref_id"]
        left_hash = hashes[left_id]
        right_hash = hashes[right_id]
        assert left_hash and right_hash
        counts = git(repo, "rev-list", "--left-right", "--count", f"{left_hash}...{right_hash}")
        left_only, right_only = (int(value) for value in counts.split())
        bases_result = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--all", left_hash, right_hash],
            capture_output=True,
            text=True,
        )
        expected_bases = bases_result.stdout.splitlines() if bases_result.returncode == 0 else []
        if left_hash == right_hash:
            expected_relation = "equal"
        else:
            left_ancestor = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", right_hash, left_hash]
            ).returncode == 0
            right_ancestor = subprocess.run(
                ["git", "-C", str(repo), "merge-base", "--is-ancestor", left_hash, right_hash]
            ).returncode == 0
            if left_ancestor:
                expected_relation = "ahead"
            elif right_ancestor:
                expected_relation = "behind"
            elif expected_bases:
                expected_relation = "diverged"
            else:
                expected_relation = "unrelated"
        assert relation["relation"] == expected_relation
        assert relation["left_only"] == left_only
        assert relation["right_only"] == right_only
        assert set(relation["merge_bases"] or []) == set(expected_bases)
    assert root not in hashes.values()
