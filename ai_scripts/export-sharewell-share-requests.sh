#!/bin/bash
# Export Sharewell sharing requests + related tables to CSV bundle (and ZIP when zip CLI available).
# Usage: ./ai_scripts/export-sharewell-share-requests.sh [--partner-id UUID] [--account-id UUID] [--out DIR]
#
# Prereq: ai_scripts/.env with SHAREWELL_DB_* ; firewall whitelist via sharewell-whitelist-my-ip.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in
      SHAREWELL_DB_SERVER=*|SHAREWELL_DB_DATABASE=*|SHAREWELL_DB_USER=*|SHAREWELL_DB_PASSWORD=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"; key="${key//[[:space:]]/}"
    val="${line#*=}"; val="$(strip_outer_quotes "$val")"
    case "$key" in
      SHAREWELL_DB_SERVER) export SHAREWELL_DB_SERVER="$val" ;;
      SHAREWELL_DB_DATABASE) export SHAREWELL_DB_DATABASE="$val" ;;
      SHAREWELL_DB_USER) export SHAREWELL_DB_USER="$val" ;;
      SHAREWELL_DB_PASSWORD) export SHAREWELL_DB_PASSWORD="$val" ;;
    esac
  done < "$SCRIPT_DIR/.env"
fi

if [ -z "${SHAREWELL_DB_PASSWORD:-}" ] || [ -z "${SHAREWELL_DB_SERVER:-}" ] || [ -z "${SHAREWELL_DB_USER:-}" ]; then
  echo "Missing SHAREWELL_DB_* in ai_scripts/.env" >&2
  exit 1
fi

chmod +x "$SCRIPT_DIR/export-sharewell-share-requests.cjs" 2>/dev/null || true
cd "$BACKEND_DIR" && node "$SCRIPT_DIR/export-sharewell-share-requests.cjs" "$@"
