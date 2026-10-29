/**
 * Incremental, session-local judge context.
 *
 * The durable session log remains authoritative. A current Host exposes the
 * result as a host-only session projection; older Hosts use a WeakMap plus
 * exact sequence checks. Both paths share the same pure init/apply fold. Any
 * uncertainty discards the derived cache and falls back to the legacy full
 * fold — stale tool arguments or user authorization context is never served.
 */

import { z } from "zod";

const TOOL_CALL_CACHE_LIMIT = 32;
const USER_TEXT_LIMIT = 800;
const PROJECTION_KEY = "agent-approval-judge-context";

/**
 * Byte-identical to the pre-optimization trunc() in index.js: a truncated
 * user message keeps its "…[truncated]" marker, because the judge prompt
 * shows the text verbatim and must be able to see that it was cut.
 */
function trunc(value, n) {
  if (typeof value !== "string") return "";
  return value.length > n ? value.slice(0, n) + "…[truncated]" : value;
}

export function initJudgeContext() {
  return { firstUser: "", recentUsersRaw: [], recentToolCalls: [] };
}

/** Exact user/message text extraction used by the legacy full fold. */
export function judgeUserText(event) {
  if (!event || event.type !== "user/message") return "";
  const msg = event.data;
  if (!msg || !msg.source || msg.source.kind !== "user") return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * Pure shared fold. Unrelated events return the same reference; tool calls
 * retain raw arguments and the most recent duplicate callId wins.
 */
export function applyJudgeContext(state, event) {
  if (!event || typeof event.type !== "string") return state;
  if (event.type === "tool/call") {
    const data = event.data;
    if (!data || typeof data.callId !== "string" || typeof data.arguments !== "string") return state;
    const calls = state.recentToolCalls.filter((entry) => entry.callId !== data.callId);
    calls.push({ callId: data.callId, arguments: data.arguments });
    if (calls.length > TOOL_CALL_CACHE_LIMIT) calls.splice(0, calls.length - TOOL_CALL_CACHE_LIMIT);
    return { firstUser: state.firstUser, recentUsersRaw: state.recentUsersRaw, recentToolCalls: calls };
  }
  const text = judgeUserText(event);
  if (text === "") return state;
  const recent = state.recentUsersRaw.slice();
  recent.push(text);
  if (recent.length > 3) recent.shift();
  return {
    firstUser: state.firstUser === "" ? text : state.firstUser,
    recentUsersRaw: recent,
    recentToolCalls: state.recentToolCalls,
  };
}

export function foldJudgeContext(events) {
  let state = initJudgeContext();
  for (const event of events) state = applyJudgeContext(state, event);
  return state;
}

const toolCallStateSchema = z.object({
  callId: z.string(),
  arguments: z.string(),
});

const judgeContextStateSchema = z.object({
  firstUser: z.string(),
  recentUsersRaw: z.array(z.string()).max(3),
  recentToolCalls: z.array(toolCallStateSchema).max(TOOL_CALL_CACHE_LIMIT),
});

function cachedArgsOf(state, callId) {
  for (let i = state.recentToolCalls.length - 1; i >= 0; i--) {
    const entry = state.recentToolCalls[i];
    if (entry.callId === callId) return entry.arguments;
  }
  return undefined;
}

export class JudgeContextCache {
  /** eventsOf is the Service's two-generation full snapshot reader. */
  constructor(eventsOf) {
    this._eventsOf = eventsOf;
    this._cache = new WeakMap();
    this._projections = undefined;
  }

  /** Register the current Host's optional projection, retaining old-Host fallback. */
  attach(ctx) {
    try {
      ctx.inject(["sessionProjections"], (scope) => {
        const projections = scope.sessionProjections;
        if (!projections || typeof projections.register !== "function") return;
        try {
          projections.register({
            key: PROJECTION_KEY,
            stateVersion: 1,
            stateSchema: judgeContextStateSchema,
            init: () => initJudgeContext(),
            apply: (state, event) => applyJudgeContext(state, event),
          });
          this._projections = projections;
        } catch (e) {
          this._projections = undefined;
        }
      });
    } catch (e) {
      this._projections = undefined;
    }
  }

  invalidate(session) {
    if (session && typeof session === "object") this._cache.delete(session);
  }

  /** Observe every committed event on old-Host caches; never throws. */
  observe(session, event) {
    try {
      if (!session || typeof session !== "object") return;
      const cache = this._cache.get(session);
      if (cache === undefined || cache.dirty) return;
      if (!Number.isSafeInteger(cache.nextSeq)) {
        cache.dirty = true;
        return;
      }
      const seq = event && event.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
        cache.dirty = true;
        return;
      }
      if (seq < cache.nextSeq) return;
      if (seq > cache.nextSeq) {
        cache.dirty = true;
        return;
      }
      cache.state = applyJudgeContext(cache.state, event);
      cache.nextSeq += 1;
    } catch (e) {
      const cache = session && typeof session === "object" ? this._cache.get(session) : undefined;
      if (cache !== undefined) cache.dirty = true;
    }
  }

  _legacyState(session) {
    return foldJudgeContext(this._eventsOf(session));
  }

  _weakState(session) {
    const currentSeq = typeof session.seq === "number" ? session.seq : undefined;
    const cache = this._cache.get(session);
    if (cache !== undefined && !cache.dirty && cache.nextSeq === currentSeq) return cache.state;
    const events = this._eventsOf(session);
    const state = foldJudgeContext(events);
    this._cache.set(session, {
      state,
      // A legacy/mock Session without seq can be reused only while untouched;
      // its first seq-less event observation marks the cache dirty.
      nextSeq: currentSeq,
      dirty: false,
    });
    return state;
  }

  _projectionState(session) {
    if (this._projections === undefined) return undefined;
    try {
      const state = this._projections.stateOf(session, PROJECTION_KEY);
      return state === undefined ? undefined : state;
    } catch (e) {
      return undefined;
    }
  }

  _state(session) {
    const projected = this._projectionState(session);
    return projected !== undefined ? projected : this._weakState(session);
  }

  /** Exact raw arguments, falling back to the legacy full reverse lookup on eviction. */
  callArgs(session, callId) {
    if (callId === undefined) return undefined;
    const args = cachedArgsOf(this._state(session), callId);
    if (args !== undefined) return args;
    const events = this._eventsOf(session);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "tool/call" && event.data.callId === callId) return event.data.arguments;
    }
    return undefined;
  }

  /** First + latest three genuine user messages, with legacy dedupe then trunc. */
  recentUserContext(session) {
    const state = this._state(session);
    const recent = state.recentUsersRaw.filter((text) => text !== state.firstUser);
    return {
      first: trunc(state.firstUser, USER_TEXT_LIMIT),
      recent: recent.map((text) => trunc(text, USER_TEXT_LIMIT)),
    };
  }
}
