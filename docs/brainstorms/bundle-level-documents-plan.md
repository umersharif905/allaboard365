# Bundle-Level Documents & AI Chunks — Plan

**Goal:** Let TenantAdmins upload documents at the bundle level (not just per-product) and have Columbus treat those bundle chunks as authoritative — falling back to underlying-product chunks only when the bundle docs don't cover a question.

**Date:** 2026-05-20

## Why this works without schema changes

Bundles are already rows in `oe.Products` with `IsBundle=true`. So `oe.ProductDocuments` and `oe.AIChunks` can be keyed on the bundle's ProductId with zero schema work. The Service Bus / Function extraction pipeline already operates on `ProductDocumentId` regardless of whether the owning ProductId is a bundle or a leaf.

The Columbus auth middleware (`columbus-api/middleware/auth.js`) already enrolls the bundle's parent ProductId in `enrolledProductIds`, and `enrolledProducts[]` already carries `bundleProductId` per enrollment. So both sides have the data they need.

The work is concentrated in (a) the bundle wizard UI to let admins upload docs, (b) the bundle-create/update flow to forward the same `productDocuments` payload products already use, and (c) Columbus prompt construction to split bundle vs product chunks into two labeled blocks with explicit priority instructions.

## Backend — products.js (AllAboard365)

**Status: nothing to change.** `POST /api/products` (lines 1397–1898) and `PUT /api/products/:id` (lines 1998–2750) already accept `productDocuments` (JSON array of `{ documentUrl, displayName, sortOrder, productDocumentId? }`) and call `queueDocumentExtraction()` per doc. The same code path runs whether `isBundle` is true or false. Confirm in implementation; no edits expected.

## Frontend — AllAboard365

### 1. `types/sysadmin/addproductswizard.types.ts`
Extend `BundleFormData` to include the same doc fields products use:

```ts
productDocumentFile?: File | null;
productDocumentFiles?: { file: File; displayName: string }[];
productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
```

### 2. New step: `components/forms/steps/Step3BundleDocuments.tsx`
Pared-down copy of `Step6MediaDocuments.tsx` — documents section only (no product image). Reuses the same `productDocuments[]` + `productDocumentFiles[]` state shape so submit logic is identical. Includes per-doc extraction status display when editing (read from `ExtractionStatus` on each existing doc returned by the backend).

### 3. `components/forms/AddBundleWizard.tsx`
- Add Step 3 "Documents" between BundleProducts and Review. STEPS array becomes 4 entries.
- `canProceedToNextStep` for step 3 returns `true` (documents are optional).
- `renderStep` adds a `case 3` rendering `Step3BundleDocuments`.
- On edit, fetch `/api/products/${productId}` (already done in `initializeForm`) — the response includes `productDocuments[]`; map them into `formData.productDocuments`.
- `handleSubmit` passes `productDocuments` + `productDocumentFiles` into `bundleData`.

### 4. `hooks/useBundleCreation.ts`
Append `productDocuments` JSON to the multipart payload (same way products do). The single-file `productDocumentFile` append already exists — keep it for legacy compat; the array is what we'll use going forward.

### 5. Host pages that render AddBundleWizard
The pages currently call `onSave={...}` and route the bundle data into `useBundleCreation`. For pending file uploads we need the same `pendingFiles` loop products use (TenantAdminProducts.tsx ~line 392):
- Upload each pending `File` to `/api/uploads` (type='documents', category='product')
- Collect resulting URL + displayName into `uploadedNewDocuments[]`
- Merge with existing `productDocuments[]` and pass the merged array to `useBundleCreation`

Pages to update: `TenantAdminProducts.tsx` (handler around line 783), and any other host that renders `AddBundleWizard` with an `onSave` prop. Search for `AddBundleWizard` usages.

## Columbus

### 6. `columbus-api/services/chunks.js`
- Extend `normalizeChunks(rawChunks, bundleProductIds)` to accept optional `bundleProductIds: string[]`. Each normalized chunk gets a `tier: 'bundle' | 'product'` field — `'bundle'` if its `productId` is in `bundleProductIds`, else `'product'`.
- Cache stays user-agnostic; tagging happens after fetch on the per-request normalized set.

### 7. `columbus-api/routes/chat.js`
- Compute `bundleProductIds = uniq(user.enrolledProducts.map(p => p.bundleProductId).filter(Boolean))`.
- Pass it through to `normalizeChunks`.
- When `bundleProductIds.length > 0`, render the context as two labeled blocks:

```
=== BUNDLE GUIDE (AUTHORITATIVE — use these to answer first) ===
<bundle chunks rendered via renderChunk()>

=== INDIVIDUAL PRODUCT REFERENCE (use ONLY if the bundle guide doesn't cover the question) ===
<product chunks rendered via renderChunk()>
```

With explicit instructions at the top: "This member is enrolled in a bundle. The bundle guide above is the authoritative source. Use individual-product reference material only when the bundle guide does not address the user's question."

When `bundleProductIds.length === 0` (solo, non-bundle member): unchanged behavior.

## Testing

Per user preference, minimize test runs during development. Run only:
- `npx tsc --noEmit` on frontend after changes
- `npx eslint .` on frontend after changes
- `node --check` on changed backend + Columbus files
- A live Columbus smoke test (the existing `/tmp/columbus-test.sh`) AFTER deploy — not in this iteration unless a bundle doc has actually been extracted on dev DB.

No unit/Jest/Cypress runs unless something breaks lint/typecheck.

## Out of scope

- No bundle-level chunk-management UI (view/edit/disable individual chunks at the bundle level). Use the existing per-product chunk UI on the bundle's own ProductId if needed.
- No retrieval/embedding selection — always load all matching chunks; rely on Anthropic prompt caching to absorb the extra tokens.
- No PR creation (user preference: explicit approval only).
