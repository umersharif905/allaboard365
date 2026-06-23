#!/usr/bin/env bash
#
# Interactive bacpac export → optional Azure delete → import → provision DB users → post-import sanitize
# (test Dime settings on all tenants, clear Member SSNs, unify User password hashes).
#
# Prerequisites: sqlpackage, az (for delete), ai_scripts/.env with DB_SERVER, etc.
# sqlpackage auth: prefers Microsoft Entra ID token from `az login` (no SQL password in .env);
#   falls back to AZURE_SQL_ADMIN_* or DB_PASSWORD when DB_USER is not oe_ai_readonly.
# node (uses repo root + backend node_modules for scripts).
#
# This script never modifies the production database (allaboard-prod). Export is read-only on the source.
# Delete / import / sanitize apply only to the target DB name you enter (e.g. allaboard-testing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

die() { echo "Error: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

# Production DB name — never delete or sanitize via this tooling (exact match, case-insensitive).
is_allaboard_production_db() {
  local name
  name=$(echo "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  case "$name" in
    allaboard-prod) return 0 ;;
    *) return 1 ;;
  esac
}

echo ""
echo "=== OpenEnroll: bacpac migration + sanitize ==="
echo "Repo: $REPO_ROOT"
echo ""

require_cmd node
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ ! -f "$ENV_FILE" ]]; then
  die "Create ai_scripts/.env (see ai_scripts README) with DB_SERVER, DB_USER, DB_PASSWORD."
fi
# shellcheck disable=SC2046
eval "$(node "$REPO_ROOT/ai_scripts/print-dotenv-exports.cjs")"

echo "Safety: Export does NOT change the source DB. This script never runs DDL/DML on production."
echo "        Only the target you name (e.g. allaboard-testing) can be deleted/imported/sanitized."
echo ""
echo "Choose workflow:"
echo "  1) Full: Export (read-only copy from source) → replace TEST target only → sanitize test"
echo "  2) Export only — .bacpac file only; does not modify any Azure database"
echo "  3) Replace TEST DB only — import from .bacpac (no export)"
echo "  4) Sanitize TEST DB only (non-prod; uses ai_scripts/.env DB_* against --database)"
echo "  5) Refresh mightywell-testing-snapshot.json from allaboard-testing (Dime template + password hash)"
echo ""
read -r -p "Choice [1-5] (default 1): " WORKFLOW
WORKFLOW=${WORKFLOW:-1}

[[ "$WORKFLOW" =~ ^[1-5]$ ]] || die "Invalid choice"

DEFAULT_SERVER="allboard-prod.database.windows.net"
DEFAULT_USER="allaboardadmin"
DEFAULT_RG="AllAboard365"
DEFAULT_AZ_SERVER="allboard-prod"
DEFAULT_BACPAC="$REPO_ROOT/db_files/allaboard-export.bacpac"

prompt_default() {
  local msg="$1"
  local def="$2"
  local var
  read -r -p "$msg [$def]: " var
  echo "${var:-$def}"
}

if [[ "$WORKFLOW" == "5" ]]; then
  echo ""
  echo "Refreshing snapshot from allaboard-testing (same credentials as db-query.sh --testing)..."
  node "$SCRIPT_DIR/snapshot-mightywell-testing.cjs"
  echo "Done."
  exit 0
fi

if [[ "$WORKFLOW" == "4" ]]; then
  read -r -p "Target database name (e.g. allaboard-testing): " SAN_DB
  [[ -n "${SAN_DB:-}" ]] || die "Database name required"
  if is_allaboard_production_db "$SAN_DB"; then
    die "Refusing to sanitize production database allaboard-prod (use a non-prod database name)."
  fi
  echo ""
  node "$SCRIPT_DIR/post-bacpac-sanitize.cjs" --database "$SAN_DB"
  exit 0
fi

require_cmd sqlpackage
if [[ "$WORKFLOW" == "1" || "$WORKFLOW" == "3" ]]; then
  require_cmd az
fi

echo ""
echo "--- SQL connection (sqlpackage) ---"
SQL_SERVER="${DB_SERVER:-$DEFAULT_SERVER}"
SQL_USER="${AZURE_SQL_ADMIN_USER:-$DEFAULT_USER}"
SQL_PASS=""
if [[ -n "${AZURE_SQL_ADMIN_PASSWORD:-}" ]]; then
  SQL_PASS="$AZURE_SQL_ADMIN_PASSWORD"
