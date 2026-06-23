#!/usr/bin/env bash
# Hermetic enrollment tests: backend Jest + frontend Vitest (no browser, no DB for Jest).
# Cypress enrollment E2E is separate — needs Vite :5173 and often backend; see
#   npm run test:e2e:enrollment --prefix frontend
# Full reference: docs/enrollments/testing.md#quickstart-reference
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
echo "== Backend Jest (enrollment suite) =="
npm run test:enrollment:backend
echo "== Frontend Vitest (enrollment units) =="
npm run test:enrollment:unit
echo "== OK (Jest + Vitest). For Cypress: start backend + npm run dev in frontend, then: =="
echo "     npm run test:enrollment:e2e"
echo "     (or: cd frontend && npm run test:e2e:enrollment)"
