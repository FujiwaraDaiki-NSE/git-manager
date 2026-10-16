"""Read-only comparison of two Git commits.

The comparison endpoint deliberately resolves both user supplied revisions to
immutable commit ids before it calculates any diff.  This keeps a copied
command reproducible even when a branch moves while the response is being
rendered.  All Git arguments are passed as separate subprocess arguments and
the diff commands disable external diff drivers and text conversion.
"""
from __future__ import annotations

import re
from typing import Any

from app import gitinfo


COMPARISON_MODES = frozenset({"direct", "merge-base"})
PATCH_MAX_BYTES = 200_000
MAX_REF_LENGTH = 512
_COMMIT_ID_RE = re.compile(r"^[0-9a-fA-F]{40,64}$")
_NUMERIC_RE = re.compile(r"^[0-9]+$")


class ComparisonError(ValueError):
    """A user-visible, safe failure while building a comparison."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_mode(mode: str) -> str:
    if not isinstance(mode, str) or mode not in COMPARISON_MODES:
        raise ComparisonError(
            "invalid_mode",
            "mode は direct または merge-base のいずれかで指定してください",
        )
    return mode


def _validate_ref(value: str, label: str) -> str:
    """Validate one revision before passing it to Git.

    ``--end-of-options`` protects rev-parse from option-like arguments, but
    rejecting those arguments here makes the API contract explicit and avoids
    accepting a revision that is not a single token.  Git refs cannot contain
    NUL or whitespace, and revision expressions are intentionally not part of
    this endpoint: callers provide a commit hash or a named/full ref.
    """

    if not isinstance(value, str) or not value:
        raise ComparisonError("invalid_ref", f"{label} を指定してください")
    if len(value) > MAX_REF_LENGTH:
        raise ComparisonError("invalid_ref", f"{label} が長すぎます")
    if value.startswith("-") or any(character.isspace() or ord(character) < 0x20 for character in value):
        raise ComparisonError("invalid_ref", f"{label} はハッシュまたはGit refとして指定してください")
    # These are revision/path operators rather than a single named ref.  A
    # full ref may contain punctuation, so only reject syntax that changes the
    # object expression itself.
    if any(operator in value for operator in ("..", "~", "^", ":", "@{")):
        raise ComparisonError("invalid_ref", f"{label} は単一のコミットハッシュまたはGit refで指定してください")
    return value


def _resolve_commit(repo: str, value: str, label: str) -> str:
    revision = _validate_ref(value, label)
    raw = gitinfo._run(
        repo,
        ["rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}"],
    )
    lines = raw.splitlines() if raw is not None else []
    if len(lines) != 1 or _COMMIT_ID_RE.fullmatch(lines[0].strip()) is None:
        raise ComparisonError("invalid_ref", f"{label} は存在するコミットを指していません")
    return lines[0].strip().lower()


def _merge_bases(repo: str, left: str, right: str) -> list[str]:
    raw, status = gitinfo._run_with_status(repo, ["merge-base", "--all", left, right])
    if status == 1:
        # Git uses exit status 1 for a valid pair with no common ancestor.
        return []
    if raw is None or status != 0:
        raise ComparisonError("git_unavailable", "merge-base を取得できませんでした")
    values: list[str] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        value = line.strip().lower()
        if not value:
            continue
        if _COMMIT_ID_RE.fullmatch(value) is None:
            raise ComparisonError("git_unavailable", "merge-base の結果を解釈できませんでした")
        if value not in seen:
            seen.add(value)
            values.append(value)
    return values


def _parse_numstat(raw: str) -> list[dict[str, Any]]:
    """Parse ``git diff --numstat -z`` without quoting or line splitting.

    A rename/copy record is encoded as ``add<TAB>del<TAB>\0old\0new\0``;
    ordinary records end with ``path\0``.  Git paths may contain tabs,
    newlines, and quotes, so only the NUL boundaries are structural.
    """

    fields = raw.split("\x00")
    files: list[dict[str, Any]] = []
    index = 0
    while index < len(fields):
        record = fields[index]
        index += 1
        if record == "":
            continue
        columns = record.split("\t", 2)
        if len(columns) != 3:
            raise ComparisonError("git_unavailable", "差分のファイル一覧を解釈できませんでした")
        additions, deletions, path = columns
        if additions != "-" and _NUMERIC_RE.fullmatch(additions) is None:
            raise ComparisonError("git_unavailable", "差分の追加行数を解釈できませんでした")
        if deletions != "-" and _NUMERIC_RE.fullmatch(deletions) is None:
            raise ComparisonError("git_unavailable", "差分の削除行数を解釈できませんでした")

        old_path: str | None = None
        if path == "":
            if index + 1 >= len(fields):
                raise ComparisonError("git_unavailable", "名前変更の差分を解釈できませんでした")
            old_path = fields[index]
            path = fields[index + 1]
            index += 2
            if not old_path or not path:
                raise ComparisonError("git_unavailable", "名前変更のパスを解釈できませんでした")
        if not path:
            raise ComparisonError("git_unavailable", "差分のパスを解釈できませんでした")
        file: dict[str, Any] = {
            "additions": additions if additions == "-" else int(additions),
            "deletions": deletions if deletions == "-" else int(deletions),
            "path": path,
            "binary": additions == "-" and deletions == "-",
        }
        if old_path is not None:
            file["old_path"] = old_path
        files.append(file)
    return files


def _stats(files: list[dict[str, Any]]) -> dict[str, Any]:
    additions = 0
    deletions = 0
    additions_known = True
    deletions_known = True
    for file in files:
        value = file["additions"]
        if file["binary"] or not isinstance(value, int):
            additions_known = False
        else:
            additions += value
        value = file["deletions"]
        if file["binary"] or not isinstance(value, int):
            deletions_known = False
        else:
            deletions += value
    return {
        "files": len(files),
        "additions": additions if additions_known else None,
        "deletions": deletions if deletions_known else None,
        "binary": sum(1 for file in files if file["binary"]),
        "renamed": sum(1 for file in files if "old_path" in file),
    }


def _truncate_patch(patch: str) -> tuple[str, bool]:
    encoded = patch.encode("utf-8")
    if len(encoded) <= PATCH_MAX_BYTES:
        return patch, False
    return encoded[:PATCH_MAX_BYTES].decode("utf-8", errors="ignore"), True


def _diff_args(left: str, right: str, *, numstat: bool = False) -> list[str]:
    common = [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--find-copies",
    ]
    if numstat:
        return [*common, "--numstat", "-z", left, right, "--"]
    return [
        *common,
        "--patch",
        "--binary",
        "--unified=3",
        left,
        right,
        "--",
    ]


def _command(left: str, right: str) -> str:
    return (
        "git -c core.quotepath=false diff --no-ext-diff --no-textconv "
        f"--find-renames --find-copies --patch --binary --unified=3 {left} {right} --"
    )


def get_comparison(repo: str, base: str, target: str, mode: str) -> dict[str, Any]:
    """Return a bounded, read-only diff between two explicitly supplied refs.

    ``base`` and ``target`` are resolved before any diff command.  In
    ``merge-base`` mode exactly one best common ancestor is required; criss-
    cross histories with multiple best bases are reported as an explicit
    ambiguity instead of selecting one arbitrarily.
    """

    mode = _validate_mode(mode)
    base_hash = _resolve_commit(repo, base, "base")
    target_hash = _resolve_commit(repo, target, "target")

    merge_bases: list[str] = []
    merge_base: str | None = None
    comparison_base = base_hash
    if mode == "merge-base":
        merge_bases = _merge_bases(repo, base_hash, target_hash)
        if not merge_bases:
            raise ComparisonError(
                "no_merge_base",
                "指定された2つのコミットに共通のmerge-baseがありません",
            )
        if len(merge_bases) > 1:
            raise ComparisonError(
                "multiple_merge_bases",
                "複数のmerge-baseがあるため比較できません。directモードを使うか履歴を整理してください",
            )
        merge_base = merge_bases[0]
        comparison_base = merge_base

    numstat = gitinfo._run(repo, _diff_args(comparison_base, target_hash, numstat=True))
    if numstat is None:
        raise ComparisonError("git_unavailable", "差分のファイル一覧を取得できませんでした")
    files = _parse_numstat(numstat)
    patch_raw = gitinfo._run_limited(repo, _diff_args(comparison_base, target_hash), PATCH_MAX_BYTES)
    if patch_raw is None:
        raise ComparisonError("git_unavailable", "差分本文を取得できませんでした")
    patch, patch_truncated = _truncate_patch(patch_raw)
    label_prefix = "merge-base" if mode == "merge-base" else "base"
    comparison_label = f"{label_prefix} {comparison_base} → target {target_hash}"
    return {
        "mode": mode,
        "base": base_hash,
        "target": target_hash,
        "comparison_base": comparison_base,
        "merge_base": merge_base,
        "merge_bases": merge_bases,
        "comparison_label": comparison_label,
        "files": files,
        "stats": _stats(files),
        "patch": patch,
        "patch_truncated": patch_truncated,
        "command": _command(comparison_base, target_hash),
    }


__all__ = [
    "COMPARISON_MODES",
    "ComparisonError",
    "PATCH_MAX_BYTES",
    "get_comparison",
]
