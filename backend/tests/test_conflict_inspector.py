from __future__ import annotations

import base64
import hashlib
import subprocess
from pathlib import Path

import pytest

from app import conflict_inspector
from app.conflict_inspector import (
    ConflictChangedError,
    ConflictInspectorInputError,
    get_conflict_comparison,
    get_conflict_stage,
    get_conflicts,
)


def git(repo: Path, *args: str, input: bytes | None = None, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input,
        capture_output=True,
        check=check,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Conflict inspector test")
    git(repo, "config", "user.email", "conflict-inspector@example.invalid")
    git(repo, "config", "core.hooksPath", "/dev/null")
    return repo


def commit(repo: Path, message: str) -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", message)


def make_modify_conflict(tmp_path: Path, *, name: str = "conflict.txt") -> Path:
    repo = make_repo(tmp_path)
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"base version\n")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    path.write_bytes(b"theirs version\n")
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    path.write_bytes(b"ours version\n")
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)
    return repo


def test_inventory_groups_base_ours_theirs_with_object_metadata(tmp_path: Path) -> None:
    repo = make_modify_conflict(tmp_path)

    result = get_conflicts(str(repo))

    assert result is not None
    assert result["truncated"] is False
    assert result["snapshot_key"] == result["snapshot"]["key"]
    assert result["files"][0]["path"] == "conflict.txt"
    conflict = result["files"][0]
    assert set(conflict["stages"]) == {"1", "2", "3"}
    assert conflict["missing_stages"] == []
    assert conflict["base"]["mode"] == "100644"
    assert conflict["ours"]["type"] == "blob"
    assert conflict["theirs"]["size"] == len(b"theirs version\n")
    assert conflict["ours"]["hash"] != conflict["theirs"]["hash"]


def test_stage_preview_is_index_pinned_and_preserves_special_path(tmp_path: Path) -> None:
    name = "odd\tname\n.txt"
    repo = make_modify_conflict(tmp_path, name=name)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    ours = next(item for item in inventory["files"] if item["path"] == name)["ours"]

    result = get_conflict_stage(str(repo), name, 2, ours["hash"])

    assert result is not None
    assert result["input"] == {"file": name, "stage": 2, "expected_hash": ours["hash"]}
    assert result["text"] == "ours version\n"
    assert result["binary"] is False
    assert result["complete"] is True
    assert result["downloadable"] is True
    assert base64.b64decode(result["content_base64"]) == b"ours version\n"
    assert result["snapshot"]["path"] == name


def test_add_add_inventory_explicitly_reports_missing_base(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    git(repo, "commit", "--allow-empty", "-qm", "empty base")
    git(repo, "switch", "-qc", "feature")
    (repo / "new.txt").write_text("theirs\n", encoding="utf-8")
    commit(repo, "feature add")
    git(repo, "switch", "-q", "main")
    (repo / "new.txt").write_text("ours\n", encoding="utf-8")
    commit(repo, "main add")
    git(repo, "merge", "feature", check=False)

    result = get_conflicts(str(repo))

    assert result is not None
    item = result["files"][0]
    assert item["path"] == "new.txt"
    assert item["base"] is None
    assert item["ours"] is not None
    assert item["theirs"] is not None
    assert item["missing_stages"] == [1]


def test_delete_modify_inventory_explicitly_reports_missing_theirs(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "delete-me.txt").write_text("base\n", encoding="utf-8")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    git(repo, "rm", "-q", "--", "delete-me.txt")
    git(repo, "commit", "-qm", "feature delete")
    git(repo, "switch", "-q", "main")
    (repo / "delete-me.txt").write_text("ours edit\n", encoding="utf-8")
    commit(repo, "main edit")
    git(repo, "merge", "feature", check=False)

    result = get_conflicts(str(repo))

    assert result is not None
    item = result["files"][0]
    assert item["base"] is not None
    assert item["ours"] is not None
    assert item["theirs"] is None
    assert item["missing_stages"] == [3]


def test_binary_stage_and_comparison_are_explicit(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "image.bin").write_bytes(b"base\x00\x01")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    (repo / "image.bin").write_bytes(b"theirs\x00\x02")
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    (repo / "image.bin").write_bytes(b"ours\x00\x03")
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)

    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    stage = get_conflict_stage(str(repo), "image.bin", 2, item["ours"]["hash"])
    assert stage is not None
    assert stage["binary"] is True
    assert stage["text"] is None
    comparison = get_conflict_comparison(str(repo), "image.bin", item["ours"]["hash"], item["theirs"]["hash"])
    assert comparison is not None
    assert comparison["binary"] is True
    assert "Binary files" in comparison["patch"] or "GIT binary patch" in comparison["patch"]
    assert comparison["patch_complete"] is True
    assert comparison["input"]["ours_hash"] == item["ours"]["hash"]


