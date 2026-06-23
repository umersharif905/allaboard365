# PROD-APP-QE: Storage env vars & folder structure

Use this when switching PROD-APP-QE to a new Azure tenant for Storage while keeping the same structure as the current Open-Enroll tenant.

---

## 1. Environment variables to set on PROD-APP-QE

The app reads these for Azure Blob Storage (see `backend/.env` and usage in `backend/routes/*.js`, `backend/services/*.js`):

| Variable | Required | Purpose |
|----------|----------|---------|
| **AZURE_STORAGE_CONNECTION_STRING** | Yes | Full connection string for the **new** storage account (new tenant). Used for all blob read/write. |
| **AZURE_STORAGE_ACCOUNT_NAME** | Optional | Account name used when building blob URLs (e.g. for receipts, enrollment PDFs). If unset, code falls back to parsing the connection string or `oestorage`. Set this to the **new** storage account name so generated URLs point to the new tenant. |

**Example (values are placeholders):**

```bash
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=<NEW_ACCOUNT>;AccountKey=<NEW_KEY>;EndpointSuffix=core.windows.net
AZURE_STORAGE_ACCOUNT_NAME=<NEW_ACCOUNT>
```

Replace `<NEW_ACCOUNT>` and `<NEW_KEY>` with the new tenant’s storage account name and key.

---

## 2. Folder structure to match (containers)

The app expects these **container names** in the storage account. Create the same containers in the new tenant so paths and behavior stay the same.

| Container | Access | Used for |
|-----------|--------|----------|
| **agreements** | blob | Agreement PDFs, agent onboarding docs, receipts |
| **proposals** | blob | Generated proposal PDFs |
| **logos** | blob | Logos, profile images (public) |
| **products** | blob | Product images |
| **documents** | blob | Private documents |
| **members** | blob | Member/ESS PDFs, share requests |
| **general** | blob | General uploads (fallback) |
| **affiliates** | blob | Affiliate uploads |
| **training** | blob | Training media |
| **enrollment-documents** | blob | Enrollment PDFs |

Current code creates containers on demand in many places (`createIfNotExists`), but creating them upfront in the new tenant avoids permission issues and keeps layout identical to Open-Enroll.

---

## 3. Update PROD-APP-QE via Azure Portal

1. **Azure Portal** → **App Services** → open **PROD-APP-QE**.
2. **Settings** → **Configuration** → **Application settings**.
3. Add or edit:
   - **AZURE_STORAGE_CONNECTION_STRING** = connection string for the **new** storage account.
   - **AZURE_STORAGE_ACCOUNT_NAME** = new storage account name (recommended).
4. Save and restart the app if prompted.

---

## 4. Update PROD-APP-QE via Azure CLI

Prerequisites: `az login` and correct subscription.

```bash
# Set your app and new storage details
APP_NAME="PROD-APP-QE"
RESOURCE_GROUP="<your-resource-group>"
NEW_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
NEW_STORAGE_ACCOUNT_NAME="<new-storage-account-name>"

# Update app settings
az webapp config appsettings set --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --settings \
  AZURE_STORAGE_CONNECTION_STRING="$NEW_STORAGE_CONNECTION_STRING" \
  AZURE_STORAGE_ACCOUNT_NAME="$NEW_STORAGE_ACCOUNT_NAME"

# Restart the app
az webapp restart --name "$APP_NAME" --resource-group "$RESOURCE_GROUP"
```

---

## 5. Create containers in the new storage account (same structure)

Run once against the **new** storage account (using its connection string or account name + key).

```bash
# Using connection string for the NEW storage account
NEW_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"

CONTAINERS="agreements proposals logos products documents members general affiliates training enrollment-documents"

for c in $CONTAINERS; do
  az storage container create --name "$c" --connection-string "$NEW_STORAGE_CONNECTION_STRING" --auth-mode key
done
```

Or create them in **Azure Portal**: Storage account → **Containers** → **+ Container** for each name above.

---

## 6. Data migration (optional)

If you need **existing blobs** from the current Open-Enroll tenant (`oestorage`) in the new tenant:

- Use **AzCopy** or **Azure Storage Explorer** to copy containers between storage accounts.
- Or a one-off script using `@azure/storage-blob` to list blobs in the old account and upload to the new one (same container names and blob paths).

After migration, point PROD-APP-QE only at the new tenant via the env vars above; the folder structure will match.
