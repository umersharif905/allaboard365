const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { v4: uuidv4 } = require('uuid');

/**
 * Get AgentId for current user (Agent or TenantAdmin acting as agent)
 */
async function getAgentIdFromUser(pool, userId) {
    const request = pool.request();
    request.input('UserId', sql.UniqueIdentifier, userId);
    const result = await request.query(`
        SELECT AgentId FROM oe.Agents WHERE UserId = @UserId AND Status = 'Active'
    `);
    return result.recordset.length > 0 ? result.recordset[0].AgentId : null;
}

async function getTenantAdvancedSettingsParsed(pool, tenantId) {
    const req = pool.request();
    req.input("TenantId", sql.UniqueIdentifier, tenantId);
    const result = await req.query(`
        SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId
    `);
    if (!result.recordset || result.recordset.length === 0) {
        return {};
    }
    const raw = result.recordset[0].AdvancedSettings;
    if (!raw) return {};
    try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        return {};
    }
}

/** When unset or true, agent portal training is shown; explicit false hides it for the tenant. */
function isAgentPortalTrainingEnabledFromAdvanced(advancedSettings) {
    return advancedSettings?.features?.enableAgentPortalTraining !== false;
}

async function rejectIfAgentPortalTrainingDisabled(pool, tenantId, res) {
    const adv = await getTenantAdvancedSettingsParsed(pool, tenantId);
    if (!isAgentPortalTrainingEnabledFromAdvanced(adv)) {
        res.status(403).json({
            success: false,
            message: "Agent portal training is disabled for this organization.",
            code: "AGENT_PORTAL_TRAINING_DISABLED"
        });
        return true;
    }
    return false;
}

/**
 * GET /api/me/agent/training/products
 * Products available to tenant that have agent training config
 */
router.get('/products', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, req.tenantId);

        const result = await request.query(`
            SELECT DISTINCT
                p.ProductId, p.Name, p.ProductType, p.Description, p.ProductImageUrl,
                p.ProductLogoUrl, p.TrainingConfig, t.Name as ProductOwnerName
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
                AND tps.TenantId = @TenantId AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.Status = 'Active'
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
            AND p.TrainingConfig IS NOT NULL
            ORDER BY p.Name
        `);

        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        const completionsRequest = pool.request();
        if (agentId) {
            completionsRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        }
        const completionsResult = agentId ? await completionsRequest.query(`
            SELECT ProductId, AttemptNumber, ScorePercent, CompletedAt
            FROM oe.TrainingCompletions
            WHERE AgentId = @AgentId
        `) : { recordset: [] };
        const completionsByProduct = {};
        (completionsResult.recordset || []).forEach(row => {
            const key = row.ProductId;
            if (!completionsByProduct[key] || row.CompletedAt > completionsByProduct[key].CompletedAt) {
                completionsByProduct[key] = { attemptNumber: row.AttemptNumber, scorePercent: row.ScorePercent, completedAt: row.CompletedAt };
            }
        });

        const products = result.recordset
            .map(row => {
                let agentTraining = null;
                if (row.TrainingConfig) {
                    try {
                        const config = typeof row.TrainingConfig === 'string' ? JSON.parse(row.TrainingConfig) : row.TrainingConfig;
                        agentTraining = config.agentTraining || null;
                    } catch (e) {
                        return null;
                    }
                }
                if (!agentTraining) return null;
                const lastCompletion = completionsByProduct[row.ProductId] || null;
                return {
                    ProductId: row.ProductId,
                    Name: row.Name,
                    ProductType: row.ProductType,
                    Description: row.Description,
                    ProductImageUrl: row.ProductImageUrl,
                    ProductLogoUrl: row.ProductLogoUrl,
                    ProductOwnerName: row.ProductOwnerName,
                    agentTraining: {
                        requiredForSell: agentTraining.requiredForSell || false,
                        passingScorePercent: agentTraining.passingScorePercent ?? 80,
                        modulesCount: (agentTraining.modules || []).length,
                        questionsCount: (agentTraining.questions || []).length
                    },
                    lastCompletion: lastCompletion ? {
                        attemptNumber: lastCompletion.attemptNumber,
                        scorePercent: lastCompletion.scorePercent,
                        completedAt: lastCompletion.completedAt
                    } : null
                };
            })
            .filter(Boolean);

        return res.json({ success: true, data: products });
    } catch (error) {
        console.error('Error fetching agent training products:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch training products' });
    }
});

/**
 * GET /api/me/agent/training/products/:productId
 * Single product's agent training config
 */
