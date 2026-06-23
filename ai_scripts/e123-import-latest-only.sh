#!/bin/bash
# Archive all E123 MemberFile_*.pgp except the newest, then run E123 import locally.
# Local run avoids the 10-minute Azure Function timeout that stalled imports since 2026-05-22.
#
# Usage: ./ai_scripts/e123-import-latest-only.sh [--skip-archive] [--skip-import]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROCESSOR_DIR="$REPO_ROOT/sharewell-csv-processor"
TMP_DIR="${TMPDIR:-/tmp}/e123-import-$$"
SKIP_ARCHIVE=false
SKIP_IMPORT=false

for arg in "$@"; do
  case "$arg" in
    --skip-archive) SKIP_ARCHIVE=true ;;
    --skip-import) SKIP_IMPORT=true ;;
  esac
done

mkdir -p "$TMP_DIR"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

az account set -s ShareWELL-PROD >/dev/null

fetch_setting() {
  az functionapp config appsettings list \
    --name sharewell-csv-processor2 \
    --resource-group ShareWELLPartners \
    --query "[?name=='$1'].value | [0]" -o tsv
}

export SFTP_HOST="$(fetch_setting SFTP_HOST)"
export SFTP_PORT="$(fetch_setting SFTP_PORT)"
export SFTP_USERNAME="$(fetch_setting SFTP_USERNAME)"
export SFTP_PASSWORD="$(fetch_setting SFTP_PASSWORD)"
export SQL_SERVER="$(fetch_setting SQL_SERVER)"
export SQL_DATABASE="$(fetch_setting SQL_DATABASE)"
export SQL_USERNAME="$(fetch_setting SQL_USERNAME)"
export SQL_PASSWORD="$(fetch_setting SQL_PASSWORD)"

if [[ -z "$SFTP_PASSWORD" || -z "$SQL_PASSWORD" ]]; then
  echo "❌ Could not load SFTP/SQL credentials from sharewell-csv-processor2" >&2
  exit 1
fi

echo "📌 SFTP: $SFTP_HOST / user $SFTP_USERNAME"
echo "📌 SQL:  $SQL_SERVER / $SQL_DATABASE"

VENV="$PROCESSOR_DIR/.venv-e123-import"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$PROCESSOR_DIR/requirements.txt" requests
fi
PY="$VENV/bin/python"

if [[ "$SKIP_ARCHIVE" != true ]]; then
  echo ""
  echo "🗂️  Archiving older E123 member files (keeping newest in /E123/)..."

  SFTP_PASSWORD="$SFTP_PASSWORD" "$PY" - <<'PY'
import os, re, paramiko

host = os.environ["SFTP_HOST"]
user = os.environ["SFTP_USERNAME"]
pwd = os.environ["SFTP_PASSWORD"]
port = int(os.environ.get("SFTP_PORT", "22"))

pat = re.compile(r"^MemberFile_(\d{8})\.csv\.pgp$", re.I)
transport = paramiko.Transport((host, port))
transport.connect(username=user, password=pwd)
sftp = paramiko.SFTPClient.from_transport(transport)

try:
    sftp.stat("/E123/archive")
except FileNotFoundError:
    sftp.mkdir("/E123/archive")

files = [f for f in sftp.listdir("/E123") if pat.match(f)]
if not files:
    raise SystemExit("❌ No MemberFile_*.csv.pgp in /E123")

files.sort(key=lambda f: pat.match(f).group(1))
latest = files[-1]
to_archive = files[:-1]
print(f"Latest: {latest} ({len(files)} total in /E123)")
print(f"Archiving {len(to_archive)} older file(s)...")

for name in to_archive:
    src = f"/E123/{name}"
    dst = f"/E123/archive/{name}"
    try:
        sftp.stat(dst)
        print(f"  skip (already archived): {name}")
        sftp.remove(src)
    except FileNotFoundError:
        sftp.rename(src, dst)
        print(f"  archived: {name}")

remaining = [f for f in sftp.listdir("/E123") if pat.match(f)]
print(f"Remaining in /E123: {remaining}")
if len(remaining) != 1 or remaining[0] != latest:
    raise SystemExit(f"❌ Expected only {latest} in /E123, got {remaining}")

sftp.close()
transport.close()
PY
fi

if [[ "$SKIP_IMPORT" == true ]]; then
  echo "⏭  --skip-import set; done."
  exit 0
