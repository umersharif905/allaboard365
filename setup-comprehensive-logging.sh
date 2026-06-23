#!/bin/bash

# Comprehensive Logging Setup for OpenEnroll Testing
# This script sets up logging for both frontend and backend

echo "🔧 Setting up comprehensive logging for OpenEnroll testing..."

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Create logs directory
mkdir -p logs/frontend
mkdir -p logs/backend
mkdir -p logs/cypress

# Create backend logging script
cat > logs/backend/start-backend-with-logging.sh << EOF
#!/bin/bash
REPO_ROOT="$REPO_ROOT"
cd "\$REPO_ROOT/backend" || exit 1
echo "🚀 Starting backend with comprehensive logging..."
echo "Backend started at \$(date)" >> "\$REPO_ROOT/logs/backend/backend.log"
node app.js 2>&1 | tee -a "\$REPO_ROOT/logs/backend/backend.log"
EOF

# Create frontend logging script
cat > logs/frontend/start-frontend-with-logging.sh << EOF
#!/bin/bash
REPO_ROOT="$REPO_ROOT"
cd "\$REPO_ROOT/frontend" || exit 1
echo "🚀 Starting frontend with comprehensive logging..."
echo "Frontend started at \$(date)" >> "\$REPO_ROOT/logs/frontend/frontend.log"
npm run dev 2>&1 | tee -a "\$REPO_ROOT/logs/frontend/frontend.log"
EOF

# Create enhanced Cypress test runner
cat > logs/cypress/enhanced-test-runner-with-logs.sh << 'EOF'
#!/bin/bash
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1
echo "🧪 Starting enhanced test runner with comprehensive logging..."
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
LOG_DIR="$REPO_ROOT/logs/cypress/test-run-$TIMESTAMP"
mkdir -p "$LOG_DIR"
echo "📁 Log directory: $LOG_DIR"
cd "$REPO_ROOT/frontend" || exit 1
npx cypress run \
  --spec "cypress/e2e/tenant-admin-user-management.cy.ts" \
  --browser chrome \
  --headless \
  --config video=true,screenshotOnRunFailure=true \
  --reporter json \
  --reporter-options "output=$LOG_DIR/cypress-results.json" \
  2>&1 | tee "$LOG_DIR/cypress-output.log"
if [ -d "cypress/screenshots" ]; then cp -r cypress/screenshots "$LOG_DIR/"; fi
if [ -d "cypress/videos" ]; then cp -r cypress/videos "$LOG_DIR/"; fi
echo "📊 Test run completed. Logs saved in: $LOG_DIR"
EOF

# Make scripts executable
chmod +x logs/backend/start-backend-with-logging.sh
chmod +x logs/frontend/start-frontend-with-logging.sh
chmod +x logs/cypress/enhanced-test-runner-with-logs.sh

# Wrapper kept for old habits — delegates to run-tests.sh
cat > run-comprehensive-test.sh << 'EOF'
#!/usr/bin/env bash
R="$(cd "$(dirname "$0")" && pwd)"
exec "$R/run-tests.sh" comprehensive
EOF

chmod +x run-comprehensive-test.sh

echo "✅ Comprehensive logging setup complete!"
echo ""
echo "📋 Main command (DB guard from backend/.env):"
echo "  ./run-tests.sh comprehensive   — same as ./run-comprehensive-test.sh (optional alias)"
echo ""
echo "  ./run-comprehensive-test.sh  - Alias: execs ./run-tests.sh comprehensive"
echo "  ./logs/backend/start-backend-with-logging.sh  - Start backend with logging"
echo "  ./logs/frontend/start-frontend-with-logging.sh  - Start frontend with logging"
echo "  ./logs/cypress/enhanced-test-runner-with-logs.sh  - Run tests with logging"
echo ""
echo "📁 Logs will be saved in:"
echo "  logs/backend/backend.log  - Backend logs"
echo "  logs/frontend/frontend.log  - Frontend logs"
echo "  logs/cypress/test-run-*/  - Test run logs with screenshots and videos"