router.get('/products/:productId', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        request.input('TenantId', sql.UniqueIdentifier, req.tenantId);

        const result = await request.query(`
            SELECT p.ProductId, p.Name, p.TrainingConfig
            FROM oe.Products p
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
                AND tps.TenantId = @TenantId AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.ProductId = @ProductId AND p.Status = 'Active'
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const row = result.recordset[0];
        let config = null;
        if (row.TrainingConfig) {
            try {
                config = typeof row.TrainingConfig === 'string' ? JSON.parse(row.TrainingConfig) : row.TrainingConfig;
            } catch (e) {
                return res.status(500).json({ success: false, message: 'Invalid training config' });
            }
        }
        const agentTraining = config?.agentTraining || null;
        if (!agentTraining) {
            return res.status(404).json({ success: false, message: 'No agent training for this product' });
        }

        return res.json({
            success: true,
            data: {
                ProductId: row.ProductId,
                Name: row.Name,
                agentTraining
            }
        });
    } catch (error) {
        console.error('Error fetching agent training product:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch training config' });
    }
});

/**
 * POST /api/me/agent/training/products/:productId/complete
 * Submit answers and record completion
 */
router.post('/products/:productId/complete', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const { answers } = req.body || {};
        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        if (!agentId) {
            return res.status(403).json({ success: false, message: 'Agent profile not found' });
        }

        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        request.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        const productResult = await request.query(`
            SELECT p.ProductId, p.TrainingConfig
            FROM oe.Products p
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
                AND tps.TenantId = @TenantId AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.ProductId = @ProductId AND p.Status = 'Active'
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
        `);

        if (productResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        let config;
        try {
            const raw = productResult.recordset[0].TrainingConfig;
            config = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid training config' });
        }
        const agentTraining = config.agentTraining || {};
        const questions = agentTraining.questions || [];
        if (questions.length === 0) {
            return res.status(400).json({ success: false, message: 'No questions configured' });
        }

        const answerMap = Array.isArray(answers) ? Object.fromEntries(answers.map(a => [a.questionId, a.chosenKey])) : {};
        let correct = 0;
        questions.forEach(q => {
            if (answerMap[q.id] === q.correctResponseKey) correct++;
        });
        const scorePercent = questions.length ? Math.round((correct / questions.length) * 10000) / 100 : 0;
        const passingScore = agentTraining.passingScorePercent ?? 0;
        const passed = scorePercent >= passingScore;

        const maxAttemptRequest = pool.request();
        maxAttemptRequest.input('ProductId', sql.UniqueIdentifier, productId);
        maxAttemptRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        const maxResult = await maxAttemptRequest.query(`
            SELECT ISNULL(MAX(AttemptNumber), 0) AS MaxAttempt FROM oe.TrainingCompletions
            WHERE ProductId = @ProductId AND AgentId = @AgentId
        `);
        const attemptNumber = (maxResult.recordset[0]?.MaxAttempt || 0) + 1;

        const insertRequest = pool.request();
        const completionId = uuidv4();
        insertRequest.input('TrainingCompletionId', sql.UniqueIdentifier, completionId);
        insertRequest.input('ProductId', sql.UniqueIdentifier, productId);
        insertRequest.input('AgentId', sql.UniqueIdentifier, agentId);
        insertRequest.input('UserId', sql.UniqueIdentifier, req.user.UserId);
        insertRequest.input('AttemptNumber', sql.Int, attemptNumber);
        insertRequest.input('ScorePercent', sql.Decimal(5, 2), scorePercent);
        insertRequest.input('TotalQuestions', sql.Int, questions.length);
        insertRequest.input('CorrectAnswers', sql.Int, correct);
        await insertRequest.query(`
            INSERT INTO oe.TrainingCompletions (
                TrainingCompletionId, ProductId, AgentId, UserId, AttemptNumber,
                ScorePercent, TotalQuestions, CorrectAnswers, CompletedAt, CreatedDate, ModifiedDate
            ) VALUES (
                @TrainingCompletionId, @ProductId, @AgentId, @UserId, @AttemptNumber,
                @ScorePercent, @TotalQuestions, @CorrectAnswers, GETUTCDATE(), GETUTCDATE(), GETUTCDATE()
            )
        `);

        return res.json({
            success: true,
            data: {
                scorePercent,
                passed,
                attemptNumber,
                completedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error completing agent training:', error);
        return res.status(500).json({ success: false, message: 'Failed to record completion' });
    }
});

/**
 * GET /api/me/agent/training/completions
 * List current agent's training completions
 */
router.get('/completions', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        if (!agentId) {
            return res.json({ success: true, data: [] });
        }

        const request = pool.request();
        request.input('AgentId', sql.UniqueIdentifier, agentId);
        const result = await request.query(`
            SELECT tc.TrainingCompletionId, tc.ProductId, tc.AttemptNumber, tc.ScorePercent,
                tc.TotalQuestions, tc.CorrectAnswers, tc.CompletedAt, p.Name as ProductName
            FROM oe.TrainingCompletions tc
            INNER JOIN oe.Products p ON tc.ProductId = p.ProductId
            WHERE tc.AgentId = @AgentId
            ORDER BY tc.CompletedAt DESC
        `);

        return res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('Error fetching agent training completions:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch completions' });
    }
});



const ORG_LIBRARY_SCOPE = "Organization";

async function getOrgTrainingLibraryRow(pool) {
    const request = pool.request();
    request.input("Scope", sql.NVarChar(50), ORG_LIBRARY_SCOPE);
    const result = await request.query(`
        SELECT TOP 1 PackagesJson, ModulesJson
        FROM oe.TrainingLibrary
        WHERE Scope = @Scope
    `);
    return result.recordset[0] || null;
}

function safeJsonParse(raw, fallback) {
    if (raw == null || raw === "") {
        return fallback;
    }
    try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {
        return fallback;
    }
}

function modulesByIdFromLibrary(modulesJsonParsed) {
    const map = {};
    if (!Array.isArray(modulesJsonParsed)) {
        return map;
    }
    modulesJsonParsed.forEach(m => {
        if (m && m.id) {
            map[m.id] = m;
        }
    });
    return map;
}

function normalizePackageCertificate(rawCertificate, packageTitle) {
    const certificate = rawCertificate && typeof rawCertificate === "object" ? rawCertificate : {};
    const safePackageTitle = packageTitle || "Training Package";
    return {
        packageName: String(certificate.packageName || safePackageTitle),
        certificateName: String(certificate.certificateName || `${safePackageTitle} Certificate`),
        certificateDetails: String(
            certificate.certificateDetails ||
                "Awarded for achieving a cumulative quiz score of 70% or higher for this package."
        ),
        certificateImageUrl: String(
            certificate.certificateImageUrl ||
                "https://res.cloudinary.com/doi8qjcv6/image/upload/v1774995133/customers/mightywell/cmedal_uyhlz1.png"
        )
    };
}

function collectPackageQuizRefs(pkg, moduleById) {
    const refs = [];
    const assignments = Array.isArray(pkg?.moduleAssignments) ? pkg.moduleAssignments : [];
    assignments.forEach(assignment => {
        const moduleId = assignment?.moduleId;
        const mod = moduleId ? moduleById[moduleId] : null;
        if (!mod || !Array.isArray(mod.moduleSteps)) {
            return;
        }
        mod.moduleSteps.forEach(step => {
            const quiz = step?.sectionQuiz;
            if (!quiz?.id || !Array.isArray(quiz.questions)) {
                return;
            }
            refs.push({
                packageId: pkg.id,
                moduleId: mod.id,
                stepId: step.id,
                quizId: quiz.id,
                totalQuestions: quiz.questions.length
            });
        });
    });
    return refs;
}

async function queryWithMissingTableFallback(requestFactory, queryText) {
    try {
        return await requestFactory().query(queryText);
    } catch (error) {
        const msg = String(error?.message || "");
        if (msg.includes("Invalid object name")) {
            return { recordset: [] };
        }
        throw error;
    }
}

async function evaluatePackageCertification(pool, agentId, packageObj, moduleById) {
    const quizRefs = collectPackageQuizRefs(packageObj, moduleById);
    if (!quizRefs.length) {
        return {
            packageId: packageObj.id,
            totalQuizzes: 0,
            completedQuizzes: 0,
            aggregateCorrectAnswers: 0,
            aggregateTotalQuestions: 0,
            aggregateScorePercent: 0,
            passingScorePercent: 70,
            passed: false,
            allRequiredQuizzesCompleted: false
        };
    }

    const completionRequest = () => {
        const req = pool.request();
        req.input("AgentId", sql.UniqueIdentifier, agentId);
        req.input("PackageId", sql.NVarChar(100), packageObj.id);
        return req;
    };
    const completionResult = await queryWithMissingTableFallback(
        completionRequest,
        `
            SELECT QuizId, CorrectAnswers, TotalQuestions
            FROM oe.AgentTrainingLibraryQuizCompletions
            WHERE AgentId = @AgentId AND PackageId = @PackageId
        `
    );
    const completionByQuizId = new Map(
        (completionResult.recordset || []).map(row => [String(row.QuizId), row])
    );

    let aggregateCorrectAnswers = 0;
    let aggregateTotalQuestions = 0;
    let completedQuizzes = 0;
    quizRefs.forEach(ref => {
        const row = completionByQuizId.get(String(ref.quizId));
        if (!row) {
            return;
        }
        completedQuizzes += 1;
        aggregateCorrectAnswers += Number(row.CorrectAnswers || 0);
        aggregateTotalQuestions += Number(row.TotalQuestions || 0);
    });

    const allRequiredQuizzesCompleted = completedQuizzes === quizRefs.length;
    const aggregateScorePercent =
        aggregateTotalQuestions > 0
            ? Math.round((aggregateCorrectAnswers / aggregateTotalQuestions) * 10000) / 100
            : 0;
    const passingScorePercent = 70;
    const passed = allRequiredQuizzesCompleted && aggregateScorePercent >= passingScorePercent;

    return {
        packageId: packageObj.id,
        totalQuizzes: quizRefs.length,
        completedQuizzes,
        aggregateCorrectAnswers,
        aggregateTotalQuestions,
        aggregateScorePercent,
        passingScorePercent,
        passed,
        allRequiredQuizzesCompleted
    };
}

/**
 * Structured diagnostics for GET /library-content?diagnose=1 (hypothesis tests).
 */
async function buildLibraryContentDiagnostics(pool, ctx) {
    const {
        tenantId,
        userId,
        libRow,
        packagesJson,
        modulesJson,
        assignedPackageIds,
        packagesOut,
        moduleLibrary
    } = ctx;

    const assignedList = [...assignedPackageIds];
    const libraryPackageIds = Array.isArray(packagesJson)
        ? packagesJson.map(p => (p && p.id ? String(p.id) : null)).filter(Boolean)
        : [];
    const assignedNotInJson = assignedList.filter(id => !libraryPackageIds.includes(String(id)));

    const excludedArchivedOnly = [];
    if (Array.isArray(packagesJson)) {
        packagesJson.forEach(pkg => {
            if (!pkg || !pkg.id || !assignedPackageIds.has(pkg.id)) {
                return;
            }
            const st = pkg.status;
            if (st === "Archived") {
                excludedArchivedOnly.push({
                    id: pkg.id,
                    title: pkg.title || null,
                    status: st
                });
            }
        });
    }

    let agentTenantId = null;
    if (userId) {
        const ar = pool.request();
        ar.input("UserId", sql.UniqueIdentifier, userId);
        const agentTenantResult = await ar.query(`
            SELECT TOP 1 TenantId FROM oe.Agents
            WHERE UserId = @UserId AND Status = 'Active'
        `);
        if (agentTenantResult.recordset && agentTenantResult.recordset[0]) {
            agentTenantId = agentTenantResult.recordset[0].TenantId;
        }
    }

    const agentTenantStr = agentTenantId != null ? String(agentTenantId) : null;
    const reqTenantStr = tenantId != null ? String(tenantId) : "";

    const moduleIdsInLibrary = new Set(
        Array.isArray(modulesJson)
            ? modulesJson.map(m => (m && m.id ? String(m.id) : null)).filter(Boolean)
            : []
    );
    const referencedModuleIds = new Set();
    packagesOut.forEach(pkg => {
        const assignments = Array.isArray(pkg.moduleAssignments) ? pkg.moduleAssignments : [];
        assignments.forEach(a => {
            if (a && a.moduleId) {
                referencedModuleIds.add(String(a.moduleId));
            }
        });
    });
    const referencedModulesMissingFromLibrary = [...referencedModuleIds].filter(mid => !moduleIdsInLibrary.has(mid));

    return {
        timestamp: new Date().toISOString(),
        hypotheses: {
            H1_assignedButPackageIsArchived: {
                meaning: "Assignment exists and id matches JSON, but package status is Archived (player excludes Archived only; Draft/Active are included).",
                likelyCause: excludedArchivedOnly.length > 0 && packagesOut.length === 0,
                excludedArchivedPackages: excludedArchivedOnly
            },
            H2_noAssignmentsForRequestTenant: {
                meaning: "No rows in TenantTrainingPackageAssignments for req.tenantId, or tenant context differs from agent primary tenant.",
                likelyCause: assignedList.length === 0,
                assignmentPackageIds: assignedList,
                reqTenantId: reqTenantStr,
                agentTenantIdFromAgentsTable: agentTenantStr,
                tenantIdMatchesAgentRow: agentTenantStr ? agentTenantStr.toLowerCase() === reqTenantStr.toLowerCase() : null
            },
            H3_assignedPackageIdNotInTrainingLibraryJson: {
                meaning: "DB assignment PackageId string does not match any packages[].id in oe.TrainingLibrary PackagesJson.",
                likelyCause: assignedNotInJson.length > 0,
                assignedButMissingFromJson: assignedNotInJson,
                sampleLibraryPackageIds: libraryPackageIds.slice(0, 20)
            },
            H4_trainingLibraryRowMissingOrPackagesJsonEmpty: {
                meaning: "No org TrainingLibrary row or PackagesJson parses to empty array.",
                likelyCause: !libRow || !Array.isArray(packagesJson) || packagesJson.length === 0,
                hasTrainingLibraryRow: Boolean(libRow),
                packagesJsonArrayLength: Array.isArray(packagesJson) ? packagesJson.length : 0,
                modulesJsonArrayLength: Array.isArray(modulesJson) ? modulesJson.length : 0
            },
            H5_packageModulesReferenceIdsMissingFromModulesJson: {
                meaning: "Package included in player but moduleAssignments point to module ids not present in ModulesJson.",
                likelyCause: referencedModulesMissingFromLibrary.length > 0,
                moduleIdsReferencedButNotInLibrary: referencedModulesMissingFromLibrary
            }
        },
        counts: {
            assignmentRowsDistinctPackageIds: assignedList.length,
            packagesReturnedToPlayer: packagesOut.length,
            moduleEntitiesReturnedToPlayer: moduleLibrary.length
        }
    };
}

/**
 * GET /api/me/agent/training/library-content
 * Assigned packages (excludes Archived only; matches library-status visibility) plus module definitions for the player.
 * ?diagnose=1 — include diagnostics object and log to server console.
 */
router.get("/library-content", authorize(["Agent", "TenantAdmin", "SysAdmin"]), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        const tenantId = req.tenantId;
        const allowAdminPreview =
            req.query.allowAdminPreview === "1" || req.query.allowAdminPreview === "true";
        const roles = getUserRoles(req.user) || [];
        const currentRole = req.user && req.user.currentRole;
        // Multi-role: use X-Current-Role + JWT (see authenticate middleware), not roles.includes alone.
        const canBypassPortalForPreview =
            allowAdminPreview &&
            (roles.includes("TenantAdmin") || roles.includes("SysAdmin")) &&
            (currentRole === "TenantAdmin" || currentRole === "SysAdmin");
        if (!canBypassPortalForPreview) {
            if (await rejectIfAgentPortalTrainingDisabled(pool, tenantId, res)) return;
        }
        const userId = req.user && req.user.UserId;
        const agentId = await getAgentIdFromUser(pool, userId);
        const diagnose = req.query.diagnose === "1" || req.query.diagnose === "true";

        const libRow = await getOrgTrainingLibraryRow(pool);
        const packagesJson = libRow ? safeJsonParse(libRow.PackagesJson, []) : [];
        const modulesJson = libRow ? safeJsonParse(libRow.ModulesJson, []) : [];

        const assignReq = pool.request();
        assignReq.input("TenantId", sql.UniqueIdentifier, tenantId);
        const assignResult = await assignReq.query(`
            SELECT PackageId
            FROM oe.TenantTrainingPackageAssignments
            WHERE TenantId = @TenantId AND IsActive = 1
        `);
        const assignedPackageIds = new Set((assignResult.recordset || []).map(r => r.PackageId).filter(Boolean));

        const packagesOut = [];
        const moduleIdSet = new Set();

        if (Array.isArray(packagesJson)) {
            packagesJson.forEach(pkg => {
                if (!pkg || !pkg.id || !assignedPackageIds.has(pkg.id)) {
                    return;
                }
                const st = pkg.status;
                if (st === "Archived") {
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

        const certificates = [];
        if (agentId) {
            const moduleById = modulesByIdFromLibrary(modulesJson);
            const awardsResult = await queryWithMissingTableFallback(
                () => {
                    const awardReq = pool.request();
                    awardReq.input("AgentId", sql.UniqueIdentifier, agentId);
                    return awardReq;
                },
                `
                    SELECT PackageId, AwardedAt
                    FROM oe.AgentTrainingPackageCertificateAwards
                    WHERE AgentId = @AgentId
                `
            );
            const awardsByPackageId = new Map(
                (awardsResult.recordset || []).map(row => [String(row.PackageId), row])
            );

            for (const pkg of packagesOut) {
                const normalizedCertificate = normalizePackageCertificate(pkg.certificate, pkg.title || pkg.id);
                const packageCertification = await evaluatePackageCertification(pool, agentId, pkg, moduleById);
                const awardRow = awardsByPackageId.get(String(pkg.id));
                certificates.push({
                    packageId: pkg.id,
                    packageTitle: pkg.title || pkg.id,
                    certificate: normalizedCertificate,
                    earned: Boolean(awardRow),
                    awardedAt: awardRow ? awardRow.AwardedAt : null,
                    packageCertification
                });
            }
        } else {
            packagesOut.forEach(pkg => {
                certificates.push({
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
                });
            });
        }

        let agentProgress = { quizCompletions: [], moduleCompletions: [] };
        if (agentId && packagesOut.length > 0) {
            const inList = packagesOut.map((_, index) => `@Pkg${index}`).join(", ");
            const quizRequestFactory = () => {
                const req = pool.request();
                req.input("AgentId", sql.UniqueIdentifier, agentId);
                packagesOut.forEach((pkg, index) => {
                    req.input(`Pkg${index}`, sql.NVarChar(100), pkg.id);
                });
                return req;
            };
            const quizResult = await queryWithMissingTableFallback(
                quizRequestFactory,
                `
                    SELECT PackageId, ModuleId, StepId, QuizId, CorrectAnswers, TotalQuestions, ScorePercent, CompletedAt
                    FROM oe.AgentTrainingLibraryQuizCompletions
                    WHERE AgentId = @AgentId AND PackageId IN (${inList})
                `
            );
            const modRequestFactory = () => {
                const req = pool.request();
                req.input("AgentId", sql.UniqueIdentifier, agentId);
                packagesOut.forEach((pkg, index) => {
                    req.input(`Pkg${index}`, sql.NVarChar(100), pkg.id);
                });
                return req;
            };
            const modResult = await queryWithMissingTableFallback(
                modRequestFactory,
                `
                    SELECT PackageId, ModuleId, CompletedAt
                    FROM oe.AgentTrainingLibraryModuleCompletions
                    WHERE AgentId = @AgentId AND PackageId IN (${inList})
                `
            );
            agentProgress = {
                quizCompletions: (quizResult.recordset || []).map(row => ({
                    packageId: String(row.PackageId),
                    moduleId: String(row.ModuleId),
                    stepId: String(row.StepId),
                    quizId: String(row.QuizId),
                    correctAnswers: Number(row.CorrectAnswers || 0),
                    totalQuestions: Number(row.TotalQuestions || 0),
                    scorePercent: Number(row.ScorePercent || 0),
                    completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : new Date().toISOString()
                })),
                moduleCompletions: (modResult.recordset || []).map(row => ({
                    packageId: String(row.PackageId),
                    moduleId: String(row.ModuleId),
                    completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : new Date().toISOString()
                }))
            };
        }

        const payload = {
            packages: packagesOut,
            moduleLibrary,
            certificates,
            agentProgress,
            hasAgentProfile: Boolean(agentId)
        };

        if (diagnose) {
            const diagnostics = await buildLibraryContentDiagnostics(pool, {
                tenantId,
                userId,
                libRow,
                packagesJson,
                modulesJson,
                assignedPackageIds,
                packagesOut,
                moduleLibrary
            });
            payload.diagnostics = diagnostics;
            console.log("[AgentTraining library-content DIAGNOSE]", JSON.stringify(diagnostics, null, 2));
        } else if (packagesOut.length === 0) {
            const diagnostics = await buildLibraryContentDiagnostics(pool, {
                tenantId,
                userId,
                libRow,
                packagesJson,
                modulesJson,
                assignedPackageIds,
                packagesOut,
                moduleLibrary
            });
            console.warn("[AgentTraining library-content empty packages — auto-diagnose]", JSON.stringify(diagnostics, null, 2));
        }

        return res.json({
            success: true,
            data: payload
        });
    } catch (error) {
        console.error("Error fetching agent library content:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch library content" });
    }
});

router.post("/library-quizzes/complete", authorize(["Agent", "TenantAdmin"]), requireTenantAccess, async (req, res) => {
    try {
        const { packageId, moduleId, stepId, quizId, score, totalQuestions } = req.body || {};
        if (
            !packageId ||
            !moduleId ||
            !stepId ||
            !quizId ||
            typeof packageId !== "string" ||
            typeof moduleId !== "string" ||
            typeof stepId !== "string" ||
            typeof quizId !== "string"
        ) {
            return res.status(400).json({
                success: false,
                message: "packageId, moduleId, stepId, and quizId are required"
            });
        }
        const parsedScore = Number(score);
        const parsedTotalQuestions = Number(totalQuestions);
        if (
            !Number.isFinite(parsedScore) ||
            !Number.isFinite(parsedTotalQuestions) ||
            parsedTotalQuestions <= 0 ||
            parsedScore < 0 ||
            parsedScore > parsedTotalQuestions
        ) {
            return res.status(400).json({
                success: false,
                message: "score and totalQuestions must be valid numbers"
            });
        }

        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        if (!agentId) {
            return res.status(403).json({ success: false, message: "Agent profile not found" });
        }

        const tenantId = req.tenantId;
        const verifyAgent = pool.request();
        verifyAgent.input("AgentId", sql.UniqueIdentifier, agentId);
        verifyAgent.input("TenantId", sql.UniqueIdentifier, tenantId);
        const agentRow = await verifyAgent.query(`
            SELECT AgentId FROM oe.Agents
            WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = 'Active'
        `);
        if (agentRow.recordset.length === 0) {
            return res.status(403).json({ success: false, message: "Agent not in current tenant context" });
        }

        const assignReq = pool.request();
        assignReq.input("TenantId", sql.UniqueIdentifier, tenantId);
        assignReq.input("PackageId", sql.NVarChar(100), packageId);
        const assignCheck = await assignReq.query(`
            SELECT 1 FROM oe.TenantTrainingPackageAssignments
            WHERE TenantId = @TenantId AND PackageId = @PackageId AND IsActive = 1
        `);
        if (assignCheck.recordset.length === 0) {
            return res.status(403).json({ success: false, message: "Package is not assigned to this tenant" });
        }

        const libRow = await getOrgTrainingLibraryRow(pool);
        const packagesJson = libRow ? safeJsonParse(libRow.PackagesJson, []) : [];
        const modulesJson = libRow ? safeJsonParse(libRow.ModulesJson, []) : [];
        const packageObj = Array.isArray(packagesJson) ? packagesJson.find(p => p && p.id === packageId) : null;
        if (!packageObj) {
            return res.status(404).json({ success: false, message: "Package not found in library" });
        }
        const moduleById = modulesByIdFromLibrary(modulesJson);
        const mod = moduleById[moduleId];
        if (!mod) {
            return res.status(404).json({ success: false, message: "Module not found in library" });
        }
        const assignments = Array.isArray(packageObj.moduleAssignments) ? packageObj.moduleAssignments : [];
        const assigned = assignments.some(a => a && a.moduleId === moduleId);
        if (!assigned) {
            return res.status(400).json({ success: false, message: "Module is not part of this package" });
        }
        const step = Array.isArray(mod.moduleSteps) ? mod.moduleSteps.find(s => s && s.id === stepId) : null;
        if (!step || !step.sectionQuiz || step.sectionQuiz.id !== quizId) {
            return res.status(400).json({ success: false, message: "Quiz does not match package/module/step" });
        }

        const scorePercent = Math.round((parsedScore / parsedTotalQuestions) * 10000) / 100;
        const completionUpsert = pool.request();
        completionUpsert.input("CompletionId", sql.UniqueIdentifier, uuidv4());
        completionUpsert.input("AgentId", sql.UniqueIdentifier, agentId);
        completionUpsert.input("PackageId", sql.NVarChar(100), packageId);
        completionUpsert.input("ModuleId", sql.NVarChar(100), moduleId);
        completionUpsert.input("StepId", sql.NVarChar(100), stepId);
        completionUpsert.input("QuizId", sql.NVarChar(100), quizId);
        completionUpsert.input("ScorePercent", sql.Decimal(5, 2), scorePercent);
        completionUpsert.input("TotalQuestions", sql.Int, parsedTotalQuestions);
        completionUpsert.input("CorrectAnswers", sql.Int, parsedScore);
        await completionUpsert.query(`
            MERGE oe.AgentTrainingLibraryQuizCompletions AS target
            USING (
                SELECT
                    @AgentId AS AgentId,
                    @PackageId AS PackageId,
                    @ModuleId AS ModuleId,
                    @StepId AS StepId,
                    @QuizId AS QuizId
            ) AS src
            ON target.AgentId = src.AgentId
                AND target.PackageId = src.PackageId
                AND target.QuizId = src.QuizId
            WHEN MATCHED THEN
                UPDATE SET
                    ModuleId = src.ModuleId,
                    StepId = src.StepId,
                    ScorePercent = @ScorePercent,
                    TotalQuestions = @TotalQuestions,
                    CorrectAnswers = @CorrectAnswers,
                    AttemptCount = ISNULL(target.AttemptCount, 1) + 1,
                    CompletedAt = GETUTCDATE(),
                    ModifiedDate = GETUTCDATE()
            WHEN NOT MATCHED THEN
                INSERT (
                    AgentTrainingLibraryQuizCompletionId,
                    AgentId,
                    PackageId,
                    ModuleId,
                    StepId,
                    QuizId,
                    ScorePercent,
                    TotalQuestions,
                    CorrectAnswers,
                    AttemptCount,
                    CompletedAt,
                    CreatedDate,
                    ModifiedDate
                )
                VALUES (
                    @CompletionId,
                    @AgentId,
                    @PackageId,
                    @ModuleId,
                    @StepId,
                    @QuizId,
                    @ScorePercent,
                    @TotalQuestions,
                    @CorrectAnswers,
                    1,
                    GETUTCDATE(),
                    GETUTCDATE(),
                    GETUTCDATE()
                );
        `);

        const packageCertification = await evaluatePackageCertification(pool, agentId, packageObj, moduleById);
        let certificateAward = null;
        if (packageCertification.passed) {
            const cert = normalizePackageCertificate(packageObj.certificate, packageObj.title || packageObj.id);
            const awardReq = pool.request();
            awardReq.input("AwardId", sql.UniqueIdentifier, uuidv4());
            awardReq.input("AgentId", sql.UniqueIdentifier, agentId);
            awardReq.input("PackageId", sql.NVarChar(100), packageId);
            awardReq.input("PackageName", sql.NVarChar(255), cert.packageName);
            awardReq.input("CertificateName", sql.NVarChar(255), cert.certificateName);
            awardReq.input("CertificateDetails", sql.NVarChar(sql.MAX), cert.certificateDetails);
            awardReq.input("CertificateImageUrl", sql.NVarChar(1000), cert.certificateImageUrl);
            const awardResult = await awardReq.query(`
                MERGE oe.AgentTrainingPackageCertificateAwards AS target
                USING (SELECT @AgentId AS AgentId, @PackageId AS PackageId) AS src
                ON target.AgentId = src.AgentId AND target.PackageId = src.PackageId
                WHEN MATCHED THEN
                    UPDATE SET
                        PackageName = @PackageName,
                        CertificateName = @CertificateName,
                        CertificateDetails = @CertificateDetails,
                        CertificateImageUrl = @CertificateImageUrl,
                        ModifiedDate = GETUTCDATE()
                WHEN NOT MATCHED THEN
                    INSERT (
                        AgentTrainingPackageCertificateAwardId,
                        AgentId,
                        PackageId,
                        PackageName,
                        CertificateName,
                        CertificateDetails,
                        CertificateImageUrl,
                        AwardedAt,
                        CreatedDate,
                        ModifiedDate
                    )
                    VALUES (
                        @AwardId,
                        @AgentId,
                        @PackageId,
                        @PackageName,
                        @CertificateName,
                        @CertificateDetails,
                        @CertificateImageUrl,
                        GETUTCDATE(),
                        GETUTCDATE(),
                        GETUTCDATE()
                    )
                OUTPUT inserted.AwardedAt, inserted.CertificateName, inserted.PackageName;
            `);
            const row = awardResult.recordset?.[0];
            certificateAward = row
                ? {
                      awardedAt: row.AwardedAt,
                      certificateName: row.CertificateName,
                      packageName: row.PackageName
                  }
                : null;
        }

        return res.json({
            success: true,
            data: {
                packageId,
                moduleId,
                stepId,
                quizId,
                score: parsedScore,
                totalQuestions: parsedTotalQuestions,
                scorePercent,
                packageCertification,
                certificateAward
            }
        });
    } catch (error) {
        console.error("Error recording library quiz completion:", error);
        return res.status(500).json({ success: false, message: "Failed to record quiz completion" });
    }
});

router.get("/library-status", authorize(["Agent", "TenantAdmin"]), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        const tenantId = req.tenantId;
        const adv = await getTenantAdvancedSettingsParsed(pool, tenantId);
        if (!isAgentPortalTrainingEnabledFromAdvanced(adv)) {
            const agentIdEarly = await getAgentIdFromUser(pool, req.user.UserId);
            return res.json({
                success: true,
                data: {
                    tenantId,
                    agentId: agentIdEarly || null,
                    agentPortalTrainingEnabled: false,
                    libraryPackages: [],
                    productTraining: []
                }
            });
        }

        const agentId = await getAgentIdFromUser(pool, req.user.UserId);

        const libRow = await getOrgTrainingLibraryRow(pool);
        const packagesJson = libRow ? safeJsonParse(libRow.PackagesJson, []) : [];
        const modulesJson = libRow ? safeJsonParse(libRow.ModulesJson, []) : [];
        const moduleById = modulesByIdFromLibrary(modulesJson);

        const assignReq = pool.request();
        assignReq.input("TenantId", sql.UniqueIdentifier, tenantId);
        const assignResult = await assignReq.query(`
            SELECT PackageId
            FROM oe.TenantTrainingPackageAssignments
            WHERE TenantId = @TenantId AND IsActive = 1
        `);
        const assignedPackageIds = new Set((assignResult.recordset || []).map(r => r.PackageId).filter(Boolean));

        let completionRows = [];
        if (agentId) {
            const compReq = pool.request();
            compReq.input("AgentId", sql.UniqueIdentifier, agentId);
            const compResult = await compReq.query(`
                SELECT PackageId, ModuleId, CompletedAt
                FROM oe.AgentTrainingLibraryModuleCompletions
                WHERE AgentId = @AgentId
            `);
            completionRows = compResult.recordset || [];
        }
        const completionKey = row => `${row.PackageId}\0${row.ModuleId}`;
        const completionMap = {};
        completionRows.forEach(row => {
            const k = completionKey(row);
            if (!completionMap[k] || new Date(row.CompletedAt) > new Date(completionMap[k].CompletedAt)) {
                completionMap[k] = row;
            }
        });

        const libraryPackages = [];
        if (Array.isArray(packagesJson)) {
            packagesJson.forEach(pkg => {
                if (!pkg || !pkg.id || !assignedPackageIds.has(pkg.id)) {
                    return;
                }
                const assignments = Array.isArray(pkg.moduleAssignments) ? [...pkg.moduleAssignments] : [];
                assignments.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                const modules = assignments.map(a => {
                    const mod = moduleById[a.moduleId] || null;
                    const k = completionKey({ PackageId: pkg.id, ModuleId: a.moduleId });
                    const done = Boolean(completionMap[k]);
                    return {
                        moduleId: a.moduleId,
                        title: mod ? mod.title : a.moduleId,
                        required: Boolean(a.required),
                        order: a.order ?? 0,
                        completed: done,
                        completedAt: done ? completionMap[k].CompletedAt : null
                    };
                });
                const modulesTotal = modules.length;
                const modulesCompleted = modules.filter(m => m.completed).length;
                libraryPackages.push({
                    packageId: pkg.id,
                    title: pkg.title || pkg.id,
                    status: pkg.status || null,
                    modulesTotal,
                    modulesCompleted,
                    modules
                });
            });
        }

        const productRequest = pool.request();
        productRequest.input("TenantId", sql.UniqueIdentifier, tenantId);
        const productResult = await productRequest.query(`
            SELECT DISTINCT
                p.ProductId, p.Name, p.TrainingConfig
            FROM oe.Products p
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId
                AND tps.TenantId = @TenantId AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.Status = 'Active'
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
            AND p.TrainingConfig IS NOT NULL
            ORDER BY p.Name
        `);

        let completionsByProduct = {};
        if (agentId) {
            const cr = pool.request();
            cr.input("AgentId", sql.UniqueIdentifier, agentId);
            const cres = await cr.query(`
                SELECT ProductId, ScorePercent, CompletedAt
                FROM oe.TrainingCompletions
                WHERE AgentId = @AgentId
            `);
            (cres.recordset || []).forEach(row => {
                const key = row.ProductId;
                if (!completionsByProduct[key] || new Date(row.CompletedAt) > new Date(completionsByProduct[key].CompletedAt)) {
                    completionsByProduct[key] = row;
                }
            });
        }

        const productTraining = (productResult.recordset || [])
            .map(row => {
                const config = safeJsonParse(row.TrainingConfig, {});
                const agentTraining = config.agentTraining || null;
                if (!agentTraining) {
                    return null;
                }
                const passingScore = agentTraining.passingScorePercent ?? 80;
                const questions = agentTraining.questions || [];
                const last = completionsByProduct[row.ProductId] || null;
                const scorePercent = last ? Number(last.ScorePercent) : null;
                const passed = last != null && scorePercent != null && scorePercent >= passingScore;
                return {
                    productId: row.ProductId,
                    name: row.Name,
                    requiredForSell: Boolean(agentTraining.requiredForSell),
                    passingScorePercent: passingScore,
                    questionsCount: questions.length,
                    modulesCount: (agentTraining.modules || []).length,
                    lastScorePercent: scorePercent,
                    passed,
                    lastCompletedAt: last ? last.CompletedAt : null
                };
            })
            .filter(Boolean);

        return res.json({
            success: true,
            data: {
                tenantId,
                agentId: agentId || null,
                agentPortalTrainingEnabled: true,
                libraryPackages,
                productTraining
            }
        });
    } catch (error) {
        console.error("Error fetching agent library training status:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch training status" });
    }
});

router.post("/library-modules/complete", authorize(["Agent", "TenantAdmin"]), requireTenantAccess, async (req, res) => {
    try {
        const { packageId, moduleId } = req.body || {};
        if (!packageId || !moduleId || typeof packageId !== "string" || typeof moduleId !== "string") {
            return res.status(400).json({ success: false, message: "packageId and moduleId are required" });
        }

        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        if (!agentId) {
            return res.status(403).json({ success: false, message: "Agent profile not found" });
        }

        const tenantId = req.tenantId;
        const verifyAgent = pool.request();
        verifyAgent.input("AgentId", sql.UniqueIdentifier, agentId);
        verifyAgent.input("TenantId", sql.UniqueIdentifier, tenantId);
        const agentRow = await verifyAgent.query(`
            SELECT AgentId FROM oe.Agents
            WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = 'Active'
        `);
        if (agentRow.recordset.length === 0) {
            return res.status(403).json({ success: false, message: "Agent not in current tenant context" });
        }

        const assignReq = pool.request();
        assignReq.input("TenantId", sql.UniqueIdentifier, tenantId);
        assignReq.input("PackageId", sql.NVarChar(100), packageId);
        const assignCheck = await assignReq.query(`
            SELECT 1 FROM oe.TenantTrainingPackageAssignments
            WHERE TenantId = @TenantId AND PackageId = @PackageId AND IsActive = 1
        `);
        if (assignCheck.recordset.length === 0) {
            return res.status(403).json({ success: false, message: "Package is not assigned to this tenant" });
        }

        const libRow = await getOrgTrainingLibraryRow(pool);
        const packagesJson = libRow ? safeJsonParse(libRow.PackagesJson, []) : [];
        const pkg = Array.isArray(packagesJson) ? packagesJson.find(p => p && p.id === packageId) : null;
        if (!pkg) {
            return res.status(404).json({ success: false, message: "Package not found in library" });
        }
        const assignments = Array.isArray(pkg.moduleAssignments) ? pkg.moduleAssignments : [];
        const allowed = assignments.some(a => a && a.moduleId === moduleId);
        if (!allowed) {
            return res.status(400).json({ success: false, message: "Module is not part of this package" });
        }

        const mergeReq = pool.request();
        mergeReq.input("AgentId", sql.UniqueIdentifier, agentId);
        mergeReq.input("PackageId", sql.NVarChar(100), packageId);
        mergeReq.input("ModuleId", sql.NVarChar(100), moduleId);
        await mergeReq.query(`
            MERGE oe.AgentTrainingLibraryModuleCompletions AS target
            USING (SELECT @AgentId AS AgentId, @PackageId AS PackageId, @ModuleId AS ModuleId) AS src
            ON target.AgentId = src.AgentId AND target.PackageId = src.PackageId AND target.ModuleId = src.ModuleId
            WHEN MATCHED THEN
                UPDATE SET CompletedAt = GETUTCDATE(), ModifiedDate = GETUTCDATE()
            WHEN NOT MATCHED THEN
                INSERT (AgentTrainingLibraryModuleCompletionId, AgentId, PackageId, ModuleId, CompletedAt, CreatedDate, ModifiedDate)
                VALUES (NEWID(), src.AgentId, src.PackageId, src.ModuleId, GETUTCDATE(), GETUTCDATE(), GETUTCDATE());
        `);

        return res.json({
            success: true,
            data: { packageId, moduleId, completedAt: new Date().toISOString() }
        });
    } catch (error) {
        console.error("Error recording library module completion:", error);
        return res.status(500).json({ success: false, message: "Failed to record module completion" });
    }
});

router.post("/profile/reset", authorize(["Agent", "TenantAdmin"]), requireTenantAccess, async (req, res) => {
    try {
        const rawHost = String(req.headers.host || "").split(":")[0];
        const forwardedHost = String(req.headers["x-forwarded-host"] || "")
            .split(",")[0]
            .trim()
            .split(":")[0];
        const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
        const isLocalRequest = localHosts.has(rawHost) || localHosts.has(forwardedHost);
        if (!isLocalRequest) {
            return res.status(403).json({ success: false, message: "Training profile reset is localhost-only." });
        }

        const pool = await getPool();
        if (await rejectIfAgentPortalTrainingDisabled(pool, req.tenantId, res)) return;
        const agentId = await getAgentIdFromUser(pool, req.user.UserId);
        if (!agentId) {
            return res.status(403).json({ success: false, message: "Agent profile not found" });
        }

        const tenantId = req.tenantId;
        const verifyAgent = pool.request();
        verifyAgent.input("AgentId", sql.UniqueIdentifier, agentId);
        verifyAgent.input("TenantId", sql.UniqueIdentifier, tenantId);
        const agentRow = await verifyAgent.query(`
            SELECT AgentId FROM oe.Agents
            WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = 'Active'
        `);
        if (agentRow.recordset.length === 0) {
            return res.status(403).json({ success: false, message: "Agent not in current tenant context" });
        }

        const clearLibraryReq = pool.request();
        clearLibraryReq.input("AgentId", sql.UniqueIdentifier, agentId);
        await clearLibraryReq.query(`
            DELETE FROM oe.AgentTrainingLibraryModuleCompletions
            WHERE AgentId = @AgentId
        `);

        const clearProductReq = pool.request();
        clearProductReq.input("AgentId", sql.UniqueIdentifier, agentId);
        await clearProductReq.query(`
            DELETE FROM oe.TrainingCompletions
            WHERE AgentId = @AgentId
        `);

        const clearQuizReq = pool.request();
        clearQuizReq.input("AgentId", sql.UniqueIdentifier, agentId);
        await queryWithMissingTableFallback(
            () => clearQuizReq,
            `
                DELETE FROM oe.AgentTrainingLibraryQuizCompletions
                WHERE AgentId = @AgentId
            `
        );

        const clearAwardsReq = pool.request();
        clearAwardsReq.input("AgentId", sql.UniqueIdentifier, agentId);
        await queryWithMissingTableFallback(
            () => clearAwardsReq,
            `
                DELETE FROM oe.AgentTrainingPackageCertificateAwards
                WHERE AgentId = @AgentId
            `
        );

        return res.json({
            success: true,
            data: {
                agentId,
                resetAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error("Error resetting training profile:", error);
        return res.status(500).json({ success: false, message: "Failed to reset training profile" });
    }
});

module.exports = router;