elif [[ "${DB_USER:-}" != "oe_ai_readonly" && -n "${DB_PASSWORD:-}" ]]; then
  SQL_PASS="$DB_PASSWORD"
fi

SQL_AAD_TOKEN=""
# Entra token is opt-in: your az user must be Microsoft Entra admin on the SQL server or sqlpackage fails with "<token-identified principal>".
# Set AZURE_SQL_ADMIN_USE_AZ_TOKEN=1 to try token first, then fall back to SQL login below.
if [[ "${AZURE_SQL_ADMIN_USE_AZ_TOKEN:-0}" != "0" ]] && command -v az >/dev/null 2>&1; then
  if az account show >/dev/null 2>&1; then
    SQL_AAD_TOKEN=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv 2>/dev/null) || true
  fi
fi

if [[ -n "$SQL_AAD_TOKEN" ]]; then
  echo "  sqlpackage: try Entra token first, then SQL login $SQL_USER if token fails"
else
  echo "  sqlpackage: SQL login (default). Set AZURE_SQL_ADMIN_USE_AZ_TOKEN=1 to try az login token first."
fi
echo "  Server: $SQL_SERVER"

ensure_sqlpackage_sql_password() {
  if [[ -z "$SQL_PASS" ]]; then
    echo ""
    echo "SQL password needed for sqlpackage (AZURE_SQL_ADMIN_PASSWORD or DB_USER/DB_PASSWORD with a non-read-only admin)."
    echo "Single-quote in .env if password contains \$."
    read -r -s -p "Or paste SQL admin password now (not saved; this run only): " SQL_PASS
    echo ""
    [[ -n "$SQL_PASS" ]] || die "Password required."
  fi
  if [[ "${SQL_USER:-}" == "oe_ai_readonly" ]]; then
    die "sqlpackage cannot use oe_ai_readonly. Set AZURE_SQL_ADMIN_USER=allaboardadmin or put full-access creds in DB_*."
  fi
}

mkdir -p "$REPO_ROOT/db_files"
BACPAC_PATH="$(prompt_default "Path to .bacpac file" "$DEFAULT_BACPAC")"

if [[ "$WORKFLOW" == "1" || "$WORKFLOW" == "2" ]]; then
  echo ""
  echo "=== Step 1 — Export (read-only; does not modify the source database) ==="
  echo "sqlpackage /Action:Export reads from the server and writes a .bacpac file to disk."
  echo "It does not DROP/UPDATE/DELETE anything on the source — including when the source is allaboard-prod."
  echo "Later steps only touch the separate TARGET database you will name (e.g. allaboard-testing), never prod."
  echo ""
  SRC_DB="$(prompt_default "Source database name to export (read-only; default is prod copy for backup)" "allaboard-prod")"
  echo ""
  read -r -p "Press Enter to run Export..."
  echo ""
  echo "Running sqlpackage Export..."
  EXPORT_USED_TOKEN=false
  if [[ -n "$SQL_AAD_TOKEN" ]]; then
    if sqlpackage /Action:Export \
      "/SourceServerName:$SQL_SERVER" \
      "/SourceDatabaseName:$SRC_DB" \
      "/AccessToken:$SQL_AAD_TOKEN" \
      "/TargetFile:$BACPAC_PATH"; then
      EXPORT_USED_TOKEN=true
    else
      echo ""
      echo "Entra token was rejected (common: your az user is not Microsoft Entra admin on this SQL server)."
      echo "Falling back to SQL authentication..."
      SQL_AAD_TOKEN=""
    fi
  fi
  if [[ "$EXPORT_USED_TOKEN" != true ]]; then
    ensure_sqlpackage_sql_password
    sqlpackage /Action:Export \
      "/SourceServerName:$SQL_SERVER" \
      "/SourceDatabaseName:$SRC_DB" \
      "/SourceUser:$SQL_USER" \
      "/SourcePassword:$SQL_PASS" \
      "/TargetFile:$BACPAC_PATH"
  fi
  echo "Export finished: $BACPAC_PATH"
fi

