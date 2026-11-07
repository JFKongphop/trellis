// Shared account-display helpers. The avatar itself is the deterministic
// <Identicon> (components/ui/identicon.tsx).

/** "0x1a2b…5f9e" — head 6 + tail 4. */
export function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * NEAR account for display: named accounts (alice.near) stay readable unless
 * very long; 64-hex implicit and 0x eth-implicit accounts are shortened.
 */
export function shortAccount(id: string): string {
  if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) {
    return shortAddr(id);
  }
  return id.length > 24 ? `${id.slice(0, 14)}…${id.slice(-8)}` : id;
}
