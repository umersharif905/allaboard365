#!/bin/bash
# Static checks on changed backend files — run before marking factory work "done".
# Usage: ./ai_scripts/factory-verify-changed.sh
# Exit 0 = all checks pass; exit 1 = at least one failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

warn() { echo "⚠️  $*"; }
fail() { echo "❌ $*"; FAIL=1; }
pass() { echo "✅ $*"; }

# Changed backend JS (staged + unstaged vs HEAD) — portable (macOS bash 3.2 has no mapfile)
FILES=()
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done < <(git diff --name-only HEAD -- backend/ 2>/dev/null | grep -E '\.js$' || true)
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done < <(git ls-files --others --exclude-standard backend/ 2>/dev/null | grep -E '\.js$' || true)

if [ "${#FILES[@]}" -eq 0 ]; then
  pass "No changed backend .js files — skipping backend static checks"
  exit 0
fi

echo "🔍 Factory verify — ${#FILES[@]} backend file(s)"

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # 1. sql.Transaction / sql.Request with database sql import (not mssql)
  if grep -qE 'sql\.(Transaction|Request)\(' "$f" 2>/dev/null; then
    if grep -qE "sql\s*\}\s*=\s*require\([^)]*database" "$f" 2>/dev/null; then
      if ! grep -qE "require\(['\"]mssql['\"]\)|rawSql" "$f" 2>/dev/null; then
        fail "$f: uses sql.Transaction/Request but imports sql from config/database (use require('mssql'))"
      fi
    fi
  fi

  # 2. Agencies.Name (prod column is AgencyName)
  if grep -qE 'FROM oe\.Agencies' "$f" 2>/dev/null; then
    if grep -qE 'SELECT[^;]*\bName\b[^;]*FROM oe\.Agencies|FROM oe\.Agencies[^;]*\bName\b' "$f" 2>/dev/null; then
      if ! grep -q 'AgencyName' "$f" 2>/dev/null; then
        fail "$f: possible Agencies.Name — prod uses AgencyName"
      fi
    fi
  fi

  # 3. Enrollments.TenantId without tableHasColumn / member join hint
  if grep -qE 'e\.TenantId|Enrollments\.TenantId' "$f" 2>/dev/null; then
    if ! grep -qE 'tableHasColumn.*Enrollments|m\.TenantId|enrollmentsHasTenantId|enrollmentsTenantFilter' "$f" 2>/dev/null; then
      fail "$f: references Enrollments.TenantId — prod may lack column; use Members.TenantId or tableHasColumn"
    fi
  fi

  # 4. tableHasColumn treating any row as true (documented anti-pattern)
  if grep -qE 'recordset.*\.length > 0' "$f" 2>/dev/null && grep -q 'tableHasColumn' "$f" 2>/dev/null; then
    if ! grep -qE 'ok === 1|Hit === 1' "$f" 2>/dev/null; then
      warn "$f: tableHasColumn may treat empty vs ok wrong — prefer ok === 1 check"
    fi
  fi
done

# 5. Route files with preview + execute — warn if tests never mention execute
for f in "${FILES[@]}"; do
  [[ "$f" == backend/routes/* ]] || continue
  if grep -qE '/preview|preview' "$f" 2>/dev/null && grep -qE '/execute|/commit|/publish' "$f" 2>/dev/null; then
    slug=$(basename "$f" .js | tr '-' '_')
    test_hits=$(find backend -path '*/__tests__/*.test.js' -print0 2>/dev/null | xargs -0 grep -lE 'execute|commit|publish' 2>/dev/null | grep -iE "${slug}|$(basename "$(dirname "$f")")" || true)
    if [ -z "$test_hits" ]; then
      warn "$f: multi-step routes (preview + execute/commit) — no related test file mentions execute/commit/publish"
    fi
  fi
done

# 6. New service with SQL but no __tests__ sibling (soft warning)
for f in "${FILES[@]}"; do
  [[ "$f" == backend/services/* ]] || continue
  [[ "$f" == *".test.js" ]] && continue
  base=$(basename "$f" .js)
  test_dir="backend/services/__tests__"
  if [ -f "$f" ] && grep -qE '\.query\(|EXEC ' "$f" 2>/dev/null; then
    if ! ls "$test_dir/${base}"*.test.js "$test_dir/"*"${base}"*.test.js 2>/dev/null | grep -q .; then
      warn "$f: SQL service has no obvious test in $test_dir/"
    fi
  fi
done

if [ "$FAIL" -eq 0 ]; then
  pass "All factory static checks passed"
  exit 0
fi

echo ""
echo "Fix failures above or document exceptions in the verification report."
exit 1
