"use client";

import "./agent-decision.css";
import { useState } from "react";
import CopyButton from "./copy-button";
import type { AgentDecision } from "./types";

export function AgentDecisionDetails({ decision, compact, replyTarget }: {
  decision: AgentDecision | null | undefined;
  compact?: boolean;
  replyTarget?: { projectId: string; branch: string; worktree: string | null };
}) {
  const [answer, setAnswer] = useState("");
  if (decision == null) return null;
  if (compact) return <div className="agent-decision agent-decision-compact">
    <strong title={decision.question}>{decision.question}</strong>
    <span>選択肢 {decision.options.length}件</span>
  </div>;
  return <div className="agent-decision">
    <strong>{decision.question}</strong>
    {decision.options.length > 0 && <ul>{decision.options.map((option, index) => <li key={index}>
      {replyTarget === undefined ? option : <button type="button" className="agent-decision-option" onClick={() => setAnswer(option)}>{option}</button>}
    </li>)}</ul>}
    {decision.links.length > 0 && <ul>{decision.links.map((link, index) => {
      try {
        const url = new URL(link);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return <li key={index}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>;
        }
      } catch { /* Invalid URLs are displayed as text. */ }
      return <li key={index}>{link}</li>;
    })}</ul>}
    <CopyButton label="判断依頼をコピー" value={[decision.question, ...decision.options, ...decision.links].join("\n")} />
    {replyTarget !== undefined && <div className="agent-decision-reply">
      <label>回答<textarea rows={2} value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} /></label>
      {answer.trim() !== "" && <CopyButton label="返答文をコピー" value={[
        `プロジェクト: ${replyTarget.projectId}`,
        `ブランチ: ${replyTarget.branch}`,
        replyTarget.worktree === null ? "報告時のパス未取得" : `報告時のパス: ${replyTarget.worktree}`,
        `質問: ${decision.question}`,
        `回答: ${answer}`,
      ].join("\n")} />}
    </div>}
  </div>;
}
