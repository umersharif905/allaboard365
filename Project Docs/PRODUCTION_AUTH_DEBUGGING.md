# Production Authentication Issue - Debugging Guide

## 🚨 **Issue Summary**
- **Error**: `Token validation failed: SyntaxError: Unexpected token '<', "<script ty"... is not valid JSON`
- **Root Cause**: Frontend is receiving HTML content instead of JSON from `/api/auth/me` endpoint
- **Impact**: Users cannot log in to the production system

## 🔍 **Immediate Debugging Steps**

### 1. **Run Browser Debug Script**
```javascript
// Copy and paste this into browser console on production site
// This will test the exact failing request

const token = localStorage.getItem('accessToken');
console.log('Token found:', !!token);

fetch('https://api.open-enroll.com/api/auth/me', {
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.text())
.then(text => {
  console.log('Response:', text.substring(0, 500));
  console.log('Contains HTML:', text.includes('<html'));
});
```

### 2. **Test Backend Health**
```bash
# Run this script to test all endpoints
node debug-production-auth.js
```

### 3. **Check Azure App Service Logs**
- Go to Azure Portal → App Service → Logs
- Check for any errors in the backend application
- Look for database connection issues

## 🎯 **Most Likely Causes**

### **1. Backend Server Not Running**
- **Symptoms**: All API calls return HTML error pages
- **Solution**: Restart the Azure App Service
- **Check**: Azure Portal → App Service → Overview → Status

### **2. Wrong API Base URL**
- **Symptoms**: Requests going to wrong server
- **Check**: Verify `https://api.open-enroll.com` is correct
- **Test**: `curl https://api.open-enroll.com/health`

### **3. CORS Configuration**
- **Symptoms**: Browser blocking requests
- **Check**: Backend CORS settings in `app.js`
- **Fix**: Ensure production domain is in `ALLOWED_ORIGINS`

### **4. Environment Variables**
- **Symptoms**: OAuth service calls failing
- **Check**: `OAUTH_BASE_URL` in production environment
- **Verify**: `https://oauth.open-enroll.com/auth`

### **5. Database Connection**
- **Symptoms**: Backend running but auth failing
- **Check**: Azure SQL connection string
- **Test**: Database connectivity in backend logs

## 🔧 **Quick Fixes to Try**

### **Fix 1: Restart Backend Service**
```bash
# In Azure Portal or Azure CLI
az webapp restart --name your-app-service-name --resource-group your-resource-group
```

### **Fix 2: Check Environment Variables**
```bash
# In Azure Portal → App Service → Configuration → Application settings
# Verify these are set:
OAUTH_BASE_URL=https://oauth.open-enroll.com
NODE_ENV=production
BYPASS_AUTH=false
```

### **Fix 3: Test Database Connection**
```bash
# Add this to backend/app.js temporarily
app.get('/test-db', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT 1 as test');
    res.json({ success: true, data: result.recordset[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

### **Fix 4: Check CORS Settings**
```javascript
// In backend/app.js, verify CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [
    'https://open-enroll.com',
    'https://admin.open-enroll.com'
  ],
  credentials: true
}));
```

## 📊 **Diagnostic Checklist**

- [ ] Backend server is running (check Azure App Service status)
- [ ] Health endpoint responds: `curl https://api.open-enroll.com/health`
- [ ] OAuth service is accessible: `curl https://oauth.open-enroll.com/auth`
- [ ] Database connection works (check backend logs)
- [ ] CORS is configured correctly
- [ ] Environment variables are set
- [ ] DNS resolution is correct
- [ ] SSL certificates are valid

## 🚀 **Emergency Workaround**

If the issue persists, you can temporarily bypass authentication for testing:

```javascript
// In backend/middleware/auth.js, temporarily add:
const authenticate = async (req, res, next) => {
  // TEMPORARY: Bypass auth for debugging
  if (process.env.BYPASS_AUTH === 'true') {
    req.user = {
      UserId: 'temp-user-id',
      UserType: 'TenantAdmin',
      TenantId: 'temp-tenant-id',
      Email: 'debug@example.com'
    };
    return next();
  }
  // ... rest of auth logic
};
```

## 📞 **Next Steps**

1. **Run the browser debug script** to identify the exact issue
2. **Check Azure App Service logs** for backend errors
3. **Verify all environment variables** are set correctly
4. **Test database connectivity** from the backend
5. **Check CORS configuration** for production domains

## 🔗 **Useful Commands**

```bash
# Test backend health
curl https://api.open-enroll.com/health

# Test OAuth service
curl https://oauth.open-enroll.com/auth

# Check Azure App Service status
az webapp show --name your-app-name --resource-group your-rg

# View backend logs
az webapp log tail --name your-app-name --resource-group your-rg
```

## 📝 **Expected Results**

**Healthy System Should Return:**
- Health endpoint: `{"success": true, "status": "healthy"}`
- Auth info: `{"success": true, "message": "OAuth Authentication Required"}`
- OAuth service: Should return OAuth service information

**If You See HTML:**
- Backend server is down or misconfigured
- Wrong server is responding
- Proxy/load balancer issue
- DNS routing problem 