"use client";

import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
  projectsLoading: boolean;
  projectsError: string | null;
  refreshProjects: () => void;
  loadOlderEvents: () => void;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
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

  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const olderRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let opened = false;
    let scanActive = false;
    let cursor: number | null = null;
    let oldest: number | null = null;
    let initialized = false;
    let historyPending = false;
    let replayPending = false;
    let eventsController: AbortController | null = null;
    let projectsController: AbortController | null = null;
    let olderController: AbortController | null = null;
    let projectTimer: ReturnType<typeof setTimeout> | null = null;
    const bufferedEvents: AgentEvent[] = [];
    const pageSize = 100;
    const message = (reason: unknown) => reason instanceof Error ? reason.message : "情報を取得できませんでした";
    const remember = (events: AgentEvent[]) => {
      const merged = mergeAgentEvents(bufferedEvents, events);
      bufferedEvents.splice(0, bufferedEvents.length, ...merged);
      setAgentEvents((previous) => mergeAgentEvents(previous, events));
      setProjectSummaries((previous) => applyBufferedAgentEvents(previous, events));
    };
    const readEvents = async (url: string, controller: AbortController) => {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as AgentEventsResponse;
      if (!Array.isArray(value.events) || !value.events.every((event) =>
        event && typeof event.event_id === "string" && Number.isSafeInteger(event.sequence))) {
        throw new Error("agentイベントの形式が不正です");
      }
      return value.events;
    };
    const loadProjects = () => {
      projectsController?.abort();
      const controller = new AbortController();
      projectsController = controller;
      setProjectsLoading(true);
      void fetch("/api/projects", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const value = await response.json() as ProjectsResponse;
          if (!Array.isArray(value.projects)) throw new Error("プロジェクト情報の形式が不正です");
          if (disposed || controller.signal.aborted) return;
          setProjectSummaries(applyBufferedAgentEvents(value.projects, bufferedEvents));
          setProjectsError(null);
        }).catch((reason: unknown) => {
          if (!disposed && !controller.signal.aborted) setProjectsError(message(reason));
        }).finally(() => {
          if (!disposed && !controller.signal.aborted) setProjectsLoading(false);
        });
    };
    const scheduleProjects = () => {
      if (projectTimer !== null) clearTimeout(projectTimer);
      projectTimer = setTimeout(loadProjects, 120);
    };
    refreshRef.current = loadProjects;
    const loadEvents = () => {
      eventsController?.abort();
      const controller = new AbortController();
      eventsController = controller;
      setAgentDataLoading(true);
      replayPending = true;
      const initial = !initialized;
      const url = initial ? `/api/agent-events?limit=${pageSize}` : `/api/agent-events?after_sequence=${cursor}`;
      void readEvents(url, controller).then((events) => {
        if (disposed || controller.signal.aborted) return;
        remember(events);
        // Advance only after a complete replay: live events must not skip an offline gap.
        cursor = Math.max(cursor === null ? 0 : cursor, ...bufferedEvents.map((event) => event.sequence as number));
        replayPending = false;
        if (initial) {
          oldest = events.length > 0 ? Math.min(...events.map((event) => event.sequence as number)) : null;
          setHistoryHasMore(events.length === pageSize);
          initialized = true;
        }
        setAgentDataError(null);
      }).catch((reason: unknown) => {
        if (!disposed && !controller.signal.aborted) setAgentDataError(message(reason));
      }).finally(() => {
        if (!disposed && !controller.signal.aborted) setAgentDataLoading(false);
      });
    };
    olderRef.current = () => {
      if (!initialized || oldest === null || historyPending) return;
      historyPending = true;
      const controller = new AbortController();
      olderController = controller;
      setHistoryLoading(true);
      setHistoryError(null);
      void readEvents(`/api/agent-events?before_sequence=${oldest}&limit=${pageSize}`, controller).then((events) => {
        if (disposed || controller.signal.aborted) return;
        setAgentEvents((previous) => mergeAgentEvents(previous, events));
        if (events.length > 0) oldest = Math.min(...events.map((event) => event.sequence as number));
        setHistoryHasMore(events.length === pageSize);
      }).catch((reason: unknown) => {
        if (!disposed && !controller.signal.aborted) setHistoryError(message(reason));
      }).finally(() => {
        historyPending = false;
        if (!disposed && !controller.signal.aborted) setHistoryLoading(false);
      });
    };
    loadProjects();
    const es = new EventSource("/api/stream");
    es.onopen = () => {
      setConnected(true);
      // Initial replay starts on open so there is no gap before SSE subscribes.
      loadEvents();
      if (opened) loadProjects();
      opened = true;
    };
    es.onerror = () => setConnected(false);
    es.addEventListener("snapshot", (event) => {
      const list: Repo[] = JSON.parse((event as MessageEvent).data);
      setRepos(new Map(list.map((repo) => [repo.path, repo])));
    });
    es.addEventListener("repo", (event) => {
      const repo = JSON.parse((event as MessageEvent).data) as Repo;
      if (!scanActive) scheduleProjects();
      setRepos((previous) => {
        const next = new Map(previous);
        next.set(repo.path, { ...next.get(repo.path), ...repo });
        return next;
      });
    });
    es.addEventListener("removed", (event) => {
      const path = (JSON.parse((event as MessageEvent).data) as { path: string })
        .path;
      scheduleProjects();
      setRepos((previous) => {
        const next = new Map(previous);
        next.delete(path);
        return next;
      });
    });
    es.addEventListener("scan", (event) => {
      const active = (JSON.parse((event as MessageEvent).data) as { active: boolean }).active;
      setScanning(active);
      if (scanActive && !active) scheduleProjects();
      scanActive = active;
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
      if (initialized && !replayPending && Number.isSafeInteger(value.sequence)) {
        cursor = Math.max(cursor as number, value.sequence as number);
      }
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
      eventsController?.abort();
      projectsController?.abort();
      olderController?.abort();
      if (projectTimer !== null) clearTimeout(projectTimer);
    };
  }, []);

  return { repos, scanning, fetching, connected, agentEvents, latestAgentEvent, projectSummaries, agentDataLoading: agentDataLoading || projectsLoading, agentDataError: [agentDataError, projectsError].filter((value) => value !== null).join(" / ") || null, projectsLoading, projectsError, refreshProjects: () => refreshRef.current(), loadOlderEvents: () => olderRef.current(), historyHasMore, historyLoading, historyError };
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
