// backend/routes/website-form-submissions.js
//
// Server-to-server endpoint called by each tenant's public website after a
// quote/contact form is submitted. Combines agent attribution lookup with
// audit logging:
//
//   1. Looks up the attributed agent (by ?id= AgentCode or ?name=)
//   2. Inserts a row into oe.WebsiteFormSubmissions
//   3. Returns the matched agent (if any) so the caller can route the email
//
// Mounted under `app.use('/api/website-form-submissions', authenticate, ...)`
// — tenant API key auth, TenantId derived from the key (never the body).

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');
const prospectService = require('../services/prospect.service');
const { resolveAgentAndSource, getAgentDefaultSource } = require('../services/prospectSource.service');

router.post('/', async (req, res) => {
    try {
        const tenantId = req.user && req.user.TenantId;
        if (!tenantId) {
            return res.status(401).json({
                success: false,
                message: 'API key is not associated with a tenant'
            });
        }

        const body = req.body || {};
        const source = ['quote', 'contact'].includes(body.source) ? body.source : 'quote';
        const formType = ['employer', 'individual'].includes(body.formType) ? body.formType : null;
        const attemptedAgentId = clip(body.attemptedAgentId, 100);
        const attemptedAgentName = clip(body.attemptedAgentName, 200);

        const submitter = body.submitter || {};
        const submitterName = clip(submitter.name, 200);
        const submitterEmail = clip(submitter.email, 200);
        const submitterPhone = clip(submitter.phone, 50);
        const submitterState = clip(submitter.state, 50);
        const submitterCompany = clip(submitter.company, 200);

        const subject = clip(body.subject, 300);
        // Read x-forwarded-for first (in case behind reverse proxy) but cap to one address.
        const ipHeader = (req.headers['x-forwarded-for'] || '').toString();
        const ip = clip((ipHeader.split(',')[0] || req.ip || '').trim(), 64);
        const userAgent = clip(req.headers['user-agent'], 500);

        // Perform attribution lookup (does NOT depend on submitter info).
        const lookup = await resolveAgent({
            tenantId,
            id: attemptedAgentId,
            name: attemptedAgentName
        });

        const matchStatus = lookup.status;
        const matchedAgent = lookup.agent || null;
        const matchedSourceId = lookup.sourceId || null;
        const matchedSourceName = lookup.sourceName || null;

        // Insert audit row.
        const pool = await getPool();
        const ins = pool.request();
        ins.input('TenantId', sql.UniqueIdentifier, tenantId);
        ins.input('Source', sql.NVarChar, source);
        ins.input('FormType', sql.NVarChar, formType);
        ins.input('Subject', sql.NVarChar, subject);
        ins.input('AttemptedAgentId', sql.NVarChar, attemptedAgentId);
        ins.input('AttemptedAgentName', sql.NVarChar, attemptedAgentName);
        ins.input('MatchStatus', sql.NVarChar, matchStatus);
        ins.input('MatchedAgentId', sql.UniqueIdentifier, matchedAgent ? matchedAgent.agentId : null);
        ins.input('MatchedAgentCode', sql.NVarChar, matchedAgent ? matchedAgent.agentCode : null);
        ins.input('MatchedAgentEmail', sql.NVarChar, matchedAgent ? matchedAgent.email : null);
        ins.input('SubmitterName', sql.NVarChar, submitterName);
        ins.input('SubmitterEmail', sql.NVarChar, submitterEmail);
        ins.input('SubmitterPhone', sql.NVarChar, submitterPhone);
        ins.input('SubmitterState', sql.NVarChar, submitterState);
        ins.input('SubmitterCompany', sql.NVarChar, submitterCompany);
        ins.input('IpAddress', sql.NVarChar, ip);
        ins.input('UserAgent', sql.NVarChar, userAgent);

        const result = await ins.query(`
            INSERT INTO oe.WebsiteFormSubmissions (
                TenantId, Source, FormType, Subject,
                AttemptedAgentId, AttemptedAgentName,
                MatchStatus, MatchedAgentId, MatchedAgentCode, MatchedAgentEmail,
                SubmitterName, SubmitterEmail, SubmitterPhone, SubmitterState, SubmitterCompany,
                IpAddress, UserAgent
            )
            OUTPUT INSERTED.SubmissionId
            VALUES (
                @TenantId, @Source, @FormType, @Subject,
                @AttemptedAgentId, @AttemptedAgentName,
                @MatchStatus, @MatchedAgentId, @MatchedAgentCode, @MatchedAgentEmail,
                @SubmitterName, @SubmitterEmail, @SubmitterPhone, @SubmitterState, @SubmitterCompany,
                @IpAddress, @UserAgent
            )
        `);

        const submissionId = result.recordset[0]?.SubmissionId;

        // On a matched submission, create (or dedupe to) a prospect owned by the matched
        // agent, tagged source 'MightyWELL Website'. This is the single creation hook that
        // also fires the centralized agent notification. A failure here must NEVER break the
        // submission — we log and continue, returning prospectId: null.
        let prospectId = null;
        if (matchStatus === 'matched' && matchedAgent && matchedAgent.agentId) {
            try {
                const nameParts = (submitterName || '').trim().split(/\s+/).filter(Boolean);
                const firstName = nameParts.length ? nameParts[0] : null;
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;

                const notes = [
                    submitterCompany ? `Company: ${submitterCompany}` : null,
                    submitterState ? `State: ${submitterState}` : null,
                    formType ? `Form type: ${formType}` : null,
                    subject || null,
                ].filter(Boolean).join(' | ') || null;

                const { prospect } = await prospectService.findOrCreateProspect({
                    tenantId,
                    agentId: matchedAgent.agentId,
                    firstName,
                    lastName,
                    email: submitterEmail,
                    phone: submitterPhone,
                    referralName: attemptedAgentName,
                    notes,
                    source: matchedSourceName || 'MightyWELL Website',
                    sourceId: matchedSourceId,
                    status: 'New',
                });
                prospectId = prospect ? prospect.ProspectId : null;
            } catch (createErr) {
                logger.error('[WEBSITE-FORM-SUB] prospect create failed', { error: createErr.message });
            }
        }

        return res.json({
            success: true,
            submissionId,
            matchStatus,
            agent: matchedAgent,
            prospectId
        });
    } catch (err) {
        logger.error('[WEBSITE-FORM-SUB] Error', { error: err.message, stack: err.stack });
        return res.status(500).json({ success: false, message: 'Submission log failed' });
    }
});

