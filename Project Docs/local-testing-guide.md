# Local Testing Guide

This guide explains how to test production builds locally.

## Quick Start (One Command)

Run this single command from the project root:

```bash
./local-production-test.sh
```

This will:
1. Build the frontend
2. Start the backend in local production testing mode
3. Serve the frontend production build

Then open http://localhost:3000 in your browser.

## Manual Steps (If Needed)

If you prefer to run things separately:

### Step 1: Build the Frontend

```bash
cd frontend
npm run build
```

### Step 2: Run the Backend in Local Testing Mode

```bash
cd backend
npm run prod:local
```

### Step 3: Serve the Frontend

```bash
cd frontend
npm run prod:serve
```

## How It Works

The system automatically detects local testing:

1. **Backend**: When run with `local-testing.js`, it enables all CORS origins while still in production mode
2. **Frontend**: Automatically detects when running on localhost and uses local backend URLs

No manual code changes are needed!

## Production Deployment

For actual production deployment:

1. Build the frontend: `cd frontend && npm run build`
2. Deploy the contents of the `frontend/dist` folder to your production server
3. Run the backend with `NODE_ENV=production` (without the LOCAL_TESTING flag) 