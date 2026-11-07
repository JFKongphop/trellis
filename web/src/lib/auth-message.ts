// NEP-413 sign-in constants shared by the browser and the server. The server
// rejects any other message/recipient, so a signature made for another app
// can't be replayed here (near-frontend skill, wallet.md).

export const AUTH_MESSAGE = "Sign in to Trellis";
export const AUTH_RECIPIENT = "trellis.app";
