import test from "node:test";
import assert from "node:assert/strict";
import { submoduleLabels, submoduleCommands } from "../app/submodule-status.mjs";

test("サブモジュールの4状態を日本語で示す", () => {
  assert.deepEqual(Object.values(submoduleLabels), ["未初期化", "記録と異なるコミットをチェックアウト中", "一致", "マージ競合"]);
  assert.equal(submoduleCommands("same", "lib", "/repo", "a", "a").length, 0);
  assert.equal(submoduleCommands("uninitialized", "lib", "/repo", "a", null)[0].command, "git submodule update --init -- 'lib'");
  assert.deepEqual(submoduleCommands("different", "lib", "/repo", "a", null).map(x => x.command), ["git submodule update -- 'lib'", "git add -- 'lib'"]);
  assert.equal(submoduleCommands("conflict", "lib", "/repo", null, null)[0].command, "git status");
  assert.equal(submoduleCommands("different", "a'b", "/repo", "a", null)[1].command, "git add -- 'a'\\''b'");
});

test("サブモジュールの履歴比較は両方のSHAがそろった差分だけに提示する", () => {
  const recorded = "a".repeat(40);
  const checkout = "b".repeat(40);
  const compare = (status, index, head) => submoduleCommands(status, "a'b", "/parent repo", index, head)
    .find(({ command }) => command.includes(" log "));

  assert.equal(compare("different", recorded, checkout).command,
    "git -C '/parent repo/a'\\''b' log --left-right --oneline " + recorded + "..." + checkout);
  assert.equal(compare("different", recorded, null), undefined);
  assert.equal(compare("different", null, checkout), undefined);
  assert.equal(compare("uninitialized", recorded, null), undefined);
  assert.equal(compare("conflict", null, checkout), undefined);
});
