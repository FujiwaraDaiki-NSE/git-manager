"use client";

import { useEffect, useState } from "react";
import type { AgentEvent, Repo } from "./types";

export type RepoStreamState = {
  repos: Map<string, Repo>;
  scanning: boolean;
  fetching: boolean;
  connected: boolean;
  agentEvents: AgentEvent[];
  agentEventVersion: number;
};

/** Shared read-only SSE snapshot used by home and the project control page. */
export function useRepoStream(): RepoStreamState {
  const [repos, setRepos] = useState<Map<string, Repo>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [connected, setConnected] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentEventVersion, setAgentEventVersion] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("snapshot", (event) => {
      const list: Repo[] = JSON.parse((event as MessageEvent).data);
      setRepos(new Map(list.map((repo) => [repo.path, repo])));
    });
    es.addEventListener("repo", (event) => {
      const repo = JSON.parse((event as MessageEvent).data) as Repo;
      setRepos((previous) => {
        const next = new Map(previous);
        next.set(repo.path, { ...next.get(repo.path), ...repo });
        return next;
      });
    });
    es.addEventListener("removed", (event) => {
      const path = (JSON.parse((event as MessageEvent).data) as { path: string })
        .path;
      setRepos((previous) => {
        const next = new Map(previous);
        next.delete(path);
        return next;
      });
    });
    es.addEventListener("scan", (event) => {
      setScanning(
        Boolean((JSON.parse((event as MessageEvent).data) as { active: boolean }).active),
      );
    });
    es.addEventListener("fetch", (event) => {
      setFetching(
        Boolean((JSON.parse((event as MessageEvent).data) as { active: boolean }).active),
      );
    });
    es.addEventListener("agent_event", (event) => {
      const value = JSON.parse((event as MessageEvent).data) as AgentEvent;
      setAgentEvents((previous) => [value, ...previous.filter((item) => item.event_id !== value.event_id)].slice(0, 200));
      setAgentEventVersion((version) => version + 1);
    });
    return () => es.close();
  }, []);

  return { repos, scanning, fetching, connected, agentEvents, agentEventVersion };
}
