import "./agent-decision.css";
import type { AgentDecision } from "./types";

export function AgentDecisionDetails({ decision }: { decision: AgentDecision | null | undefined }) {
  if (decision == null) return null;
  return <div className="agent-decision">
    <strong>{decision.question}</strong>
    {decision.options.length > 0 && <ul>{decision.options.map((option, index) => <li key={index}>{option}</li>)}</ul>}
    {decision.links.length > 0 && <ul>{decision.links.map((link, index) => {
      try {
        const url = new URL(link);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return <li key={index}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></li>;
        }
      } catch { /* Invalid URLs are displayed as text. */ }
      return <li key={index}>{link}</li>;
    })}</ul>}
  </div>;
}