def test_symlink_stage_is_not_followed(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "target.txt").write_text("outside target\n", encoding="utf-8")
    (repo / "link").symlink_to("target.txt")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    (repo / "link").unlink()
    (repo / "link").symlink_to("feature-target.txt")
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    (repo / "link").unlink()
    (repo / "link").symlink_to("main-target.txt")
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)

    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = next(item for item in inventory["files"] if item["path"] == "link")
    stage = get_conflict_stage(str(repo), "link", 2, item["ours"]["hash"])
    assert stage is not None
    assert stage["kind"] == "symlink"
    assert stage["unavailable_reason"]
    assert stage["content_base64"] == ""
    assert stage["downloadable"] is False


def test_changed_index_hash_is_rejected_before_object_read(tmp_path: Path) -> None:
    repo = make_modify_conflict(tmp_path)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    old_hash = item["ours"]["hash"]
    replacement = git(repo, "hash-object", "-w", "--stdin", input=b"replacement\n")
    git(repo, "update-index", "--cacheinfo", f"100644,{replacement},conflict.txt")

    with pytest.raises(ConflictChangedError):
        get_conflict_stage(str(repo), "conflict.txt", 2, old_hash)
    with pytest.raises(ConflictChangedError):
        get_conflict_comparison(str(repo), "conflict.txt", old_hash, item["theirs"]["hash"])


def test_stage_rechecks_index_after_blob_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = make_modify_conflict(tmp_path)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    original_read = conflict_inspector._read_blob_limited
    changed = False

    def read_then_change(repository: str, object_hash: str, limit: int):
        nonlocal changed
        result = original_read(repository, object_hash, limit)
        if not changed:
            replacement = git(repo, "hash-object", "-w", "--stdin", input=b"changed while reading\n")
            git(repo, "update-index", "--cacheinfo", f"100644,{replacement},conflict.txt")
            changed = True
        return result

    monkeypatch.setattr(conflict_inspector, "_read_blob_limited", read_then_change)
    with pytest.raises(ConflictChangedError):
        get_conflict_stage(str(repo), "conflict.txt", 2, item["ours"]["hash"])


def test_comparison_rechecks_index_after_diff_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = make_modify_conflict(tmp_path)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    original_read = conflict_inspector._read_limited_output
    changed = False

    def diff_then_change(command: list[str], *, max_bytes: int):
        nonlocal changed
        result = original_read(command, max_bytes=max_bytes)
        if not changed and "diff" in command:
            replacement = git(repo, "hash-object", "-w", "--stdin", input=b"changed after diff\n")
            git(repo, "update-index", "--cacheinfo", f"100644,{replacement},conflict.txt")
            changed = True
        return result

    monkeypatch.setattr(conflict_inspector, "_read_limited_output", diff_then_change)
    with pytest.raises(ConflictChangedError):
        get_conflict_comparison(str(repo), "conflict.txt", item["ours"]["hash"], item["theirs"]["hash"])


def test_input_rejects_unsafe_paths_and_non_exact_stages(tmp_path: Path) -> None:
    repo = make_modify_conflict(tmp_path)
    for value in ("../outside", "/etc/passwd", "a/../b", ""):
        with pytest.raises(ConflictInspectorInputError):
            get_conflict_stage(str(repo), value, 2, "0" * 40)
    with pytest.raises(ConflictInspectorInputError):
        get_conflict_stage(str(repo), "conflict.txt", 0, "0" * 40)
    with pytest.raises(ConflictInspectorInputError):
        get_conflict_stage(str(repo), "conflict.txt", 2, "0" * 39)
    assert get_conflicts(str(tmp_path / "missing")) is None


