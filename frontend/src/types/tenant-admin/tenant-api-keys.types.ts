// File: frontend/src/types/tenant-admin/tenant-api-keys.types.ts
// Types for the tenant-level "Website Integration" API key (one key per tenant website,
// AgentId = NULL, Scope = 'website-integration'). Routes: /api/tenant-api-keys.

/** A tenant website API key as returned by GET /api/tenant-api-keys (no raw secret). */
export interface TenantApiKey {
  apiKeyId: string;
  keyName: string;
  /** Trailing fragment of the key for display, e.g. shown as `sk_live_…{partialKey}`. */
  partialKey: string;
  status: string; // 'active' | 'revoked'
  createdDate: string;
  lastUsedDate: string | null;
}

/** Result of POST /api/tenant-api-keys — the raw `key` is returned only once. */
export interface CreatedTenantApiKey {
  apiKeyId: string;
  keyName: string;
  partialKey: string;
  /** Full secret — shown once at creation, never returned again. */
  key: string;
}
