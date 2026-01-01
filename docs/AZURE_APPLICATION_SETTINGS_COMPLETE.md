# Complete Azure Application Settings Checklist

## 📋 All Settings Required in Azure Function App

### Database Settings (Required)
| Setting | Production Value | Notes |
|---------|----------------|-------|
| `DB_USER` | `oe-sqladmin` | Database username |
| `DB_PASSWORD` | `[production password]` | Database password |
| `DB_SERVER` | `oe-sql-srvr.database.windows.net` | Database server |
| `DB_NAME` | `open-enroll` | **NOT** `open-enroll-dev` |

### Environment Settings (Required)
| Setting | Production Value | Notes |
|---------|----------------|-------|
| `NODE_ENV` | `production` | **NOT** `development` - This determines which DIME credentials to use |

### Security Keys (Required)
| Setting | Production Value | Notes |
|---------|----------------|-------|
| `ENCRYPTION_KEY` | `Kj8mN2pQ9vR5sT7uW3xY6zA1bC4dE8fG` | Used to encrypt/decrypt DIME API tokens and webhook secrets stored in database |
| `ADMIN_API_KEY` | `a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c` | Required for manual trigger authentication |

### DIME API Settings (NOT Required - Stored in Database)
**Note:** DIME settings are stored per-tenant in `oe.Tenants.PaymentProcessorSettings` and retrieved dynamically. No environment variables needed.

The function uses `DimeService.getConfigForTenant()` to:
- Read DIME credentials from `oe.Tenants.PaymentProcessorSettings`
- Decrypt using `ENCRYPTION_KEY`
- Support multiple tenants with different DIME configurations

### Azure-Managed Settings (Auto-configured)
These are automatically set by Azure - **DO NOT** manually configure:
- `AzureWebJobsStorage` - Azure handles this
- `FUNCTIONS_WORKER_RUNTIME` - Azure sets to `node`
- `WEBSITE_NODE_DEFAULT_VERSION` - Azure sets Node.js version

---

## 🔧 How to Configure in Azure Portal

1. Go to **Azure Portal** → **Function Apps** → **oe-payment-manager-fyerfvdyb3atffhj**
2. Click **Configuration** → **Application settings**
3. For each setting above:
   - If it exists: Click on it and update the value
   - If it doesn't exist: Click **+ New application setting** and add it
4. Click **Save** at the top (restarts the function app)
5. Wait 30-60 seconds for restart

---

## ⚠️ Critical Settings for Production

**These MUST be set correctly for production:**

1. ✅ `DB_NAME` = `open-enroll` (NOT `open-enroll-dev`)
2. ✅ `NODE_ENV` = `production` (NOT `development`)
3. ✅ `ENCRYPTION_KEY` = Must match the key used to encrypt DIME credentials in database
4. ✅ DIME credentials are stored in `oe.Tenants.PaymentProcessorSettings` (not in environment variables)

---

## 🔍 Verification

After updating settings, verify:

1. **Check function logs** - Look for database connection messages
2. **Test manual trigger** - Should process production groups
3. **Check database** - Invoices should be created in `open-enroll` database

---

## 📝 Notes

- **ENCRYPTION_KEY**: This is critical! It must match the key used when DIME credentials were encrypted and stored in the database. If it doesn't match, the function won't be able to decrypt DIME API tokens from `oe.Tenants.PaymentProcessorSettings`.
- **NODE_ENV**: When set to `production`, the function allows production database access. When `development`, it blocks production DB access for safety.
- **DIME Settings**: Stored per-tenant in the database (`oe.Tenants.PaymentProcessorSettings`), not in environment variables. Each tenant can have different DIME credentials.
- **Database**: The function has a safety check that blocks production DB access if `NODE_ENV=development`, so both must be set correctly.