def test_inventory_file_bound_is_coherent_and_explicit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = make_repo(tmp_path)
    for index in range(3):
        name = f"conflict-{index}.txt"
        (repo / name).write_text("base\n", encoding="utf-8")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    for index in range(3):
        (repo / f"conflict-{index}.txt").write_text("theirs\n", encoding="utf-8")
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    for index in range(3):
        (repo / f"conflict-{index}.txt").write_text("ours\n", encoding="utf-8")
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)
    monkeypatch.setattr(conflict_inspector, "MAX_CONFLICT_FILES", 2)

    result = get_conflicts(str(repo))

    assert result is not None
    assert result["truncated"] is True
    assert len(result["files"]) == 2
    assert all(set(item["stages"]) == {"1", "2", "3"} for item in result["files"])


def test_comparison_patch_limit_preserves_identity_and_bounds_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = make_repo(tmp_path)
    (repo / "large.txt").write_text("base\n", encoding="utf-8")
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    (repo / "large.txt").write_text("theirs\n" + ("t" * 30_000), encoding="utf-8")
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    (repo / "large.txt").write_text("ours\n" + ("o" * 30_000), encoding="utf-8")
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    monkeypatch.setattr(conflict_inspector, "MAX_PATCH_BYTES", 120)

    result = get_conflict_comparison(str(repo), "large.txt", item["ours"]["hash"], item["theirs"]["hash"])

    assert result is not None
    assert result["patch_truncated"] is True
    assert result["patch_complete"] is False
    assert len(result["patch"].encode("utf-8")) <= 120
    assert result["input"] == {
        "file": "large.txt",
        "ours_hash": item["ours"]["hash"],
        "theirs_hash": item["theirs"]["hash"],
    }


def test_large_stage_preview_is_partial_and_not_downloadable(tmp_path: Path) -> None:
    repo = make_repo(tmp_path)
    (repo / "large.bin").write_bytes(b"base\x00" + b"b" * 20)
    commit(repo, "base")
    git(repo, "switch", "-qc", "feature")
    (repo / "large.bin").write_bytes(b"theirs\x00" + b"t" * (conflict_inspector.MAX_BLOB_BYTES + 10))
    commit(repo, "theirs")
    git(repo, "switch", "-q", "main")
    (repo / "large.bin").write_bytes(b"ours\x00" + b"o" * (conflict_inspector.MAX_BLOB_BYTES + 10))
    commit(repo, "ours")
    git(repo, "merge", "feature", check=False)
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]

    result = get_conflict_stage(str(repo), "large.bin", 2, item["ours"]["hash"])

    assert result is not None
    assert result["truncated"] is True
    assert result["complete"] is False
    assert result["downloadable"] is False
    assert len(base64.b64decode(result["content_base64"])) == conflict_inspector.MAX_BLOB_BYTES


def test_module_does_not_change_index_or_worktree(tmp_path: Path) -> None:
    repo = make_modify_conflict(tmp_path)
    before_status = git(repo, "status", "--porcelain=v2", "-z", check=True)
    before_index = str(repo / ".git" / "index")
    before_index_hash = hashlib.sha256(Path(before_index).read_bytes()).hexdigest()
    inventory = get_conflicts(str(repo))
    assert inventory is not None
    item = inventory["files"][0]
    get_conflict_stage(str(repo), "conflict.txt", 2, item["ours"]["hash"])
    get_conflict_comparison(str(repo), "conflict.txt", item["ours"]["hash"], item["theirs"]["hash"])
    after_status = git(repo, "status", "--porcelain=v2", "-z", check=True)
    after_index_hash = hashlib.sha256(Path(before_index).read_bytes()).hexdigest()
    assert after_status == before_status
    assert after_index_hash == before_index_hash
