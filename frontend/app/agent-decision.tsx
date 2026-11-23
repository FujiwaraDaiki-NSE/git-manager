"use client";

import "./agent-decision.css";
import { useState } from "react";
import CopyButton from "./copy-button";
import type { AgentDecision } from "./types";

export function AgentDecisionDetails({ decision, compact, replyBranch }: {
  decision: AgentDecision | null | undefined;
  compact?: boolean;
  replyBranch?: string | null;
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
      {replyBranch == null ? option : <button type="button" className="agent-decision-option" onClick={() => setAnswer(option)}>{option}</button>}
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
    {replyBranch != null && <div className="agent-decision-reply">
      <label>回答<textarea rows={2} value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} /></label>
      {answer.trim() !== "" && <CopyButton label="返答文をコピー" value={`ブランチ: ${replyBranch}\n質問: ${decision.question}\n回答: ${answer}`} />}
    </div>}
  </div>;
}
