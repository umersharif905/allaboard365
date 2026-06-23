/**
 * Shared logic to build a member SSO portal URL for a product.
 * Used by GET /products/:id/sso-url and POST /telemedicine-sso-url.
 */
const axios = require('axios');
const { sql } = require('../../../config/database');
const ProductAPIService = require('../../../services/ProductAPIService');

/**
 * @param {object} pool - DB pool
 * @param {object} member - Member record (MemberId, TenantId, HouseholdMemberID, etc.)
 * @param {string} productId - Product GUID
 * @returns {Promise<{ url: string }>}
 * @throws Error if not enrolled, no config, or SSO request fails
 */
async function buildMemberSsoUrl(pool, member, productId) {
    const productAndEnrollmentResult = await pool.request()
        .input('productId', sql.UniqueIdentifier, productId)
        .input('tenantId', sql.UniqueIdentifier, member.TenantId)
        .input('memberId', sql.UniqueIdentifier, member.MemberId)
        .query(`
            SELECT p.ProductId, e.EnrollmentId, e.HouseholdId, e.TerminationDate
            FROM oe.TenantProductSubscriptions tps
            INNER JOIN oe.Products p ON tps.ProductId = p.ProductId
            LEFT JOIN oe.Enrollments e ON p.ProductId = e.ProductId AND e.MemberId = @memberId AND e.Status = 'Active'
            WHERE p.ProductId = @productId
              AND tps.TenantId = @tenantId
              AND tps.SubscriptionStatus = 'Active'
              AND p.Status = 'Active'
        `);
    if (productAndEnrollmentResult.recordset.length === 0) {
        const err = new Error('Product not found or not available');
        err.code = 'PRODUCT_NOT_FOUND';
        throw err;
    }
    const row = productAndEnrollmentResult.recordset[0];
    if (!row.EnrollmentId) {
        const err = new Error('You must be enrolled in this product to open the portal');
        err.code = 'NOT_ENROLLED';
        throw err;
    }

    const configResult = await pool.request()
        .input('productId', sql.UniqueIdentifier, productId)
        .query(`SELECT ConfigJson FROM oe.ProductAPIConfigs WHERE ProductId = @productId`);
    if (configResult.recordset.length === 0) {
        const err = new Error('Product has no API config');
        err.code = 'NO_SSO_CONFIG';
        throw err;
    }
    const config = typeof configResult.recordset[0].ConfigJson === 'string'
        ? JSON.parse(configResult.recordset[0].ConfigJson) : configResult.recordset[0].ConfigJson;
    const sso = config?.sso;
    if (!sso?.enabled || !sso?.login?.endpoint || !sso?.portal?.portalBaseUrl) {
        const err = new Error('SSO is not configured for this product');
        err.code = 'NO_SSO_CONFIG';
        throw err;
    }

    let accessToken = await ProductAPIService.fetchAuthToken(sso.login);

    const enrollment = {
        EnrollmentId: row.EnrollmentId,
        MemberId: member.MemberId,
        HouseholdId: row.HouseholdId,
        TerminationDate: row.TerminationDate
    };
    const ctx = { member, enrollment };

    if (sso.tokenRequest?.enabled && sso.tokenRequest?.endpoint) {
        const body = ProductAPIService.substitutePrefills(sso.tokenRequest.body || [], ctx, { authToken: accessToken });
        const headers = ProductAPIService.substitutePrefills(sso.tokenRequest.headers || [], ctx, { authToken: accessToken });
        const method = (sso.tokenRequest.method || 'POST').toUpperCase();
        const ct = sso.tokenRequest.contentType || 'application/x-www-form-urlencoded';
        let axiosConfig = {
            method,
            url: sso.tokenRequest.endpoint.trim(),
            timeout: 15000,
            validateStatus: () => true
        };
        if (ct === 'application/x-www-form-urlencoded') {
            axiosConfig.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
            axiosConfig.data = new URLSearchParams(body).toString();
        } else if (ct === 'application/json') {
            axiosConfig.headers = { ...headers, 'Content-Type': 'application/json' };
            axiosConfig.data = body;
        } else {
            const FormData = require('form-data');
            const form = new FormData();
            for (const [k, v] of Object.entries(body)) {
                form.append(k, String(v ?? ''));
            }
            axiosConfig.data = form;
            axiosConfig.headers = { ...headers, ...form.getHeaders() };
        }
        const resp = await axios(axiosConfig);
        if (resp.status >= 400) {
            const err = new Error('Could not create portal access. Please try again later.');
            err.code = 'TOKEN_REQUEST_FAILED';
            throw err;
        }
        if (resp.data && typeof resp.data === 'object' && resp.data.accessToken != null) {
            accessToken = resp.data.accessToken;
        } else if (typeof resp.data === 'string' && resp.data.length < 2000) {
            accessToken = resp.data.trim();
        } else {
            const err = new Error('Portal token not available. Please try again later.');
            err.code = 'TOKEN_REQUEST_FAILED';
            throw err;
        }
    }

    const portal = sso.portal;
    let urlTemplate = (portal.urlTemplate || '').trim() || '/{accessToken}';
    urlTemplate = urlTemplate.replace(/\{accessToken\}/g, encodeURIComponent(accessToken));
    const customFields = portal.customFields || [];
    const customObj = {};
    for (const item of customFields) {
        const k = (item.key || item.Key || '').trim();
        if (k) customObj[k] = item.value || item.Value || '';
    }
    for (const [k, v] of Object.entries(customObj)) {
        urlTemplate = urlTemplate.replace(new RegExp('\\{' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'g'), encodeURIComponent(v));
    }
    const queryParts = [];
    for (const [k, v] of Object.entries(customObj)) {
        if (!urlTemplate.includes('{' + k + '}')) {
            queryParts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
    }
    const baseUrl = (portal.portalBaseUrl || '').trim().replace(/\/$/, '');
    const path = urlTemplate.startsWith('http') ? urlTemplate : urlTemplate.startsWith('/') ? urlTemplate : '/' + urlTemplate;
    const finalUrl = path.startsWith('http') ? path : baseUrl + path;
    const sep = finalUrl.includes('?') ? '&' : '?';
    const url = queryParts.length ? finalUrl + sep + queryParts.join('&') : finalUrl;

    return { url };
}

module.exports = { buildMemberSsoUrl };
