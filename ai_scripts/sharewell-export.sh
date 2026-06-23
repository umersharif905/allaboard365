#!/bin/bash
# Export ShareWELL eligibility CSVs to ~/Downloads/sharewell-YYYY-MM-DD/
# Usage: ./ai_scripts/sharewell-export.sh [--slug=align_health] [--as-of-date=2026-05-01]
# Align / Align SHA: active billable households only (matches invoice). Other slugs: full account dump.
#
# Uses SHAREWELL_DB_* from ai_scripts/.env (same as db-query-sharewell.sh)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"

strip_outer_quotes() {
  local v="$1"
  if [ "${#v}" -ge 2 ] && [ "${v#\'}" != "$v" ] && [ "${v%\'}" != "$v" ]; then
    v="${v#\'}"; v="${v%\'}"
  elif [ "${#v}" -ge 2 ] && [ "${v#\"}" != "$v" ] && [ "${v%\"}" != "$v" ]; then
    v="${v#\"}"; v="${v%\"}"
  fi
  printf '%s' "$v"
}

if [ -f "$SCRIPT_DIR/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      SHAREWELL_DB_SERVER=*|SHAREWELL_DB_DATABASE=*|SHAREWELL_DB_NAME=*|SHAREWELL_DB_USER=*|SHAREWELL_DB_PASSWORD=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    key="${key//[[:space:]]/}"
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="$(strip_outer_quotes "$val")"
    export "$key=$val"
  done < "$SCRIPT_DIR/.env"
fi

if [ -z "${SHAREWELL_DB_PASSWORD:-}" ] || [ -z "${SHAREWELL_DB_SERVER:-}" ] || [ -z "${SHAREWELL_DB_USER:-}" ]; then
  echo "❌ Missing SHAREWELL_DB_SERVER, SHAREWELL_DB_USER, or SHAREWELL_DB_PASSWORD in ai_scripts/.env" >&2
  exit 1
fi

cd "$BACKEND_DIR" && node "$SCRIPT_DIR/sharewell-export.cjs" "$@"
