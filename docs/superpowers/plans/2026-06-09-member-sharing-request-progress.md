# Member Portal — Sharing-Request Status Progress Bar

Branch: `member-sharing-request` (off staging). Scope: **ShareRequests only**, NOT Cases.

## Goal
In the member portal "Medical Needs" page, show a per–sharing-request 4-step progress bar
(Submitted → Acknowledged → Processing → Processed) with hover tooltips and an expandable
member-facing detail panel. Gated by a per-vendor "show status" flag.

## Confirmed product decisions
1. **Gating flag**: new bit column `ShowShareRequestStatusToMembers` on `oe.Vendors` (per-vendor, global).
2. **Terminal colors on the "Processed" step**: Completed = green, Denied = red, Withdrawn = gray.
3. **"Awaiting Member Info"**: sits on the Processing step + amber "Action needed" cue telling the
   member to check their email, and if they see nothing, reach out to the care team directly.

## Status → step mapping (single source of truth: `mapShareRequestStatusToStep`)
| Backend Status | stepIndex | terminalVariant | actionNeeded |
|---|---|---|---|
| New | 0 (Submitted) | null | false |
| Acknowledged | 1 (Acknowledged) | null | false |
| In Review | 2 (Processing) | null | false |
| Awaiting Authorization | 2 (Processing) | null | false |
| Processing | 2 (Processing) | null | false |
| Awaiting Member Info | 2 (Processing) | null | **true** |
| Completed | 3 (Processed) | 'success' | false |
| Denied | 3 (Processed) | 'denied' | false |
| Withdrawn | 3 (Processed) | 'withdrawn' | false |
| (unknown/default) | 2 (Processing) | null | false |

Steps array labels: `['Submitted', 'Acknowledged', 'Processing', 'Processed']`.

## Member-facing tooltip copy
- **Submitted**: "Your request has been submitted. A care team member will be reviewing it shortly."
- **Acknowledged**: "The care team has received your sharing request and is determining the next steps."
- **Processing**: "Your request is being actively worked — the team is reviewing bills, coordinating
  with providers, and determining what can be shared. This step can take some time."
- **Processing + actionNeeded (amber banner)**: "Action needed — please check your email for a request
  for more information. If you don't see anything, reach out to the care team directly."
- **Processed (success)**: "Your request has been processed and completed. See the details for the outcome."
- **Processed (denied)**: "Your request has been processed. It was not approved for sharing — open the
  details for the reason."
- **Processed (withdrawn)**: "This request was withdrawn."

---

## Build contract (interfaces other workstreams depend on)

### DB column
`oe.Vendors.ShowShareRequestStatusToMembers BIT NOT NULL DEFAULT 0`

### API: list — `GET /api/me/member/sharing-requests` (already exists)
Service `getShareRequestsByHousehold` / `getShareRequestByIdForMember` must additionally return
(via `LEFT JOIN oe.Vendors v ON sr.VendorId = v.VendorId`):
`VendorName`, `ShowShareRequestStatusToMembers`. (`sr.*` already includes ShareRequestId,
RequestNumber, RequestTypeName (aliased), SubType, Status, Determination, SubmittedDate, IntakeDate,
ReviewStartDate, CompletedDate, VendorId, MemberFirstName/LastName, TotalBilledAmount, TotalUAAmount,
IncidentUAAmount, MemberStatedUA, NextSteps, GeneralNotes.)

### API: documents — NEW `GET /api/me/member/sharing-requests/:id/documents`
Household ownership check (mirror existing `/:id` route), then `ShareRequestService.getDocuments(id)`,
then attach `AuthenticatedUrl` via `generateAuthenticatedUrl`/`isBlobUrl` from `../../uploads`
(mirror vendor route at `routes/me/vendor/share-requests.js:1683`). Returns array of
`{ DocumentId, DocumentName, DocumentType, FileName, BillId, BillNumber, CreatedDate, AuthenticatedUrl, BlobUrl }`.

### Frontend helper (in `shareRequest.types.ts`)
```ts
export type ShareRequestTerminalVariant = 'success' | 'denied' | 'withdrawn';
export interface ShareRequestStepInfo {
  stepIndex: 0 | 1 | 2 | 3;
  terminalVariant: ShareRequestTerminalVariant | null;
  actionNeeded: boolean;
}
export const SHARE_REQUEST_STEPS = ['Submitted', 'Acknowledged', 'Processing', 'Processed'] as const;
export function mapShareRequestStatusToStep(status: string): ShareRequestStepInfo;
export const SHARE_REQUEST_STEP_TOOLTIPS: { ... }; // copy above
```

### Frontend hooks
- `useMemberSharingRequests()` → `MemberShareRequest[]` from `/api/me/member/sharing-requests`.
  Define `MemberShareRequest` with the fields listed above. Mirror staleTime/gcTime of
  `useMemberMedicalNeedsRequests.ts`.
- `useMemberShareRequestDocuments(shareRequestId, enabled)` → documents array (lazy, enabled on expand).

### Frontend components (Tailwind + Lucide only; brand colors `oe-primary`/`oe-dark`/`oe-success`)
- `ShareRequestProgressBar` (`components/member/`): horizontal 4-circle stepper using
  `mapShareRequestStatusToStep`; completed steps oe-success, active step oe-primary, pending gray;
  on the Processed step use green/red/gray per terminalVariant; hover tooltip per step; amber
  "Action needed" banner under the bar when actionNeeded.
- `ShareRequestCard` (`components/member/`): card (`bg-white rounded-lg border border-gray-200 p-6`)
  with header (RequestNumber, RequestTypeName/SubType, formatted SubmittedDate), the progress bar,
  and an expand toggle revealing a detail panel: who it was submitted for (MemberFirstName/LastName),
  submitted date, amounts (TotalBilledAmount, TotalUAAmount / MemberStatedUA), outcome text for
  terminal states (NextSteps/Determination), and the documents list (download via AuthenticatedUrl).

### Member page integration (`pages/member/SharingRequests.tsx`)
Add a new section ABOVE the existing external-links block. Fetch `useMemberSharingRequests()`,
render a `ShareRequestCard` for each request whose `ShowShareRequestStatusToMembers` is truthy.
Widen container `max-w-xl` → `max-w-3xl`. Keep external-links block unchanged below.

### Admin toggle (`pages/admin/Vendors.tsx`)
Add a labeled checkbox/toggle "Show sharing-request status to members" in the existing Settings
section, bound to vendor `ShowShareRequestStatusToMembers`, persisted through the existing vendor
PUT save path. Backend `routes/vendors.js` GET/:id projection + PUT/:id update must include the column.

## DB policy
The migration script must default to a dry-run/SELECT preview; the actual `ALTER TABLE` runs only
when a flag is explicitly set. **Do NOT execute any DB write** — only write the script file.
