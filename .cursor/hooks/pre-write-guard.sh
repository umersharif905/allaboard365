#!/usr/bin/env bash
# Blocks forbidden UI imports and SQL writes without @DryRun (mirrors .claude/settings.json)
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

CONTENT=$(echo "$input" | jq -r '
  (.tool_input.contents // .tool_input.content // .tool_input.new_string // "") | tostring
')

if [ -z "$FILE" ] && [ -z "$CONTENT" ]; then
  exit 0
fi

deny() {
  local msg="$1"
  echo "{\"permission\":\"deny\",\"user_message\":\"$msg\",\"agent_message\":\"$msg\"}"
  exit 2
}

# If only path is set, read file from disk for StrReplace-style edits
if [ -n "$FILE" ] && [ -z "$CONTENT" ] && [ -f "$FILE" ]; then
  CONTENT=$(cat "$FILE" 2>/dev/null || true)
fi

check_text() {
  local text="$1"
  case "$FILE" in
    *.ts|*.tsx)
      if echo "$text" | grep -qE "from ['\"]@mui/|from ['\"]@material-ui/|from ['\"]@emotion/|from ['\"]styled-components"; then
        deny "BLOCKED: Forbidden UI library import. Tailwind CSS ONLY — no Material-UI, no CSS-in-JS, no styled-components."
      fi
      if echo "$text" | grep -qE "from ['\"](react-icons|@fortawesome|@ant-design/icons|@heroicons)"; then
        deny "BLOCKED: Non-Lucide icon library. Use lucide-react ONLY."
      fi
      ;;
    *.sql)
      if echo "$text" | grep -qiE "^[^-]*\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b"; then
        if ! echo "$text" | grep -qi "DryRun"; then
          deny "BLOCKED: SQL file contains write operations but no @DryRun flag. All database write scripts MUST include a @DryRun parameter defaulting to 1."
        fi
      fi
      ;;
  esac
}

if [ -n "$CONTENT" ]; then
  check_text "$CONTENT"
fi

echo '{"permission":"allow"}'
exit 0
