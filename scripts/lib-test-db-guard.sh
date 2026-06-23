# shellcheck shell=bash
# Assert backend/.env has an allowed test DB (default: allaboard-testing).
# Source with ROOT=repo root, then: oe_test_db_assert || exit 1
# Override: OEO_ALLOW_NON_TEST_DB=1 (emergency). OEO_TEST_DB_NAMES=db1,db2 (comma list).

oe_test_db_assert() {
  if [[ "${OEO_ALLOW_NON_TEST_DB:-0}" == "1" ]]; then
    echo "Warning: OEO_ALLOW_NON_TEST_DB=1 — skipping DB_NAME safety check" >&2
    return 0
  fi

  if [[ -z "${ROOT:-}" ]]; then
    echo "oe_test_db_assert: internal error, ROOT is not set" >&2
    return 1
  fi

  local envf="$ROOT/backend/.env"
  if [[ ! -f "$envf" ]]; then
    echo "run-tests.sh: Refusing: backend/.env not found (cannot read DB_NAME)." >&2
    return 1
  fi

  local line
  line=$(grep -E '^[[:space:]]*DB_NAME=' "$envf" 2>/dev/null | tail -1 || true)
  if [[ -z "$line" ]]; then
    echo "run-tests.sh: Refusing: no active DB_NAME= in $envf" >&2
    return 1
  fi

  local db_name
  db_name=${line#*=}
  if [[ "$db_name" == \"*\" ]]; then
    db_name=${db_name#\"}
    db_name=${db_name%\"}
  elif [[ "$db_name" == \'*\' ]]; then
    db_name=${db_name#\'}
    db_name=${db_name%\'}
  fi
  db_name=${db_name%%#*}
  db_name=$(printf '%s' "$db_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ -z "$db_name" ]]; then
    echo "run-tests.sh: Refusing: empty DB_NAME in $envf" >&2
    return 1
  fi

  # Hard deny: allaboard-prod (any substring, case-insensitive) can never be allowlisted
  local dbl
  dbl=$(printf '%s' "$db_name" | tr '[:upper:]' '[:lower:]')
  if [[ "$dbl" == *"allaboard-prod"* ]]; then
    echo "run-tests.sh: Refusing: DB_NAME='$db_name' is allaboard-prod (not for test runs)." >&2
    echo "  Use DB_NAME=allaboard-testing in backend/.env, or (emergency) OEO_ALLOW_NON_TEST_DB=1" >&2
    return 1
  fi

  local allow="${OEO_TEST_DB_NAMES:-allaboard-testing}"
  local a ok=0
  IFS=',' read -r -a parts <<< "$allow"
  for a in "${parts[@]}"; do
    a="${a//[[:space:]]/}"
    if [[ -n "$a" && "$db_name" == "$a" ]]; then
      ok=1
      break
    fi
  done
  if (( ok )); then
    echo "run-tests.sh: DB_NAME=$db_name (allowed test database)"
    return 0
  fi

  echo "run-tests.sh: Refusing: DB_NAME='$db_name' is not in the allowed test list: $allow" >&2
  echo "  Fix: set DB_NAME=allaboard-testing in backend/.env" >&2
  echo "  Or: OEO_TEST_DB_NAMES=your-dev-db,other-test-db" >&2
  echo "  Emergency: OEO_ALLOW_NON_TEST_DB=1" >&2
  return 1
}
