// Cross-pane bridge: a feed post asks Trellis a question; the visible chat pane
// picks it up and sends it. The feed list and the chat live in sibling trees,
// and the mobile chat sheet stays mounted alongside the desktop rail — so two
// <Conversation> instances exist at once. This is a plain module store with an
// atomic take-once read; the consumer is breakpoint-gated so exactly one pane
// claims and sends each question (see conversation.tsx).

let pending: string | null = null;
const subscribers = new Set<() => void>();

/** Queue a question and notify the chat panes. */
export function askTrellis(text: string): void {
  pending = text;
  for (const cb of subscribers) cb();
}

export function subscribeAskTrellis(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Atomically read and clear the pending question (null if already taken). */
export function takePendingAsk(): string | null {
  const text = pending;
  pending = null;
  return text;
}
