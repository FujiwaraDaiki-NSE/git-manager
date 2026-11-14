"use client";

import { useEffect, useState, type ReactNode } from "react";
import BranchRelations from "./branch-relations";
import BranchHistoryExplorer from "./branch-history-explorer";
import type { ProjectEvent, ProjectResponse } from "./types";

const sections = [
  { id: "relations", label: "全関係と関連履歴" },
  { id: "history", label: "ブランチ履歴を調査" },
  { id: "notes", label: "未解決の関係・見方・取得状態" },
];

export default function BranchFlowSections({ project, section, onSectionChange, relationRef, selectedLane, selectedRowId, onSelect, children }: {
  project: ProjectResponse;
  section: string;
  onSectionChange: (section: string) => void;
  relationRef: string | null;
  selectedLane: string | null;
  selectedRowId: string | null;
  onSelect: (event: ProjectEvent, branchRowId?: string) => void;
  children: ReactNode;
}) {
  // Mount a section on first use, then retain it so filters and selections
  // survive switching sections. Hidden investigation panels need no initial work.
  const [visited, setVisited] = useState(() => new Set([section]));
  useEffect(() => {
    setVisited((previous) => previous.has(section) ? previous : new Set([...previous, section]));
  }, [section]);
  return <div>
    <nav className="control-tabs" role="tablist" aria-label="ブランチの調査セクション">
      {sections.map((item, index) => <button key={item.id} type="button" className="control-tab" role="tab" id={`flow-section-tab-${item.id}`} aria-controls={`flow-section-panel-${item.id}`} aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => onSectionChange(item.id)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        onSectionChange(sections[next].id);
        document.getElementById(`flow-section-tab-${sections[next].id}`)?.focus();
      }}>{item.label}</button>)}
    </nav>
    {sections.map((item) => <div key={item.id} hidden={section !== item.id} role="tabpanel" tabIndex={0} id={`flow-section-panel-${item.id}`} aria-labelledby={`flow-section-tab-${item.id}`}>
      {(section === item.id || visited.has(item.id)) && item.id === "relations" && <BranchRelations project={project} relationRef={relationRef} selectedLane={selectedLane} selectedRowId={selectedRowId} />}
      {(section === item.id || visited.has(item.id)) && item.id === "history" && <BranchHistoryExplorer project={project} onSelect={onSelect} />}
      {(section === item.id || visited.has(item.id)) && item.id === "notes" && <div onClick={(event) => {
        if (!(event.target instanceof HTMLAnchorElement) || event.target.hash !== "#branch-relations-title") return;
        event.preventDefault();
        onSectionChange("relations");
        document.getElementById("flow-section-tab-relations")?.focus();
      }}>{children}</div>}
    </div>)}
  </div>;
}
