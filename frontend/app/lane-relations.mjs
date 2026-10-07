// Work lanes represent local refs. A shared row with a remote is not evidence
// that a remote PR or merge also happened on this local ref.
/**
 * @param {import('./types').ProjectBranchConnections|null} connection
 * @param {{branch:string|null}} lane
 * @returns {{incoming:import('./types').ProjectBranchConnectionEdge[], outgoing:import('./types').ProjectBranchConnectionEdge[]}}
 */
export function laneRecordedMerges(connection, lane) {
  if (!connection || !Array.isArray(connection.edges) || !lane.branch) return { incoming: [], outgoing: [] };
  const ref = `refs/heads/${lane.branch}`;
  const merges = connection.edges.filter(edge => edge.kind === "merge");
  return {
    incoming: merges.filter(edge => edge.target_ref_id === ref),
    outgoing: merges.filter(edge => edge.source_ref_id === ref),
  };
}
