// routes/me/vendor/training.js
// Back-office vendor portal — Training.
//
// VendorAgents (and VendorAdmins) get read-only access to the same
// organization-wide training library agents use, so they share the same
// product knowledge. This is a *resource*, not a required course:
//   - no per-user progress tracking
//   - no quiz/module completion recording
//   - no certificates awarded
//   - no due dates
//
// The org training library is a single org-scoped row in oe.TrainingLibrary
// (Scope = 'Organization'). Unlike the agent endpoint, we do NOT filter by
// oe.TenantTrainingPackageAssignments — vendors span tenants, and this is a
// shared knowledge resource. All non-Archived packages are returned.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');

const ORG_LIBRARY_SCOPE = 'Organization';

router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

function safeJsonParse(raw, fallback) {
    if (raw == null || raw === '') {
        return fallback;
    }
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return fallback;
    }
}

async function getOrgTrainingLibraryRow(pool) {
    const request = pool.request();
    request.input('Scope', sql.NVarChar(50), ORG_LIBRARY_SCOPE);
    const result = await request.query(`
        SELECT TOP 1 PackagesJson, ModulesJson
        FROM oe.TrainingLibrary
        WHERE Scope = @Scope
    `);
    return result.recordset[0] || null;
}

// Mirrors normalizePackageCertificate in routes/me/agent/training.js so the
// shared TrainingPlayer2Panel renders certificate metadata identically.
function normalizePackageCertificate(rawCertificate, packageTitle) {
    const certificate = rawCertificate && typeof rawCertificate === 'object' ? rawCertificate : {};
    const safePackageTitle = packageTitle || 'Training Package';
    return {
        packageName: String(certificate.packageName || safePackageTitle),
        certificateName: String(certificate.certificateName || `${safePackageTitle} Certificate`),
        certificateDetails: String(
            certificate.certificateDetails ||
                'Awarded for achieving a cumulative quiz score of 70% or higher for this package.'
        ),
        certificateImageUrl: String(
            certificate.certificateImageUrl ||
                'https://res.cloudinary.com/doi8qjcv6/image/upload/v1774995133/customers/mightywell/cmedal_uyhlz1.png'
        )
    };
}

/**
 * GET /api/me/vendor/training/library-content
 * All non-Archived org training packages plus the modules they reference.
 * Read-only resource: certificates are reported as unearned and progress is
 * empty (the same shape the agent endpoint returns when there is no agent
 * profile), so the shared player renders without recording anything.
 */
router.get('/library-content', async (req, res) => {
    try {
        const pool = await getPool();

        const libRow = await getOrgTrainingLibraryRow(pool);
        const packagesJson = libRow ? safeJsonParse(libRow.PackagesJson, []) : [];
        const modulesJson = libRow ? safeJsonParse(libRow.ModulesJson, []) : [];

        const packagesOut = [];
        const moduleIdSet = new Set();

        if (Array.isArray(packagesJson)) {
            packagesJson.forEach(pkg => {
                if (!pkg || !pkg.id) {
                    return;
                }
                if (pkg.status === 'Archived') {
                    return;
                }
                packagesOut.push(pkg);
                const assignments = Array.isArray(pkg.moduleAssignments) ? pkg.moduleAssignments : [];
                assignments.forEach(a => {
                    if (a && a.moduleId) {
                        moduleIdSet.add(a.moduleId);
                    }
                });
            });
        }

        const moduleLibrary = Array.isArray(modulesJson)
            ? modulesJson.filter(m => m && m.id && moduleIdSet.has(m.id))
            : [];

        const certificates = packagesOut.map(pkg => ({
            packageId: pkg.id,
            packageTitle: pkg.title || pkg.id,
            certificate: normalizePackageCertificate(pkg.certificate, pkg.title || pkg.id),
            earned: false,
            awardedAt: null,
            packageCertification: {
                packageId: pkg.id,
                totalQuizzes: 0,
                completedQuizzes: 0,
                aggregateCorrectAnswers: 0,
                aggregateTotalQuestions: 0,
                aggregateScorePercent: 0,
                passingScorePercent: 70,
                passed: false,
                allRequiredQuizzesCompleted: false
            }
        }));

        return res.json({
            success: true,
            data: {
                packages: packagesOut,
                moduleLibrary,
                certificates,
                agentProgress: { quizCompletions: [], moduleCompletions: [] },
                hasAgentProfile: false
            }
        });
    } catch (error) {
        console.error('Error fetching vendor training library content:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch training library' });
    }
});

module.exports = router;