if [[ "$WORKFLOW" == "1" ]]; then
  echo ""
  echo "=== Backup file written (source DB unchanged) ==="
  echo "  $BACPAC_PATH"
  echo "The source database [$SRC_DB] was not modified. Nothing in this script alters prod."
  echo "Next: you will name a NON-PRODUCTION target only (e.g. allaboard-testing) for delete + import + sanitize."
  read -r -p "Press Enter to continue to target selection (test DB only)..."
fi

if [[ "$WORKFLOW" == "2" ]]; then
  echo ""
  echo "Export-only complete. Import later with option 3, then option 4 for sanitize if needed."
  exit 0
fi

if [[ "$WORKFLOW" == "3" ]]; then
  [[ -f "$BACPAC_PATH" ]] || die "Bacpac not found: $BACPAC_PATH"
  echo ""
  echo "=== No export in this run ==="
  echo "Ensure [$BACPAC_PATH] is the backup you intend to restore (e.g. from a recent prod export)."
  read -r -p "Press Enter when ready to pick target DB and delete/import..."
fi

echo ""
echo "=== Target for import (must NOT be production) ==="
echo "sqlpackage Import creates a new database from the bacpac. If the name already exists, it must be removed first."
TGT_DB="$(prompt_default "Target database name (e.g. allaboard-testing)" "allaboard-testing")"
if is_allaboard_production_db "$TGT_DB"; then
  die "Refusing to delete production database [allaboard-prod]. This script cannot drop prod. Use a non-prod name (e.g. allaboard-testing)."
fi
AZ_RG="$(prompt_default "Azure resource group (for az sql db show/delete)" "$DEFAULT_RG")"
AZ_SRV="$(prompt_default "Azure SQL server short name (az --server)" "$DEFAULT_AZ_SERVER")"
echo ""
echo "DESTRUCTIVE if the target DB exists: we may DELETE that Azure SQL database:"
echo "  Name:   $TGT_DB"
echo "  Server: $AZ_SRV  (resource group: $AZ_RG)"
echo "This will NOT delete [$TGT_DB] if the name were allaboard-prod — that is blocked."
read -r -p "Type YES if this is the intended NON-PRODUCTION target: " CONF
[[ "$CONF" == "YES" ]] || die "Aborted."
echo ""
echo "Second confirmation: type the exact target database name again to proceed:"
read -r CONFIRM_NAME
[[ "$CONFIRM_NAME" == "$TGT_DB" ]] || die "Name mismatch — aborted."
echo ""
if az sql db show --resource-group "$AZ_RG" --server "$AZ_SRV" --name "$TGT_DB" &>/dev/null; then
  echo "Database [$TGT_DB] already exists on this server."
  read -r -p "Delete it so sqlpackage can import? [y/N]: " DEL_EXIST
  DEL_LC=$(echo "${DEL_EXIST:-}" | tr '[:upper:]' '[:lower:]')
  if [[ "$DEL_LC" == "y" || "$DEL_LC" == "yes" ]]; then
    echo "Deleting existing database [$TGT_DB]..."
    az sql db delete \
      --resource-group "$AZ_RG" \
      --server "$AZ_SRV" \
      --name "$TGT_DB" \
      --yes
  else
    die "Aborted (existing database was not deleted; sqlpackage import would fail)."
  fi
else
  echo "Database [$TGT_DB] does not exist yet; sqlpackage will create it (no delete needed)."
fi
echo ""
read -r -p "Press Enter to run sqlpackage Import (creates/replaces [$TGT_DB] from bacpac)..."
echo "Running sqlpackage Import..."
# Refresh Entra token before import if export/delete took a while (tokens expire ~1h).
if [[ -n "$SQL_AAD_TOKEN" ]] && [[ "${AZURE_SQL_ADMIN_USE_AZ_TOKEN:-0}" != "0" ]] && command -v az >/dev/null 2>&1 && az account show >/dev/null 2>&1; then
  NEWTOK=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv 2>/dev/null) || true
  [[ -n "$NEWTOK" ]] && SQL_AAD_TOKEN="$NEWTOK"
fi
IMPORT_USED_TOKEN=false
if [[ -n "$SQL_AAD_TOKEN" ]]; then
  if sqlpackage /Action:Import \
    "/SourceFile:$BACPAC_PATH" \
    "/TargetServerName:$SQL_SERVER" \
    "/TargetDatabaseName:$TGT_DB" \
    "/AccessToken:$SQL_AAD_TOKEN"; then
    IMPORT_USED_TOKEN=true
  else
    echo ""
    echo "Entra token import failed; falling back to SQL login..."
    SQL_AAD_TOKEN=""
  fi
