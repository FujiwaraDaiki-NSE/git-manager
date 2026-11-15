export function remoteLabel(remote) {
  if (!remote) return "リモート未取得";
  const value = remote.trim();
  if (!value.includes("://") && !/^(?:[^@/]+@)?[^:/]+:.+$/.test(value) || value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value)) return remote;
  const scp = !value.includes("://") && value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git\/?$/i, "")}`;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.host}${url.pathname.replace(/\.git\/?$/i, "")}`;
  } catch {
    return value.replace(/\.git\/?$/i, "");
  }
}
