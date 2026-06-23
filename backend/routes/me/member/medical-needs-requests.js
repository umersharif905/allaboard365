/**
 * GET /api/me/member/medical-needs-requests
 * Aggregates per-product medical needs link sections for the signed-in member's active product enrollments.
 */
const express = require('express');
const { getPool, sql } = require('../../../config/database');
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');

const router = express.Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const HTTPS_RE = /^https:\/\//i;
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?/i;
const isDev = process.env.NODE_ENV !== 'production';

function normalizeGuidString(s) {
    if (s == null) return '';
    return String(s).replace(/[{}]/g, '').trim();
}

function safeJsonParse(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function normalizeButtonColor(c) {
    if (c == null || c === '') return 'teal';
    const s = String(c).trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s;
    const presets = ['teal', 'purple', 'oePrimary', 'violet', 'slate'];
    if (presets.includes(s)) return s;
    return 'teal';
}

/** 1 = first on member portal; matches wizard clamp 1–25 */
function clampDisplayPriority(v) {
    const n = parseInt(String(v), 10);
    if (Number.isNaN(n)) return 1;
    return Math.min(25, Math.max(1, n));
}

router.get('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const pool = await getPool();

        const memReq = pool.request();
        memReq.input('userId', sql.UniqueIdentifier, userId);
        const memRes = await memReq.query(`
            SELECT m.MemberId, m.TenantId, m.Status AS MemberStatus
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE u.UserId = @userId
        `);
        if (!memRes.recordset?.length) {
            return res.status(404).json({ success: false, message: 'Member record not found.' });
        }
        const member = memRes.recordset[0];
        if (member.MemberStatus && member.MemberStatus !== 'Active' && member.MemberStatus !== 'Terminated') {
            return res.status(403).json({ success: false, message: 'Member account is not active.' });
        }

        const tenantId = member.TenantId;
        const enrollReq = pool.request();
        enrollReq.input('userId', sql.UniqueIdentifier, userId);
        enrollReq.input('tenantId', sql.UniqueIdentifier, tenantId);
        const enrollRes = await enrollReq.query(`
            SELECT DISTINCT
                e.ProductId,
                p.Name AS ProductName,
                p.MedicalNeedsLinksConfig
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE u.UserId = @userId
              AND m.TenantId = @tenantId
              AND e.Status = 'Active'
              AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
              AND (
                  e.EnrollmentType = 'Product'
                  OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)
              )
              AND p.MedicalNeedsLinksConfig IS NOT NULL
              AND LEN(LTRIM(RTRIM(p.MedicalNeedsLinksConfig))) > 0
            ORDER BY p.Name ASC, e.ProductId ASC
        `);

        const sections = [];
        const seenProduct = new Set();

        for (const row of enrollRes.recordset || []) {
            const pid = String(row.ProductId);
            if (seenProduct.has(pid)) continue;
            seenProduct.add(pid);

            const cfg = safeJsonParse(row.MedicalNeedsLinksConfig, null);
            if (!cfg || typeof cfg !== 'object') continue;

            const categoryTitle = typeof cfg.categoryTitle === 'string' ? cfg.categoryTitle.trim() : '';
            const linksRaw = Array.isArray(cfg.links) ? cfg.links : [];
            if (!categoryTitle && linksRaw.length === 0) continue;

            const outLinks = [];
            for (const link of linksRaw) {
                if (!link || typeof link !== 'object') continue;
                const label = typeof link.label === 'string' ? link.label.trim() : '';
                if (!label) continue;

                const linkType = link.linkType === 'custom' ? 'custom' : 'tenantForm';
                let href = null;

                if (linkType === 'custom') {
                    const u = typeof link.customUrl === 'string' ? link.customUrl.trim() : '';
                    if (u && (HTTPS_RE.test(u) || (isDev && LOCALHOST_RE.test(u)))) {
                        href = u;
                    }
                } else {
                    const ft = normalizeGuidString(link.formTemplateId);
                    if (ft && UUID_RE.test(ft)) {
                        const chk = pool.request();
                        chk.input('ft', sql.UniqueIdentifier, ft);
                        chk.input('tenantId', sql.UniqueIdentifier, tenantId);
                        const cr = await chk.query(`
                            SELECT 1 AS ok
                            FROM oe.PublicFormTemplates t
                            WHERE t.FormTemplateId = @ft AND t.TenantId = @tenantId
                        `);
                        if (cr.recordset?.length) {
                            href = `/forms/${ft}`;
                        }
                    }
                }

                if (!href) continue;

                outLinks.push({
                    label,
                    href,
                    buttonColor: normalizeButtonColor(link.buttonColor)
                });
            }

            if (outLinks.length === 0) continue;

            const displayPriority = clampDisplayPriority(cfg.displayPriority);

            sections.push({
                productId: row.ProductId,
                productName: row.ProductName || 'Product',
                categoryTitle: categoryTitle || 'Medical needs',
                links: outLinks,
                _sortPriority: displayPriority
            });
        }

        sections.sort((a, b) => {
            const pa = a._sortPriority;
            const pb = b._sortPriority;
            if (pa !== pb) return pa - pb;
            const na = String(a.productName || '');
            const nb = String(b.productName || '');
            if (na !== nb) return na.localeCompare(nb);
            return String(a.productId).localeCompare(String(b.productId));
        });
        for (const s of sections) {
            delete s._sortPriority;
        }

        return res.json({
            success: true,
            data: { sections }
        });
    } catch (err) {
        console.error('GET /api/me/member/medical-needs-requests:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to load medical needs requests'
        });
    }
});

module.exports = router;
