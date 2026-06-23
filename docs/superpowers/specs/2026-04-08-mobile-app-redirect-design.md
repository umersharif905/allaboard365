# Mobile App Redirect & Desktop Download Card

## Problem

The member portal (`/member/*`) is not optimized for mobile browsers. Members who complete enrollment on mobile are redirected to the portal, which has a fixed sidebar layout that doesn't work well on small screens. Tenants with published mobile apps need a way to redirect mobile users to the native app, and desktop users should have an easy way to discover and download the app.

## Solution

Two complementary features, both gated on whether the tenant has configured mobile app store URLs:

1. **Mobile Redirect Modal** — Full-screen modal shown to mobile users visiting any `/member/*` route, prompting them to open/download the native app.
2. **Desktop QR Code Card** — Dashboard card showing QR codes for iOS/Android app download, visible only to desktop users.

## Scope

### In Scope
- Mobile device detection via user agent
- Full-screen redirect modal on all member portal routes
- Platform detection (iOS vs Android) with appropriate store link
- Session-based dismissal (`sessionStorage`)
- Desktop QR code card on member dashboard
- Backend: extend member tenant API to return app store URLs
- Install `qrcode.react` package

### Out of Scope
- Deep linking into the native app (just store URLs)
- Native app changes
- Responsive redesign of the member portal
- New backend endpoints or public APIs

## Architecture

### Backend

**File:** `backend/routes/me/member/tenant.js`

Extend the existing `GET /api/me/member/tenant` SQL query to return two additional fields from the tenant's `AdvancedSettings` JSON:

```sql
ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.appStoreUrl'), '') AS AppStoreUrl,
ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.playStoreUrl'), '') AS PlayStoreUrl
```

These use the production JSON paths already written by the existing tenant settings UI (`UnifiedTenantSettingsModal.tsx` → `features.mobileApp.appStoreUrl` / `features.mobileApp.playStoreUrl`).

**File:** `frontend/src/services/member/member-tenant.service.ts`

Update `MemberTenantInfo` interface to include `AppStoreUrl` and `PlayStoreUrl`.

### Feature 1: Mobile Redirect Modal

**New file:** `frontend/src/components/member/MobileAppRedirectModal.tsx`

**Behavior:**
1. On mount, evaluate three conditions:
   - Is user on a mobile device? (user-agent check: `iPad|iPhone|iPod`, `Android`, `Mobi`)
   - Does the tenant have at least one app store URL configured? (`AppStoreUrl` or `PlayStoreUrl` non-empty)
   - Has the user NOT dismissed the modal this session? (`sessionStorage` key `dismissedMobileAppRedirect` is absent)
2. If all three pass → render full-screen modal overlay
3. If any fail → render nothing

**UI (full-screen modal with dimmed background):**
- Dimmed backdrop covering entire viewport
- Centered white modal card
- App icon or phone illustration
- Heading: "The member portal works best in the app"
- Subtext: "Download for the full mobile experience"
- Primary CTA button: platform-detected store link
  - iOS users → "Download on the App Store" (links to `AppStoreUrl`)
  - Android users → "Get it on Google Play" (links to `PlayStoreUrl`)
- Secondary link: "Also available on [other platform]" (small text, only if both URLs exist)
- De-emphasized "Continue to site anyway" at bottom
  - On click: sets `sessionStorage.setItem('dismissedMobileAppRedirect', 'true')` and closes modal

**Platform detection logic** (reused from enrollment wizard):
```typescript
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua);
const isAndroid = /Android/.test(ua);
const isMobile = isIOS || isAndroid || /Mobi/.test(ua);
```

If user is mobile but platform is ambiguous (neither iOS nor Android specifically), show whichever URL is available, or both buttons if both exist.

**Integration point:** `frontend/src/components/member/MemberLayout.tsx`

Render `<MobileAppRedirectModal />` inside `MemberLayout`, before the main content. The component is self-contained — it fetches tenant data from the member tenant API internally and manages its own visibility state.

### Feature 2: Desktop QR Code Card

**New file:** `frontend/src/components/member/MobileAppDownload.tsx`

Based on the work from `feature/MobileAppLinkOnDashboard` branch, cleaned up:

- Fetches tenant info from `GET /api/me/member/tenant` via `react-query`
- Only renders if at least one store URL is configured
- Hidden on mobile devices (the modal handles mobile users)
- Shows QR codes for each configured platform (iOS and/or Android)
- Direct "App Store" / "Google Play" buttons below each QR code
- Uses `qrcode.react` for QR code generation

**Integration point:** `frontend/src/pages/member/dashboard.tsx`

Render `<MobileAppDownload />` on the member dashboard, after the existing content sections.

### Dependency

Install `qrcode.react` package:
```
npm install qrcode.react
```

## Data Flow

```
Tenant Admin configures appStoreUrl/playStoreUrl
  → Saved to oe.Tenants.AdvancedSettings ($.features.mobileApp.*)
  → Member visits /member/* route
  → MemberLayout renders MobileAppRedirectModal
  → Component calls GET /api/me/member/tenant
  → Backend returns AppStoreUrl, PlayStoreUrl from AdvancedSettings
  → If mobile + URLs exist + not dismissed → show modal
  → If desktop + URLs exist → show QR card on dashboard
```

## Files Changed

| File | Change |
|------|--------|
| `backend/routes/me/member/tenant.js` | Add AppStoreUrl, PlayStoreUrl to SQL query |
| `frontend/src/services/member/member-tenant.service.ts` | Add fields to MemberTenantInfo interface |
| `frontend/src/components/member/MobileAppRedirectModal.tsx` | New — mobile redirect modal |
| `frontend/src/components/member/MemberLayout.tsx` | Render MobileAppRedirectModal |
| `frontend/src/components/member/MobileAppDownload.tsx` | New — desktop QR code card |
| `frontend/src/pages/member/dashboard.tsx` | Render MobileAppDownload |
| `frontend/package.json` | Add qrcode.react dependency |

## Decisions

- **No deep linking.** Store URLs only. Deep linking requires native app configuration (Expo linking, universal links, app links) which is out of scope.
- **No public API.** The old PR created a `/api/public/settings/mobile-app` endpoint, but we don't need it — the member portal is behind auth, so the existing authenticated member tenant endpoint is sufficient.
- **Session-based dismissal.** The modal reappears each browser session. Persistent dismissal (localStorage) was rejected because the goal is to strongly encourage app usage.
- **User-agent detection over feature detection.** UA sniffing is imperfect but sufficient for this use case. The existing enrollment wizard uses the same approach.
- **Production JSON paths.** The old PR used `$.mobileApp.iosAppUrl` / `$.mobileApp.androidAppUrl`. Production uses `$.features.mobileApp.appStoreUrl` / `$.features.mobileApp.playStoreUrl`. We use the production paths.
