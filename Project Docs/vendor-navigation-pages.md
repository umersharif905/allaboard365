## Vendor Navigation Pages – Data Model

This document captures the schema and core concepts for vendor-driven navigation within the member portal.

### Table: `oe.VendorNavigationPages`
| Column | Type | Notes |
| --- | --- | --- |
| `VendorNavigationPageId` | `uniqueidentifier (PK)` | Generated with `NEWID()` |
| `VendorId` | `uniqueidentifier` | FK to `oe.Vendors` |
| `TenantId` | `uniqueidentifier` (nullable) | Optional override per tenant; NULL means “all tenants reselling the vendor” |
| `RouteKey` | `nvarchar(100)` | Unique per vendor/tenant; used to build member route slug |
| `Label` | `nvarchar(150)` | Display text in nav |
| `Description` | `nvarchar(500)` | Optional tooltip or summary |
| `IconName` | `nvarchar(100)` | Lucide icon key to render in nav (optional) |
| `ContentType` | `nvarchar(50)` | One of: `markdown`, `static_html`, `iframe`, `component` |
| `ContentRef` | `nvarchar(500)` | Pointer to file/blob/component key/external URL |
| `VisibilityRule` | `nvarchar(max)` | JSON describing prerequisites (product IDs, plan types, bundle membership, etc.) |
| `SortOrder` | `int` | Determines ordering inside vendor group (ascending) |
| `Published` | `bit` | Set to 1 to expose page |
| `EffectiveDate` / `ExpirationDate` | `datetime2` | Window for showing page |
| `CreatedDate`, `CreatedBy`, `ModifiedDate`, `ModifiedBy` | audit columns |

### Indices & Constraints
- Unique index across `(VendorId, ISNULL(TenantId, GuidEmpty), RouteKey)` ensures no duplicate keys per vendor/tenant scope.
- Non-clustered index on `(VendorId, Published, EffectiveDate, ExpirationDate)` accelerates lookups for active pages.

### Visibility JSON (Draft)
Example payload:
```json
{
  "requiresActiveEnrollment": true,
  "productIds": ["{PRODUCT-ID-1}", "{PRODUCT-ID-2}"],
  "productTypes": ["Healthcare"],
  "bundleProductIds": [],
  "minStartDate": "2025-01-01"
}
```

Rules will be evaluated server-side when building the vendor navigation list for a member session.

### Content Reference Strategy
- **markdown / static_html:** Path to blob storage asset (e.g. `content/vendor/sharewell/welcome.md`); server will fetch and sanitize.
- **iframe:** HTTPS URL to vendor-hosted experience (CSP allow-list required).
- **component:** Key mapped to a React component we ship (e.g. `sharewellClaimStatus`).

### Seed Example
See `Project Docs/add-vendor-navigation-pages.sql` for an example insert scaffold for ShareWELL.










