# Vendor Invoices (AllAboard vendor backoffice)

**Status:** Implemented (2026-06-04)  
**Scope:** admin-web — VendorAdmin only

## Summary

Generate XLSX invoices for **IsExternal** tenants using **NetRate** on active `oe.Enrollments` in a date range. ZIP download with preview total mismatch warnings (still downloads).

## API

- `GET /api/me/vendor/invoices/preview?periodStart&periodEnd`
- `POST /api/me/vendor/invoices/generate` — body `{ periodStart, periodEnd, tenantIds[] }` → ZIP

## UI

- Nav: **Invoices** after **Tenants** (`/vendor/invoices`)
- Month dropdown (default prior month → current month 1st); advanced calendar optional
- External tenants only; select all / generate ZIP

## Parity

`ai_scripts/verify-vendor-invoice-parity.cjs` — informational OE NetRate vs ShareWELL premium (Align/SHA). Expect deltas until enrollments/pricing aligned.

## Tests

- `backend/services/__tests__/vendorInvoiceService.test.js`
- `frontend/src/pages/vendor/__tests__/VendorInvoicesPage.test.tsx`
