const path = require('path');
// backend/app.js
// Only load .env file in development - production and qa use Azure App Service environment variables
// if (process.env.NODE_ENV === 'development') {
//     require('dotenv').config();
// }
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
    const preserveTestPort = process.env.OE_TEST_BACKEND_PORT;
    const preservePort = process.env.PORT;
    require('dotenv').config({ path: path.join(__dirname, '.env') });
    if (preserveTestPort) {
        process.env.OE_TEST_BACKEND_PORT = preserveTestPort;
    }
    if (preservePort) {
        process.env.PORT = preservePort;
    }
}

require('./instrument.js');
const Sentry = require('@sentry/node');

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const cors = require('cors');
const emailRoutes = require('./routes/email');
const messageCenterRoutes = require('./routes/messageCenter');
const errorRoutes = require('./routes/errors');
const { buildCorsMiddleware } = require('./middleware/cors');
const posthog = require('./config/posthog');

const app = express();

process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

// Trust proxy for Azure App Service (behind load balancer)
// This is required for accurate client IP detection and rate limiting
app.set('trust proxy', 1);

// ============================================================================
// ROUTE IMPORTS
// ============================================================================

// Authentication routes
const authRoutes = require('./routes/auth');

// Core data routes
let membersRoutes, usersRoutes, tenantsRoutes, productsRoutes, groupsRoutes, enrollmentRoutes, uploadsRoutes, domainVerificationRoutes;

try {
    membersRoutes = require('./routes/members');
} catch (e) {
    console.warn('⚠️ Members routes not found:', e.message);
}

try {
    usersRoutes = require('./routes/users');
} catch (e) {
    console.warn('⚠️ Users routes not found:', e.message);
}

try {
    tenantsRoutes = require('./routes/tenants');
} catch (e) {
    console.warn('⚠️ Tenants routes not found:', e.message);
}

try {
    productsRoutes = require('./routes/products');
} catch (e) {
    console.warn('⚠️ Products routes not found:', e.message);
}

try {
    domainVerificationRoutes = require('./routes/domainVerification');
} catch (e) {
    console.warn('⚠️ Domain verification routes not found:', e.message);
}

// ADD: Enrollment Link Templates routes
let enrollmentLinkTemplatesRoutes;
try {
    enrollmentLinkTemplatesRoutes = require('./routes/enrollment-link-templates');
    console.log('✅ Enrollment Link Templates routes imported successfully');
} catch (e) {
    console.warn('⚠️ Enrollment Link Templates routes not found:', e.message);
}

try {
    groupsRoutes = require('./routes/groups');
} catch (e) {
    console.warn('⚠️ Groups routes not found:', e.message);
}

// ADD: Group Contributions routes
let groupContributionsRoutes;

try {
    groupContributionsRoutes = require('./routes/groupContributions');
    console.log('✅ Group Contributions routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Contributions routes not found:', e.message);
}

// ADD: Group Billing routes
let groupBillingRoutes;

try {
    groupBillingRoutes = require('./routes/groupBilling');
    console.log('✅ Group Billing routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Billing routes not found:', e.message);
}

// ADD: Group Advanced routes (TenantAdmin/SysAdmin bulk ops)
let groupAdvancedRoutes;
try {
    groupAdvancedRoutes = require('./routes/groupAdvanced');
    console.log('✅ Group Advanced routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Advanced routes not found:', e.message);
}

// ADD: Group ASA Status routes
let groupASAStatusRoutes;

try {
    groupASAStatusRoutes = require('./routes/group-asa-status');
    console.log('✅ Group ASA Status routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group ASA Status routes not found:', e.message);
}

try {
    enrollmentRoutes = require('./routes/enrollments');
} catch (e) {
    console.warn('⚠️ Enrollment routes not found:', e.message);
}

try {
    uploadsRoutes = require('./routes/uploads');
    console.log('✅ Uploads routes imported successfully');
} catch (e) {
    console.warn('⚠️ Uploads routes not found:', e.message);
}

// Always available routes
const paymentsRoutes = require('./routes/payments');
const accountingRoutes = require('./routes/accounting');
const nachaRoutes = require('./routes/accounting/nacha');

// Phase 1 Commission System routes
let commissionsRoutes, agencyRoutes, reportsRoutes, marketplaceRoutes, subscriptionsRoutes, adminRoutes;

try {
    commissionsRoutes = require('./routes/commissions');
    console.log('✅ Commission routes imported successfully');
} catch (e) {
    console.warn('⚠️ Commission routes not found:', e.message);
}

try {
    agencyRoutes = require('./routes/agencies');
    console.log('✅ Agency routes imported successfully');
} catch (e) {
    console.warn('⚠️ Agency routes not found:', e.message);
}

try {
    reportsRoutes = require('./routes/reports');
    console.log('✅ Reports routes imported successfully');
} catch (e) {
    console.warn('⚠️ Reports routes not found:', e.message);
}

try {
    marketplaceRoutes = require('./routes/marketplace');
    console.log('✅ Marketplace routes imported successfully');
} catch (e) {
    console.warn('⚠️ Marketplace routes not found:', e.message);
}

try {
    subscriptionsRoutes = require('./routes/subscriptions');
    console.log('✅ Subscriptions routes imported successfully');
} catch (e) {
    console.warn('⚠️ Subscriptions routes not found:', e.message);
}

// Admin routes
try {
    adminRoutes = require('./routes/admin');
    console.log('✅ Admin routes imported successfully');
} catch (e) {
    console.warn('⚠️ Admin routes not found:', e.message);
}

// ADD: Agent routes
let agentsRoutes;
try {
    agentsRoutes = require('./routes/agents');
    console.log('✅ Agent routes imported successfully');
} catch (e) {
    console.warn('⚠️ Agent routes not found:', e.message);
}

// ADD: Vendor routes
let vendorsRoutes;
try {
    vendorsRoutes = require('./routes/vendors');
    console.log('✅ Vendors routes imported successfully');
} catch (e) {
    console.warn('⚠️ Vendors routes not found:', e.message);
}

// ADD: Group Onboarding routes
let groupOnboardingRoutes;
try {
    groupOnboardingRoutes = require('./routes/group-onboarding');
    console.log('✅ Group Onboarding routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Onboarding routes not found:', e.message);
}

// TENANT ADMIN ROUTES
const tenantAdminRoutes = require('./routes/tenantAdmin');
const tenantAdminAgentsRoutes = require('./routes/tenant-admin-agents');
const tenantAdminAgentOverridesRoutes = require('./routes/tenant-admin-agent-overrides');
const tenantAdminAgentCommissionPayoutsRoutes = require('./routes/tenant-admin-agent-commission-payouts');

// GROUP ADMIN ROUTES
let groupAdminRoutes;
try {
    groupAdminRoutes = require('./routes/group-admin/index');
    console.log('✅ Group Admin routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Admin routes not found:', e.message);
}

// DKIM ROUTES - UNIFIED for both SysAdmin and TenantAdmin
let dkimRoutes;
try {
    dkimRoutes = require('./routes/dkim');
    console.log('✅ DKIM routes imported successfully');
} catch (e) {
    console.warn('⚠️ DKIM routes not found:', e.message);
}

// ME ROUTES - UNIFIED APPROACH
// All me routes are now handled through the unified /routes/me/index.js approach
// Individual imports are no longer needed

let metricsRoutes;
try {
    metricsRoutes = require('./routes/metrics');
    console.log('✅ Metrics routes imported successfully');
} catch (e) {
    console.warn('⚠️ Metrics routes not found:', e.message);
}

