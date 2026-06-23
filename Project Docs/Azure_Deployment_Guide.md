# Azure Deployment Guide

## Complete Deployment Steps for Open-Enroll

### Prerequisites
- Azure App Services configured:
  - Backend: `open-enroll-api`
  - Frontend: `open-enroll`
- VS Code with Azure Tools extension installed
- All environment variables configured in Azure Portal

---

## Frontend Deployment

### Step 1: Build the Frontend
```bash
cd frontend
npm run build
```

This will:
- Create optimized production build in `dist/`
- Copy `.deployment`, `web.config`, and `package.json` to `dist/`
- Output ready-to-deploy static files

### Step 2: Switch to Frontend Deployment Settings
```powershell
# In project root
Copy-Item .vscode\settings-frontend.json .vscode\settings.json -Force
```

Or run the VS Code task: **"Deploy Frontend"** (Terminal → Run Task)

### Step 3: Deploy to Azure
Use VS Code Azure Tools:
1. Right-click on the frontend App Service in Azure Explorer
2. Select "Deploy to Web App..."
3. Choose `frontend/dist` folder
4. Wait for deployment to complete

### What Gets Deployed
- `index.html` - Main entry point
- `assets/*` - JS bundles and CSS
- `images/*` - Branding assets
- `package.json` - Minimal Node.js config for Oryx
- `.deployment` - Azure deployment configuration
- `web.config` - IIS routing for SPA

---

## Backend Deployment

### Step 1: Switch to Backend Deployment Settings
```powershell
# In project root
Copy-Item .vscode\settings-backend.json .vscode\settings.json -Force
```

Or run the VS Code task: **"Deploy Backend"** (Terminal → Run Task)

### Step 2: Deploy to Azure
Use VS Code Azure Tools:
1. Right-click on the backend App Service in Azure Explorer
2. Select "Deploy to Web App..."
3. Choose `backend` folder
4. Wait for deployment to complete

### What Happens During Deployment
1. **Oryx Build System**:
   - Detects Node.js 22.x from `.nvmrc` and `.node-version`
   - Runs `npm install` to install dependencies
   - No build step needed (pure Node.js)

2. **Environment Variables**:
   - Loaded from Azure Portal configuration
   - Override any `.env` files
   - Process.env available to app

3. **Startup**:
   - Runs `node app.js` (from package.json)
   - Logs CORS configuration
   - Starts Express server

### Step 3: Restart App Service (If Needed)
After deployment, restart the App Service:
1. Azure Portal → App Service → Restart button
2. Monitor Log Stream for startup messages

---

## Verification

### Frontend
Visit: `https://open-enroll.com`
- Should see React app loading
- No "Azure placeholder" page
- All routes work via SPA routing

### Backend
Check logs for:
```
🚀 AllAboard365 Backend Server is now running.
   - Port: 3001
   - Environment: production
   - Database: Connected
   - Auth Bypass: Disabled
   - CORS Origins: ...
```

Health check: `https://api.open-enroll.com/health`

---

## Troubleshooting

### Frontend: "Azure placeholder page"
**Issue**: Oryx didn't find package.json in dist
**Fix**: 
1. Run `npm run build` to regenerate deployment files
2. Verify `frontend/dist/package.json` exists
3. Redeploy

### Backend: "Couldn't detect Node.js version"
**Issue**: Missing version files
**Fix**: Ensure `.nvmrc` and `.node-version` exist in backend folder

### Backend: CORS errors still occurring
**Issue**: Old code deployed or app not restarted
**Fix**:
1. Verify logs show CORS configuration at startup
2. If not, restart App Service
3. Check environment variables in Azure Portal

### Yarn/npm conflicts during deployment
**Issue**: Both lock files present
**Fix**: Remove `yarn.lock`, use only `package-lock.json`

---

## Key Files Reference

### Frontend Deployment Files
```
frontend/
├── .deployment          # Azure deployment config
├── .nvmrc               # Node version for Oryx
├── .node-version        # Node version for Oryx
├── web.config           # IIS configuration
├── package.json         # Dependencies
└── dist/                # Built static files
    ├── package.json     # Minimal config for Oryx
    ├── .deployment      # Deployment settings
    ├── web.config       # IIS routing
    ├── index.html       # SPA entry point
    ├── assets/          # JS bundles
    └── images/          # Branding assets
```

### Backend Deployment Files
```
backend/
├── .deployment          # Azure deployment config
├── .deployignore        # Files to exclude
├── .nvmrc               # Node version
├── .node-version        # Node version
├── web.config           # IIS configuration
├── package.json         # Dependencies
├── app.js               # Main application
└── config/
    ├── app.js           # Config from env vars
    └── database.js      # DB connection
```

---

## Environment Variables

### Required for Backend (Azure Portal)
- `NODE_ENV=production`
- `ALLOWED_ORIGINS=https://app.open-enroll.com,https://portal.open-enroll.com,https://oauth.open-enroll.com,https://open-enroll.com`
- `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `JWT_SECRET`, `JWT_REFRESH_SECRET`
- `AZURE_STORAGE_CONNECTION_STRING`
- `SENDGRID_API_KEY`
- `OPENAI_API_KEY`
- `OAUTH_BASE_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`
- `DIME_PROD_API_TOKEN`, `DIME_PROD_SID`, `DIME_PROD_API_BASE_URL`
- `BYPASS_AUTH=false` ⚠️ Critical

See full list in Azure Portal → App Service → Configuration → Application Settings

---

## Quick Commands

```bash
# Frontend
cd frontend && npm run build && cd ..

# Backend deployment settings
Copy-Item .vscode\settings-backend.json .vscode\settings.json -Force

# Frontend deployment settings  
Copy-Item .vscode\settings-frontend.json .vscode\settings.json -Force

# Switch based on what you're deploying
```

---

## Deployment Checklist

- [ ] Built frontend with `npm run build`
- [ ] Copied correct settings file (backend or frontend)
- [ ] Environment variables configured in Azure
- [ ] Deployed via VS Code Azure Tools
- [ ] Restarted App Service after deployment
- [ ] Verified startup logs in Log Stream
- [ ] Tested frontend URL loads correctly
- [ ] Tested backend API endpoints
- [ ] Checked CORS working from browser console

---

## Support

If deployment fails:
1. Check Azure Log Stream for detailed errors
2. Verify all configuration files exist
3. Check environment variables are set
4. Try restarting App Service
5. Review this guide for common issues