/**
 * Optional: report whether the email was actually sent. Called by the website
 * server after SendGrid acks (or fails). Updates the existing row by
 * SubmissionId. No-op if the row doesn't belong to the caller's tenant.
 */
router.patch('/:submissionId/email-status', async (req, res) => {
    try {
        const tenantId = req.user && req.user.TenantId;
        if (!tenantId) return res.status(401).json({ success: false });

        const submissionId = req.params.submissionId;
        const status = ['sent', 'failed', 'skipped'].includes(req.body.status) ? req.body.status : null;
        const failureReason = clip(req.body.failureReason, 500);
        if (!status) return res.status(400).json({ success: false, message: 'status required' });

        const pool = await getPool();
        const r = pool.request();
        r.input('SubmissionId', sql.UniqueIdentifier, submissionId);
        r.input('TenantId', sql.UniqueIdentifier, tenantId);
        r.input('Status', sql.NVarChar, status);
        r.input('FailureReason', sql.NVarChar, failureReason);
        await r.query(`
            UPDATE oe.WebsiteFormSubmissions
            SET EmailSendStatus = @Status,
                EmailFailureReason = @FailureReason
            WHERE SubmissionId = @SubmissionId AND TenantId = @TenantId
        `);
        return res.json({ success: true });
    } catch (err) {
        logger.error('[WEBSITE-FORM-SUB] email-status error', { error: err.message });
        return res.status(500).json({ success: false });
    }
});

/**
 * Resolve the attributed agent for a tenant.
 * Returns { status, agent, sourceId, sourceName } where status is one of:
 *   matched | not_found | ambiguous_id | ambiguous_name | no_attribution | error
 */
async function resolveAgent({ tenantId, id, name }) {
    if (!id && !name) return { status: 'no_attribution', agent: null, sourceId: null, sourceName: null };

    try {
        const pool = await getPool();

        if (id) {
            const resolved = await resolveAgentAndSource(pool, tenantId, id);
            if (resolved.agentId) {
                // Fetch the display fields (name + email) for the matched agent.
                const r = pool.request();
                r.input('agentId', sql.UniqueIdentifier, resolved.agentId);
                const agentRow = await r.query(`
                    SELECT a.AgentId, a.AgentCode, u.FirstName, u.LastName, u.Email
                    FROM oe.Agents a
                    INNER JOIN oe.Users u ON u.UserId = a.UserId
                    WHERE a.AgentId = @agentId
                `);
                const row = agentRow.recordset[0];
                return {
                    status: 'matched',
                    agent: row ? shape(row) : { agentId: resolved.agentId, agentCode: resolved.agentCode, displayName: '', email: null },
                    sourceId: resolved.sourceId,
                    sourceName: resolved.sourceName,
                };
            }
            // id was present but agent not found — fall through to name lookup if available.
        }

        if (name) {
            const parts = name.split(/\s+/).filter(Boolean);
            if (parts.length < 2) return { status: 'not_found', agent: null, sourceId: null, sourceName: null };
            const first = parts[0];
            const last = parts.slice(1).join(' ');

            const r = pool.request();
            r.input('tenantId', sql.UniqueIdentifier, tenantId);
            r.input('first', sql.NVarChar, first);
            r.input('last', sql.NVarChar, last);
            const result = await r.query(`
                SELECT TOP 2
                    a.AgentId, a.AgentCode,
                    u.FirstName, u.LastName, u.Email
                FROM oe.Agents a
                INNER JOIN oe.Users u ON u.UserId = a.UserId
                WHERE a.TenantId = @tenantId
                  AND a.Status = N'Active'
                  AND LOWER(u.FirstName) = LOWER(@first)
                  AND LOWER(u.LastName) = LOWER(@last)
            `);
            if (result.recordset.length === 1) {
                const matched = shape(result.recordset[0]);
                // No ?id= source was determined on the name path — attribute the
                // lead to the agent's default source so it isn't left sourceless.
                let sourceId = null;
                let sourceName = null;
                try {
                    const def = await getAgentDefaultSource(pool, tenantId, matched.agentId);
                    if (def) { sourceId = def.SourceId; sourceName = def.Name; }
                } catch (defErr) {
                    logger.error('[WEBSITE-FORM-SUB] default source lookup failed', { error: defErr.message });
                }
                return { status: 'matched', agent: matched, sourceId, sourceName };
            }
            if (result.recordset.length > 1) {
                return { status: 'ambiguous_name', agent: null, sourceId: null, sourceName: null };
            }
        }

        return { status: 'not_found', agent: null, sourceId: null, sourceName: null };
    } catch (err) {
        logger.error('[WEBSITE-FORM-SUB] resolveAgent error', { error: err.message });
        return { status: 'error', agent: null, sourceId: null, sourceName: null };
    }
}

function shape(row) {
    return {
        agentId: row.AgentId,
        agentCode: row.AgentCode,
        displayName: `${row.FirstName || ''} ${row.LastName || ''}`.trim(),
        email: row.Email
    };
}

function clip(value, max) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
}

module.exports = router;