// Import groupProducts routes
let groupProductsRoutes;
try {
    groupProductsRoutes = require('./routes/groupProducts');
    console.log('✅ Group Products routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Products routes not found:', e.message);
}

// Import householdVendorNetworks routes (per-household ID card network selection for individuals)
let householdVendorNetworksRoutes;
try {
    householdVendorNetworksRoutes = require('./routes/householdVendorNetworks');
    console.log('✅ Household Vendor Networks routes imported successfully');
} catch (e) {
    console.warn('⚠️ Household Vendor Networks routes not found:', e.message);
}

// Import groupNewGroupForm routes (Generate New Group Form PDF + send email)
let groupNewGroupFormRoutes;
try {
    groupNewGroupFormRoutes = require('./routes/groupNewGroupForm');
    console.log('✅ Group New Group Form routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group New Group Form routes not found:', e.message);
}

// Import groupMembers routes
let groupMembersRoutes;
try {
    groupMembersRoutes = require('./routes/groupMembers');
    console.log('✅ Group Members routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Members routes not found:', e.message);
}

// Import groupFiles routes
let groupFilesRoutes;
try {
    groupFilesRoutes = require('./routes/groupFiles');
    console.log('✅ Group Files routes imported successfully');
} catch (e) {
    console.warn('⚠️ Group Files routes not found:', e.message);
}


// Tenant Products Routes
let tenantProductsRoutes;
try {
    tenantProductsRoutes = require('./routes/tenant-products');
} catch (e) {
    console.warn('⚠️ Tenant Products routes not found:', e.message);
}

// Import middlewares
const { authenticate } = require('./middleware/auth');
// const { requireTenantAccess } = require('./middleware/requireTenantAccess');
// const { auditLogger } = require('./middleware/auditMiddleware');

// Import route modules
// ... existing routes imports ...

// Import ME routes (for user-scoped endpoints)
const meRoutes = require('./routes/me');

// ============================================================================
// MIDDLEWARE CONFIGURATION
// ============================================================================

// CORS configuration with wildcard subdomain support
const corsOptions = buildCorsMiddleware();

// Log OPTIONS (preflight) requests for debugging
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        console.log(`🔍 OPTIONS preflight request from origin: ${req.headers.origin || 'none'}`);
        console.log(`   Request headers: ${JSON.stringify(req.headers)}`);
    }
    next();
});

app.use(cors(corsOptions));
// Explicitly enable preflight across all routes (some proxies/CDNs require this)
app.options('*', cors(corsOptions));

// Legacy SendGrid Event Webhook (existing on master) — raw body for ECDSA verify.
// Intentionally dormant: its env var SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is not set.
const sendgridEventWebhookRoutes = require('./routes/webhooks/sendgrid-events');
app.use('/api/webhooks/sendgrid-events', express.raw({ type: 'application/json' }), sendgridEventWebhookRoutes);
console.log('✅ Mounted /api/webhooks/sendgrid-events (raw body, legacy path, dormant backup)');

// New SendGrid Event Webhook → oe.MessageEvent + legacy service delegation.
// Applies express.raw() locally; must be mounted BEFORE the global express.json().
const sendGridWebhookRoutes = require('./routes/webhooks/sendgrid');
app.use('/api/webhooks/sendgrid', sendGridWebhookRoutes);
console.log('✅ Mounted /api/webhooks/sendgrid (signed event webhook → oe.MessageEvent)');

// Twilio status callback — flag-gated. Uses its own urlencoded parser internally,
// but mounted here for consistency with the SendGrid webhook placement.
if (process.env.ENABLE_TWILIO_WEBHOOK === 'true') {
    const twilioStatusWebhookRoutes = require('./routes/webhooks/twilio');
    app.use('/api/webhooks/twilio', twilioStatusWebhookRoutes);
    console.log('✅ Mounted /api/webhooks/twilio (SMS status callback, flag-gated)');
} else {
    console.log('ℹ️  /api/webhooks/twilio not mounted (set ENABLE_TWILIO_WEBHOOK=true to enable)');
}

// Sentry tunnel — mounted before express.json so it can own its own body parser.
// Bypasses ad-blockers that drop requests to *.ingest.sentry.io.
const sentryTunnelRoutes = require('./routes/sentry-tunnel');
app.use('/api/sentry-tunnel', sentryTunnelRoutes);
console.log('✅ Mounted /api/sentry-tunnel (Sentry envelope forwarder)');

// Sentry Internal Integration webhook → Cursor Automation bridge.
// Verifies sentry-hook-signature and forwards eligible issues to BUG_REPORT_WEBHOOK_URL.
const sentryWebhookRoutes = require('./routes/webhooks/sentry');
app.use('/api/webhooks/sentry', sentryWebhookRoutes);
console.log('✅ Mounted /api/webhooks/sentry (Sentry issue → Cursor automation bridge)');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/message-center', messageCenterRoutes);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false
}));

// Rate limiting
// Custom keyGenerator to handle IP addresses that may include port numbers (e.g., "99.32.61.191:59953")
// This happens when behind proxies like Azure Front Door
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    keyGenerator: (req) => {
        try {
            // Extract IP address from request
            let ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
            
            if (!ip || typeof ip !== 'string') {
                // If no IP found, try to use User-Agent + a header combination as fallback
                // This prevents all requests without IPs from sharing the same rate limit bucket
                // Note: This is less secure than IP-based limiting, but better than nothing
                const userAgent = req.get('User-Agent') || 'unknown';
                const forwardedFor = req.get('X-Forwarded-For') || req.get('X-Real-IP') || '';
                const fallbackKey = forwardedFor ? `forwarded-${forwardedFor.split(',')[0].trim()}` : `noip-${userAgent.substring(0, 50)}`;
                
                console.warn('⚠️ Rate limiter: No IP address found, using fallback key based on headers');
                return fallbackKey;
            }
            
            // Handle IPv4 with port: "99.32.61.191:59953" -> "99.32.61.191"
            // Match IPv4 pattern (4 groups of digits separated by dots) followed by colon and port
            const ipv4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/;
            if (ipv4WithPort.test(ip)) {
                ip = ip.split(':')[0];
            }
            // Handle IPv6-mapped IPv4: "::ffff:192.168.1.1" or "::ffff:192.168.1.1:8080"
            else if (ip.startsWith('::ffff:')) {
                ip = ip.replace('::ffff:', '').split(':')[0];
            }
            // Handle IPv6 with port: "[2001:db8::1]:8080" -> "2001:db8::1"
            else if (ip.startsWith('[') && ip.includes(']:')) {
                ip = ip.substring(1, ip.indexOf(']:'));
            }
            // For pure IPv6 without brackets, check if last segment is a port (numeric and > 65535 is unlikely)
            else if (ip.includes(':') && ip.split(':').length > 2) {
                const parts = ip.split(':');
                const lastPart = parts[parts.length - 1];
                // If last part is all digits and the IP has more than 4 segments, it might be a port
                // But be careful - IPv6 can have numeric segments, so only remove if it looks like a port
                // (i.e., if removing it leaves a valid-looking IPv6 address)
                if (/^\d+$/.test(lastPart) && parseInt(lastPart) <= 65535 && parts.length > 4) {
                    // Likely a port, but this is risky - only do it if we're confident
                    // Actually, let's be more conservative and only handle the clear IPv4 case
                    // Pure IPv6 addresses are complex, so we'll leave them as-is
                }
            }
            
            return ip || 'unknown';
        } catch (error) {
            // If anything goes wrong in keyGenerator, return a safe fallback
            // This ensures the rate limiter never throws an error that breaks the request
            console.error('❌ Rate limiter keyGenerator error:', error);
            return `error-${Date.now()}`;
        }
    },
    // Skip rate limiting only in extreme cases where we can't identify the request at all
    // This should be very rare - normally we'll have an IP or at least headers
    skip: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
        const userAgent = req.get('User-Agent');
        const forwardedFor = req.get('X-Forwarded-For') || req.get('X-Real-IP');
        
        // Only skip if we have absolutely no identifying information
        // (This should be extremely rare and might indicate a misconfiguration)
        if (!ip && !userAgent && !forwardedFor) {
            console.warn('⚠️ Rate limiter: Skipping rate limit - no IP or identifying headers found. This may indicate a proxy misconfiguration.');
            return true;
        }
        
        return false;
    }
});