fi

echo ""
echo "🐍 Running E123 member import locally (no Azure timeout)..."

export PYTHONPATH="$PROCESSOR_DIR"
cd "$PROCESSOR_DIR"

"$PY" - <<'PY'
import os, re, sys, logging
from datetime import datetime
import paramiko
from shared_code.e123_member_processor_robust import E123MemberProcessorRobust
from shared_code.event_logger import EventLogger

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

host = os.environ["SFTP_HOST"]
user = os.environ["SFTP_USERNAME"]
pwd = os.environ["SFTP_PASSWORD"]
port = int(os.environ.get("SFTP_PORT", "22"))
pat = re.compile(r"^MemberFile_(\d{8})\.csv\.pgp$", re.I)

transport = paramiko.Transport((host, port))
transport.connect(username=user, password=pwd)
sftp = paramiko.SFTPClient.from_transport(transport)
files = sorted(
    [f for f in sftp.listdir("/E123") if pat.match(f)],
    key=lambda f: pat.match(f).group(1),
)
if not files:
    print("❌ No member PGP files in /E123", file=sys.stderr)
    sys.exit(1)
filename = files[-1]
print(f"Processing {filename}...")
pgp = sftp.open(f"/E123/{filename}", "rb").read()
sftp.close()
transport.close()

processor = E123MemberProcessorRobust()
decrypted = processor.decrypt_pgp_file(pgp, filename)
print(f"Decrypted {len(decrypted):,} bytes")

event_logger = EventLogger()
batch_id = event_logger.start_batch(process_name="E123_Member_Import", source_file=filename)
event_logger.source_file = filename

start = datetime.now()
try:
    stats = processor.process_member_file(decrypted, filename)
    event_logger.end_batch(success=True, summary=stats)
except Exception as e:
    event_logger.end_batch(success=False, summary={"error": str(e)})
    raise

duration = (datetime.now() - start).total_seconds()
print("\n✅ Import complete in %.1fs" % duration)
for k in (
    "total_records", "valid_records", "members_inserted", "members_updated",
    "sb_accounts_created", "sb_members_added", "sb_products_added",
    "lb_accounts_created", "lb_members_added", "products_inserted",
):
    print(f"  {k}: {stats.get(k, 0)}")
errors = stats.get("errors") or []
if errors:
    print(f"  errors: {len(errors)} (non-fatal skips)")
PY

echo ""
echo "📦 Archiving processed file on SFTP..."
SFTP_PASSWORD="$SFTP_PASSWORD" "$PY" - <<'PY'
import os, re, paramiko
host = os.environ["SFTP_HOST"]
user = os.environ["SFTP_USERNAME"]
pwd = os.environ["SFTP_PASSWORD"]
port = int(os.environ.get("SFTP_PORT", "22"))
pat = re.compile(r"^MemberFile_(\d{8})\.csv\.pgp$", re.I)
transport = paramiko.Transport((host, port))
transport.connect(username=user, password=pwd)
sftp = paramiko.SFTPClient.from_transport(transport)
files = sorted([f for f in sftp.listdir("/E123") if pat.match(f)], key=lambda f: pat.match(f).group(1))
for name in files:
    src = f"/E123/{name}"
    dst = f"/E123/archive/{name}"
    try:
        sftp.stat(dst)
        sftp.remove(src)
    except FileNotFoundError:
        sftp.rename(src, dst)
    print(f"  archived: {name}")
sftp.close()
transport.close()
PY

echo ""
echo "🔍 Spot-check SW2440013 (Cordova-Gomez)..."
DB_QUERY=""
for candidate in "$SCRIPT_DIR/db-query-sharewell.sh" "$REPO_ROOT/../MightyWellMobile/ai_scripts/db-query-sharewell.sh"; do
  if [[ -x "$candidate" ]]; then DB_QUERY="$candidate"; break; fi
done
if [[ -n "$DB_QUERY" ]]; then
  "$DB_QUERY" \
    "SELECT m.member_id, m.first_name, m.last_name, m.status, u.username, u.active FROM dbo.members m LEFT JOIN dbo.users u ON u.member_id = m.member_id WHERE m.member_id = 'SW2440013' AND m.relationship = 'P'"
else
  echo "(db-query-sharewell.sh not found — verify manually)"
fi

echo ""
echo "✅ Done."
