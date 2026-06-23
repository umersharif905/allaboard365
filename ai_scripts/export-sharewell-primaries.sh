#!/bin/bash
# Export ShareWELL primary members (P only) to xlsx or CSV: partner_name, first_name, last_name, relationship, email
# Output: ai_scripts/output/ShareWELL_primary_members_YYYY-MM-DD.xlsx (default)
#   With --csv: ShareWELL_primary_members_YYYY-MM-DD.csv and ShareWELL_active_primary_sharewell_total_YYYY-MM-DD.csv
# Usage: ./ai_scripts/export-sharewell-primaries.sh [YYYY-MM-DD] [--csv]
#   No arg = report as of today. With date = report as of that date (e.g. 2026-01-14).

if [ -f "ai_scripts/.env" ]; then
  set -a
  . ai_scripts/.env
  set +a
fi

cd "$(dirname "$0")/.." && node ai_scripts/export-sharewell-primaries.cjs "$@"
