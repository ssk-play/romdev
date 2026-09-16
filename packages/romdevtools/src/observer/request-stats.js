// Bounded request accounting independent of the livestream's tiny replay ring.
// No request payloads or ROM contents are retained.
export class RequestStats {
  constructor({ maxSessions = 128, windowSeconds = 60, now = Date.now } = {}) {
    this.sessions = new Map(); this.maxSessions = maxSessions; this.windowSeconds = windowSeconds; this.now = now;
  }
  record(event) {
    if (event.type !== "call" || !event.sessionKey) return;
    const now = this.now(), second = Math.floor(now / 1000);
    let s = this.sessions.get(event.sessionKey);
    if (!s) {
      if (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
      s = { session: event.sessionKey, since: now, lastCallAt: now, calls: 0, errors: 0,
        consecutiveErrors: 0, durationMs: 0, buckets: new Map(), byTool: new Map(), recentErrors: [] };
    }
    // LRU retention is bounded even if clients manufacture session handles.
    this.sessions.delete(event.sessionKey); this.sessions.set(event.sessionKey, s);
    s.lastCallAt = now; s.calls++; s.durationMs += Math.max(0, event.durationMs ?? 0);
    const failed = event.ok === false;
    if (failed) s.errors++;
    s.consecutiveErrors = failed ? s.consecutiveErrors + 1 : 0;
    const bucket = s.buckets.get(second) ?? { calls: 0, errors: 0 };
    bucket.calls++; if (failed) bucket.errors++;
    s.buckets.set(second, bucket);
    for (const t of s.buckets.keys()) if (t <= second - this.windowSeconds) s.buckets.delete(t);
    const tool = s.byTool.has(event.tool) || s.byTool.size < 64 ? event.tool : "(other)";
    const count = s.byTool.get(tool) ?? { calls: 0, errors: 0 };
    count.calls++; if (failed) count.errors++;
    s.byTool.set(tool, count);
    if (failed) {
      s.recentErrors.push({ at: now, tool: event.tool, phase: event.phase ?? "execution",
        message: String(event.error ?? "tool error").slice(0, 240) });
      if (s.recentErrors.length > 5) s.recentErrors.shift();
    }
  }
  snapshot() {
    const second = Math.floor(this.now() / 1000);
    return { windowSeconds: this.windowSeconds, retainedSessions: this.sessions.size, maxSessions: this.maxSessions,
      scope: "completed observed calls since this process started; HTTP validation errors included; SDK errors before MCP handler dispatch are not observed",
      sessions: [...this.sessions.values()].map((s) => {
        const buckets = [...s.buckets].filter(([t]) => t > second - this.windowSeconds);
        const recentCalls = buckets.reduce((n, [, b]) => n + b.calls, 0);
        const recentErrors = buckets.reduce((n, [, b]) => n + b.errors, 0);
        return { session: s.session, since: s.since, lastCallAt: s.lastCallAt, calls: s.calls, errors: s.errors,
          errorRate: s.errors / s.calls, consecutiveErrors: s.consecutiveErrors,
          recentCalls, recentErrors, requestsPerSecond: recentCalls / this.windowSeconds,
          meanDurationMs: s.durationMs / s.calls, byTool: Object.fromEntries(s.byTool), lastErrors: s.recentErrors,
          ...(s.consecutiveErrors >= 10 || recentCalls >= 20 && recentErrors / recentCalls >= 0.5
            ? { warning: "high error traffic: inspect argument/address-domain errors before retrying or blaming server restarts" } : {}) };
      }) };
  }
}
export const requestStats = new RequestStats();
