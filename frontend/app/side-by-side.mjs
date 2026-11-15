/** Pair consecutive deletion/addition blocks without crossing metadata or hunks. */
export function sideBySideRows(rows) {
  const result = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.line.kind === "deletion" || row.line.kind === "addition") {
      const left = [], right = [];
      while (i < rows.length && rows[i].line.kind === "deletion") left.push(rows[i++]);
      while (i < rows.length && rows[i].line.kind === "addition") right.push(rows[i++]);
      for (let j = 0; j < Math.max(left.length,right.length); j++) result.push({left:left[j] ?? null,right:right[j] ?? null,shared:null});
    } else { result.push(row.line.kind === "context" ? {left:row,right:row,shared:null} : {left:null,right:null,shared:row}); i++; }
  }
  return result;
}
