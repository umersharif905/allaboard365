const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const {
  getEffectiveUserId,
  getEffectiveMemberId,
  getActorUserId,
} = require('../../../middleware/attachMemberHouseholdContext');

async function getMemberIdFromUser(pool, userId) {
    const request = pool.request();
    request.input('UserId', sql.UniqueIdentifier, userId);
    const result = await request.query(`
        SELECT MemberId FROM oe.Members WHERE UserId = @UserId AND Status IN ('Active', 'Terminated')
    `);
    return result.recordset.length > 0 ? result.recordset[0].MemberId : null;
}

/**
 * GET /api/me/member/training/products
 * Products the member is enrolled in that have member training
 */
router.get('/products', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const memberId = getEffectiveMemberId(req) || await getMemberIdFromUser(pool, getEffectiveUserId(req));
        if (!memberId) {
            return res.status(404).json({ success: false, message: 'Member record not found' });
        }

        const request = pool.request();
        request.input('MemberId', sql.UniqueIdentifier, memberId);
        const result = await request.query(`
            SELECT DISTINCT
                p.ProductId, p.Name, p.ProductType, p.Description, p.ProductImageUrl,
                p.ProductLogoUrl, p.TrainingConfig
            FROM oe.Products p
            INNER JOIN oe.Enrollments e ON e.ProductId = p.ProductId AND e.MemberId = @MemberId
                AND e.Status IN ('Active', 'Pending')
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            WHERE p.Status = 'Active' AND p.TrainingConfig IS NOT NULL
            ORDER BY p.Name
        `);

        const completionsRequest = pool.request();
        completionsRequest.input('MemberId', sql.UniqueIdentifier, memberId);
        const completionsResult = await completionsRequest.query(`
            SELECT ProductId, AttemptNumber, ScorePercent, CompletedAt
            FROM oe.TrainingCompletions
            WHERE MemberId = @MemberId
        `);
        const completionsByProduct = {};
        (completionsResult.recordset || []).forEach(row => {
            const key = row.ProductId;
            if (!completionsByProduct[key] || row.CompletedAt > completionsByProduct[key].CompletedAt) {
                completionsByProduct[key] = { attemptNumber: row.AttemptNumber, scorePercent: row.ScorePercent, completedAt: row.CompletedAt };
            }
        });

        const products = result.recordset
            .map(row => {
                let memberTraining = null;
                if (row.TrainingConfig) {
                    try {
                        const config = typeof row.TrainingConfig === 'string' ? JSON.parse(row.TrainingConfig) : row.TrainingConfig;
                        memberTraining = config.memberTraining || null;
                    } catch (e) {
                        return null;
                    }
                }
                if (!memberTraining) return null;
                const lastCompletion = completionsByProduct[row.ProductId] || null;
                return {
                    ProductId: row.ProductId,
                    Name: row.Name,
                    ProductType: row.ProductType,
                    Description: row.Description,
                    ProductImageUrl: row.ProductImageUrl,
                    ProductLogoUrl: row.ProductLogoUrl,
                    memberTraining: {
                        modulesCount: (memberTraining.modules || []).length,
                        questionsCount: (memberTraining.questions || []).length
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
        console.error('Error fetching member training products:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch training products' });
    }
});

/**
 * GET /api/me/member/training/products/:productId
 */
router.get('/products/:productId', authorize(['Member']), async (req, res) => {
    try {
        const { productId } = req.params;
        const pool = await getPool();
        const memberId = getEffectiveMemberId(req) || await getMemberIdFromUser(pool, getEffectiveUserId(req));
        if (!memberId) {
            return res.status(404).json({ success: false, message: 'Member record not found' });
        }

        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        request.input('MemberId', sql.UniqueIdentifier, memberId);
        const result = await request.query(`
            SELECT p.ProductId, p.Name, p.TrainingConfig
            FROM oe.Products p
            INNER JOIN oe.Enrollments e ON e.ProductId = p.ProductId AND e.MemberId = @MemberId
                AND e.Status IN ('Active', 'Pending')
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            WHERE p.ProductId = @ProductId AND p.Status = 'Active'
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found or not enrolled' });
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
        const memberTraining = config?.memberTraining || null;
        if (!memberTraining) {
            return res.status(404).json({ success: false, message: 'No member training for this product' });
        }

        return res.json({
            success: true,
            data: {
                ProductId: row.ProductId,
                Name: row.Name,
                memberTraining
            }
        });
    } catch (error) {
        console.error('Error fetching member training product:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch training config' });
    }
});

/**
 * POST /api/me/member/training/products/:productId/complete
 */
router.post('/products/:productId/complete', authorize(['Member']), async (req, res) => {
    try {
        const { productId } = req.params;
        const { answers } = req.body || {};
        const pool = await getPool();
        const memberId = getEffectiveMemberId(req) || await getMemberIdFromUser(pool, getEffectiveUserId(req));
        if (!memberId) {
            return res.status(403).json({ success: false, message: 'Member record not found' });
        }

        const request = pool.request();
        request.input('ProductId', sql.UniqueIdentifier, productId);
        request.input('MemberId', sql.UniqueIdentifier, memberId);
        const productResult = await request.query(`
            SELECT p.ProductId, p.TrainingConfig
            FROM oe.Products p
            INNER JOIN oe.Enrollments e ON e.ProductId = p.ProductId AND e.MemberId = @MemberId
                AND e.Status IN ('Active', 'Pending')
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            WHERE p.ProductId = @ProductId AND p.Status = 'Active'
        `);

        if (productResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found or not enrolled' });
        }

        let config;
        try {
            const raw = productResult.recordset[0].TrainingConfig;
            config = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Invalid training config' });
        }
        const memberTraining = config.memberTraining || {};
        const questions = memberTraining.questions || [];
        if (questions.length === 0) {
            return res.status(400).json({ success: false, message: 'No questions configured' });
        }

        const answerMap = Array.isArray(answers) ? Object.fromEntries(answers.map(a => [a.questionId, a.chosenKey])) : {};
        let correct = 0;
        questions.forEach(q => {
            if (answerMap[q.id] === q.correctResponseKey) correct++;
        });
        const scorePercent = questions.length ? Math.round((correct / questions.length) * 10000) / 100 : 0;
        const passingScore = memberTraining.passingScorePercent ?? 0;
        const passed = scorePercent >= passingScore;

        const maxAttemptRequest = pool.request();
        maxAttemptRequest.input('ProductId', sql.UniqueIdentifier, productId);
        maxAttemptRequest.input('MemberId', sql.UniqueIdentifier, memberId);
        const maxResult = await maxAttemptRequest.query(`
            SELECT ISNULL(MAX(AttemptNumber), 0) AS MaxAttempt FROM oe.TrainingCompletions
            WHERE ProductId = @ProductId AND MemberId = @MemberId
        `);
        const attemptNumber = (maxResult.recordset[0]?.MaxAttempt || 0) + 1;

        const insertRequest = pool.request();
        const completionId = uuidv4();
        insertRequest.input('TrainingCompletionId', sql.UniqueIdentifier, completionId);
        insertRequest.input('ProductId', sql.UniqueIdentifier, productId);
        insertRequest.input('MemberId', sql.UniqueIdentifier, memberId);
        insertRequest.input('UserId', sql.UniqueIdentifier, getActorUserId(req));
        insertRequest.input('AttemptNumber', sql.Int, attemptNumber);
        insertRequest.input('ScorePercent', sql.Decimal(5, 2), scorePercent);
        insertRequest.input('TotalQuestions', sql.Int, questions.length);
        insertRequest.input('CorrectAnswers', sql.Int, correct);
        await insertRequest.query(`
            INSERT INTO oe.TrainingCompletions (
                TrainingCompletionId, ProductId, MemberId, UserId, AttemptNumber,
                ScorePercent, TotalQuestions, CorrectAnswers, CompletedAt, CreatedDate, ModifiedDate
            ) VALUES (
                @TrainingCompletionId, @ProductId, @MemberId, @UserId, @AttemptNumber,
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
        console.error('Error completing member training:', error);
        return res.status(500).json({ success: false, message: 'Failed to record completion' });
    }
});

/**
 * GET /api/me/member/training/completions
 */
router.get('/completions', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const memberId = getEffectiveMemberId(req) || await getMemberIdFromUser(pool, getEffectiveUserId(req));
        if (!memberId) {
            return res.json({ success: true, data: [] });
        }

        const request = pool.request();
        request.input('MemberId', sql.UniqueIdentifier, memberId);
        const result = await request.query(`
            SELECT tc.TrainingCompletionId, tc.ProductId, tc.AttemptNumber, tc.ScorePercent,
                tc.TotalQuestions, tc.CorrectAnswers, tc.CompletedAt, p.Name as ProductName
            FROM oe.TrainingCompletions tc
            INNER JOIN oe.Products p ON tc.ProductId = p.ProductId
            WHERE tc.MemberId = @MemberId
            ORDER BY tc.CompletedAt DESC
        `);

        return res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('Error fetching member training completions:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch completions' });
    }
});

module.exports = router;
