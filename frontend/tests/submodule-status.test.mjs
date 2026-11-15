import test from "node:test";
import assert from "node:assert/strict";
import { submoduleLabels, submoduleCommands } from "../app/submodule-status.mjs";

test("サブモジュールの4状態を日本語で示す", () => {
  assert.deepEqual(Object.values(submoduleLabels), ["未初期化", "記録と異なるコミットをチェックアウト中", "一致", "マージ競合"]);
  assert.equal(submoduleCommands("same", "lib").length, 0);
  assert.equal(submoduleCommands("uninitialized", "lib")[0].command, "git submodule update --init -- 'lib'");
  assert.deepEqual(submoduleCommands("different", "lib").map(x => x.command), ["git submodule update -- 'lib'", "git add -- 'lib'"]);
  assert.equal(submoduleCommands("conflict", "lib")[0].command, "git status");
  assert.equal(submoduleCommands("different", "a'b")[1].command, "git add -- 'a'\\''b'");
});
