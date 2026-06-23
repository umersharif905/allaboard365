# Mobile App Redirect & Desktop Download Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redirect mobile users visiting the member portal to download the native app via a full-screen modal, and show desktop users QR codes to scan for app download.

**Architecture:** Extend the existing `GET /api/me/member/tenant` backend endpoint to return app store URLs from tenant settings. Add a self-contained `MobileAppRedirectModal` component rendered in `MemberLayout` (covers all `/member/*` routes). Add a `MobileAppDownload` card component rendered on the member dashboard for desktop users. Both features are gated on whether the tenant has configured app store URLs.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, React Query, qrcode.react (already installed), Express/MSSQL backend

**Spec:** `docs/superpowers/specs/2026-04-08-mobile-app-redirect-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/routes/me/member/tenant.js` | Modify (lines 40-44) | Add AppStoreUrl, PlayStoreUrl to SQL query |
| `frontend/src/services/member/member-tenant.service.ts` | Modify | Add AppStoreUrl, PlayStoreUrl to MemberTenantInfo interface |
| `frontend/src/components/member/MobileAppRedirectModal.tsx` | Create | Full-screen modal for mobile users |
| `frontend/src/components/member/MemberLayout.tsx` | Modify (line 77-97) | Render MobileAppRedirectModal |
| `frontend/src/components/member/MobileAppDownload.tsx` | Create | Desktop QR code download card |
| `frontend/src/pages/member/dashboard.tsx` | Modify (line 502-503) | Render MobileAppDownload |

---

### Task 1: Extend Backend Tenant API to Return App Store URLs

**Files:**
- Modify: `backend/routes/me/member/tenant.js:40-44`

- [ ] **Step 1: Add app store URL fields to the SQL query**

In `backend/routes/me/member/tenant.js`, replace the SELECT block (lines 40-44):

```javascript
// OLD (lines 40-44):
          t.TenantId,
          t.Name,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') AS LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f8dbf') AS PrimaryColor

// NEW:
          t.TenantId,
          t.Name,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') AS LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f8dbf') AS PrimaryColor,
          ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.appStoreUrl'), '') AS AppStoreUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.playStoreUrl'), '') AS PlayStoreUrl
```

- [ ] **Step 2: Verify the backend starts without errors**

Run: `cd backend && node -e "require('./routes/me/member/tenant.js'); console.log('OK')"`
Expected: `OK` (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add backend/routes/me/member/tenant.js
git commit -m "feat: return app store URLs from member tenant API"
```

---

### Task 2: Update Frontend Tenant Service Interface

**Files:**
- Modify: `frontend/src/services/member/member-tenant.service.ts`

- [ ] **Step 1: Add AppStoreUrl and PlayStoreUrl to MemberTenantInfo**

In `frontend/src/services/member/member-tenant.service.ts`, replace the `MemberTenantInfo` interface (lines 4-12):

```typescript
// OLD:
export interface MemberTenantInfo {
  TenantId: string;
  Name?: string;
  LogoUrl?: string;
  PrimaryColor?: string;
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
}

// NEW:
export interface MemberTenantInfo {
  TenantId: string;
  Name?: string;
  LogoUrl?: string;
  PrimaryColor?: string;
  AppStoreUrl?: string;
  PlayStoreUrl?: string;
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No new errors related to MemberTenantInfo

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/member/member-tenant.service.ts
git commit -m "feat: add AppStoreUrl and PlayStoreUrl to MemberTenantInfo interface"
```

---

### Task 3: Create Mobile App Redirect Modal Component

**Files:**
- Create: `frontend/src/components/member/MobileAppRedirectModal.tsx`

- [ ] **Step 1: Create the MobileAppRedirectModal component**

Create `frontend/src/components/member/MobileAppRedirectModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Smartphone, X } from 'lucide-react';
import { MemberTenantService } from '../../services/member/member-tenant.service';

const SESSION_STORAGE_KEY = 'dismissedMobileAppRedirect';

// Platform detection
function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid || /Mobi/.test(ua);
  return { isIOS, isAndroid, isMobile };
}

// Play Store icon (Lucide doesn't have one)
const PlayStoreIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className || 'h-5 w-5'}>
    <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z" />
  </svg>
);