app.use('/api/', limiter);

// Body parsing middleware (already declared above)

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ============================================================================
// PUBLIC CONFIGURATION ENDPOINT
// ============================================================================

// Config route - must be before authentication middleware (public endpoint)
const configRoutes = require('./routes/config');
app.use('/', configRoutes);
console.log('✅ Mounted /config.json route (public configuration endpoint)');

// Local auth routes (login, me, refresh, logout) - public, no authenticate middleware
const localAuthRoutes = require('./routes/local-auth');
app.use('/auth', localAuthRoutes);
console.log('✅ Mounted /auth (local auth: login, me, refresh, logout)');

// ============================================================================
// HEALTH CHECK ENDPOINTS
// ============================================================================

// Basic health check
app.get('/health', async (req, res) => {
    try {
        // Test database connection
        let dbHealthy = false;
        try {
            const { testDatabase } = require('./config/database');
            dbHealthy = await testDatabase();
        } catch (dbError) {
            console.warn('⚠️ Database config not found - server starting anyway');
        }
        
        res.json({
            status: dbHealthy ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            database: dbHealthy ? 'connected' : 'disconnected',
            auth_bypass: process.env.BYPASS_AUTH === 'true'
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

// Commission system health check
app.get('/health/commission', async (req, res) => {
    try {
        let dbHealthy = false;
        let commissionStats = null;
        
        try {
            const { getPool } = require('./config/database');
            const pool = await getPool();
            
            // Test commission system database connectivity
            const testQuery = await pool.request().query(`
                SELECT 
                    COUNT(*) as CommissionRuleCount,
                    (SELECT COUNT(*) FROM oe.CommissionLogs WHERE CreatedDate >= DATEADD(DAY, -1, GETDATE())) as RecentLogs,
                    (SELECT COUNT(*) FROM oe.Agencies WHERE Status = 'Active') as ActiveAgencies
                FROM oe.CommissionRules 
                WHERE Status = 'Active'
            `);
            
            commissionStats = testQuery.recordset[0];
            dbHealthy = true;
        } catch (dbError) {
            console.warn('⚠️ Commission database test failed:', dbError.message);
        }
        
        res.json({
            success: true,
            status: dbHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            commission_system: commissionStats ? {
                active_rules: commissionStats.CommissionRuleCount,
                recent_logs: commissionStats.RecentLogs,
                active_agencies: commissionStats.ActiveAgencies
            } : null
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// CORS test endpoint
app.get('/api/test-cors', (req, res) => {
    res.json({
        success: true,
        message: 'CORS test successful',
        origin: req.headers.origin || 'none',
        timestamp: new Date().toISOString()
    });
});

// Debug endpoint to show all routes
app.get('/api/debug/routes', (req, res) => {
    const routes = [];
    
    function extractRoutes(stack, basePath = '') {
        stack.forEach((layer) => {
            if (layer.route) {
                routes.push({
                    path: basePath + layer.route.path,
                    methods: Object.keys(layer.route.methods),
                    type: 'route'
                });
            } else if (layer.name === 'router' && layer.regexp) {
                const match = layer.regexp.toString().match(/^\/\^\\(.*?)\\\?\(\?\=\\\/\|\$\)/);
                const routerPath = match ? match[1].replace(/\\\//g, '/') : '';
                
                if (layer.handle && layer.handle.stack) {
                    extractRoutes(layer.handle.stack, basePath + routerPath);
                }
            }
        });
    }
    
    if (app._router && app._router.stack) {
        extractRoutes(app._router.stack);
    }
    
    res.json({ 
        routes, 
        timestamp: new Date().toISOString(),
        message: 'Available API routes' 
    });
});

// Authentication middleware alias
const authenticateMiddleware = authenticate;

// ============================================================================
// PUBLIC ROUTES - MOUNT BEFORE AUTHENTICATED ROUTES
// ============================================================================

// NONE - All routes require authentication in this configuration

// ============================================================================
// ROUTE MOUNTING
// ============================================================================

// STEP 1: Mount core authentication routes FIRST
// do we need this?
app.use('/api/auth', authRoutes);
console.log('✅ Mounted /api/auth');

// Import requireTenantAccess middleware for tenant-scoped routes
const requireTenantAccess = require('./middleware/requireTenantAccess');

// STEP 2: Mount main API routes
// Apply requireTenantAccess to tenant-scoped routes to support tenant switching
if (membersRoutes) {
    app.use('/api/members', authenticateMiddleware, requireTenantAccess, membersRoutes);
    console.log('✅ Mounted /api/members (with tenant access control)');
}

// Note: Member enrollments routes should be handled through /api/me routes to avoid conflicts

if (usersRoutes) {
    app.use('/api/users', authenticateMiddleware, usersRoutes);
    console.log('✅ Mounted /api/users');
}

if (tenantsRoutes) {
    app.use('/api/tenants', authenticateMiddleware, tenantsRoutes);
    console.log('✅ Mounted /api/tenants');
}

if (domainVerificationRoutes) {
    app.use('/api/tenants', authenticateMiddleware, domainVerificationRoutes);
    console.log('✅ Mounted /api/tenants domain verification');
}

if (productsRoutes) {
    app.use('/api/products', authenticateMiddleware, productsRoutes);
    console.log('✅ Mounted /api/products');
}

// Manual chunk CRUD endpoints (POST/PUT/DELETE per-chunk, wizard live editing)
const productChunksRouter = require('./routes/product-chunks');
app.use('/api/products', productChunksRouter);
console.log('✅ Mounted /api/products (chunk CRUD)');

// ADD: Mount enrollment link templates routes
if (enrollmentLinkTemplatesRoutes) {
    app.use('/api/enrollment-link-templates', authenticateMiddleware, requireTenantAccess, enrollmentLinkTemplatesRoutes);
    console.log('✅ Mounted /api/enrollment-link-templates (with tenant access control)');
}

// ADD: Mount enrollment links routes (public access for enrollment)
let enrollmentLinksRoutes;
try {
    enrollmentLinksRoutes = require('./routes/enrollment-links');
    console.log('✅ Enrollment Links routes imported successfully');
} catch (e) {
    console.warn('⚠️ Enrollment Links routes not found:', e.message);
}

// ADD: Mount enrollment links routes (public access for enrollment)
if (enrollmentLinksRoutes) {
    app.use('/api/enrollment-links', enrollmentLinksRoutes); // No authentication for public enrollment access
    console.log('✅ Mounted /api/enrollment-links (public access)');
}

// ADD: Mount enroll-now short code resolver (public access)
let enrollNowRoutes;
try {
    enrollNowRoutes = require('./routes/enroll-now');
    app.use('/api/enroll-now', enrollNowRoutes); // No authentication for public short code resolution
    console.log('✅ Mounted /api/enroll-now (public access)');
} catch (e) {
    console.warn('⚠️ Enroll-now routes not found:', e.message);
}

// ADD: Mount group onboarding routes (public access for group onboarding)
if (groupOnboardingRoutes) {
    app.use('/api/group-onboarding', groupOnboardingRoutes); // No authentication for public group onboarding access
    console.log('✅ Mounted /api/group-onboarding (public access)');
}

// ADD: Mount password setup routes (public access for password setup)
const passwordSetupRoutes = require('./routes/password-setup');
app.use('/api/password-setup', passwordSetupRoutes); // No authentication for public password setup access
console.log('✅ Mounted /api/password-setup (public access)');

// Password reset routes
const passwordResetRoutes = require('./routes/password-reset');
app.use('/api/password-reset', passwordResetRoutes); // No authentication for public password reset access
console.log('✅ Mounted /api/password-reset (public access)');

// Error logging routes (public access - errors can occur before/during authentication)
app.use('/api/errors', errorRoutes); // No authentication for error logging
console.log('✅ Mounted /api/errors (public access)');

// Internal routes (called by other services in our infra; auth via INTERNAL_API_TOKEN header)
const internalRefundsRoutes = require('./routes/internal/refunds');
app.use('/api/internal/refunds', internalRefundsRoutes);
console.log('✅ Mounted /api/internal/refunds (internal token auth)');
const internalPaymentFailureNotificationsRoutes = require('./routes/internal/payment-failure-notifications');
app.use('/api/internal/payment-failure-notifications', internalPaymentFailureNotificationsRoutes);
console.log('✅ Mounted /api/internal/payment-failure-notifications (internal token auth)');

const internalCreditsRoutes = require('./routes/internal/credits');
app.use('/api/internal/credits', internalCreditsRoutes);
console.log('✅ Mounted /api/internal/credits (internal token auth)');

const internalRecurringPaymentSuccessRoutes = require('./routes/internal/recurring-payment-success');
app.use('/api/internal/recurring-payment-success', internalRecurringPaymentSuccessRoutes);
console.log('✅ Mounted /api/internal/recurring-payment-success (internal token auth)');

const internalPaymentBouncesRoutes = require('./routes/internal/payment-bounces');
app.use('/api/internal/payment-bounces', internalPaymentBouncesRoutes);
console.log('✅ Mounted /api/internal/payment-bounces (internal token auth)');

// Webhook routes (public access - called by external services)
const zoomPhoneWebhookRoutes = require('./routes/webhooks/zoom-phone');
app.use('/api/webhooks/zoom-phone', zoomPhoneWebhookRoutes); // No authentication for webhooks
console.log('✅ Mounted /api/webhooks/zoom-phone (public access)');

const graphEmailWebhookRoutes = require('./routes/webhooks/graph-email');
app.use('/api/webhooks/graph-email', graphEmailWebhookRoutes); // No auth; verified via per-vendor clientState
console.log('✅ Mounted /api/webhooks/graph-email (public access, Back Office inbox)');

const twilioSmsWebhookRoutes = require('./routes/webhooks/twilio-sms');

// Log all webhook requests for debugging
app.use('/api/webhooks/twilio-sms', (req, res, next) => {
    console.log(`🔔 [WEBHOOK] ${req.method} ${req.path} - IP: ${req.ip} - ${new Date().toISOString()}`);
    console.log(`🔔 [WEBHOOK] Headers:`, JSON.stringify(req.headers, null, 2));
    next();
});

app.use('/api/webhooks/twilio-sms', twilioSmsWebhookRoutes); // No authentication for webhooks
console.log('✅ Mounted /api/webhooks/twilio-sms (public access)');

// ADD: Mount public onboarding routes (public access for agent onboarding)
const publicOnboardingRoutes = require('./routes/public/onboarding');
app.use('/api/public/onboarding', publicOnboardingRoutes); // No authentication for public onboarding access
console.log('✅ Mounted /api/public/onboarding (public access)');

// ADD: Mount public sign-acknowledgements routes (public access for signing acknowledgements via email/SMS)
const publicSignAcknowledgementsRoutes = require('./routes/public/sign-acknowledgements');
app.use('/api/public/sign-acknowledgements', publicSignAcknowledgementsRoutes); // No authentication for public acknowledgement signing
console.log('✅ Mounted /api/public/sign-acknowledgements (public access)');

const publicMarketingUnsubscribeRoutes = require('./routes/public/marketing-unsubscribe');
app.use('/api/public/marketing-unsubscribe', publicMarketingUnsubscribeRoutes);
console.log('✅ Mounted /api/public/marketing-unsubscribe (CAN-SPAM one-click unsubscribe)');

// ADD: Mount public tenant admin routes (public access for tenant admin password setup)
const publicTenantAdminRoutes = require('./routes/public/tenant-admin');
app.use('/api/public/tenant-admin', publicTenantAdminRoutes); // No authentication for public tenant admin access
console.log('✅ Mounted /api/public/tenant-admin (public access)');

const publicVendorExportDownloadRoutes = require('./routes/public/vendor-export-download');
app.use('/api/public/vendor-export', publicVendorExportDownloadRoutes);
console.log('✅ Mounted /api/public/vendor-export (signed eligibility file download)');

const publicFormsRoutes = require('./routes/public/public-forms');
const publicFormsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.PUBLIC_FORMS_RATE_LIMIT_MAX || 120),
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/public/forms', publicFormsLimiter, publicFormsRoutes);
console.log('✅ Mounted /api/public/forms (public sharing forms)');

const publicCaseStudiesRoutes = require('./routes/public/case-studies');
// Short 1-min window: public marketing read endpoint, multiple simultaneous site visitors
const publicCaseStudiesLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/public/case-studies', publicCaseStudiesLimiter, publicCaseStudiesRoutes); // No auth — published marketing content
console.log('✅ Mounted /api/public/case-studies (public marketing case studies)');
const publicNpiSearchRoutes = require('./routes/public/npi-search');
const publicNpiSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_NPI_RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/public/npi', publicNpiSearchLimiter, publicNpiSearchRoutes);
console.log('✅ Mounted /api/public/npi (public NPI provider search)');

const publicDeleteAccountRoutes = require('./routes/public/delete-account');
const publicDeleteAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.PUBLIC_DELETE_ACCOUNT_RATE_LIMIT_MAX || 20),
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/public/delete-account', publicDeleteAccountLimiter, publicDeleteAccountRoutes);
console.log('✅ Mounted /api/public/delete-account (public account cancellation request)');

// ShareWELL aggregate sharing statistics for marketing sites (public, cached, read-only)
const publicShareWellStatsRoutes = require('./routes/public/sharewell-stats');
const publicShareWellStatsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.PUBLIC_SHAREWELL_STATS_RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/public/sharewell-stats', publicShareWellStatsLimiter, publicShareWellStatsRoutes);
console.log('✅ Mounted /api/public/sharewell-stats (public ShareWELL sharing stats)');

// ADD: Mount AI chunks routes (for fetching AI chunks for chat widget)
const aiChunksRoutes = require('./routes/ai-chunks');
app.use('/api/ai', aiChunksRoutes); // No authentication for AI chunks access
console.log('✅ Mounted /api/ai (AI chunks access)');

// ADD: Mount tenant-scoped AI knowledge dashboard routes (TenantAdmin only)
const aiTenantKnowledgeRoutes = require('./routes/ai-tenant-knowledge');
app.use('/api/ai/tenant-knowledge', authenticateMiddleware, requireTenantAccess, aiTenantKnowledgeRoutes);
console.log('✅ Mounted /api/ai/tenant-knowledge (tenant-scoped, authenticated)');

// ADD: Mount AI product generator routes (for AI-powered product creation)
const aiProductGeneratorRoutes = require('./routes/ai-product-generator');
app.use('/api/ai', aiProductGeneratorRoutes); // Authentication required in route
console.log('✅ Mounted /api/ai (AI product generator)');

const aiCommissionRuleAssistantRoutes = require('./routes/ai-commission-rule-assistant');
app.use('/api/ai', aiCommissionRuleAssistantRoutes);
console.log('✅ Mounted /api/ai (commission rule assistant)');

// ADD: Mount tenant identification routes (mixed access - some public, some authenticated)
const tenantIdentificationRoutes = require('./routes/tenantIdentification');
app.use('/api/tenant-identification', tenantIdentificationRoutes); // Mixed access handled in route file
console.log('✅ Mounted /api/tenant-identification (mixed access)');

// Mount group products routes
if (groupProductsRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupProductsRoutes);
    console.log('✅ Mounted /api/groups (products) (with tenant access control)');
}

// Mount household vendor networks routes (per-household ID card network selection)
if (householdVendorNetworksRoutes) {
    app.use('/api/households', authenticateMiddleware, requireTenantAccess, householdVendorNetworksRoutes);
    console.log('✅ Mounted /api/households (vendor networks) (with tenant access control)');
}

// Mount group members routes
if (groupMembersRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupMembersRoutes);
    console.log('✅ Mounted /api/groups (members) (with tenant access control)');
}

// Mount group files routes FIRST (before groupsRoutes) to ensure specific routes like /:groupId/documents are matched before the catch-all /:id route
if (groupFilesRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupFilesRoutes);
    console.log('✅ Mounted /api/groups (files) (with tenant access control)');
}

// ADD: Mount group contributions routes
if (groupContributionsRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupContributionsRoutes);
    console.log('✅ Mounted /api/groups (contributions) (with tenant access control)');
}

// ADD: Mount group billing routes
if (groupBillingRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupBillingRoutes);
    console.log('✅ Mounted /api/groups (billing) (with tenant access control)');
}

// ADD: Mount group advanced routes (change effective date, etc.)
if (groupAdvancedRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupAdvancedRoutes);
    console.log('✅ Mounted /api/groups (advanced) (with tenant access control)');
}

// ADD: Mount group ASA status routes
if (groupASAStatusRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupASAStatusRoutes);
    console.log('✅ Mounted /api/groups (ASA status) (with tenant access control)');
}

// ADD: Mount group new group form routes (generate PDF, send email to vendor)
if (groupNewGroupFormRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupNewGroupFormRoutes);
    console.log('✅ Mounted /api/groups (new group form) (with tenant access control)');
}

// Mount groups routes LAST (after all specific routes) to ensure catch-all /:id route doesn't intercept specific routes
if (groupsRoutes) {
    app.use('/api/groups', authenticateMiddleware, requireTenantAccess, groupsRoutes);
    console.log('✅ Mounted /api/groups (with tenant access control)');
}

// Mount group-type-change-requests routes (vendor minimums / list-bill feature)
app.use('/api/group-type-change-requests', authenticateMiddleware, requireTenantAccess, require('./routes/group-type-change-requests'));
console.log('✅ Mounted /api/group-type-change-requests (with tenant access control)');

if (enrollmentRoutes) {
    app.use('/api/enrollments', authenticateMiddleware, requireTenantAccess, enrollmentRoutes);
    console.log('✅ Mounted /api/enrollments (with tenant access control)');
}

if (uploadsRoutes && uploadsRoutes.router) {
    // All uploads require authentication to prevent anonymous abuse (no /api/public/uploads)
    app.use('/api/uploads', authenticateMiddleware, uploadsRoutes.router);
    console.log('✅ Mounted /api/uploads (authenticated only)');
    // Token-protected upload for onboarding only (group linkToken or agent sessionToken required)
    if (uploadsRoutes.onboardingUploadRouter) {
        app.use('/api/public/onboarding-upload', uploadsRoutes.onboardingUploadRouter);
        console.log('✅ Mounted /api/public/onboarding-upload (token-validated only)');
    }
}

// Mount email routes WITH AUTHENTICATION
if (emailRoutes) {
    app.use('/api/email', authenticateMiddleware, emailRoutes);
    console.log('✅ Mounted /api/email - Email Service (AUTHENTICATED)');
}

// Always mount these since they exist
app.use('/api/payments', authenticateMiddleware, requireTenantAccess, paymentsRoutes);
console.log('✅ Mounted /api/payments');

// Mount individual payments routes (authenticated)
const individualPaymentsRoutes = require('./routes/individual-payments');
app.use('/api/individual-payments', authenticateMiddleware, individualPaymentsRoutes);
console.log('✅ Mounted /api/individual-payments');


// Mount effective dates routes
const effectiveDatesRoutes = require('./routes/effective-dates');
app.use('/api/effective-dates', effectiveDatesRoutes);
console.log('✅ Mounted /api/effective-dates');

app.use('/api/accounting', authenticateMiddleware, accountingRoutes);
app.use('/api/accounting/nacha', authenticateMiddleware, nachaRoutes);
console.log('✅ Mounted /api/accounting');
console.log('✅ Mounted /api/accounting/nacha');

const { internalRouter: invoicesInternalRoutes, readRouter: invoicesReadRoutes } = require('./routes/invoices');
app.use('/api/invoices', invoicesInternalRoutes);
app.use('/api/invoices', authenticateMiddleware, requireTenantAccess, invoicesReadRoutes);
console.log('✅ Mounted /api/invoices (internal + auth/tenant-scoped read)');

// PHASE 1: Commission system routes
if (commissionsRoutes) {
    app.use('/api/commissions', authenticateMiddleware, requireTenantAccess, commissionsRoutes);
    console.log('✅ Mounted /api/commissions - Phase 1 Commission System (with tenant access control)');
}

if (agencyRoutes) {
    app.use('/api/agencies', authenticateMiddleware, agencyRoutes);
    console.log('✅ Mounted /api/agencies - Phase 1 Agency Management');
}

if (reportsRoutes) {
    app.use('/api/reports', authenticateMiddleware, reportsRoutes);
    console.log('✅ Mounted /api/reports');
}

if (marketplaceRoutes) {
    app.use('/api/marketplace', authenticateMiddleware, marketplaceRoutes);
    console.log('✅ Mounted /api/marketplace');
}

if (subscriptionsRoutes) {
    app.use('/api/subscriptions', authenticateMiddleware, subscriptionsRoutes);
    console.log('✅ Mounted /api/subscriptions');
}

if (adminRoutes) {
    app.use('/api/admin', authenticateMiddleware, adminRoutes);
    console.log('✅ Mounted /api/admin');
}

// Admin Tenant Management routes
const tenantAdminsRoutes = require('./routes/admin/tenant-admins');
app.use('/api/admin/tenant-admins', authenticateMiddleware, tenantAdminsRoutes);
console.log('✅ Mounted /api/admin/tenant-admins routes');

// ADD: Mount agent routes
if (agentsRoutes) {
    app.use('/api/agents', authenticateMiddleware, agentsRoutes);
    console.log('✅ Mounted /api/agents');
}

// ADD: Mount tenant-scoped agent lookup (used by external sites like mightywellhealth.com
// to resolve `?id=AGENTCODE` / `?name=First Last` URL params into an agent's email).
// Auth: existing API-key flow via Authorization: Bearer sk_live_...
const agentLookupRoutes = require('./routes/agent-lookup');
app.use('/api/agent-lookup', authenticateMiddleware, agentLookupRoutes);
console.log('✅ Mounted /api/agent-lookup');

// Website form submissions: lookup + audit log + (digest source).
// Same tenant API key auth; tenant inferred from the key.
const websiteFormSubmissionsRoutes = require('./routes/website-form-submissions');
app.use('/api/website-form-submissions', authenticateMiddleware, websiteFormSubmissionsRoutes);
console.log('✅ Mounted /api/website-form-submissions');

// Cron-triggered jobs. NOT behind authenticateMiddleware — they use a shared
// secret header (CRON_SHARED_SECRET) compared with crypto.timingSafeEqual.
const websiteFormDigestCronRoutes = require('./routes/cron/website-form-digest');
app.use('/api/cron/website-form-digest', websiteFormDigestCronRoutes);
console.log('✅ Mounted /api/cron/website-form-digest');

// ADD: Mount vendors routes
if (vendorsRoutes) {
    app.use('/api/vendors', authenticateMiddleware, vendorsRoutes);
    console.log('✅ Mounted /api/vendors');
}

// ADD: Mount vendor Group IDs routes
let vendorGroupIdsRoutes;
try {
    vendorGroupIdsRoutes = require('./routes/vendorGroupIds');
    app.use('/api/vendor-group-ids', authenticateMiddleware, vendorGroupIdsRoutes);
    console.log('✅ Mounted /api/vendor-group-ids');
} catch (e) {
    console.warn('⚠️ Vendor Group IDs routes not found:', e.message);
}

// ADD: Mount document signatures routes
let documentSignaturesRoutes;
try {
    documentSignaturesRoutes = require('./routes/document-signatures');
    console.log('✅ Document Signatures routes imported successfully');
} catch (e) {
    console.warn('⚠️ Document Signatures routes not found:', e.message);
}

// ADD: Mount proposal documents routes
let proposalDocumentsRoutes;
try {
    proposalDocumentsRoutes = require('./routes/proposal-documents');
    console.log('✅ Proposal Documents routes imported successfully');
} catch (e) {
    console.warn('⚠️ Proposal Documents routes not found:', e.message);
}

// ADD: Mount proposal sends routes
let proposalSendsRoutes;
try {
    proposalSendsRoutes = require('./routes/proposal-sends');
    console.log('✅ Proposal Sends routes imported successfully');
} catch (e) {
    console.warn('⚠️ Proposal Sends routes not found:', e.message);
}

// ADD: Mount business proposal sends routes
let businessProposalSendsRoutes;
try {
    businessProposalSendsRoutes = require('./routes/business-proposal-sends');
    console.log('✅ Business Proposal Sends routes imported successfully');
} catch (e) {
    console.warn('⚠️ Business Proposal Sends routes not found:', e.message);
}

if (documentSignaturesRoutes) {
    // Mount public routes FIRST (before authenticated routes) for group onboarding
    // These need to be accessible without authentication for public group onboarding
    const DocumentSignatureService = require('./services/documentSignature.service');
    
    // Public template endpoint (for group onboarding) - mount BEFORE authenticated routes
    app.get('/api/document-signatures/templates/:documentId', async (req, res) => {
      try {
        const { documentId } = req.params;
        if (!documentId) {
          return res.status(400).json({
            success: false,
            message: 'Document ID is required'
          });
        }
        const template = await DocumentSignatureService.getSignatureTemplate(documentId);
        res.json({
          success: true,
          data: template
        });
      } catch (error) {
        console.error('❌ Error getting signature template (public):', error);
        res.status(500).json({
          success: false,
          message: 'Failed to get signature template',
          error: {
            message: error.message,
            code: 'TEMPLATE_FETCH_ERROR'
          }
        });
      }
    });
    
    // Public proxy endpoint (for group onboarding) - mount BEFORE authenticated routes
    app.get('/api/document-signatures/documents/:documentId/proxy', async (req, res) => {
      try {
        const { documentId } = req.params;
        if (!documentId) {
          return res.status(400).json({
            success: false,
            message: 'Document ID is required'
          });
        }
        const pdfBuffer = await DocumentSignatureService.downloadPDFFromAzure(
          await DocumentSignatureService.getDocument(documentId)
        );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(pdfBuffer);
      } catch (error) {
        console.error('❌ Error proxying PDF document (public):', error);
        res.status(500).json({
          success: false,
          message: 'Failed to load PDF document',
          error: {
            message: error.message,
            code: 'PDF_PROXY_ERROR'
          }
        });
      }
    });
    
    // Public apply endpoint (for group onboarding) - mount BEFORE authenticated routes
    app.post('/api/document-signatures/apply', async (req, res) => {
      try {
        const { documentId, signatureData, autoFillData } = req.body;
        
        if (!documentId) {
          return res.status(400).json({
            success: false,
            message: 'Document ID is required'
          });
        }
        
        if (!signatureData || typeof signatureData !== 'object') {
          return res.status(400).json({
            success: false,
            message: 'Signature data is required'
          });
        }
        
        // Validate ESIGN compliance
        const compliance = DocumentSignatureService.validateESIGNCompliance({
          consentToElectronicSignature: req.body.consentToElectronicSignature,
          ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'] || 'Unknown',
          signedDate: new Date().toISOString()
        });
        
        if (!compliance.isValid) {
          return res.status(400).json({
            success: false,
            message: 'ESIGN Act compliance validation failed',
            errors: compliance.errors
          });
        }
        
        // Get document to get file name
        const document = await DocumentSignatureService.getDocument(documentId);
        
        // Apply signatures to PDF
        const signedPdfBuffer = await DocumentSignatureService.applySignaturesToPDF(
          documentId,
          signatureData,
          autoFillData || {}
        );
        
        // Upload signed PDF
        const signedPdfUrl = await DocumentSignatureService.uploadSignedPDF(
          signedPdfBuffer,
          document.FileName || 'signed-document.pdf',
          'agreements',
          `signed-documents/${documentId}/${Date.now()}_signed.pdf`
        );
        
        // Generate authenticated URL for the signed document
        const { generateAuthenticatedUrl } = require('./routes/uploads');
        let authenticatedSignedUrl = signedPdfUrl;
        try {
          authenticatedSignedUrl = await generateAuthenticatedUrl(signedPdfUrl);
        } catch (authError) {
          console.warn('⚠️ Failed to authenticate signed PDF URL, using original:', authError.message);
        }
        
        res.json({
          success: true,
          data: {
            signedDocumentUrl: authenticatedSignedUrl,
            documentId: documentId
          },
          message: 'Signatures applied successfully'
        });
      } catch (error) {
        console.error('❌ Error applying signatures (public):', error);
        res.status(500).json({
          success: false,
          message: 'Failed to apply signatures',
          error: {
            message: error.message,
            code: 'APPLY_SIGNATURES_ERROR'
          }
        });
      }
    });
    
    console.log('✅ Mounted /api/document-signatures (public template/proxy/apply endpoints)');
    
    // Mount authenticated routes AFTER public routes
    app.use('/api/document-signatures', authenticateMiddleware, documentSignaturesRoutes);
    console.log('✅ Mounted /api/document-signatures (authenticated)');
}

// ADD: Mount proposal documents routes (router applies requireTenantAccess for X-Current-Tenant-Id)
if (proposalDocumentsRoutes) {
    app.use('/api/proposal-documents', authenticateMiddleware, proposalDocumentsRoutes);
    console.log('✅ Mounted /api/proposal-documents');
}

// ADD: Mount proposal sends routes — requireTenantAccess so X-Current-Tenant-Id updates req.user.TenantId before agent validation
if (proposalSendsRoutes) {
    app.use('/api/proposal-sends', authenticateMiddleware, requireTenantAccess, proposalSendsRoutes);
    console.log('✅ Mounted /api/proposal-sends (with tenant access / multi-tenant switch)');
}

// ADD: Mount business proposal sends routes
if (businessProposalSendsRoutes) {
    app.use('/api/business-proposal-sends', authenticateMiddleware, requireTenantAccess, businessProposalSendsRoutes);
    console.log('✅ Mounted /api/business-proposal-sends (with tenant access / multi-tenant switch)');
}

// Mount prospects CRM routes — tenant-scoped; visibility resolved per-role inside the router
const prospectsRoutes = require('./routes/prospects');
app.use('/api/prospects', authenticateMiddleware, requireTenantAccess, prospectsRoutes);
console.log('✅ Mounted /api/prospects (Prospects CRM, tenant-scoped)');

// Mount quotes routes — lightweight quotes that auto-create/link a prospect
const quotesRoutes = require('./routes/quotes');
app.use('/api/quotes', authenticateMiddleware, requireTenantAccess, quotesRoutes);
console.log('✅ Mounted /api/quotes (tenant-scoped)');

// Mount prospect tags routes — agency-shared, colored tags for prospects
const prospectTagsRoutes = require('./routes/prospect-tags');
app.use('/api/prospect-tags', authenticateMiddleware, requireTenantAccess, prospectTagsRoutes);
console.log('✅ Mounted /api/prospect-tags (tenant-scoped)');

// Mount agent API key management (agent mints/revokes their own lead-ingest key)
const agentApiKeysRoutes = require('./routes/agent-api-keys');
app.use('/api/agent-api-keys', authenticateMiddleware, requireTenantAccess, agentApiKeysRoutes);
console.log('✅ Mounted /api/agent-api-keys');

// Mount prospect sources — agent-owned source CRUD (website / landing / api link codes)
app.use('/api/prospect-sources', authenticateMiddleware, requireTenantAccess, require('./routes/prospect-sources'));
console.log('✅ Mounted /api/prospect-sources (agent prospect source CRUD, tenant-scoped)');

// Mount tenant-level Website Integration API key management (TenantAdmin mints/revokes a shared website key)
const tenantApiKeysRoutes = require('./routes/tenant-api-keys');
app.use('/api/tenant-api-keys', authenticateMiddleware, requireTenantAccess, tenantApiKeysRoutes);
console.log('✅ Mounted /api/tenant-api-keys');

// Mount lead ingest (auth via agent-scoped API key; no tenant header needed)
const leadIngestRoutes = require('./routes/lead-ingest');
app.use('/api/lead-ingest', authenticateMiddleware, leadIngestRoutes);
console.log('✅ Mounted /api/lead-ingest (API-key lead intake)');

// ============================================================================
// TENANT ADMIN ROUTES - CRITICAL: CORRECT ORDER
// ============================================================================

// STEP 1: Mount GENERAL tenant admin routes FIRST (handles /settings, /metrics, etc.)
app.use('/api/tenant-admin', authenticateMiddleware, tenantAdminRoutes);
console.log('✅ Mounted /api/tenant-admin (general routes including /settings, /metrics, /financial-summary)');

// STEP 2: Mount SPECIFIC agent routes SECOND
app.use('/api/tenant-admin', authenticateMiddleware, tenantAdminAgentsRoutes);
console.log('✅ Mounted /api/tenant-admin (agent routes including /agents/*)');

app.use('/api/tenant-admin/agent-overrides', authenticateMiddleware, tenantAdminAgentOverridesRoutes);
console.log('✅ Mounted /api/tenant-admin/agent-overrides (agent-to-agent commission overrides)');

app.use('/api/tenant-admin/agents', authenticateMiddleware, tenantAdminAgentCommissionPayoutsRoutes);
console.log('✅ Mounted /api/tenant-admin/agents (commission payout routes)');


// Mount group admin routes
if (groupAdminRoutes) {
    app.use('/api/group-admin', authenticateMiddleware, groupAdminRoutes);
    console.log('✅ Mounted /api/group-admin routes');
}

// ============================================================================
// "ME" ROUTES MOUNTING - UNIFIED APPROACH ONLY
// ============================================================================

// CRITICAL: Use ONLY the unified approach to avoid routing conflicts
// All specific role routes (/member, /agent, /tenant-admin, etc.) are handled 
// through the unified /api/me router in ./routes/me/index.js

// Public wallet pass download (no auth — the download token IS the auth)
const { walletDownloadRouter } = require('./routes/me/member/wallet');
app.use('/api/me/member/wallet', walletDownloadRouter);

// Public email-signature image hosting (no auth — referenced by <img> in emails)
const emailAssetsPublicRoutes = require('./routes/public/email-assets');
app.use('/api/public', emailAssetsPublicRoutes);
console.log('✅ Mounted /api/public (email signature image hosting)');

// Email-signature photo upload (own auth; mounted before the generic /api/me)
const emailSignatureRoutes = require('./routes/me/email-signature');
app.use('/api/me/email-signature', emailSignatureRoutes);
console.log('✅ Mounted /api/me/email-signature');

// Mount the unified /api/me routes (includes /member, /agent, etc.)
app.use('/api/me', authenticate, meRoutes);
console.log('✅ Mounted /api/me routes (unified approach - handles all /member, /agent, /tenant-admin sub-routes)');

// ============================================================================
// PRICING ROUTES - NEW UNIFIED PRICING SYSTEM
// ============================================================================

// Import pricing routes
const pricingRoutes = require('./routes/pricing');

// Mount main pricing routes (admin-scoped)
app.use('/api/pricing', authenticateMiddleware, pricingRoutes);
console.log('✅ Mounted /api/pricing routes (unified pricing system)');

// Dev routes (development only) - Load early to ensure they're available
if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'production') {
    try {
        const devMembersRoutes = require('./routes/dev/members');
        app.use('/api/dev', authenticateMiddleware, devMembersRoutes);
        console.log('✅ Mounted /api/dev routes (development only)');
    } catch (error) {
        console.warn('⚠️ Dev routes not available:', error.message);
    }
}

