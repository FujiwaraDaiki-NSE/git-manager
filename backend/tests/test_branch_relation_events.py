from __future__ import annotations

import os
import subprocess
from pathlib import Path

from app import branch_relation_events


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def git_at(repo: Path, timestamp: str, *args: str) -> str:
    environment = os.environ.copy()
    environment["GIT_AUTHOR_DATE"] = timestamp
    environment["GIT_COMMITTER_DATE"] = timestamp
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    return result.stdout.strip()


def init_repo(repo: Path) -> None:
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.com")
    git_at(
        repo,
        "2026-10-07T09:00:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
    )


def local_row(repo: Path, branch: str, row_id: str | None = None) -> dict:
    return {
        "id": row_id or f"local:{branch}",
        "name": branch,
        "remote_ref": None,
        "locals": [
            {
                "id": f"branch:{branch}",
                "branch": branch,
                "head": git(repo, "rev-parse", f"refs/heads/{branch}"),
                "upstream": None,
            }
        ],
    }


def test_named_fast_forward_has_both_after_hash_endpoints_and_commit_metadata(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:00:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:01:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:03:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "source",
    )

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source")]
    )
    edge = next(item for item in result["edges"] if item["operation"] == "fast_forward")

    assert edge["kind"] == "merge"
    assert edge["evidence"] == "reflog"
    assert edge["source_row_id"] == "local:source"
    assert edge["target_row_id"] == "local:main"
    assert edge["source_ref_id"] == "refs/heads/source"
    assert edge["target_ref_id"] == "refs/heads/main"
    assert edge["source_commit_hash"] == source_hash
    assert edge["target_commit_hash"] == source_hash
    assert edge["source_commit"]["hash"] == source_hash
    assert edge["target_commit"]["hash"] == source_hash
    assert edge["pr_number"] is None and edge["pr_url"] is None
    assert any(character >= "\u0080" for character in edge["label"])


def test_normal_and_octopus_merges_keep_actual_parent_hashes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:00:00+09:00", "switch", "-q", "-c", "source-a")
    git_at(
        repo,
        "2026-10-07T10:01:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source a",
    )
    source_a = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:00:00+09:00", "switch", "-q", "-c", "source-b")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source b",
    )
    source_b = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "-c", "release")
    git_at(
        repo,
        "2026-10-07T10:05:00+09:00",
        "merge",
        "--no-ff",
        "-q",
        "source-a",
        "source-b",
        "-m",
        "octopus",
    )
    merge_hash = git(repo, "rev-parse", "HEAD")

    rows = [local_row(repo, name) for name in ("source-a", "source-b", "release")]
    result = branch_relation_events.build(str(repo), rows)
    edges = [
        item
        for item in result["edges"]
        if item["operation"] == "merge" and item["commit_hash"] == merge_hash
    ]

    assert {item["source_commit_hash"] for item in edges} == {source_a, source_b}
    assert all(item["target_row_id"] == "local:release" for item in edges)
    assert all(item["source_commit"]["hash"] == item["source_commit_hash"] for item in edges)
    assert all(item["target_commit"]["hash"] == merge_hash for item in edges)


def test_deleted_or_sha_only_source_stays_unresolved_with_evidence(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "source")
    git(repo, "commit", "--allow-empty", "-qm", "source")
    source_hash = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git(repo, "switch", "-q", "-c", "release")
    git(repo, "merge", "--no-ff", "-q", "source", "-m", "merge source")
    merge_hash = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git(repo, "branch", "-D", "source")

    result = branch_relation_events.build(str(repo), [local_row(repo, "main"), local_row(repo, "release")])
    unresolved = next(
        item
        for item in result["unresolved"]
        if item["operation"] == "merge" and item["commit_hash"] == merge_hash
    )
    assert unresolved["reason"] == "source_ref_not_found"
    assert unresolved["source"] == "source"
    assert unresolved["source_commit_hash"] == source_hash
    assert unresolved["target_commit_hash"] == merge_hash


