import { Suspense } from "react";
import ProjectControl from "../project-control";

export default function ProjectPage() {
  return (
    <Suspense fallback={<main className="control-shell"><div className="control-state" role="status">プロジェクト管制画面を読み込み中…</div></main>}>
      <ProjectControl />
    </Suspense>
  );
}
