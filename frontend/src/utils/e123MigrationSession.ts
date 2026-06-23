const ACTIVE_BATCH_KEY = 'e123-migration:active-batch';
const ACTIVE_INSTANCE_KEY = 'e123-migration:active-instance';
const PRODUCT_DRAFT_PREFIX = 'e123-migration:product-draft:';

export interface E123MigrationActiveInstance {
  instanceId: string;
  label: string;
  updatedAt: number;
}

export interface E123MigrationActiveBatch {
  batchId: string;
  updatedAt: number;
}

export interface E123ProductMappingDraft {
  productSelections: Record<string, string>;
  tierSelections: Record<string, { productId: string; pricingId: string }>;
  /** Bundles created via migration "Create missing bundle" — surfaced first in product picker. */
  syncedBundleProductIds?: string[];
  updatedAt: number;
}

export function isResumableBatchStatus(status: string): boolean {
  return ['draft', 'fetching', 'ready', 'applying', 'failed'].includes(status);
}

/** Member import batches the hub should link back into the wizard (not product-only work). */
export function isMemberImportBatchStatus(status: string): boolean {
  return ['draft', 'fetching', 'ready', 'applying', 'failed', 'applied'].includes(status);
}

/** Batches that need attention on the hub (in-progress member imports). */
export function isInProgressMemberImportStatus(status: string): boolean {
  return isResumableBatchStatus(status);
}

export function pickHighlightedMemberImportBatch<T extends { BatchId: string; Status: string }>(
  history: T[],
  sessionBatchId?: string | null
): T | null {
  const inProgress = history.filter((row) => isResumableBatchStatus(row.Status));
  if (!inProgress.length) return null;
  if (sessionBatchId) {
    const sessionMatch = inProgress.find((row) => row.BatchId === sessionBatchId);
    if (sessionMatch) return sessionMatch;
  }
  const priority = ['applying', 'failed', 'fetching', 'ready', 'draft'];
  for (const status of priority) {
    const match = inProgress.find((row) => row.Status === status);
    if (match) return match;
  }
  return inProgress[0];
}

export function listInProgressMemberImports<T extends { Status: string }>(history: T[]): T[] {
  const priority = ['applying', 'failed', 'fetching', 'ready', 'draft'];
  return history
    .filter((row) => isResumableBatchStatus(row.Status))
    .sort((a, b) => priority.indexOf(a.Status) - priority.indexOf(b.Status));
}

export function loadActiveMigrationInstance(): E123MigrationActiveInstance | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_INSTANCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as E123MigrationActiveInstance;
    if (!parsed?.instanceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveActiveMigrationInstance(instanceId: string, label: string): void {
  try {
    sessionStorage.setItem(ACTIVE_INSTANCE_KEY, JSON.stringify({
      instanceId,
      label,
      updatedAt: Date.now()
    } satisfies E123MigrationActiveInstance));
  } catch {
    // ignore quota errors
  }
}

export function clearActiveMigrationInstance(): void {
  try {
    sessionStorage.removeItem(ACTIVE_INSTANCE_KEY);
  } catch {
    // ignore
  }
}

export function loadActiveMigrationBatch(): E123MigrationActiveBatch | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_BATCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as E123MigrationActiveBatch;
    if (!parsed?.batchId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveActiveMigrationBatch(batchId: string): void {
  try {
    sessionStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify({
      batchId,
      updatedAt: Date.now()
    } satisfies E123MigrationActiveBatch));
  } catch {
    // ignore quota errors
  }
}

export function clearActiveMigrationBatch(): void {
  try {
    sessionStorage.removeItem(ACTIVE_BATCH_KEY);
  } catch {
    // ignore
  }
}

export function loadProductMappingDraft(batchId: string): E123ProductMappingDraft | null {
  try {
    const raw = sessionStorage.getItem(`${PRODUCT_DRAFT_PREFIX}${batchId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as E123ProductMappingDraft;
    if (!parsed?.productSelections) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProductMappingDraft(batchId: string, draft: Omit<E123ProductMappingDraft, 'updatedAt'>): void {
  try {
    sessionStorage.setItem(`${PRODUCT_DRAFT_PREFIX}${batchId}`, JSON.stringify({
      ...draft,
      updatedAt: Date.now()
    } satisfies E123ProductMappingDraft));
  } catch {
    // ignore quota errors
  }
}

export function clearProductMappingDraft(batchId: string): void {
  try {
    sessionStorage.removeItem(`${PRODUCT_DRAFT_PREFIX}${batchId}`);
  } catch {
    // ignore
  }
}
