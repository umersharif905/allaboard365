// backend/middleware/cors.js
/**
 * CORS Middleware with Wildcard Subdomain Support and Dynamic Custom Domain Loading
 * Handles CORS for Azure App Service with wildcard subdomain patterns
 * Dynamically loads verified white-labeled custom domains from the database
 */

const cors = require('cors');

// Cache for custom domains (white-labeled domains)
let customDomainsCache = [];
let customDomainsCacheTimestamp = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

/**
 * Fetch all verified custom domains from the database
 * Returns array of hostnames (e.g., ['portal.clientdomain.com', 'app.anotherdomain.com'])
 */
async function fetchVerifiedCustomDomains() {
    try {
        const { getPool, sql } = require('../config/database');
        const pool = await getPool();
        
        // Query for tenants with verified custom domains
        // Check both CustomDomain field and AdvancedSettings JSON (multiple paths)
        const query = `
            SELECT DISTINCT
                t.TenantId,
                t.Name as TenantName,
                COALESCE(
                    NULLIF(t.CustomDomain, ''),
                    NULLIF(json_value(t.AdvancedSettings, '$.domain.hostName'), ''),
                    NULLIF(json_value(t.AdvancedSettings, '$.domain.customDomain'), '')
                ) as HostName,
                json_value(t.AdvancedSettings, '$.domain.verificationStatus') as VerificationStatus,
                json_value(t.AdvancedSettings, '$.domain.endpointAssociation') as EndpointAssociation
            FROM oe.Tenants t
            WHERE t.Status = 'Active'
                AND (
                    (t.CustomDomain IS NOT NULL AND t.CustomDomain != '')
                    OR json_value(t.AdvancedSettings, '$.domain.hostName') IS NOT NULL
                    OR json_value(t.AdvancedSettings, '$.domain.customDomain') IS NOT NULL
                )
        `;
        
        const result = await pool.request().query(query);
        
        const verifiedDomains = [];
        const unverifiedDomains = [];
        
        for (const row of result.recordset) {
            const hostName = row.HostName;
            const verificationStatus = row.VerificationStatus;
            const endpointAssociation = row.EndpointAssociation;
            const tenantName = row.TenantName;
            
            if (!hostName) continue;
            
            // Normalize hostname: remove protocol if present, remove port, lowercase
            let normalizedHostname = hostName.toLowerCase().trim();
            // Remove protocol
            normalizedHostname = normalizedHostname.replace(/^https?:\/\//, '');
            // Remove port
            normalizedHostname = normalizedHostname.split(':')[0];
            
            // Normalize to https:// protocol for CORS origin matching
            const normalizedDomain = `https://${normalizedHostname}`;
            
            // Include verified domains OR domains that are associated with endpoint
            // In production, we may want to be more lenient and allow configured domains
            const isVerified = verificationStatus === 'verified' || endpointAssociation === 'Associated';
            
            if (isVerified) {
                verifiedDomains.push(normalizedDomain);
                console.log(`   ✅ Verified: ${normalizedDomain} (${tenantName || 'Unknown'})`);
            } else {
                unverifiedDomains.push({ domain: normalizedDomain, tenant: tenantName, status: verificationStatus, association: endpointAssociation });
                console.log(`   ⚠️  Unverified: ${normalizedDomain} (${tenantName || 'Unknown'}) - Status: ${verificationStatus || 'null'}, Association: ${endpointAssociation || 'null'}`);
            }
        }
        
        // In production, optionally allow configured but unverified domains
        // This prevents CORS errors during domain setup/verification with Azure Front Door
        // Set ALLOW_UNVERIFIED_DOMAINS=true in production if domains are configured in Front Door
        // but verification status hasn't been updated in the database yet
        const productionMode = process.env.NODE_ENV === 'production';
        const allowUnverified = process.env.ALLOW_UNVERIFIED_DOMAINS === 'true';
        
        if (productionMode && unverifiedDomains.length > 0) {
            console.log(`   ℹ️  Production mode: Found ${unverifiedDomains.length} configured but unverified domains`);
            if (allowUnverified) {
                console.log(`   ⚠️  ALLOW_UNVERIFIED_DOMAINS=true: Including unverified domains for CORS`);
                unverifiedDomains.forEach(({ domain, tenant }) => {
                    verifiedDomains.push(domain);
                    console.log(`   ✅ Allowing unverified: ${domain} (${tenant || 'Unknown'})`);
                });
            } else {
                console.log(`   ℹ️  Set ALLOW_UNVERIFIED_DOMAINS=true to allow these domains in production`);
            }
        }
        
        console.log(`✅ Loaded ${verifiedDomains.length} verified custom domains for CORS`);
        if (verifiedDomains.length > 0) {
            console.log(`   Custom domains: ${verifiedDomains.join(', ')}`);
        }
        
        return verifiedDomains;
    } catch (error) {
        console.error('❌ Error fetching verified custom domains for CORS:', error.message);
        // Return empty array on error to prevent blocking all requests
        return [];
    }
}

/**
 * Refresh the custom domains cache
 */
async function refreshCustomDomainsCache() {
    try {
        customDomainsCache = await fetchVerifiedCustomDomains();
        customDomainsCacheTimestamp = Date.now();
        return customDomainsCache;
    } catch (error) {
        console.error('❌ Error refreshing custom domains cache:', error.message);
        return customDomainsCache; // Return cached value on error
    }
}

/**
 * Get custom domains from cache (refresh if expired)
 */
async function getCustomDomains() {
    const now = Date.now();
    
    // If cache is empty or expired, refresh it
    if (customDomainsCache.length === 0 || 
        !customDomainsCacheTimestamp || 
        (now - customDomainsCacheTimestamp) > CACHE_TTL) {
        await refreshCustomDomainsCache();
    }
    
    return customDomainsCache;
}

/**
 * Build a CORS configuration that supports wildcard subdomains and custom domains
 * Reads from process.env.ALLOWED_ORIGINS which can contain patterns like:
 * - Specific origins: https://app.allaboard365.com
 * - Wildcard patterns: *.allaboard365.com
 * Also dynamically loads verified custom domains from the database
 */
const buildCorsMiddleware = () => {
    // Read environment variable (comma-separated list)
    // Supports both wildcard patterns (*.domain.com) and specific origins (https://app.domain.com)
    // Default includes allaboard365.com wildcard for backward compatibility
    const envPattern = process.env.ALLOWED_ORIGINS || '*.allaboard365.com';
    const patterns = envPattern.split(',').map(p => p.trim()).filter(Boolean);
    
    // Separate wildcard patterns from specific origins
    const specificOrigins = [];
    const wildcardPatterns = [];
    
    patterns.forEach(pattern => {
        if (pattern.includes('*')) {
            wildcardPatterns.push(pattern);
        } else {
            specificOrigins.push(pattern);
        }
    });
    
    // Build regex from wildcard patterns
    const wildcardRegexes = wildcardPatterns.map(pattern => {
        // Convert *.allaboard365.com to /^.*\.allaboard365\.com$/
        // First escape dots, then convert wildcards (order matters!)
        const regexPattern = pattern
            .replace(/\./g, '\\.')          // . -> \. (escape dots first)
            .replace(/\*/g, '.*');          // * -> .* (then wildcards)
        return new RegExp(`^${regexPattern}$`);
    });
    
    // Static origins for backward compatibility and development
    // NOTE: For production multi-tenant deployments, use ALLOWED_ORIGINS environment variable instead
    // This static list is only for:
    // 1. Development (localhost)
    // 2. Default/primary brand (allaboard365.com) for backward compatibility
    // 3. Known shared custom domains
    // DO NOT add tenant-specific domains here - use ALLOWED_ORIGINS environment variable
    const staticOrigins = [
        // Development origins
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:5174',
        // Default/primary brand (allaboard365.com) - for backward compatibility only
        // Known shared custom domains (cross-tenant)
        'https://portal.mightywellhealth.com',
        // ShareWELL + MightyWell public marketing sites (consume /api/public/sharewell-stats)
        'https://sharewellhealth.org',
        'https://www.sharewellhealth.org',
        'https://mightywellhealth.com',
        'https://www.mightywellhealth.com',
        // AllAboard365 Azure deployment (frontend origin)
        'https://allaboard365-atc0eaaqbac5dhay.centralus-01.azurewebsites.net',
        'https://app.allaboard365.com'
    ];
    
    // Load custom domains on initialization (async, but we'll check cache in origin function)
    refreshCustomDomainsCache().catch(err => {
        console.warn('⚠️ Failed to load custom domains on CORS initialization:', err.message);
    });
    
    // Create CORS options with dynamic origin checking
    // NOTE: Using synchronous check first, then async fallback for custom domains
    // This ensures preflight requests work even if database is slow/unavailable
    const corsOptions = {
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, Postman, curl, etc.)
            if (!origin) {
                console.log('🔍 CORS: No origin header (allowing)');
                return callback(null, true);
            }
            
            console.log(`🔍 CORS check for origin: ${origin}`);
            
            // Get static + env origins (synchronous check - fast path)
            const allSpecificOrigins = [...new Set([...staticOrigins, ...specificOrigins])];
            
            // Check specific origins first (exact match) - SYNCHRONOUS
            if (allSpecificOrigins.includes(origin)) {
                console.log(`✅ CORS allowed (exact match): ${origin}`);
                return callback(null, true);
            }
            
            // Parse origin to extract hostname for hostname-based matching
            let originHostname = null;
            try {
                const url = new URL(origin);
                originHostname = url.hostname;
                
                // Check wildcard patterns - SYNCHRONOUS
                for (const regex of wildcardRegexes) {
                    if (regex.test(originHostname)) {
                        console.log(`✅ CORS allowed (wildcard match): ${origin} matches pattern ${regex}`);
                        return callback(null, true);
                    }
                }
                
                // Check static origins by hostname (in case protocol/port differs)
                for (const allowedOrigin of allSpecificOrigins) {
                    try {
                        const allowedUrl = new URL(allowedOrigin);
                        if (allowedUrl.hostname === originHostname) {
                            console.log(`✅ CORS allowed (hostname match): ${origin} matches ${allowedOrigin}`);
                            return callback(null, true);
                        }
                    } catch (e) {
                        // Skip invalid URLs in allowed origins list
                        continue;
                    }
                }
            } catch (e) {
                console.warn(`⚠️ CORS: Invalid origin URL: ${origin}`, e.message);
            }
            
            // For custom domains, check cache synchronously (may be empty on first request)
            // This prevents blocking if database is slow, while still allowing custom domains once cached
            const cachedCustomDomains = customDomainsCache || [];
            const allAllowedOrigins = [...new Set([...allSpecificOrigins, ...cachedCustomDomains])];
            
            // Check cached custom domains (exact match)
            if (cachedCustomDomains.includes(origin)) {
                console.log(`✅ CORS allowed (cached custom domain): ${origin}`);
                return callback(null, true);
            }
            
            // Check cached custom domains by hostname
            if (originHostname) {
                for (const allowedOrigin of cachedCustomDomains) {
                    try {
                        const allowedUrl = new URL(allowedOrigin);
                        if (allowedUrl.hostname === originHostname) {
                            console.log(`✅ CORS allowed (cached custom domain hostname match): ${origin} matches ${allowedOrigin}`);
                            return callback(null, true);
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            
            // If cache is empty or expired, try async refresh in background for next time
            // But don't block this request - if it's not in static/wildcard, reject it
            const now = Date.now();
            const cacheExpired = !customDomainsCacheTimestamp || (now - customDomainsCacheTimestamp) > CACHE_TTL;
            
            if (cacheExpired || cachedCustomDomains.length === 0) {
                // Refresh cache in background (fire and forget)
                refreshCustomDomainsCache().catch(err => {
                    console.warn('⚠️ Background CORS cache refresh failed:', err.message);
                });
            }
            
            // Reject unknown origins with detailed logging
            console.warn(`❌ CORS blocked origin: ${origin}`);
            console.warn(`   Origin hostname: ${originHostname || 'could not parse'}`);
            console.warn(`   Expected pattern: ${envPattern}`);
            console.warn(`   Cached custom domains: ${cachedCustomDomains.length}`);
            if (cachedCustomDomains.length > 0) {
                console.warn(`   Cached custom domains: ${JSON.stringify(cachedCustomDomains.slice(0, 5))}`);
            }
            console.warn(`   Static origins: ${staticOrigins.length}`);
            console.warn(`   Wildcard patterns: ${wildcardPatterns.length > 0 ? wildcardPatterns.join(', ') : 'none'}`);
            console.warn(`   All allowed origins (first 10): ${JSON.stringify(allAllowedOrigins.slice(0, 10))}`);
            if (allAllowedOrigins.length > 10) {
                console.warn(`   ... and ${allAllowedOrigins.length - 10} more`);
            }
            callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Requested-With',
            'Accept',
            'x-current-tenant-id',
            'X-Current-Tenant-Id',
            'x-current-role',
            'X-Current-Role',
            'x-trace-id',
            'x-correlation-id',
            'cache-control',
            'sentry-trace',
            'baggage'
        ]
    };
    
    return corsOptions;
};

/**
 * Get the CORS middleware instance
 * Use this in app.js: app.use(cors(buildCorsMiddleware()))
 */
const corsMiddleware = () => {
    const options = buildCorsMiddleware();
    return cors(options);
};

module.exports = {
    buildCorsMiddleware,
    corsMiddleware,
    refreshCustomDomainsCache,
    getCustomDomains
};