def test_head_and_sha_sources_are_not_guessed_from_matching_hashes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "switch", "-q", "-c", "source")
    git(repo, "commit", "--allow-empty", "-qm", "source")
    source_hash = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "-q", "main")
    git(repo, "switch", "-q", "-c", "release")
    git(repo, "merge", "--no-ff", "-q", source_hash, "-m", "merge by sha")

    rows = [local_row(repo, "main"), local_row(repo, "source"), local_row(repo, "release")]
    result = branch_relation_events.build(str(repo), rows)
    sha_unresolved = next(
        item
        for item in result["unresolved"]
        if item["operation"] == "merge" and item["source"] == source_hash
    )
    assert sha_unresolved["reason"] == "source_ref_not_named"
    assert sha_unresolved["source_commit_hash"] == source_hash


def test_reflog_failure_is_unknown_without_using_a_shell(monkeypatch, tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    row = local_row(repo, "main")

    def fail(*_args, **_kwargs):
        return None, None

    monkeypatch.setattr(branch_relation_events.gitinfo, "_run_with_status", fail)
    result = branch_relation_events.build(str(repo), [row])

    assert result["edges"] == []
    assert result["reflog_status"] == "unavailable"


def test_fast_forward_keeps_endpoint_before_source_followup_commit(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "before merge",
    )
    before_merge = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:04:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "source",
    )
    git_at(repo, "2026-10-07T10:05:00+09:00", "switch", "-q", "source")
    git_at(
        repo,
        "2026-10-07T10:06:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "after merge",
    )
    after_merge = git(repo, "rev-parse", "HEAD")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_commit_hash"] == before_merge
    assert edge["target_commit_hash"] == before_merge
    assert after_merge != before_merge


def test_fast_forward_is_retained_after_target_reset_as_historical_edge(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:04:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "source",
    )
    git_at(repo, "2026-10-07T10:05:00+09:00", "reset", "--hard", "HEAD^")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_commit_hash"] == source_hash
    assert edge["target_commit_hash"] == source_hash
    assert edge["historical"] is True


def test_expired_reflog_has_no_false_edge_and_successful_read_status(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:04:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "source",
    )
    git(repo, "reflog", "expire", "--expire=now", "--all")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source")]
    )
    assert result["edges"] == []
    assert result["reflog_status"] == "available"


def test_recreated_source_name_with_different_history_stays_unresolved(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "old source",
    )
    old_source = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "switch", "-q", "-c", "release")
    git_at(
        repo,
        "2026-10-07T10:05:00+09:00",
        "merge",
        "--no-ff",
        "-q",
        "source",
        "-m",
        "merge old source",
    )
    merge_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:06:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:07:00+09:00", "branch", "-D", "source")
    git_at(repo, "2026-10-07T10:08:00+09:00", "branch", "source", "main")
    git_at(repo, "2026-10-07T10:09:00+09:00", "switch", "-q", "source")
    git_at(
        repo,
        "2026-10-07T10:10:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "new source",
    )

    rows = [local_row(repo, name) for name in ("main", "release", "source")]
    result = branch_relation_events.build(str(repo), rows)
    assert not any(
        item["operation"] == "merge" and item["commit_hash"] == merge_hash
        for item in result["edges"]
    )
    unresolved = next(
        item
        for item in result["unresolved"]
        if item["operation"] == "merge" and item["commit_hash"] == merge_hash
    )
    assert unresolved["source"] == "source"
    assert unresolved["source_commit_hash"] == old_source
    assert unresolved["reason"] in {
        "source_commit_not_in_reflog",
        "source_ref_incarnation_unproven",
    }


def test_same_second_source_recreation_is_not_attached_to_old_fast_forward(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    same_second = "2026-10-07T10:01:00+09:00"
    git_at(repo, same_second, "switch", "-q", "-c", "source")
    git_at(repo, same_second, "commit", "--allow-empty", "-qm", "source")
    git_at(repo, same_second, "switch", "-q", "main")
    git_at(repo, same_second, "merge", "--ff-only", "-q", "source")
    merged_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, same_second, "branch", "-D", "source")
    git_at(repo, same_second, "branch", "source", merged_hash)

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source")]
    )
    assert not any(
        item["operation"] == "fast_forward" for item in result["edges"]
    )
    unresolved = next(
        item
        for item in result["unresolved"]
        if item["operation"] == "fast_forward"
    )
    assert unresolved["source_commit_hash"] == merged_hash


def test_source_rename_alias_preserves_old_named_fast_forward(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "old")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "merge", "--ff-only", "-q", "old")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "-m", "old", "new")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "new")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_row_id"] == "local:new"
    assert edge["source_ref_id"] == "refs/heads/new"
    assert edge["source_commit_hash"] == source_hash


