// Single source of truth for chat input limits, shared by the composer
// (frontend) and the /api/chat route (backend) so they can't drift.

/** Max characters allowed in a single user message. */
export const MAX_USER_MESSAGE_CHARS = 1000;