if (metricsRoutes) {
    app.use('/api/metrics', authenticateMiddleware, requireTenantAccess, metricsRoutes);
    console.log('✅ Mounted /api/metrics');
}

// STEP 3: Mount DKIM routes THIRD - for both SysAdmin and TenantAdmin
if (dkimRoutes) {
    app.use('/api/tenants', authenticateMiddleware, dkimRoutes); // Mounts SysAdmin routes like /api/tenants/:id/dkim/test
    app.use('/api/tenant-admin', authenticateMiddleware, dkimRoutes); // Mounts TenantAdmin routes like /api/tenant-admin/dkim/test
    console.log('✅ Mounted DKIM routes (SysAdmin: /api/tenants/:id/dkim/*, TenantAdmin: /api/tenant-admin/dkim/*)');
}

// Test routes (development only) - Mounted independently
if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    try {
        const testCommissionRoutes = require('./routes/test-commission');
        app.use('/api/test/commissions', testCommissionRoutes);
        console.log('✅ Test commission routes loaded (development only)');
    } catch (error) {
        console.warn('⚠️ Test commission routes not available:', error.message);
    }
}

// Diagnostics Routes - Azure Front Door health check
const diagnosticsRoutes = require('./routes/diagnostics');
app.use('/api/diagnostics', diagnosticsRoutes);
console.log('✅ Mounted /api/diagnostics routes (Azure Front Door diagnostics)');

