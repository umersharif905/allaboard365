#!/usr/bin/env bash
# generateDeveloperSecrets.sh
# Creates ~/Downloads/AASecrets_MDDYY (e.g. AASecrets_41426) with ai_scripts/.env, backend/.env, frontend/.env
# copied from this project (comments stripped). Backend DB target is configurable (testing vs prod).
# ai_scripts/.env export is always AI-safe: oe_ai_readonly (+ passwords), testing RW user for db-query default,
# no SQL admin keys — prod queries require ./db-query.sh "...sql..." --prod-readonly.
# Also copies messageCenter/local.settings.json (Azure Functions) as-is into that folder's messageCenter/.
#
# Run interactively (no arguments). For documentation only: --help

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPORT_AI_SCRIPTS_ENV="$PROJECT_ROOT/ai_scripts/.env"
# Today as MDDYY with no leading zero on month (e.g. 41426 = Apr 14, 2026)
M="$(date +%m)"; M=$((10#$M))
D="$(date +%d)"; D=$((10#$D))
Y="$(date +%y)"
DATE_SUFFIX="${M}${D}${Y}"
DEST_BASE="$HOME/Downloads/AASecrets_${DATE_SUFFIX}"

if [[ "${1:-}" == '-h' || "${1:-}" == '--help' ]]; then
  cat <<'EOF'
generateDeveloperSecrets.sh

Runs interactively: validates repo ai_scripts/.env, asks backend DB target, then writes:

  ~/Downloads/AASecrets_MDDYY/   (e.g. AASecrets_41426 — month/day/year, no leading zero on month)
    ai_scripts/.env   — always: oe_ai_readonly + DB_USER_TESTING_RW; DB_NAME=allaboard-testing;
                        AZURE_SQL_ADMIN_* / DB_ADMIN_* never included (safe for AI + db-query.sh).
    backend/.env      — testing: allaboard-testing + oe_testing_migrate;
                        production: keeps allaboard-prod + repo credentials (admin mirror keys stripped).
    frontend/.env     — comment-stripped; allaboard-prod → allaboard-testing in values.
    messageCenter/local.settings.json  (if present)

db-query.sh usage with exported ai_scripts/.env:
  ./db-query.sh "SELECT 1"              → allaboard-testing + DB_USER_TESTING_RW (read/write on test)
  ./db-query.sh "SELECT 1" --testing   → same
  ./db-query.sh "SELECT 1" --prod-readonly → allaboard-prod + oe_ai_readonly (read-only)

Non-interactive backend target:
  GENERATE_SECRETS_BACKEND_TARGET=testing   or   prod

Legacy alias:
  GENERATE_SECRETS_DB_MODE=2 → testing backend (same as GENERATE_SECRETS_BACKEND_TARGET=testing)
  GENERATE_SECRETS_DB_MODE=1 → prod backend
EOF
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "This script is interactive — run it with no arguments." >&2
  echo "Help: $0 --help" >&2
  exit 1
fi

BACKEND_USE_PROD=0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AASecrets export → $DEST_BASE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Checking repo ai_scripts/.env (required: oe_ai_readonly + DB_USER_TESTING_RW)..."
AI_SCRIPTS_ENV_FILE="$EXPORT_AI_SCRIPTS_ENV" node "$SCRIPT_DIR/apply-testing-db-only-env.cjs" --check-source-only
echo ""

echo "Exported backend/.env — which database should the API use?"
echo ""
echo "  1) Testing (recommended)"
echo "     allaboard-testing + oe_testing_migrate from ai_scripts/.env — same narrow access as most devs."
echo ""
echo "  2) Production"
echo "     Keeps allaboard-prod + DB credentials from your repo backend/.env (high risk locally)."
echo ""
echo "Exported ai_scripts/.env is always testing-oriented + read-only prod via db-query --prod-readonly"
echo "(never includes SQL admin passwords)."
echo ""

backend_choice=""
if [[ -t 0 ]]; then
  read -r -p "Choose 1 (testing) or 2 (production) [1]: " backend_choice
elif [[ -n "${GENERATE_SECRETS_BACKEND_TARGET:-}" ]]; then
  case "$(echo "${GENERATE_SECRETS_BACKEND_TARGET}" | tr '[:upper:]' '[:lower:]')" in
    prod|production|p|2) backend_choice=2 ;;
    testing|test|t|*) backend_choice=1 ;;
  esac
  echo "(non-interactive) GENERATE_SECRETS_BACKEND_TARGET=${GENERATE_SECRETS_BACKEND_TARGET:-testing}"
elif [[ -n "${GENERATE_SECRETS_DB_MODE:-}" ]]; then
  # Legacy: 2 = testing migrate (same as today); 1 = production backend (old "standard" mixed behavior removed — use prod explicitly).
  case "$(echo "${GENERATE_SECRETS_DB_MODE}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    2|2*|testing|test|t) backend_choice=1 ;;
    *) backend_choice=2 ;;
  esac
  echo "(non-interactive) Legacy GENERATE_SECRETS_DB_MODE=${GENERATE_SECRETS_DB_MODE} → backend_choice=${backend_choice}"
