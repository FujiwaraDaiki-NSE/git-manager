from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app import tags


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    return result.stdout.decode("utf-8", errors="replace")


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Tag Test")
    git(repo, "config", "user.email", "tag@example.invalid")
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "base")
    return repo


def add_tags(repo: Path) -> str:
    head = git(repo, "rev-parse", "HEAD").strip()
    tree = git(repo, "rev-parse", "HEAD^{tree}").strip()
    git(repo, "tag", "light")
    git(repo, "tag", "-a", "-m", "release message", "annotated", head)
    # A tag pointing at another annotated tag exercises Git's recursive
    # peeling in %( *objectname ) without changing the direct object hash.
    git(repo, "tag", "-a", "-m", "nested message", "nested/tag", "annotated")
    # A tree target is still a valid tag row, but it cannot use commit detail.
    git(repo, "tag", "-a", "-m", "tree message", "tree-target", tree)
    # A leading dash is a valid ref component even though ``git tag`` refuses
    # to create that spelling through its tag-name parser.  Create the same
    # annotated object under the exact full ref to exercise safe membership.
    git(repo, "tag", "-a", "-m", "odd message", "odd-temporary", head)
    odd_hash = git(repo, "rev-parse", "refs/tags/odd-temporary").strip()
    git(repo, "update-ref", "refs/tags/-odd", odd_hash)
    git(repo, "update-ref", "-d", "refs/tags/odd-temporary")
    return head


def test_empty_inventory_is_distinct_from_git_failure(tmp_path: Path):
    repo = make_repo(tmp_path)

    result = tags.get_tags(str(repo))

    assert result is not None
    assert result["tags"] == []
    assert "for-each-ref" in result["command"]
    assert tags.get_tags(str(tmp_path / "missing")) is None


def test_inventory_captures_direct_hash_peeled_target_type_and_creator(tmp_path: Path):
    repo = make_repo(tmp_path)
    head = add_tags(repo)

    result = tags.get_tags(str(repo))

    assert result is not None
    by_name = {item["name"]: item for item in result["tags"]}
    assert set(by_name) == {"light", "annotated", "nested/tag", "tree-target", "-odd"}
    assert by_name["light"]["type"] == "lightweight"
    assert by_name["light"]["hash"] == head
    assert by_name["light"]["peeled_hash"] == head
    assert by_name["light"]["peeled_type"] == "commit"
    assert by_name["annotated"]["type"] == "annotated"
    assert by_name["annotated"]["hash"] != head
    assert by_name["annotated"]["peeled_hash"] == head
    assert by_name["annotated"]["peeled_type"] == "commit"
    assert by_name["annotated"]["creator"]
    assert by_name["annotated"]["creator_date"]
    assert by_name["nested/tag"]["peeled_hash"] == head
    assert by_name["nested/tag"]["peeled_type"] == "commit"
    assert by_name["tree-target"]["peeled_type"] == "tree"


def test_detail_requires_exact_name_and_reads_annotation_without_mutation(tmp_path: Path):
    repo = make_repo(tmp_path)
    head = add_tags(repo)
    before = git(repo, "show-ref")

    annotated = tags.get_tag(str(repo), "annotated")
    lightweight = tags.get_tag(str(repo), "light")
    tree = tags.get_tag(str(repo), "tree-target")

    assert annotated is not None
    assert annotated["annotation"]["object_hash"] == head
    assert annotated["annotation"]["object_type"] == "commit"
    assert annotated["annotation"]["tag"] == "annotated"
    assert "release message" in annotated["annotation"]["message"]
    assert annotated["annotation"]["message_truncated"] is False
    assert lightweight is not None and lightweight["annotation"] is None
    assert tree is not None
    assert tree["peeled_type"] == "tree"
    assert tree["annotation"]["object_type"] == "tree"
    assert git(repo, "show-ref") == before

    with pytest.raises(tags.TagNotFound):
        tags.get_tag(str(repo), "annot")
    with pytest.raises(tags.TagInputError):
        tags.get_tag(str(repo), "bad name")
    with pytest.raises(tags.TagNotFound):
        tags.get_tag(str(repo), "refs/tags/annotated")


def test_annotation_message_is_bounded(tmp_path: Path):
    repo = make_repo(tmp_path)
    message = tmp_path / "message.txt"
    message.write_text("header\n\n" + "あ" * (tags.TAG_MESSAGE_MAX_BYTES + 500), encoding="utf-8")
    git(repo, "tag", "-a", "-F", str(message), "long")

    result = tags.get_tag(str(repo), "long")

    assert result is not None and result["annotation"] is not None
    annotation = result["annotation"]
    assert annotation["message_truncated"] is True
    assert len(annotation["message"].encode("utf-8")) <= tags.TAG_MESSAGE_MAX_BYTES
