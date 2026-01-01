# Azure Function Database Configuration

## 🎯 Production Configuration

To configure the Azure Function App to use **production database**:

### Required Application Settings:

| Setting | Production Value | Notes |
|---------|-----------------|-------|
| `DB_NAME` | `open-enroll` | **NOT** `open-enroll-dev` |
| `DB_SERVER` | `oe-sql-srvr.database.windows.net` | |
| `DB_USER` | `oe-sqladmin` | |
| `DB_PASSWORD` | `[production password]` | |
| `NODE_ENV` | `production` | **NOT** `development` |
| `ENCRYPTION_KEY` | `Kj8mN2pQ9vR5sT7uW3xY6zA1bC4dE8fG` | **Critical** - Used to decrypt DIME API tokens stored in database |
| `ADMIN_API_KEY` | `a2fb9635baeaab58f1c8887b90ebb61c13664c7a5a1bf490d112757928930b6c` | |

### How to Update:

1. **Azure Portal** → **Function Apps** → **oe-payment-manager-fyerfvdyb3atffhj**
2. **Configuration** → **Application settings**
3. Update these critical settings:
   - `DB_NAME`: `open-enroll-dev` → `open-enroll`
   - `NODE_ENV`: `development` → `production`
   - `ENCRYPTION_KEY`: Ensure it's set to `Kj8mN2pQ9vR5sT7uW3xY6zA1bC4dE8fG` (or the key used to encrypt DIME credentials)
4. Click **Save** (restarts function app)
6. Wait 30-60 seconds for restart

### Verification:

After updating, check the function logs to confirm it's using production:
- Look for database connection messages
- Run manual trigger and verify invoices are created in production database

### ⚠️ Important Notes:

- The function has a safety check: it will **BLOCK** production DB access if `NODE_ENV=development`
- Always verify `DB_NAME` and `NODE_ENV` are set correctly before running manual triggers
- Production database: `open-enroll`
- Dev database: `open-enroll-dev`

### Current Status:

- ✅ Manual trigger is working
- ✅ API key is configured
- ⚠️ **Needs update:** `DB_NAME` should be `open-enroll` for production

