export function inventoryKind(entry) {
  if (entry.type === 'tree') return 'directory';
  if (entry.mode === '160000' || entry.type === 'commit') return 'gitlink';
  if (entry.mode === '120000') return 'symlink';
  return 'file';
}

export function organizeInventory(entries, kind, order) {
  if (!['all', 'directory', 'file', 'symlink', 'gitlink'].includes(kind)) throw new TypeError('kind is required');
  if (!['path', 'path-desc', 'kind'].includes(order)) throw new TypeError('order is required');
  return entries.filter(entry => kind === 'all' || inventoryKind(entry) === kind).sort((a, b) => {
    const pathOrder = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (order === 'path-desc') return -pathOrder;
    if (order === 'kind') {
      const kinds = ['directory', 'file', 'symlink', 'gitlink'];
      return kinds.indexOf(inventoryKind(a)) - kinds.indexOf(inventoryKind(b)) || pathOrder;
    }
    return pathOrder;
  });
}

/** JSON strings keep embedded newlines and tabs unambiguous, one path per line. */
export function inventoryPathList(entries) {
  return entries.map(entry => JSON.stringify(entry.path)).join('\n');
}

export function inventoryCsv(entries, revision) {
  if (typeof revision !== 'string' || revision === '') throw new TypeError('resolved revision is required');
  // Prefix spreadsheet formula starters before RFC4180 escaping.
  const cell = value => {
    const text = /^[=+\-@\t\r\n]/u.test(value) ? `'${value}` : value;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [['revision', 'path', 'kind', 'mode', 'object'], ...entries.map(entry => [revision, entry.path, inventoryKind(entry), entry.mode, entry.hash === null ? '' : entry.hash])].map(row => row.map(cell).join(',')).join('\r\n');
}

export function adjacentInventoryFiles(entries, selectedPath) {
  const files = entries.filter(entry => entry.type !== 'tree');
  const index = files.findIndex(entry => entry.path === selectedPath);
  return { index, count: files.length, previous: index > 0 ? files[index - 1] : null, next: index >= 0 && index + 1 < files.length ? files[index + 1] : null };
}
