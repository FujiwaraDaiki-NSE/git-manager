"use client";

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { mergeAgentSnapshot } from "./agent-overview.mjs";
import { applyBufferedAgentEvents, mergeAgentEvents } from "./agent-timeline-tools.mjs";
import type { AgentEvent, AgentEventEnvelope, ProjectSummary, Repo } from "./types";

export type RepoStreamState = {
  repos: Map<string, Repo>;
  scanning: boolean;
  fetching: boolean;
  connected: boolean;
  agentEvents: AgentEvent[];
  latestAgentEvent: AgentEvent | null;
  projectSummaries: ProjectSummary[];
  agentDataLoading: boolean;
  agentDataError: string | null;
};

type AgentEventsResponse = { events: AgentEvent[] };
type ProjectsResponse = { projects: ProjectSummary[] };

function parseAgentEvent(payload: unknown): AgentEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Partial<AgentEventEnvelope> & { snapshot?: AgentEvent };
  const snapshot = envelope.snapshot && typeof envelope.snapshot === "object"
    ? envelope.snapshot
    : payload as AgentEvent;
  const eventId = typeof snapshot.event_id === "string" && snapshot.event_id.length > 0
    ? snapshot.event_id
    : typeof envelope.event_id === "string" && envelope.event_id.length > 0
      ? envelope.event_id
      : null;
  if (!eventId) return null;
  const worktree = typeof snapshot.worktree === "string"
    ? snapshot.worktree
    : typeof envelope.worktree === "string"
      ? envelope.worktree
      : null;
  return { ...snapshot, event_id: eventId, worktree } as AgentEvent;
}

/** Shared read-only SSE snapshot used by home and the project control page. */
function useRepoStreamState(): RepoStreamState {
  const [repos, setRepos] = useState<Map<string, Repo>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [connected, setConnected] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [latestAgentEvent, setLatestAgentEvent] = useState<AgentEvent | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [agentDataLoading, setAgentDataLoading] = useState(true);
  const [agentDataError, setAgentDataError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let requestSerial = 0;
    const controllers = new Set<AbortController>();
    const bufferedEvents: AgentEvent[] = [];

    const loadAgentData = () => {
      const requestId = ++requestSerial;
      const controller = new AbortController();
      controllers.add(controller);
      setAgentDataLoading(true);
      const eventsRequest = fetch("/api/agent-events", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json() as Partial<AgentEventsResponse>;
          if (!Array.isArray(value.events)) throw new Error("agentイベントの形式が不正です");
          if (!value.events.every((event) => event && typeof event.event_id === "string" && event.event_id.length > 0)) {
            throw new Error("agentイベントの識別子が不正です");
          }
          return value as AgentEventsResponse;
        });
      const projectsRequest = fetch("/api/projects", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json() as Partial<ProjectsResponse>;
          if (!Array.isArray(value.projects)) throw new Error("プロジェクト情報の形式が不正です");
          return value as ProjectsResponse;
        });
      void Promise.allSettled([eventsRequest, projectsRequest]).then((results) => {
        controllers.delete(controller);
        if (disposed || requestId !== requestSerial) return;
        const eventsResult = results[0];
        const projectsResult = results[1];
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (eventsResult.status === "fulfilled") {
          const events = eventsResult.value.events;
          const merged = mergeAgentEvents([...bufferedEvents], events);
          bufferedEvents.splice(0, bufferedEvents.length, ...merged);
          setAgentEvents((previous) => mergeAgentEvents(previous, merged));
          setProjectSummaries((previous) => applyBufferedAgentEvents(previous, merged));
        }
        if (projectsResult.status === "fulfilled") {
          setProjectSummaries(applyBufferedAgentEvents(projectsResult.value.projects, bufferedEvents));
        }
        setAgentDataError(failures.length > 0
          ? failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : "agent情報を取得できませんでした").join(" / ")
          : null);
        setAgentDataLoading(false);
      });
    };

    loadAgentData();
    const es = new EventSource("/api/stream");
    es.onopen = () => {
      setConnected(true);
      // The stream starts with Git state only. On every reconnect, replay the
      // persisted agent history so events missed while offline are restored.
      loadAgentData();
    };
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
      const active = (JSON.parse((event as MessageEvent).data) as { active: boolean }).active;
      setScanning(active);
      if (!active) loadAgentData();
    });
    es.addEventListener("fetch", (event) => {
      setFetching(
        Boolean((JSON.parse((event as MessageEvent).data) as { active: boolean }).active),
      );
    });
    es.addEventListener("agent_event", (event) => {
      let value: AgentEvent | null = null;
      try {
        value = parseAgentEvent(JSON.parse((event as MessageEvent).data));
      } catch {
        return;
      }
      if (!value) return;
      bufferedEvents.push(value);
      const merged = mergeAgentEvents([], bufferedEvents);
      bufferedEvents.splice(0, bufferedEvents.length, ...merged);
      setLatestAgentEvent(value);
      setAgentEvents((previous) => mergeAgentEvents(previous, [value]));
      if (value.kind === "status" && value.project_id) {
        setProjectSummaries((previous) => previous.map((project) => (
          project.id === value?.project_id ? mergeAgentSnapshot(project, value) : project
        )));
      }
    });
    return () => {
      disposed = true;
      es.close();
      for (const controller of controllers) controller.abort();
    };
  }, []);

  return { repos, scanning, fetching, connected, agentEvents, latestAgentEvent, projectSummaries, agentDataLoading, agentDataError };
}

const RepoStreamContext = createContext<RepoStreamState | null>(null);

export function RepoStreamProvider({ children }: { children: ReactNode }) {
  const state = useRepoStreamState();
  return createElement(RepoStreamContext.Provider, { value: state }, children);
}

export function useRepoStream(): RepoStreamState {
  const state = useContext(RepoStreamContext);
  if (state === null) throw new Error("RepoStreamProvider is required");
  return state;
}