else
  read -r backend_choice || true
  backend_choice="${backend_choice:-1}"
  echo "(non-interactive) Using choice from stdin or default: $backend_choice"
fi

case "$(echo "${backend_choice:-1}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  '' | 1 | 1* | testing | test | t)
    BACKEND_USE_PROD=0
    echo ""
    echo "→ Backend export: testing database + oe_testing_migrate."
    ;;
  2 | 2* | prod | production | p)
    BACKEND_USE_PROD=1
    echo ""
    echo "→ Backend export: production database (credentials from repo backend/.env)."
    ;;
  *)
    echo "Invalid choice. Enter 1 or 2." >&2
    exit 1
    ;;
esac

mkdir -p "$DEST_BASE/ai_scripts"
mkdir -p "$DEST_BASE/backend"
mkdir -p "$DEST_BASE/frontend"
mkdir -p "$DEST_BASE/messageCenter"

# Strip full-line comments; optional inline # trim; drop empty lines.
# Optional: map allaboard-prod -> allaboard-testing (testing-oriented exports).
process_env_substitute_prod() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "Warning: source not found, skipping: $src"
    return
  fi
  grep -v '^[[:space:]]*\(#\|$\)' "$src" | \
  sed 's/allaboard-prod/allaboard-testing/g' | \
  sed 's/\([[:space:]]\)#.*$/\1/' | \
  sed 's/[[:space:]]*$//' | \
  sed '/^[[:space:]]*$/d' \
  > "$dest"
  echo "Created: $dest"
}

process_env_keep_prod_names() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "Warning: source not found, skipping: $src"
    return
  fi
  grep -v '^[[:space:]]*\(#\|$\)' "$src" | \
  sed 's/\([[:space:]]\)#.*$/\1/' | \
  sed 's/[[:space:]]*$//' | \
  sed '/^[[:space:]]*$/d' \
  > "$dest"
  echo "Created (prod names preserved): $dest"
}

process_env_substitute_prod "$PROJECT_ROOT/ai_scripts/.env"    "$DEST_BASE/ai_scripts/.env"

if [[ "$BACKEND_USE_PROD" -eq 1 ]]; then
  process_env_keep_prod_names "$PROJECT_ROOT/backend/.env" "$DEST_BASE/backend/.env"
else
  process_env_substitute_prod "$PROJECT_ROOT/backend/.env" "$DEST_BASE/backend/.env"
fi

process_env_substitute_prod "$PROJECT_ROOT/frontend/.env"      "$DEST_BASE/frontend/.env"

AI_SCRIPTS_ENV_FILE="$EXPORT_AI_SCRIPTS_ENV" node "$SCRIPT_DIR/apply-testing-db-only-env.cjs" --ai-scripts-export "$DEST_BASE/ai_scripts/.env"

if [[ "$BACKEND_USE_PROD" -eq 1 ]]; then
  AI_SCRIPTS_ENV_FILE="$EXPORT_AI_SCRIPTS_ENV" node "$SCRIPT_DIR/apply-testing-db-only-env.cjs" --backend-prod-strip-admin "$DEST_BASE/backend/.env"
else
  AI_SCRIPTS_ENV_FILE="$EXPORT_AI_SCRIPTS_ENV" node "$SCRIPT_DIR/apply-testing-db-only-env.cjs" --backend-testing "$DEST_BASE/backend/.env"
fi

MC_LS="$PROJECT_ROOT/messageCenter/local.settings.json"
if [[ -f "$MC_LS" ]]; then
  cp "$MC_LS" "$DEST_BASE/messageCenter/local.settings.json"
  echo "Created: $DEST_BASE/messageCenter/local.settings.json"
else
  echo "Warning: source not found, skipping: $MC_LS"
fi

echo ""
echo "Done. Secrets written to $DEST_BASE"
