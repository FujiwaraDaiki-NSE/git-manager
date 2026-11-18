import { shellQuote } from "./status-file-tools.mjs";

/**
 * Pin a next command to the checkout it must run in. `git worktree …` manages the
 * repository's worktree list, so it runs in the main checkout: the selected
 * worktree may be the one that was deleted (prunable) or is about to be removed.
 */
export function worktreeCommand(command, path, mainPath) {
  if (!command.startsWith("git ")) return command;
  const target = command.startsWith("git worktree ") ? mainPath : path;
  if (target === null) return command;
  return `git -C ${shellQuote(target)} ${command.slice(4)}`;
}

export function commandTarget(command, path, mainPath) {
  return command.startsWith("git worktree ") ? mainPath : path;
}