// Additional Azure Front Door diagnostics
const afdDiagnosticsRoutes = require('./routes/diagnostics-afd');
app.use('/api/diagnostics/afd', authenticateMiddleware, afdDiagnosticsRoutes);
console.log('✅ Mounted /api/diagnostics/afd routes (Detailed Azure Front Door diagnostics)');

// Custom Domains Routes - for Azure Front Door integration
const customDomainsRoutes = require('./routes/custom-domains');
app.use('/api/custom-domains', authenticateMiddleware, customDomainsRoutes);
console.log('✅ Mounted /api/custom-domains routes (Azure Front Door integration)');

// Webhook Routes - handled by Azure Functions (oe_payment_manager/WebhookProcessor)
// No backend routes needed for webhooks

// Email Configuration Routes - for SendGrid DKIM integration
const emailConfigRoutes = require('./routes/email-config');
app.use('/api/email-config', authenticateMiddleware, emailConfigRoutes);
console.log('✅ Mounted /api/email-config routes (SendGrid DKIM integration)');

// SFTP Import Scheduled Job Route (mounted before general /api/scheduled-jobs to take priority)
app.use('/api/scheduled-jobs/sftp-import', require('./routes/scheduled-jobs/sftp-import'));
console.log('✅ Mounted /api/scheduled-jobs/sftp-import route');