def test_source_rename_chain_resolves_each_old_alias_to_current_ref(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "old")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "merge", "--ff-only", "-q", "old")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "-m", "old", "middle")
    git_at(repo, "2026-10-07T10:06:00+09:00", "branch", "-m", "middle", "current")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "current")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_row_id"] == "local:current"
    assert edge["source_ref_id"] == "refs/heads/current"
    assert edge["source_commit_hash"] == source_hash


def test_renamed_source_and_recreated_old_name_keep_merge_on_new_ref(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "old")
    git_at(repo, "2026-10-07T10:02:00+09:00", "commit", "--allow-empty", "-qm", "source")
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "merge", "--ff-only", "-q", "old")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "-m", "old", "new")
    git_at(repo, "2026-10-07T10:06:00+09:00", "branch", "old", "main")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, name) for name in ("main", "new", "old")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_ref_id"] == "refs/heads/new"
    assert edge["source_row_id"] == "local:new"
    assert edge["source_commit_hash"] == source_hash
    assert any(
        item["operation"] == "branch_create"
        and item["target_row_id"] == "local:old"
        for item in result["edges"]
    )


def test_source_name_interval_does_not_attach_deleted_temporary_ref(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "old")
    git_at(repo, "2026-10-07T10:02:00+09:00", "commit", "--allow-empty", "-qm", "source")
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "-m", "old", "originalnew")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "old", source_hash)
    git_at(repo, "2026-10-07T10:06:00+09:00", "switch", "-q", "-c", "target", "main")
    git_at(repo, "2026-10-07T10:07:00+09:00", "merge", "--ff-only", "-q", "old")
    merge_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:08:00+09:00", "branch", "-D", "old")
    git_at(repo, "2026-10-07T10:09:00+09:00", "branch", "-m", "originalnew", "old")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, name) for name in ("main", "target", "old")]
    )
    assert not any(
        item["operation"] == "fast_forward"
        and item["commit_hash"] == merge_hash
        and item["source_ref_id"] == "refs/heads/old"
        for item in result["edges"]
    )
    unresolved = next(
        item
        for item in result["unresolved"]
        if item["operation"] == "fast_forward"
        and item["commit_hash"] == merge_hash
    )
    assert unresolved["source_commit_hash"] == source_hash
    assert unresolved["reason"] in {
        "source_ref_incarnation_unproven",
        "source_commit_not_in_reflog",
    }


def test_source_rename_round_trip_keeps_same_incarnation_at_old_name(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:00:00+09:00", "switch", "-q", "-c", "old")
    git_at(
        repo,
        "2026-10-07T10:01:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:02:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:03:00+09:00", "merge", "--ff-only", "-q", "old")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "-m", "old", "middle")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "-m", "middle", "old")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "old")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_ref_id"] == "refs/heads/old"
    assert edge["source_row_id"] == "local:old"
    assert edge["source_commit_hash"] == source_hash


def test_renamed_historical_source_beats_recreated_name_after_second_rename(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:00:00+09:00", "switch", "-q", "-c", "old")
    git_at(
        repo,
        "2026-10-07T10:01:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:02:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:03:00+09:00", "merge", "--ff-only", "-q", "old")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "-m", "old", "new1")
    git_at(repo, "2026-10-07T10:05:00+09:00", "branch", "old", "main")
    git_at(repo, "2026-10-07T10:06:00+09:00", "branch", "-m", "old", "new2")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, name) for name in ("main", "new1", "new2")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_ref_id"] == "refs/heads/new1"
    assert edge["source_row_id"] == "local:new1"
    assert edge["source_commit_hash"] == source_hash
    assert not any(
        item["operation"] == "fast_forward"
        and item.get("source_ref_id") == "refs/heads/new2"
        for item in result["edges"]
    )


