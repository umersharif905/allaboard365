#!/usr/bin/env bash
# Non-blocking warnings after file writes (mirrors .claude/settings.json)
set -euo pipefail

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

FILE=$(echo "$input" | jq -r '
  .tool_input.path //
  .tool_input.file_path //
  .file_path //
  .path //
  empty
')

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  exit 0
fi

WARNINGS=()

case "$FILE" in
  */backend/routes/me/member/*.js)
    if ! grep -q "attachMemberHouseholdContext" "$FILE" 2>/dev/null; then
      BASENAME=$(basename "$FILE")
      WARNINGS+=("WARNING: Member route $BASENAME should use attachMemberHouseholdContext (not requireTenantAccess).")
    fi
    ;;
  */backend/routes/*.js)
    BASENAME=$(basename "$FILE")
    case "$BASENAME" in
      auth.js|enroll-now.js|password-setup.js|local-auth.js|agent-lookup.js|diagnostics.js|health.js)
        ;;
      *)
        if ! grep -q "requireTenantAccess" "$FILE" 2>/dev/null; then
          WARNINGS+=("WARNING: Route file $BASENAME does not use requireTenantAccess. All tenant-scoped admin routes MUST include this middleware.")
        fi
        ;;
    esac
    ;;
  *.tsx)
    if grep -qE "(bg|text|border|ring)-blue-(500|600|700|800)" "$FILE" 2>/dev/null; then
      WARNINGS+=("WARNING: Raw Tailwind blue colors detected in $FILE. Use oe-primary/oe-dark/oe-light brand colors instead.")
    fi
    ;;
esac

if [ "${#WARNINGS[@]}" -eq 0 ]; then
  exit 0
fi

MSG=$(printf '%s\n' "${WARNINGS[@]}" | jq -Rs .)
echo "{\"additional_context\":$MSG}"
exit 0