// Scheduled Jobs Routes
const scheduledJobsRoutes = require('./routes/scheduled-jobs');
app.use('/api/scheduled-jobs', scheduledJobsRoutes);
console.log('✅ Mounted /api/scheduled-jobs routes (monthly payment calculations)');

// Employee-facing docs routes
app.use(require('./routes/groups.employee-docs'));
console.log('✅ Mounted /api/groups/:groupId/employee-docs routes');

// Tenant Products Routes - for managing product subscriptions
if (tenantProductsRoutes) {
    app.use('/api/tenant', authenticateMiddleware, tenantProductsRoutes);
    app.use('/api/products', authenticateMiddleware, tenantProductsRoutes); // This handles the /catalog endpoint
    console.log('✅ Mounted /api/tenant (product subscriptions)');
    console.log('✅ Mounted /api/products/catalog');
}

// ME routes (user-scoped endpoints)
// app.use('/api/me', authenticate, meRoutes); // This line is removed as per the edit hint

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Sentry error handler must come before other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Multer error handling
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 25MB.'
            });
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Too many files. Maximum is 20 files per request.'
            });
        }
    }
    
    if (error.message.includes('File type') && error.message.includes('not allowed')) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
    
    next(error);
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('❌ Express Error:', err.stack);

    const distinctId = req.user?.UserId || req.user?.userId || 'anonymous';
    posthog.captureException(err, String(distinctId), {
        path: req.path,
        method: req.method,
    });
    
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ 
            success: false,
            message: 'CORS policy violation' 
        });
    }
    
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({ 
            success: false,
            message: 'Invalid token' 
        });
    }
    
    if (err.name === 'ValidationError') {
        return res.status(400).json({ 
            success: false,
            message: err.message 
        });
    }
    
    res.status(500).json({ 
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false,
        message: 'Route not found',
        path: req.path,
        method: req.method,
        suggestion: 'Visit /api/debug/routes to see available endpoints'
    });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.OE_TEST_BACKEND_PORT || process.env.PORT || 3001;

