// Liveness for /healthz (an external cron alerts if lastTickAt goes stale).
export const health = {
  lastTickAt: 0,
  lastError: null as string | null,
  ok() {
    return Date.now() - this.lastTickAt < 120_000;
  },
};
