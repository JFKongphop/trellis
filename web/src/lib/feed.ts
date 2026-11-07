// Public activity feed (/feed): recent agent moves across the vaults the worker protects.
import type { VaultReceipt } from "@/lib/near/vault";

export type FeedItem = VaultReceipt & { vault_id: string };

export type FeedResponse = {
  /** False when the server has no worker configured (nothing to list). */
  configured: boolean;
  vaults: number;
  items: FeedItem[];
  /** Last 24 h. */
  stats: { moves: number; automatic: number; failed: number; vaultsActive: number };
  generatedAt: number;
};