/** Active HTTP server — set once listen succeeds. */
let activeServer = null;
let shuttingDown = false;

function closeActiveServer() {
    return new Promise((resolve) => {
        if (!activeServer) {
            resolve();
            return;
        }
        const server = activeServer;
        activeServer = null;
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        server.close(() => resolve());
    });
}

function registerProcessShutdownHandlers() {
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${signal} received, closing HTTP server…`);
        const forceExit = setTimeout(() => {
            console.warn('Shutdown timed out — forcing exit.');
            process.exit(0);
        }, 5000);
        forceExit.unref();
        await closeActiveServer();
        clearTimeout(forceExit);
        process.exit(0);
    };
    // Nodemon uses SIGTERM (see nodemon.json) and waits for exit before spawning the next process.
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

registerProcessShutdownHandlers();

/**
 * Bind HTTP server. In dev, retry briefly when nodemon overlap still holds the port.
 * Each attempt uses a fresh Server instance (reuse after EADDRINUSE is unreliable).
 */
function listenWithDevRetries(dbHealthy) {
    const isDev = process.env.NODE_ENV === 'development';
    const maxAttempts = isDev ? 20 : 1;
    const retryMs = 1000;

    return new Promise((resolve, reject) => {
        const tryBind = (attempt) => {
            const server = http.createServer(app);

            const onListening = () => {
                server.removeListener('error', onError);
                console.log(`\n🚀 AllAboard365 Backend Server is now running.`);
                console.log(`   - Port: ${PORT}`);
                console.log(`   - Environment: ${process.env.NODE_ENV || 'development'}`);
                console.log(`   - Database: ${dbHealthy ? 'Connected' : 'Disconnected / Not Configured'}`);
                console.log(`   - Auth Bypass: ${process.env.BYPASS_AUTH === 'true' ? 'Enabled' : 'Disabled'}`);

                const envOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
                console.log(`   - CORS Origins: ${envOrigins.length > 0 ? envOrigins.join(', ') : 'Using static list'}`);

                console.log(`\n   🔗 Health Check: http://localhost:${PORT}/health`);
                console.log(`   🛠️  Debug Routes: http://localhost:${PORT}/api/debug/routes\n`);

                activeServer = server;
                resolve(server);
            };

            const onError = (err) => {
                server.removeListener('listening', onListening);
                if (err.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
                    console.warn(
                        `⚠️ Port ${PORT} still busy (waiting for prior process to exit). `
                        + `Retry ${attempt + 1}/${maxAttempts} in ${retryMs}ms…`
                    );
                    if (typeof server.closeAllConnections === 'function') {
                        server.closeAllConnections();
                    }
                    server.close(() => setTimeout(() => tryBind(attempt + 1), retryMs));
                    return;
                }
                if (err.code === 'EADDRINUSE') {
                    console.error(`\n❌ Port ${PORT} is already in use after ${maxAttempts} attempts.`);
                    console.error('   Another node/nodemon process is probably still running.');
                    console.error(`   Run: npx kill-port ${PORT}`);
                    console.error('   Also check for duplicate "npm run dev" / nodemon tabs.\n');
                } else {
                    console.error('❌ Server error:', err);
                }
                reject(err);
            };

            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(PORT);
        };

        tryBind(0);
    });
}

async function startServer() {
    try {
        let dbHealthy = false;
        try {
            const { testConnection } = require('./config/database');
            dbHealthy = await testConnection();
        } catch (dbError) {
            console.warn('⚠️ Database not configured or connection failed. Server will start but may not be fully functional.');
        }

        const server = await listenWithDevRetries(dbHealthy);
        server.timeout = 3600000;
        if ('requestTimeout' in server) {
            server.requestTimeout = 3600000;
        }
        if ('headersTimeout' in server) {
            server.headersTimeout = 3660000;
        }
    } catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;