fi
if [[ "$IMPORT_USED_TOKEN" != true ]]; then
  ensure_sqlpackage_sql_password
  sqlpackage /Action:Import \
    "/SourceFile:$BACPAC_PATH" \
    "/TargetServerName:$SQL_SERVER" \
    "/TargetDatabaseName:$TGT_DB" \
    "/TargetUser:$SQL_USER" \
    "/TargetPassword:$SQL_PASS"
fi
echo "Import finished."

# sqlpackage admin may have been typed this session only — export for provision + sanitize child processes
export AZURE_SQL_ADMIN_USER="${AZURE_SQL_ADMIN_USER:-$SQL_USER}"
if [[ -n "${SQL_PASS:-}" ]]; then
  export AZURE_SQL_ADMIN_PASSWORD="${AZURE_SQL_ADMIN_PASSWORD:-$SQL_PASS}"
fi

echo ""
echo "=== Post-import: provision SQL users (optional) ==="
echo "Sanitize (next step) automatically ensures oe_testing_migrate on TESTING_RW_DATABASE"
echo "when AZURE_SQL_ADMIN_PASSWORD or a server-admin DB_USER is in ai_scripts/.env."
echo "Optional: run provision-db-users.cjs for oe_ai_readonly + to refresh the marked .env block."
echo "  --write-env updates DB_PASSWORD / DB_PASSWORD_TESTING_RW (readonly random + shared migrate password)."
echo "If import used only an Entra token, set AZURE_SQL_ADMIN_PASSWORD in ai_scripts/.env before sanitize/provision."
read -r -p "Run provision-db-users now? [Y/n]: " RUN_PROV
if [[ -z "${RUN_PROV:-}" ]]; then RUN_PROV=Y; fi
RUN_PROV_LC=$(echo "$RUN_PROV" | tr '[:upper:]' '[:lower:]')
if [[ "$RUN_PROV_LC" == "y" || "$RUN_PROV_LC" == "yes" ]]; then
  read -r -p "Append/update passwords in ai_scripts/.env (--write-env)? [Y/n]: " RUN_WE
  if [[ -z "${RUN_WE:-}" ]]; then RUN_WE=Y; fi
  WE_LC=$(echo "$RUN_WE" | tr '[:upper:]' '[:lower:]')
  PROV_ARGS=()
  if [[ "$WE_LC" == "y" || "$WE_LC" == "yes" ]]; then
    PROV_ARGS+=(--write-env)
  fi
  node "$SCRIPT_DIR/provision-db-users.cjs" "${PROV_ARGS[@]}"
else
  echo "Skipped. Run later:"
  echo "  $REPO_ROOT/ai_scripts/provision-db-users.sh"
  echo "  (requires AZURE_SQL_ADMIN_* in ai_scripts/.env)"
fi

echo ""
echo "Post-import sanitize (ensures oe_testing_migrate on test DB when admin creds exist;"
echo "  uses AZURE_SQL_ADMIN_* or DB_ADMIN_* or non-readonly DB_USER — see post-bacpac-sanitize.cjs;"
echo "  test DIME settings on all tenants, SSN clear, unified passwords)."
echo "  Credential order: AZURE_SQL_ADMIN_* → DB_ADMIN_* → DB_USER_TESTING_RW → DB_USER."
echo "Target DB for sanitize: [$TGT_DB]"
read -r -p "Run sanitize now? [Y/n]: " RUN_SAN
if [[ -z "${RUN_SAN:-}" ]]; then RUN_SAN=Y; fi
RUN_LC=$(echo "$RUN_SAN" | tr '[:upper:]' '[:lower:]')
if [[ "$RUN_LC" == "y" || "$RUN_LC" == "yes" ]]; then
  node "$SCRIPT_DIR/post-bacpac-sanitize.cjs" --database "$TGT_DB"
else
  echo "Skipped. Run later:"
  echo "  node $SCRIPT_DIR/post-bacpac-sanitize.cjs --database $TGT_DB"
fi

echo ""
echo "All done."
