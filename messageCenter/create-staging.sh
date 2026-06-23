#!/usr/bin/env bash
# Create the staging Azure Function App for Message Center (test DB) and deploy.
# Run with an Azure identity that can create Function Apps and Storage (e.g. Owner/Contributor).
#
# Required env (or set before running):
#   RESOURCE_GROUP   - Azure resource group (e.g. AllAboard365)
#   LOCATION        - Region (e.g. eastus)
# Optional:
#   MC_STORAGE_NAME - Storage account for staging (must be globally unique, 3-24 lowercase alphanumeric)
#
# After create: copies app settings from prod (allaboard-messagecenter) and overrides DB_NAME=allaboard-testing.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Use AllAboard365 subscription (prod message center may be in another subscription)
az account set --subscription "AllAboard365" 2>/dev/null || true

RESOURCE_GROUP="${RESOURCE_GROUP:-AllAboard365}"
LOCATION="${LOCATION:-eastus}"
PROD_APP_NAME="allaboard-messagecenter"
FUNC_APP_NAME="allaboard-messagecenter-staging"
TEST_DB_NAME="${TEST_DB_NAME:-allaboard-testing}"
# Storage account name: globally unique, 3-24 chars, lowercase alphanumeric
MC_STORAGE_NAME="${MC_STORAGE_NAME:-allaboardmcstg}"

echo "Resource group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo "Function app:  $FUNC_APP_NAME"
echo "Storage:       $MC_STORAGE_NAME"
echo ""

# Create resource group if it doesn't exist
if ! az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  echo "Creating resource group $RESOURCE_GROUP..."
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
fi

# Create storage account for the staging function app (if not exists)
if ! az storage account show --name "$MC_STORAGE_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  echo "Creating storage account $MC_STORAGE_NAME..."
  az storage account create \
    --name "$MC_STORAGE_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS
else
  echo "Storage account $MC_STORAGE_NAME already exists."
fi

# Create the staging Function App (consumption plan, Node 18)
if ! az functionapp show --name "$FUNC_APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  echo "Creating Function App $FUNC_APP_NAME..."
  az functionapp create \
    --name "$FUNC_APP_NAME" \
    --storage-account "$MC_STORAGE_NAME" \
    --consumption-plan-location "$LOCATION" \
    --resource-group "$RESOURCE_GROUP" \
    --runtime node \
    --runtime-version 24 \
    --functions-version 4
  echo "Created."
else
  echo "Function App $FUNC_APP_NAME already exists."
fi

# Copy app settings from prod; override DB_NAME to test database
echo ""
echo "Copying app settings from $PROD_APP_NAME to $FUNC_APP_NAME (DB_NAME=$TEST_DB_NAME)..."
PROD_SETTINGS=$(az functionapp config appsettings list --name "$PROD_APP_NAME" --resource-group "$RESOURCE_GROUP" -o json 2>/dev/null) || true
if [ -n "$PROD_SETTINGS" ]; then
  TMPFILE=$(mktemp)
  TEST_DB_NAME="$TEST_DB_NAME" node -e "
    const d = process.argv[1];
    const testDb = process.env.TEST_DB_NAME || 'allaboard-testing';
    let arr = [];
    try { arr = JSON.parse(d); } catch(e) { process.exit(1); }
    arr.forEach(s => {
      const v = s.name === 'DB_NAME' ? testDb : (s.value || '');
      console.log(s.name + '=' + String(v).replace(/\n/g, ' '));
    });
  " "$PROD_SETTINGS" > "$TMPFILE" 2>/dev/null
  if [ -s "$TMPFILE" ]; then
    SETTINGS_ARGS=()
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      key="${line%%=*}"; val="${line#*=}"
      SETTINGS_ARGS+=("$key=$val")
    done < "$TMPFILE"
    az functionapp config appsettings set --name "$FUNC_APP_NAME" --resource-group "$RESOURCE_GROUP" --settings "${SETTINGS_ARGS[@]}"
    echo "App settings applied (DB_NAME=$TEST_DB_NAME)."
  fi
  rm -f "$TMPFILE"
else
  echo "Could not read prod settings (missing permissions or app). Add staging settings manually."
fi

echo ""
echo "Deploying code to $FUNC_APP_NAME..."
func azure functionapp publish "$FUNC_APP_NAME"
echo "Done. Staging uses same keys as prod with DB_NAME=$TEST_DB_NAME."