export default function MobileAppRedirectModal() {
  const [visible, setVisible] = useState(false);
  const [appStoreUrl, setAppStoreUrl] = useState('');
  const [playStoreUrl, setPlayStoreUrl] = useState('');
  const [platform, setPlatform] = useState<{ isIOS: boolean; isAndroid: boolean; isMobile: boolean }>({
    isIOS: false,
    isAndroid: false,
    isMobile: false,
  });

  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);

    // Not mobile — don't show
    if (!detected.isMobile) return;

    // Already dismissed this session
    if (sessionStorage.getItem(SESSION_STORAGE_KEY)) return;

    // Fetch tenant app URLs
    MemberTenantService.getTenant().then((response) => {
      if (!response?.success || !response.data) return;
      const ios = response.data.AppStoreUrl || '';
      const android = response.data.PlayStoreUrl || '';
      // No URLs configured — don't show
      if (!ios && !android) return;
      setAppStoreUrl(ios);
      setPlayStoreUrl(android);
      setVisible(true);
    }).catch(() => {
      // Silently fail — don't block the portal
    });
  }, []);

  const dismiss = () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
    setVisible(false);
  };

  if (!visible) return null;

  // Determine primary and secondary CTAs based on platform
  const showIOSPrimary = appStoreUrl && (platform.isIOS || !platform.isAndroid);
  const showAndroidPrimary = playStoreUrl && (platform.isAndroid || !platform.isIOS);

  const primaryUrl = showIOSPrimary ? appStoreUrl : playStoreUrl;
  const primaryLabel = showIOSPrimary ? 'Download on the App Store' : 'Get it on Google Play';
  const primaryIcon = showIOSPrimary
    ? <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 mr-2"><path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 21.99 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 21.99C7.79 22.03 6.8 20.68 5.96 19.47C4.25 16.97 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5M13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z"/></svg>
    : <PlayStoreIcon className="h-5 w-5 mr-2" />;

  // Secondary link (the other platform)
  let secondaryUrl = '';
  let secondaryLabel = '';
  if (showIOSPrimary && playStoreUrl) {
    secondaryUrl = playStoreUrl;
    secondaryLabel = 'Also available on Google Play';
  } else if (showAndroidPrimary && appStoreUrl) {
    secondaryUrl = appStoreUrl;
    secondaryLabel = 'Also available on the App Store';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-8 text-center relative">
        {/* Phone icon */}
        <div className="mx-auto mb-4 bg-blue-100 rounded-full p-4 w-16 h-16 flex items-center justify-center">
          <Smartphone size={28} className="text-blue-600" />
        </div>

        {/* Heading */}
        <h2 className="text-xl font-bold text-gray-900 mb-2">
          The member portal works best in the app
        </h2>
        <p className="text-sm text-gray-500 mb-6">
          Download for the full mobile experience
        </p>

        {/* Primary CTA */}
        <a
          href={primaryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center w-full px-6 py-3 bg-gray-900 text-white rounded-xl font-semibold text-sm hover:bg-gray-800 transition-colors"
        >
          {primaryIcon}
          {primaryLabel}
        </a>

        {/* Secondary platform link */}
        {secondaryUrl && (
          <a
            href={secondaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {secondaryLabel}
          </a>
        )}

        {/* Continue to site — de-emphasized */}
        <button
          onClick={dismiss}
          className="mt-6 text-xs text-gray-300 hover:text-gray-500 transition-colors"
        >
          Continue to site anyway
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to MobileAppRedirectModal

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/member/MobileAppRedirectModal.tsx
git commit -m "feat: add MobileAppRedirectModal component for mobile users"
```

---

### Task 4: Integrate Mobile Redirect Modal into MemberLayout

**Files:**
- Modify: `frontend/src/components/member/MemberLayout.tsx:1-2,77-97`

- [ ] **Step 1: Import and render MobileAppRedirectModal in MemberLayout**

In `frontend/src/components/member/MemberLayout.tsx`, add the import at line 2 (after the React import):

```typescript
// Add after line 2 (after the Outlet import):
import MobileAppRedirectModal from './MobileAppRedirectModal';
```

Then inside the return JSX, add the modal as the first child of the outermost div. Replace line 78:

```tsx
// OLD (line 78):
    <div className="min-h-screen bg-oe-neutral-light flex">

// NEW:
    <div className="min-h-screen bg-oe-neutral-light flex">
      <MobileAppRedirectModal />
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/member/MemberLayout.tsx
git commit -m "feat: render MobileAppRedirectModal in MemberLayout"
```

---

### Task 5: Create Desktop QR Code Download Card

**Files:**
- Create: `frontend/src/components/member/MobileAppDownload.tsx`

- [ ] **Step 1: Create the MobileAppDownload component**

Create `frontend/src/components/member/MobileAppDownload.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { Apple, ChevronRight, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { MemberTenantService } from '../../services/member/member-tenant.service';

// Play Store icon (Lucide doesn't have one)
const PlayStoreIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className || 'h-5 w-5'}>
    <path d="M3,20.5V3.5C3,2.91 3.34,2.39 3.84,2.15L13.69,12L3.84,21.85C3.34,21.6 3,21.09 3,20.5M16.81,15.12L6.05,21.34L14.54,12.85L16.81,15.12M20.16,10.81C20.5,11.08 20.75,11.5 20.75,12C20.75,12.5 20.53,12.9 20.18,13.18L17.89,14.5L15.39,12L17.89,9.5L20.16,10.81M6.05,2.66L16.81,8.88L14.54,11.15L6.05,2.66Z" />
  </svg>
);

// Simple mobile detection to hide QR codes on phones (modal handles mobile)
function isMobileDevice() {
  return /iPad|iPhone|iPod|Android|Mobi/.test(navigator.userAgent);
}

export default function MobileAppDownload() {
  const { data: tenantInfo, isLoading } = useQuery({
    queryKey: ['memberTenantInfo'],
    queryFn: async () => {
      const response = await MemberTenantService.getTenant();
      if (!response?.success || !response.data) {
        throw new Error('Failed to fetch tenant info');
      }
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    retry: 2,
  });

  const appStoreUrl = tenantInfo?.AppStoreUrl || '';
  const playStoreUrl = tenantInfo?.PlayStoreUrl || '';

  // Don't render if: loading, no URLs configured, or on mobile (modal handles mobile)
  if (isLoading || (!appStoreUrl && !playStoreUrl) || isMobileDevice()) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-white">
        <div className="flex items-center">
          <div className="bg-blue-100 rounded-full p-2 mr-3">
            <Smartphone size={20} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-gray-900">Get the Mobile App</h2>
            <p className="text-sm text-gray-500">Access your benefits on the go</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <p className="text-gray-600 mb-6">
          Download our mobile app to manage your benefits, view ID cards, and submit sharing requests anytime, anywhere.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* iOS App */}
          {appStoreUrl && (
            <div className="border border-gray-200 rounded-lg p-6 hover:border-blue-300 transition-colors duration-200">
              <div className="flex items-center mb-4">
                <div className="bg-gray-900 rounded-xl p-2 mr-3">
                  <Apple size={24} className="text-white" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">iOS App</h3>
                  <p className="text-sm text-gray-500">Download on the App Store</p>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm mb-4">
                  <QRCodeSVG value={appStoreUrl} size={140} level="M" includeMargin={false} />
                </div>
                <p className="text-xs text-gray-500 text-center mb-3">Scan with your iPhone camera</p>
                <a
                  href={appStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors text-sm font-medium"
                >
                  <Apple size={16} className="mr-2" />
                  App Store
                  <ChevronRight size={14} className="ml-1" />
                </a>
              </div>
            </div>
          )}

          {/* Android App */}
          {playStoreUrl && (
            <div className="border border-gray-200 rounded-lg p-6 hover:border-green-300 transition-colors duration-200">
              <div className="flex items-center mb-4">
                <div className="bg-green-600 rounded-xl p-2 mr-3 text-white">
                  <PlayStoreIcon className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Android App</h3>
                  <p className="text-sm text-gray-500">Get it on Google Play</p>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-lg border border-gray-100 shadow-sm mb-4">
                  <QRCodeSVG value={playStoreUrl} size={140} level="M" includeMargin={false} />
                </div>
                <p className="text-xs text-gray-500 text-center mb-3">Scan with your Android camera</p>
                <a
                  href={playStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
                >
                  <PlayStoreIcon className="h-4 w-4 mr-2" />
                  Google Play
                  <ChevronRight size={14} className="ml-1" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/member/MobileAppDownload.tsx
git commit -m "feat: add MobileAppDownload QR code card for desktop users"
```

---

### Task 6: Integrate Desktop Download Card into Member Dashboard

**Files:**
- Modify: `frontend/src/pages/member/dashboard.tsx:1,502-503`

- [ ] **Step 1: Import MobileAppDownload and render it on the dashboard**

In `frontend/src/pages/member/dashboard.tsx`, add the import after line 23 (after the `useNavigate` import):

```typescript
// Add after line 23:
import MobileAppDownload from '../../components/member/MobileAppDownload';
```

Then add the component just before the commented-out "Active Benefits" section. Insert after line 502 (after the closing of the Monthly Contribution card `)}` block):

```tsx
      {/* Mobile App Download Section (desktop only — hidden on mobile) */}
      <MobileAppDownload />
```

This goes between the Monthly Contribution `)}` closing (line 502) and the `{/* Active Benefits/Enrollments - Commented out for now */}` comment (line 504).

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Verify the dev server starts and renders**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: Build succeeds without errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/member/dashboard.tsx
git commit -m "feat: add MobileAppDownload card to member dashboard"
```

---

### Task 7: Manual Testing Checklist

This task is for verifying the full feature in the browser. No code changes.

- [ ] **Step 1: Test mobile redirect modal**

Open Chrome DevTools → Toggle device toolbar (Ctrl+Shift+M) → Select iPhone or Android device. Navigate to `/member/dashboard`.

Verify:
- Full-screen modal appears with dimmed background
- Correct platform button is shown (iOS for iPhone, Android for Pixel)
- "Also available on [other]" link appears if both URLs are configured
- "Continue to site anyway" is visible but de-emphasized
- Clicking "Continue to site anyway" dismisses the modal
- Refreshing the page does NOT show the modal again (session storage)
- Opening a new tab / incognito DOES show the modal again

- [ ] **Step 2: Test desktop QR code card**

Open the member dashboard in a regular desktop browser (no device emulation).

Verify:
- QR code card appears at the bottom of the dashboard
- QR codes render correctly for configured platforms
- "App Store" and "Google Play" buttons link to correct URLs
- Card does NOT appear if tenant has no app URLs configured

- [ ] **Step 3: Test with no app URLs configured**

Use a tenant that has no `appStoreUrl` / `playStoreUrl` in their settings.

Verify:
- Mobile: No modal appears
- Desktop: No QR card appears
- Portal works normally

- [ ] **Step 4: Commit all (if any fixups were needed)**

```bash
git add -A
git commit -m "fix: address testing feedback for mobile app redirect"
```
