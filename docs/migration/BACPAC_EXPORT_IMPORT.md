# Database migration: bacpac export and import

Use this to migrate the Open Enroll database from the legacy server to the new AllAboard Azure SQL server (e.g. for test first, then production).

**Credentials:** Server, user, and password values are in **`bacpac-credentials.md`** in this folder. That file is gitignored. Substitute the placeholders below from your local copy of `bacpac-credentials.md`.

---

## AllAboard only: prod → bacpac → testing

Use from `bacpac-credentials.md`: **ALLABOARD_SERVER**, **ALLABOARD_USER**, **ALLABOARD_PASSWORD**, **ALLABOARD_RESOURCE_GROUP**.

**1. Export prod to bacpac**

```bash
sqlpackage /Action:Export \
  /SourceServerName:<ALLABOARD_SERVER> \
  /SourceDatabaseName:allaboard-prod \
  /SourceUser:<ALLABOARD_USER> \
  /SourcePassword:'<ALLABOARD_PASSWORD>' \
  /TargetFile:/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/allaboard-prod-export.bacpac
```

**2. Delete existing testing DB (so import can create it)**

```bash
az sql db delete \
  --resource-group <ALLABOARD_RESOURCE_GROUP> \
  --server allboard-prod \
  --name allaboard-testing \
  --yes
```

**3. Import bacpac as testing**

```bash
sqlpackage /Action:Import \
  /SourceFile:/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/allaboard-prod-export.bacpac \
  /TargetServerName:<ALLABOARD_SERVER> \
  /TargetDatabaseName:allaboard-testing \
  /TargetUser:<ALLABOARD_USER> \
  /TargetPassword:'<ALLABOARD_PASSWORD>'
```

Adjust `TargetFile` / `SourceFile` path if needed.

---

**Done so far:** Test DB (open-enroll → allaboard-dev on allboard-prod).  
**To do later:** Production DB (open-enroll → allaboard-prod on allboard-prod).

---

## Prerequisites

- **sqlpackage** installed (e.g. `dotnet tool install -g Microsoft.SqlPackage` or Docker image).
- **.NET 8** runtime if using the dotnet-tools sqlpackage (see repo docs if you hit framework version errors).
- **Credentials** in `bacpac-credentials.md`: legacy source (OE_SOURCE_*), AllAboard target (ALLABOARD_*).
- Firewall allows your IP on both servers.

---

## Delete existing target DB (to overwrite / wipe before import)

**sqlpackage Import** creates the database; the target DB **must not exist**. To overwrite **allaboard-prod** (or any target), delete it first.

**Azure CLI** (use **ALLABOARD_RESOURCE_GROUP** and server name from `bacpac-credentials.md`):

```bash
az sql db delete \
  --resource-group <ALLABOARD_RESOURCE_GROUP> \
  --server allboard-prod \
  --name allaboard-prod \
  --yes
```

- Replace `--server` with your actual SQL Server name (Azure Portal → SQL servers → name, e.g. `allboard-prod`).
- Replace `--name` with the database to delete (e.g. `allaboard-prod` or `allaboard-dev`).
- `--yes` skips confirmation. Omit it to be prompted.

**Alternative:** Azure Portal → SQL server → Databases → select the DB → **Delete**. Or run `DROP DATABASE [allaboard-prod];` connected to the **master** database on the target server (e.g. in SSMS/Azure Data Studio).

After the DB is gone, run the Import command (Step 3) to create it from the bacpac.

---

## Step 1: Fix source DB (required before export)

The legacy function `oe.fn_GetAgentUpline` references old `AgentHierarchy` columns and causes import to fail. Nothing in the DB or app uses it; the app uses `fn_GetAgentUplineForCommission` only. Drop it on the **source** database before exporting.

Run against **open-enroll** on **oe-sql-srvr.database.windows.net** (SSMS, Azure Data Studio, or `ai_scripts/db-execute.sh` if pointed at that DB):

```sql
-- Drop legacy function that references old AgentHierarchy columns.
-- App and DB only use fn_GetAgentUplineForCommission.
IF OBJECT_ID('oe.fn_GetAgentUpline', 'IF') IS NOT NULL
  DROP FUNCTION oe.fn_GetAgentUpline;
```

---

## Step 2: Export bacpac from source

Use **OE_SOURCE_SERVER**, **OE_SOURCE_DATABASE**, **OE_SOURCE_USER**, **OE_SOURCE_PASSWORD** from `bacpac-credentials.md`.

```bash
sqlpackage /Action:Export \
  /SourceServerName:<OE_SOURCE_SERVER> \
  /SourceDatabaseName:<OE_SOURCE_DATABASE> \
  /SourceUser:<OE_SOURCE_USER> \
  /SourcePassword:'<OE_SOURCE_PASSWORD>' \
  /TargetFile:/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/open-enroll-export.bacpac
```

- Adjust **TargetFile** to your path if needed.
- On Windows (cmd), use double quotes for the password and escape `$` as needed.

---

## Step 3: Import bacpac into target (create new DB from bacpac)

The target database **must not exist**; sqlpackage creates it from the bacpac. To overwrite an existing DB (e.g. **allaboard-prod**), delete it first — see **Delete existing target DB** above. Use **ALLABOARD_SERVER**, **ALLABOARD_USER**, **ALLABOARD_PASSWORD** from `bacpac-credentials.md`.

**Test DB (allaboard-dev):**

```bash
sqlpackage /Action:Import \
  /SourceFile:/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/open-enroll-export.bacpac \
  /TargetServerName:<ALLABOARD_SERVER> \
  /TargetDatabaseName:allaboard-dev \
  /TargetUser:<ALLABOARD_USER> \
  /TargetPassword:'<ALLABOARD_PASSWORD>'
```

**Production DB (allaboard-prod):**

```bash
sqlpackage /Action:Import \
  /SourceFile:/Users/jeremyfrancis/Desktop/FalconEye/OpenEnroll/open-enroll-export.bacpac \
  /TargetServerName:<ALLABOARD_SERVER> \
  /TargetDatabaseName:allaboard-prod \
  /TargetUser:<ALLABOARD_USER> \
  /TargetPassword:'<ALLABOARD_PASSWORD>'
```

- Use the same **SourceFile** path you used in Step 2 (or the production export path when you run for prod).
- For production, export from **open-enroll** again (or a production backup) immediately before import so the bacpac is current.

---

## Step 4: Point the app at the new database

In backend `.env` (or Azure App Settings), set:

- `DB_SERVER=<ALLABOARD_SERVER>`
- `DB_NAME=allaboard-dev` (test) or `allaboard-prod` (production)
- `DB_USER=<ALLABOARD_USER>`
- `DB_PASSWORD=<ALLABOARD_PASSWORD>` (or your secure value)

---

## Summary

| Step | Action |
|------|--------|
| 1 | On **source** (open-enroll): drop `oe.fn_GetAgentUpline` |
| 2 | Export: open-enroll → `open-enroll-export.bacpac` |
| (optional) | **Delete existing target DB** (see above): `az sql db delete --resource-group AllAboard365 --server allboard-prod --name allaboard-prod --yes` |
| 3 | Import: bacpac → allaboard-dev or allaboard-prod (creates DB; target must not exist) |
| 4 | Update app config to use new DB_SERVER / DB_NAME |