def test_target_rename_keeps_old_merge_and_recreated_target_is_unresolved(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "switch", "-q", "-c", "release")
    git_at(
        repo,
        "2026-10-07T10:05:00+09:00",
        "merge",
        "--no-ff",
        "-q",
        "source",
        "-m",
        "merge",
    )
    merge_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:06:00+09:00", "branch", "-m", "release", "delivery")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source"), local_row(repo, "delivery")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "merge" and item["commit_hash"] == merge_hash
    )
    assert edge["target_row_id"] == "local:delivery"
    assert edge["target_ref_id"] == "refs/heads/delivery"

    git_at(repo, "2026-10-07T10:07:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:08:00+09:00", "branch", "-D", "delivery")
    git_at(repo, "2026-10-07T10:09:00+09:00", "branch", "release", "main")
    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source"), local_row(repo, "release")]
    )
    assert not any(
        item["operation"] == "merge" and item["commit_hash"] == merge_hash
        for item in result["edges"]
    )
    assert any(
        item["operation"] == "merge"
        and item["commit_hash"] == merge_hash
        and item["reason"] == "target_incarnation_unproven"
        for item in result["unresolved"]
    )


def test_remote_ref_fast_forward_uses_remote_row_even_with_local_source(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:04:00+09:00",
        "update-ref",
        "refs/remotes/origin/source",
        source_hash,
    )
    git_at(repo, "2026-10-07T10:05:00+09:00", "switch", "-q", "-c", "target")
    git_at(
        repo,
        "2026-10-07T10:06:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "origin/source",
    )

    remote_row = {
        "id": "remote:origin/source",
        "name": "source",
        "remote_ref": "origin/source",
        "locals": [],
    }
    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source"), local_row(repo, "target"), remote_row]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
        and item["target_row_id"] == "local:target"
    )
    assert edge["source_row_id"] == "remote:origin/source"
    assert edge["source_ref_id"] == "refs/remotes/origin/source"
    assert edge["target_ref_id"] == "refs/heads/target"


def test_remote_and_local_refs_in_one_row_can_form_distinct_edge(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(
        repo,
        "2026-10-07T10:04:00+09:00",
        "update-ref",
        "refs/remotes/origin/main",
        source_hash,
    )
    git_at(
        repo,
        "2026-10-07T10:05:00+09:00",
        "merge",
        "--ff-only",
        "-q",
        "origin/main",
    )
    row = {
        **local_row(repo, "main", "remote:origin/main"),
        "remote_ref": "origin/main",
    }
    result = branch_relation_events.build(str(repo), [row])
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_row_id"] == edge["target_row_id"] == "remote:origin/main"
    assert edge["source_ref_id"] != edge["target_ref_id"]


def test_same_second_fast_forwards_to_two_targets_keep_both_target_edges(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(repo, "2026-10-07T10:02:00+09:00", "commit", "--allow-empty", "-qm", "source")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "target1", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "target2", "main")
    same_second = "2026-10-07T10:05:00+09:00"
    git_at(repo, same_second, "switch", "-q", "target1")
    git_at(repo, same_second, "merge", "--ff-only", "-q", "source")
    git_at(repo, same_second, "switch", "-q", "target2")
    git_at(repo, same_second, "merge", "--ff-only", "-q", "source")

    result = branch_relation_events.build(
        str(repo),
        [local_row(repo, name) for name in ("main", "source", "target1", "target2")],
    )
    edges = [
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    ]
    assert {item["target_row_id"] for item in edges} == {
        "local:target1",
        "local:target2",
    }


def test_same_target_fast_forward_reset_fast_forward_keeps_two_sequences(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(repo, "2026-10-07T10:02:00+09:00", "commit", "--allow-empty", "-qm", "source")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:04:00+09:00", "branch", "target", "main")
    same_second = "2026-10-07T10:05:00+09:00"
    git_at(repo, same_second, "switch", "-q", "target")
    git_at(repo, same_second, "merge", "--ff-only", "-q", "source")
    git_at(repo, same_second, "reset", "--hard", "main")
    git_at(repo, same_second, "merge", "--ff-only", "-q", "source")

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "source"), local_row(repo, "target")]
    )
    edges = [
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
        and item["target_row_id"] == "local:target"
    ]
    assert len(edges) == 2
    assert len({item["id"] for item in edges}) == 2


