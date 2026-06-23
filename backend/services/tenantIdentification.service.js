const { getPool, sql } = require('../config/database');

/**
 * UNIFIED TENANT IDENTIFICATION SERVICE
 * 
 * Handles tenant identification for both:
 * - Custom domains (app.mightywell.us)
 * - Default domain paths (app.allaboard365.com/mightywellhealth)
 * 
 * Used by:
 * - /api/tenant-identification endpoint
 * - Frontend route handler for /:tenantPath
 */

class TenantIdentificationService {
  /**
   * Get tenant information by hostname and path
   * @param {string} hostname - Current hostname (e.g., "app.mightywell.us" or "app.allaboard365.com")
   * @param {string} path - Current path (e.g., "/mightywellhealth" or "/")
   * @returns {Object|null} Tenant information or null if not found
   */
  static async getTenantByHostnameAndPath(hostname, path) {
    try {
      const pool = await getPool();
      
      // Extract tenant path from URL path (remove leading slash)
      const tenantPath = path ? path.replace(/^\//, '') : '';
      
      console.log(`🔍 TenantIdentificationService - Starting tenant lookup`);
      console.log(`🔍 Hostname: ${hostname}`);
      console.log(`🔍 Path: ${path}`);
      console.log(`🔍 TenantPath: ${tenantPath}`);
      console.log(`🔍 Is localhost: ${hostname === 'localhost'}`);
      console.log(`🔍 Is default domain: ${hostname === 'app.allaboard365.com'}`);
      
      // First, try to find by custom domain
      if (hostname !== 'localhost' && hostname !== 'app.allaboard365.com') {
        console.log(`🔍 Attempting custom domain lookup for: ${hostname}`);
        const customDomainTenant = await this.getTenantByCustomDomain(hostname);
        if (customDomainTenant) {
          console.log(`✅ CUSTOM DOMAIN MATCH FOUND: ${hostname}`);
          console.log(`✅ Tenant ID: ${customDomainTenant.TenantId}`);
          console.log(`✅ Tenant Name: ${customDomainTenant.Name}`);
          console.log(`✅ Logo URL: ${customDomainTenant.LogoUrl}`);
          return customDomainTenant;
        } else {
          console.log(`❌ No custom domain match for: ${hostname}`);
        }
      } else {
        console.log(`🔍 Skipping custom domain lookup (localhost or default domain)`);
      }
      
      // If no custom domain match, try default domain path
      if (tenantPath) {
        console.log(`🔍 Attempting URL path lookup for: ${tenantPath}`);
        const pathTenant = await this.getTenantByUrlPath(tenantPath);
        if (pathTenant) {
          console.log(`✅ URL PATH MATCH FOUND: ${tenantPath}`);
          console.log(`✅ Tenant ID: ${pathTenant.TenantId}`);
          console.log(`✅ Tenant Name: ${pathTenant.Name}`);
          console.log(`✅ Logo URL: ${pathTenant.LogoUrl}`);
          return pathTenant;
        } else {
          console.log(`❌ No URL path match for: ${tenantPath}`);
        }
      } else {
        console.log(`🔍 Skipping URL path lookup (no tenant path provided)`);
      }

      // HOSTNAME-DERIVED URL PATH FALLBACK
      // If someone visits a custom domain like `portal.mightywellhealth.com` but
      // the tenant's CustomDomain field wasn't populated exactly, try to resolve
      // by matching hostname segments against DefaultUrlPath. This way
      // `portal.mightywellhealth.com` still finds the tenant whose urlPath is
      // `mightywellhealth`.
      if (hostname && hostname !== 'localhost' && hostname !== 'app.allaboard365.com') {
        const candidates = this.deriveUrlPathCandidatesFromHostname(hostname);
        console.log(`🔍 Hostname-derived urlPath candidates for ${hostname}: ${JSON.stringify(candidates)}`);
        for (const candidate of candidates) {
          const pathTenant = await this.getTenantByUrlPath(candidate);
          if (pathTenant) {
            console.log(`✅ HOSTNAME-DERIVED URL PATH MATCH: "${candidate}" for hostname ${hostname}`);
            return pathTenant;
          }
        }
      }

      console.log(`❌ NO TENANT FOUND for hostname: ${hostname}, path: ${path}`);
      return null;
      
    } catch (error) {
      console.error('❌ ERROR in tenant identification:', error);
      console.error('❌ Error details:', {
        message: error.message,
        stack: error.stack,
        hostname,
        path
      });
      return null;
    }
  }

  /**
   * Derive possible DefaultUrlPath candidates from a hostname.
   * Example: "portal.mightywellhealth.com" ->
   *   ["mightywellhealth", "portal-mightywellhealth", "mightywell", "portal"]
   * Candidates are returned in order of most-likely to least-likely.
   * @param {string} hostname
   * @returns {string[]}
   */
  static deriveUrlPathCandidatesFromHostname(hostname) {
    if (!hostname) return [];
    const lower = hostname.toLowerCase().trim();
    // Strip port if present
    const host = lower.split(':')[0];
    const parts = host.split('.').filter(Boolean);
    if (parts.length === 0) return [];

    // Known TLDs we always strip (single-label TLDs only; good enough here).
    // Multi-part TLDs (co.uk, com.au) can be handled by adding the second-to-last
    // label too, which we already do below.
    const tld = parts[parts.length - 1];
    const withoutTld = parts.slice(0, -1); // e.g. ["portal", "mightywellhealth"]

    const candidates = new Set();

    if (withoutTld.length >= 1) {
      // Second-level domain (most likely match): "mightywellhealth"
      const sld = withoutTld[withoutTld.length - 1];
      if (sld) candidates.add(sld);
    }
    if (withoutTld.length >= 2) {
      // Subdomain-qualified: "portal-mightywellhealth"
      candidates.add(withoutTld.join('-'));
      // First label alone: "portal"
      const first = withoutTld[0];
      if (first) candidates.add(first);
    }
    // Also consider the full host with dots replaced by hyphens, minus the TLD
    if (withoutTld.length > 0) {
      candidates.add(withoutTld.join(''));
    }

    // Drop any candidates that are obvious non-tenant identifiers
    const blocklist = new Set(['www', 'app', 'portal', 'enroll', 'api', 'oauth']);
    return Array.from(candidates).filter(
      (c) => c && c.length > 1 && !blocklist.has(c) && c !== tld
    );
  }

  /**
   * Score tenants by how well their Name / DefaultUrlPath matches the hostname,
   * and return them sorted from best match to worst. Used to resolve conflicts
   * when multiple tenants share the same CustomDomain.
   *
   * Score is the number of characters from the normalized tenant identifier
   * (urlPath or name) that overlap with the hostname. A tenant whose urlPath
   * appears verbatim in the hostname beats one that doesn't.
   *
   * @param {Array} tenants
   * @param {string} hostname
   * @returns {Array} sorted copy of tenants with a `_affinityScore` field
   */
  static rankTenantsByHostnameAffinity(tenants, hostname) {
    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedHost = normalize(hostname);

    const scored = tenants.map((t) => {
      const urlPath = normalize(t.UrlPath || t.DefaultUrlPath);
      const name = normalize(t.Name);

      let score = 0;
      // Strongest signal: urlPath is contained in the hostname
      if (urlPath && normalizedHost.includes(urlPath)) {
        score += 100 + urlPath.length;
      }
      // Second signal: normalized tenant name is contained in the hostname
      if (name && normalizedHost.includes(name)) {
        score += 50 + name.length;
      }
      // Tiny tiebreaker: having a populated CustomDomain field beats AdvancedSettings-only
      if (t.CustomDomain) score += 1;

      return { ...t, _affinityScore: score };
    });

    // Highest score wins; stable otherwise (keeps DB order for ties)
    scored.sort((a, b) => b._affinityScore - a._affinityScore);
    return scored;
  }

  /**
   * Get tenant by custom domain (checks both database field and AdvancedSettings)
   * @param {string} hostname - Custom domain hostname
   * @returns {Object|null} Tenant information or null
   */
  static async getTenantByCustomDomain(hostname) {
    try {
      console.log(`🔍 getTenantByCustomDomain - Starting lookup for: ${hostname}`);
      
      const pool = await getPool();
      const request = pool.request();
      request.input('hostname', sql.NVarChar(255), hostname);
      
      const query = `
        SELECT 
          t.TenantId,
          t.Name,
          t.DefaultUrlPath as UrlPath,
          t.CustomDomain,
          t.CustomLogoUrl,
          json_value(t.AdvancedSettings, '$.domain.customDomain') as CustomDomainFromJson,
          t.AdvancedSettings,
          ISNULL(t.CustomLogoUrl, ISNULL(NULLIF(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''), '/images/branding/allaboard365/allaboard365-logo-transparent.png')) as LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColorHex,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColorHex
        FROM oe.Tenants t
        WHERE (t.CustomDomain = @hostname OR json_value(t.AdvancedSettings, '$.domain.customDomain') = @hostname)
          AND t.Status = 'Active'
      `;
      
      console.log(`🔍 Executing custom domain query for: ${hostname}`);
      console.log(`🔍 Query: ${query}`);
      
      const result = await request.query(query);
      console.log(`🔍 Custom domain query executed`);
      console.log(`🔍 Records found: ${result.recordset.length}`);
      
      if (result.recordset.length > 0) {
        // CONFLICT RESOLUTION: if multiple tenants share the same custom domain
        // (e.g. two tenants accidentally both set portal.mightywellhealth.com),
        // pick the one whose Name / DefaultUrlPath best matches the hostname.
        // This makes the tenant that actually "owns" the domain win, and falls
        // back to the other if nothing matches.
        const ranked = this.rankTenantsByHostnameAffinity(result.recordset, hostname);
        if (result.recordset.length > 1) {
          console.log(`⚠️ Multiple tenants (${result.recordset.length}) share custom domain "${hostname}":`);
          ranked.forEach((t, i) => {
            console.log(`   ${i + 1}. ${t.Name} (urlPath=${t.UrlPath}, score=${t._affinityScore})`);
          });
        }
        const tenant = ranked[0];
        
        // Debug: Check raw values before ISNULL processing
        const rawCustomLogoUrl = tenant.CustomLogoUrl;
        const rawJsonLogoUrl = tenant.AdvancedSettings ? 
          (JSON.parse(tenant.AdvancedSettings)?.branding?.logoUrl || null) : null;
        
        console.log(`✅ CUSTOM DOMAIN MATCH SELECTED:`);
        console.log(`✅ Tenant ID: ${tenant.TenantId}`);
        console.log(`✅ Tenant Name: ${tenant.Name}`);
        console.log(`✅ CustomDomain field: ${tenant.CustomDomain}`);
        console.log(`✅ CustomDomainFromJson: ${tenant.CustomDomainFromJson}`);
        console.log(`✅ Affinity score: ${tenant._affinityScore}`);
        console.log(`🔍 DEBUG - Raw CustomLogoUrl: ${rawCustomLogoUrl}`);
        console.log(`🔍 DEBUG - Raw JSON logoUrl: ${rawJsonLogoUrl}`);
        console.log(`✅ Logo URL (from query): ${tenant.LogoUrl}`);
        console.log(`✅ Primary Color: ${tenant.PrimaryColorHex}`);
        console.log(`✅ Secondary Color: ${tenant.SecondaryColorHex}`);
        
        // If LogoUrl is empty string or default, try to get it from AdvancedSettings directly
        if (!tenant.LogoUrl || tenant.LogoUrl === '/images/branding/allaboard365/allaboard365-logo-transparent.png' || tenant.LogoUrl.trim() === '') {
          console.log(`⚠️ Logo URL is empty or default, attempting to extract from AdvancedSettings directly...`);
          try {
            if (tenant.AdvancedSettings) {
              const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
                ? JSON.parse(tenant.AdvancedSettings) 
                : tenant.AdvancedSettings;
              
              if (advancedSettings?.branding?.logoUrl) {
                tenant.LogoUrl = advancedSettings.branding.logoUrl;
                console.log(`✅ Logo URL extracted from AdvancedSettings: ${tenant.LogoUrl}`);
              }
            }
          } catch (parseError) {
            console.error(`❌ Error parsing AdvancedSettings for logo:`, parseError.message);
          }
        }
        
        return tenant;
      } else {
        console.log(`❌ NO CUSTOM DOMAIN MATCH for: ${hostname}`);
        console.log(`❌ Searched in CustomDomain field and AdvancedSettings JSON`);
        return null;
      }
      
    } catch (error) {
      console.error('❌ ERROR getting tenant by custom domain:', error);
      console.error('❌ Error details:', {
        message: error.message,
        stack: error.stack,
        hostname
      });
      return null;
    }
  }

  /**
   * Get tenant by URL path
   * @param {string} urlPath - URL path (e.g., "mightywellhealth")
   * @returns {Object|null} Tenant information or null
   */
  static async getTenantByUrlPath(urlPath) {
    try {
      console.log(`🔍 getTenantByUrlPath - Starting lookup for: ${urlPath}`);
      
      const pool = await getPool();
      const request = pool.request();
      request.input('urlPath', sql.NVarChar(100), urlPath);
      
      const query = `
        SELECT 
          t.TenantId,
          t.Name,
          t.DefaultUrlPath as UrlPath,
          t.CustomLogoUrl,
          json_value(t.AdvancedSettings, '$.domain.customDomain') as CustomDomain,
          t.AdvancedSettings,
          ISNULL(t.CustomLogoUrl, ISNULL(NULLIF(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''), '/images/branding/allaboard365/allaboard365-logo-transparent.png')) as LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColorHex,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColorHex
        FROM oe.Tenants t
        WHERE t.DefaultUrlPath = @urlPath 
          AND t.Status = 'Active'
      `;
      
      console.log(`🔍 Executing URL path query for: ${urlPath}`);
      console.log(`🔍 Query: ${query}`);
      
      const result = await request.query(query);
      console.log(`🔍 URL path query executed`);
      console.log(`🔍 Records found: ${result.recordset.length}`);
      
      if (result.recordset.length > 0) {
        const tenant = result.recordset[0];
        
        // Debug: Check raw values before ISNULL processing
        const rawCustomLogoUrl = tenant.CustomLogoUrl;
        const rawJsonLogoUrl = tenant.AdvancedSettings ? 
          (JSON.parse(tenant.AdvancedSettings)?.branding?.logoUrl || null) : null;
        
        console.log(`✅ URL PATH MATCH FOUND:`);
        console.log(`✅ Tenant ID: ${tenant.TenantId}`);
        console.log(`✅ Tenant Name: ${tenant.Name}`);
        console.log(`✅ URL Path: ${tenant.UrlPath}`);
        console.log(`🔍 DEBUG - Raw CustomLogoUrl: ${rawCustomLogoUrl}`);
        console.log(`🔍 DEBUG - Raw JSON logoUrl: ${rawJsonLogoUrl}`);
        console.log(`✅ Logo URL (from query): ${tenant.LogoUrl}`);
        console.log(`✅ Primary Color: ${tenant.PrimaryColorHex}`);
        console.log(`✅ Secondary Color: ${tenant.SecondaryColorHex}`);
        
        // If LogoUrl is empty string or default, try to get it from AdvancedSettings directly
        if (!tenant.LogoUrl || tenant.LogoUrl === '/images/branding/allaboard365/allaboard365-logo-transparent.png' || tenant.LogoUrl.trim() === '') {
          console.log(`⚠️ Logo URL is empty or default, attempting to extract from AdvancedSettings directly...`);
          try {
            if (tenant.AdvancedSettings) {
              const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
                ? JSON.parse(tenant.AdvancedSettings) 
                : tenant.AdvancedSettings;
              
              if (advancedSettings?.branding?.logoUrl) {
                tenant.LogoUrl = advancedSettings.branding.logoUrl;
                console.log(`✅ Logo URL extracted from AdvancedSettings: ${tenant.LogoUrl}`);
              }
            }
          } catch (parseError) {
            console.error(`❌ Error parsing AdvancedSettings for logo:`, parseError.message);
          }
        }
        
        return tenant;
      } else {
        console.log(`❌ NO URL PATH MATCH for: ${urlPath}`);
        return null;
      }
      
    } catch (error) {
      console.error('❌ ERROR getting tenant by URL path:', error);
      console.error('❌ Error details:', {
        message: error.message,
        stack: error.stack,
        urlPath
      });
      return null;
    }
  }

  /**
   * Generate URL path suggestions with conflict resolution
   * @param {string} tenantName - Tenant name to generate suggestions from
   * @param {string} excludeTenantId - Tenant ID to exclude from availability check
   * @returns {Array} Array of available URL path suggestions
   */
  static async generateUrlPathSuggestions(tenantName, excludeTenantId = null) {
    try {
      const pool = await getPool();
      
      // Clean and normalize the tenant name
      const cleanName = tenantName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

      const suggestions = [
        cleanName,
        cleanName.replace(/-/g, ''),
        `${cleanName}app`,
        `${cleanName}portal`,
        `${cleanName}enroll`
      ];

      // Check availability and add numbered variants if needed
      const availableSuggestions = [];
      
      for (const suggestion of suggestions) {
        if (await this.isUrlPathAvailable(suggestion, excludeTenantId)) {
          availableSuggestions.push(suggestion);
        }
      }

      // If no suggestions available, add numbered variants
      if (availableSuggestions.length === 0) {
        for (let i = 1; i <= 10; i++) {
          const numberedSuggestion = `${cleanName}${i}`;
          if (await this.isUrlPathAvailable(numberedSuggestion, excludeTenantId)) {
            availableSuggestions.push(numberedSuggestion);
          }
        }
      }

      return availableSuggestions.slice(0, 5); // Return top 5 suggestions
      
    } catch (error) {
      console.error('❌ Error generating URL path suggestions:', error);
      return [];
    }
  }

  /**
   * Generate the best available URL path for a tenant name
   * @param {string} tenantName - Tenant name to generate path from
   * @returns {string} The best available URL path
   */
  static async generateUrlPath(tenantName) {
    try {
      const suggestions = await this.generateUrlPathSuggestions(tenantName);
      
      if (suggestions.length > 0) {
        return suggestions[0]; // Return the first (best) suggestion
      }
      
      // If no suggestions available, generate a unique one with timestamp
      const cleanName = tenantName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
      
      const timestamp = Date.now().toString().slice(-6); // Last 6 digits
      return `${cleanName}-${timestamp}`;
      
    } catch (error) {
      console.error('❌ Error generating URL path:', error);
      // Fallback to timestamp-based name
      const timestamp = Date.now().toString().slice(-6);
      return `tenant-${timestamp}`;
    }
  }

  /**
   * Check if URL path is available
   * @param {string} urlPath - URL path to check
   * @param {string} excludeTenantId - Tenant ID to exclude from check
   * @returns {boolean} True if available, false if taken
   */
  static async isUrlPathAvailable(urlPath, excludeTenantId = null) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('urlPath', sql.NVarChar(100), urlPath);
      
      // Check if DefaultUrlPath column exists, if not, assume all paths are available
      const columnCheckQuery = `
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Tenants' 
        AND COLUMN_NAME = 'DefaultUrlPath' 
        AND TABLE_SCHEMA = 'oe'
      `;
      
      const columnResult = await request.query(columnCheckQuery);
      const columnExists = columnResult.recordset[0].count > 0;
      
      if (!columnExists) {
        console.log('⚠️ DefaultUrlPath column does not exist yet - assuming all paths are available');
        return true; // If column doesn't exist, assume available
      }
      
      let query = 'SELECT COUNT(*) as count FROM oe.Tenants WHERE DefaultUrlPath = @urlPath';
      if (excludeTenantId) {
        request.input('excludeTenantId', sql.UniqueIdentifier, excludeTenantId);
        query += ' AND TenantId != @excludeTenantId';
      }
      
      const result = await request.query(query);
      return result.recordset[0].count === 0;
      
    } catch (error) {
      console.error('❌ Error checking URL path availability:', error);
      // If there's an error (like column doesn't exist), assume available
      return true;
    }
  }

  /**
   * Set tenant URL path
   * @param {string} tenantId - Tenant ID
   * @param {string} urlPath - URL path to set
   * @returns {boolean} Success status
   */
  static async setTenantUrlPath(tenantId, urlPath) {
    try {
      // Validate and format URL path to match constraint
      if (!urlPath) {
        throw new Error('URL path is required');
      }
      
      // Convert to lowercase and remove invalid characters
      const formattedUrlPath = urlPath.toLowerCase().replace(/[^a-z0-9-]/g, '');
      
      // Ensure it starts and ends with alphanumeric characters
      const validUrlPath = formattedUrlPath.replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
      
      if (!validUrlPath) {
        throw new Error('URL path must contain only lowercase letters, numbers, and hyphens');
      }
      
      // Validate against constraint pattern: [a-z0-9] OR [a-z0-9][a-z0-9-]*[a-z0-9]
      const constraintPattern = /^[a-z0-9]$|^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
      if (!constraintPattern.test(validUrlPath)) {
        throw new Error('URL path must start and end with alphanumeric characters and can only contain lowercase letters, numbers, and hyphens');
      }
      
      console.log(`🔧 URL path validation: "${urlPath}" → "${validUrlPath}"`);
      
      const pool = await getPool();
      const request = pool.request();
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      request.input('urlPath', sql.NVarChar(100), validUrlPath);
      
      // Check if DefaultUrlPath column exists first
      const columnCheckQuery = `
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'Tenants' 
        AND COLUMN_NAME = 'DefaultUrlPath' 
        AND TABLE_SCHEMA = 'oe'
      `;
      
      const columnResult = await request.query(columnCheckQuery);
      const columnExists = columnResult.recordset[0].count > 0;
      
      if (!columnExists) {
        console.log('⚠️ DefaultUrlPath column does not exist yet - cannot set URL path');
        console.log('💡 Please run the database schema update first: backend/database-updates/tenant-url-path-schema.sql');
        return false;
      }
      
      await request.query(`
        UPDATE oe.Tenants 
        SET DefaultUrlPath = @urlPath, 
            IsDefaultUrlPathVerified = 1,
            DefaultUrlPathCreatedDate = GETDATE()
        WHERE TenantId = @tenantId
      `);
      
      console.log(`✅ Set URL path for tenant ${tenantId}: ${urlPath}`);
      return true;
      
    } catch (error) {
      console.error('❌ Error setting tenant URL path:', error);
      return false;
    }
  }
}

module.exports = TenantIdentificationService;
