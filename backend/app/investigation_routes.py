"""Routes wired to the application's repository validation and lock."""
import asyncio
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from app import investigation, compare
from pydantic import BaseModel, Field


CommitSearchMode = Literal["message", "content"]


class CommitSearchPage(BaseModel):
    path: str
    scope: str
    mode: CommitSearchMode
    grep: str
    author: str
    since_at: str
    until_at: str
    file: str
    offset: int = Field(ge=0)
    fixed_shas: list[str]



def create_router(known_repo, repo_lock, pool):
    router = APIRouter(prefix="/api/repo")

    async def execute(path, function, *args):
        repo = known_repo(path)
        def locked():
            with repo_lock(path):
                return function(repo, *args)
        try:
            return await asyncio.get_running_loop().run_in_executor(pool, locked)
        except compare.ComparisonError as error:
            raise HTTPException(422 if error.code.startswith("invalid_") else 502, str(error)) from error
        except investigation.InvalidSearchSnapshot as error:
            raise HTTPException(400, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except RuntimeError as error:
            raise HTTPException(502, str(error)) from error

    @router.get("/worktree-overlaps")
    async def overlaps(path: str):
        return await execute(path, investigation.overlaps)

    @router.get("/commit-search")
    async def search(
        path: str, scope: str, mode: CommitSearchMode, grep: str, author: str, since_at: str, until_at: str, file: str,
        offset: int = Query(..., ge=0), fixed_shas: str | None = None,
    ):
        return await execute(path, investigation.search, scope, grep, author, since_at, until_at, file, offset, mode, fixed_shas)

    @router.post("/commit-search")
    async def search_page(body: CommitSearchPage):
        return await execute(body.path, investigation.search, body.scope, body.grep, body.author,
                             body.since_at, body.until_at, body.file, body.offset, body.mode, body.fixed_shas)

    @router.get("/recovery-candidates")
    async def recovery(path: str):
        return await execute(path, investigation.recovery)

    @router.get("/patch-equivalence")
    async def cherry(path: str, left: str, right: str):
        return await execute(path, investigation.cherry, left, right)

    return router