def test_local_origin_prefix_wins_when_tracking_ref_is_absent(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git(repo, "remote", "add", "origin", str(repo))
    git_at(repo, "2026-10-07T10:01:00+09:00", "branch", "origin/topic", "main")
    git_at(repo, "2026-10-07T10:02:00+09:00", "switch", "-q", "origin/topic")
    git_at(repo, "2026-10-07T10:03:00+09:00", "commit", "--allow-empty", "-qm", "topic")
    git_at(repo, "2026-10-07T10:04:00+09:00", "switch", "-q", "main")
    git_at(repo, "2026-10-07T10:05:00+09:00", "switch", "-q", "-c", "target", "main")
    git_at(repo, "2026-10-07T10:06:00+09:00", "merge", "--ff-only", "-q", "origin/topic")

    result = branch_relation_events.build(
        str(repo),
        [local_row(repo, name) for name in ("main", "origin/topic", "target")],
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "fast_forward"
    )
    assert edge["source_ref_id"] == "refs/heads/origin/topic"
    assert edge["source_row_id"] == "local:origin/topic"
    assert not any(
        item.get("source_ref_id") == "refs/remotes/origin/topic"
        for item in result["edges"]
    )


def test_branch_create_distinguishes_explicit_main_from_head_source(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "branch", "explicit", "main")
    git_at(repo, "2026-10-07T10:02:00+09:00", "switch", "-q", "-c", "head-derived")

    result = branch_relation_events.build(
        str(repo),
        [local_row(repo, "main"), local_row(repo, "explicit"), local_row(repo, "head-derived")],
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "branch_create"
        and item["target_row_id"] == "local:explicit"
    )
    assert edge["source_row_id"] == "local:main"
    assert any(
        item["operation"] == "branch_create"
        and item["target_row_id"] == "local:head-derived"
        and item["reason"] == "source_ref_not_named"
        for item in result["unresolved"]
    )


def test_old_reflog_event_survives_more_than_two_hundred_followup_commits(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "branch", "old", "main")
    git_at(repo, "2026-10-07T10:02:00+09:00", "switch", "-q", "old")
    for index in range(205):
        git_at(
            repo,
            f"2026-10-07T10:{3 + index // 60:02d}:{index % 60:02d}+09:00",
            "commit",
            "--allow-empty",
            "-qm",
            f"followup {index}",
        )

    result = branch_relation_events.build(
        str(repo), [local_row(repo, "main"), local_row(repo, "old")]
    )
    edge = next(
        item
        for item in result["edges"]
        if item["operation"] == "branch_create"
        and item["target_row_id"] == "local:old"
    )
    assert edge["source_row_id"] == "local:main"


def test_linked_worktree_head_reflog_preserves_deleted_target_as_unresolved(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    worktree = tmp_path / "worktree"
    init_repo(repo)
    git_at(repo, "2026-10-07T10:01:00+09:00", "switch", "-q", "-c", "source")
    git_at(
        repo,
        "2026-10-07T10:02:00+09:00",
        "commit",
        "--allow-empty",
        "-qm",
        "source",
    )
    source_hash = git(repo, "rev-parse", "HEAD")
    git_at(repo, "2026-10-07T10:03:00+09:00", "switch", "-q", "main")
    git(repo, "worktree", "add", "-q", str(worktree), "-b", "target", "main")
    git_at(
        worktree,
        "2026-10-07T10:04:00+09:00",
        "merge",
        "--no-ff",
        "-q",
        "source",
        "-m",
        "worktree merge",
    )
    merge_hash = git(worktree, "rev-parse", "HEAD")
    git_at(worktree, "2026-10-07T10:05:00+09:00", "switch", "-q", "-c", "other", "main")
    git(repo, "branch", "-D", "target")

    other_row = local_row(repo, "main", "local:other")
    other_row["name"] = "other"
    other_row["locals"][0]["branch"] = "other"
    other_row["locals"][0]["id"] = "branch:other"
    other_row["locals"][0]["head"] = git(worktree, "rev-parse", "HEAD")
    other_row["locals"][0]["path"] = str(worktree)
    rows = [local_row(repo, "main"), local_row(repo, "source"), other_row]

    result = branch_relation_events.build(str(repo), rows)
    assert not any(item["commit_hash"] == merge_hash for item in result["edges"])
    unresolved = next(
        item
        for item in result["unresolved"]
        if item["commit_hash"] == merge_hash
    )
    assert unresolved["reason"] in {"target_ref_not_found", "target_ref_unknown"}
    assert unresolved["source"] == "source"
    assert unresolved["source_commit_hash"] == source_hash
