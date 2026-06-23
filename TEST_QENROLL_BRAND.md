# Testing QEnroll Brand

## Quick Test Instructions

### Option 1: Set Environment Variable (Recommended)

**PowerShell:**
```powershell
$env:VITE_BRAND="qenroll"
cd frontend
npm run dev
```

**Command Prompt:**
```cmd
set VITE_BRAND=qenroll
cd frontend
npm run dev
```

**Linux/Mac:**
```bash
export VITE_BRAND=qenroll
cd frontend
npm run dev
```

### Option 2: Create .env File

Create `frontend/.env` file:
```env
VITE_BRAND=qenroll
```

Then run:
```bash
cd frontend
npm run dev
```

## What to Check

1. **Browser Console:**
   - Look for: `[BrandingContext] Brand initialized: qenroll`
   - Look for: `[BrandingContext] Applied brand colors to CSS variables`

2. **Visual Changes:**
   - Logo should show "QEnroll" (purple gradient)
   - Primary buttons should be purple (#7c3aed)
   - Page title should be "QEnroll"
   - Favicon should update (may need hard refresh)

3. **Backend Config Endpoint:**
   ```bash
   # Start backend first, then test:
   curl http://localhost:3001/config.json
   ```
   Should return: `{ "BRAND": "qenroll", ... }`

4. **CSS Variables:**
   Open browser console and run:
   ```javascript
   getComputedStyle(document.documentElement).getPropertyValue('--oe-primary')
   ```
   Should return: `#7c3aed`

5. **Data Attribute:**
   ```javascript
   document.documentElement.getAttribute('data-brand')
   ```
   Should return: `qenroll`

## Testing Backend Config Endpoint

### Set Backend Environment Variable

**PowerShell:**
```powershell
$env:BRAND="qenroll"
cd backend
node app.js
```

**Command Prompt:**
```cmd
set BRAND=qenroll
cd backend
node app.js
```

Then test:
```bash
curl http://localhost:3001/config.json
```

Should return:
```json
{
  "BRAND": "qenroll",
  "API_URL": "...",
  "OAUTH_URL": "..."
}
```

## Switching Back to Open-Enroll

**PowerShell:**
```powershell
$env:VITE_BRAND="open-enroll"
# or remove the variable
Remove-Item Env:\VITE_BRAND
```

**Command Prompt:**
```cmd
set VITE_BRAND=open-enroll
# or
set VITE_BRAND=
```

## Expected QEnroll Brand Colors

- **Primary:** `#7c3aed` (Purple)
- **Primary Light:** `#ede9fe` (Light Purple)
- **Primary Dark:** `#5b21b6` (Dark Purple)
- **Secondary:** `#a855f7` (Lighter Purple)

## Troubleshooting

### Brand Not Loading
1. Check environment variable is set: `echo $env:VITE_BRAND`
2. Restart dev server after setting variable
3. Check browser console for errors

### Logos Not Showing
1. Check files exist in `frontend/public/images/branding/qenroll/`
2. Check browser Network tab for 404 errors
3. Hard refresh browser (Ctrl+Shift+R)

### Colors Not Applying
1. Check browser console for `[BrandingContext]` logs
2. Verify CSS variables: `getComputedStyle(document.documentElement).getPropertyValue('--oe-primary')`
3. Check data attribute: `document.documentElement.getAttribute('data-brand')`
