# Vendor Team — VendorAdmin manages VendorAgents

Issue #327: VendorAdmins should be able to create/view VendorAgents in the Backoffice.

## Goal

Give VendorAdmins a dedicated "Vendor Team" tab where they can:
- See a searchable list of VendorAgents on their vendor
- View details (name, email, phone) for any VendorAgent
- Create a new VendorAgent (name + email required, phone optional)

VendorAdmin creation stays in Settings — unchanged.

## Approach

Reuse the existing `/api/me/vendor/users` endpoints. The GET already returns all users on the vendor with roles attached; the POST already accepts a `roles` array. Filter to VendorAgent on the client and pass `roles: ['VendorAgent']` on create.

Add a password-setup token to the POST so newly created VendorAgents can actually sign in (mirroring the SysAdmin admin route in `routes/vendors.js`). Return the setup link in the response.

## Changes

### Backend — `backend/routes/me/vendor/users.js`

- POST: validate `roles` against `['VendorAdmin', 'VendorAgent']`, generate `ResetPasswordToken` (7-day expiry), store on the new user row, return `passwordSetupLink` in the response payload. Keep all existing behavior (transaction, role assignment, email uniqueness).
- No GET changes — client filters by role.

### Frontend — routing & nav

- `App.tsx`: wrap the `/vendor/users` route in `ProtectedRoute requiredRole={['VendorAdmin']}` so VendorAgents can't see it.
- `components/vendor/VendorNavigation.tsx`: add a "Vendor Team" nav item (Users icon) pointing to `/vendor/users`. Hide for VendorAgent the same way Settings is hidden.

### Frontend — page rewrite

- `pages/vendor/VendorUsers.tsx`: replace stub with full implementation:
  - Header: "Vendor Team" + brief description
  - Search input (filter by name or email, client-side)
  - "Add Vendor Agent" button → modal (first name, last name, email — required; phone — optional; checkbox to send welcome email)
  - Card/table list of VendorAgent users (filter GET result to rows whose roles include `VendorAgent`)
  - "See details" button per row → details modal (name, email, phone)
  - On create success: confirmation popup with copyable password setup link

## Out of scope

- Editing existing VendorAgents (not in issue)
- Deactivating VendorAgents from this tab (already supported by the DELETE endpoint — can be added later if needed)
- New backend endpoints — reuse `/api/me/vendor/users`
