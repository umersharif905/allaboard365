# Frontend Deployment Configuration - Ready ✅

## 📁 Files Created in `frontend/dist`

### ✅ `package.json`
**Purpose**: Azure Oryx detects Node.js platform and installs dependencies

```json
{
  "name": "open-enroll-frontend",
  "version": "1.0.0",
  "description": "Open-Enroll Frontend React App",
  "main": "server.js",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "start": "node server.js",
    "prod:serve": "node server.js"
  },
  "engines": {
    "node": "22.x"
  },
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

**Key Points**:
- ✅ `scripts.start` = `node server.js` (Azure auto-runs this)
- ✅ `engines.node` = `22.x` (matches Azure App Service Node version)
- ✅ Only includes `express` dependency (minimal for production)

### ✅ `server.js`
**Purpose**: Serves static React build files via Express

```javascript
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static(__dirname));

// SPA fallback: serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`🚀 Frontend server running on port ${port}`);
});
```

**Key Points**:
- ✅ Serves all static files from current directory
- ✅ SPA routing via catch-all `*` route
- ✅ Uses `process.env.PORT` for Azure compatibility

### ✅ `.deployment`
**Purpose**: Azure deployment configuration

```
[config]
# Deployment configuration for Azure App Service Frontend
# Build during deployment - npm install will run
SCM_DO_BUILD_DURING_DEPLOYMENT = true

# Use .deployignore file to exclude files
SCM_USE_DEPLOYIGNORE = true
```

**Key Points**:
- ✅ `SCM_DO_BUILD_DURING_DEPLOYMENT = true` enables npm install
- ✅ Oryx will install Express before starting server

### ✅ `web.config`
**Purpose**: IIS configuration (Windows Azure App Service only)

**Note**: Currently configured for static site. Will be updated if Windows deployment needed.

---

## 🚀 Deployment Flow

### 1. Vite Build
**Command**: `npm run build`
**Output**: Static React app in `frontend/dist/`

### 2. Azure Oryx Detection
**Process**:
- Oryx scans deployed files
- Finds `package.json` → Detects Node.js platform
- Reads `.deployment` → Sees `SCM_DO_BUILD_DURING_DEPLOYMENT = true`
- Runs `npm install` to install Express

### 3. Azure App Service Start
**Command**: `npm start` (runs `node server.js`)
**Result**: Express server serves the React app

---

## ✅ Verification Checklist

- [x] `frontend/dist/package.json` exists with correct scripts
- [x] `frontend/dist/server.js` exists with Express server
- [x] `frontend/dist/.deployment` exists with build enabled
- [x] `frontend/.deployment` matches `dist/.deployment`
- [x] VS Code settings point to `frontend\dist`
- [x] `vite.config.production.ts` copies deployment files
- [x] Node.js 22.x specified in package.json

---

## 🧪 Local Testing

### Test Express Server Locally
```bash
cd frontend/dist
npm install
node server.js
# Visit http://localhost:3000
```

### Test Full Build + Deploy
```bash
cd frontend
npm run build          # Build React app
cd dist
npm install            # Install Express
node server.js         # Start server
# Visit http://localhost:3000
```

---

## 📋 Deployment Steps

### 1. Build Frontend
```bash
cd frontend
npm run build
```

### 2. Verify dist Contents
```bash
ls frontend/dist/
# Should see: package.json, server.js, .deployment, index.html, assets/
```

### 3. Deploy via VS Code
- Right-click **Frontend App Service** in Azure Explorer
- Select **"Deploy to Web App..."**
- Confirm deployment

### 4. Monitor Logs
**Azure Portal** → **Log stream**

Look for:
```
🚀 Frontend server running on port 3000
```

---

## 🎯 Expected Behavior

1. **Azure Deployment**: Deploys `frontend/dist` folder
2. **Oryx Detection**: Finds `package.json` → Detects Node.js
3. **npm install**: Installs `express`
4. **Start Script**: Runs `node server.js`
5. **Express Serves**: Static React app accessible at production URL

---

**Ready to deploy!** ✅

