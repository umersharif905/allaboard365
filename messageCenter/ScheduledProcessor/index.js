// messageCenter/ScheduledProcessor/index.js
// Runs daily at 10 AM — processes due campaign steps for active campaign enrollments.
const sql = require('mssql');
const { buildMarketingFooterAndUnsubscribeUrl } = require('../shared/marketingEmailCompliance');

// Database config
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true,
        enableArithAbort: true,
        trustServerCertificate: false
    }
};

module.exports = async function (context, myTimer) {
    context.log('ScheduledProcessor started');

    let pool;
    try {
        pool = await sql.connect(dbConfig);
        await processCampaignSteps(context, pool);
    } catch (error) {
        context.log.error('Error:', error);
    } finally {
        if (pool) await pool.close();
    }
};

/**
 * Process campaign steps that are due today.
 * Finds active CampaignEnrollments where the next step's DelayDays has been reached.
 * Checks termination before sending. Queues messages to oe.MessageQueue.
 */
async function memberMarketingFlags(pool, memberId) {
  const r = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT COALESCE(p.EmailMarketingOptOut, 0) AS EmailOptOut,
             COALESCE(p.SmsMarketingOptOut, 0) AS SmsOptOut,
             m.SmsConsent
      FROM oe.Members m
      LEFT JOIN oe.MemberCommunicationPreferences p ON p.MemberId = m.MemberId
      WHERE m.MemberId = @memberId
    `);
  const row = r.recordset[0];
  if (!row) return { emailMarketingBlocked: true, smsMarketingBlocked: true };
  return {
    emailMarketingBlocked: !!row.EmailOptOut,
    smsMarketingBlocked: !!row.SmsOptOut || !(row.SmsConsent === true || row.SmsConsent === 1)
  };
}

async function insertSkippedCampaignLog(pool, enrollmentId, stepId, messageType) {
  await pool.request()
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('stepId', sql.UniqueIdentifier, stepId)
    .input('messageType', sql.NVarChar(20), messageType)
    .query(`
      INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
      VALUES (NEWID(), @enrollmentId, @stepId, @messageType, NULL, SYSUTCDATETIME(), 'Skipped')
    `);
}

async function processCampaignSteps(context, pool) {
  try {
    context.log('Processing campaign steps...');

    // Find all active campaign enrollments with due steps (DelayDays > 0 only — Day 0 is handled immediately by the trigger)
    const dueSteps = await pool.request().query(`
      SELECT ce.CampaignEnrollmentId, ce.CampaignId, ce.MemberId, ce.TenantId,
             ce.TriggerDate, ce.CurrentStepOrder, c.RecipientType,
             cs.StepId, cs.StepOrder, cs.DelayDays, cs.EmailTemplateId, cs.SmsTemplateId
      FROM oe.CampaignEnrollments ce
      JOIN oe.Campaigns c ON ce.CampaignId = c.CampaignId
      JOIN oe.CampaignSteps cs ON ce.CampaignId = cs.CampaignId
      WHERE ce.Status = 'Active'
        AND cs.StepOrder > ce.CurrentStepOrder
        AND cs.IsActive = 1
        AND cs.DelayDays > 0
        AND DATEADD(DAY, cs.DelayDays, ce.TriggerDate) <= CAST(GETUTCDATE() AS DATE)
      ORDER BY ce.CampaignEnrollmentId, cs.StepOrder
    `);

    context.log(`Found ${dueSteps.recordset.length} due campaign steps`);

    // Group by enrollment to process sequentially
    const byEnrollment = {};
    for (const row of dueSteps.recordset) {
      if (!byEnrollment[row.CampaignEnrollmentId]) {
        byEnrollment[row.CampaignEnrollmentId] = { ...row, steps: [] };
      }
      byEnrollment[row.CampaignEnrollmentId].steps.push(row);
    }

    let totalQueued = 0;

    for (const enrollmentId of Object.keys(byEnrollment)) {
      const enrollment = byEnrollment[enrollmentId];
      try {
        // Check termination — use TerminationDate column, not Status field
        const termResult = await pool.request()
          .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
          .query(`
            SELECT TOP 1 TerminationDate FROM oe.Enrollments
            WHERE MemberId = @memberId AND TerminationDate IS NOT NULL
          `);

        if (termResult.recordset.length > 0) {
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .query(`
              UPDATE oe.CampaignEnrollments
              SET Status = 'Cancelled', CompletedDate = SYSUTCDATETIME()
              WHERE CampaignEnrollmentId = @enrollmentId
            `);
          context.log(`Cancelled campaign for terminated member ${enrollment.MemberId}`);
          continue;
        }

        // Load member context for variable substitution (UserId = MessageQueue RecipientId)
        const ctxResult = await pool.request()
          .input('memberId', sql.UniqueIdentifier, enrollment.MemberId)
          .query(`
            SELECT m.MemberId, u.UserId, u.FirstName, u.LastName, u.Email, u.PhoneNumber AS Phone,
                   COALESCE(m.TerminationDate, (SELECT MAX(e.TerminationDate) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.TerminationDate IS NOT NULL)) AS MemberTerminationDate,
                   m.TenantId, t.Name AS TenantName, t.ContactEmail AS TenantEmail, t.ContactPhone AS TenantPhone,
                   t.PrimaryAddress AS TenantPrimaryAddress, t.PrimaryCity AS TenantPrimaryCity,
                   t.PrimaryState AS TenantPrimaryState, t.PrimaryZip AS TenantPrimaryZip,
                   g.Name AS GroupName,
                   au.UserId AS AgentUserId,
                   au.FirstName AS AgentFirstName, au.LastName AS AgentLastName,
                   au.Email AS AgentEmail, au.PhoneNumber AS AgentPhone
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Tenants t ON m.TenantId = t.TenantId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            LEFT JOIN oe.Users au ON a.UserId = au.UserId
            WHERE m.MemberId = @memberId
          `);

        if (!ctxResult.recordset.length) continue;

        const ctx = ctxResult.recordset[0];
        const varContext = {
          member: {
            FirstName: ctx.FirstName,
            LastName: ctx.LastName,
            Email: ctx.Email,
            Phone: ctx.Phone,
            TerminationDate: ctx.MemberTerminationDate ?? null
          },
          agent: { FirstName: ctx.AgentFirstName, LastName: ctx.AgentLastName, Email: ctx.AgentEmail, Phone: ctx.AgentPhone },
          tenant: { Name: ctx.TenantName, Email: ctx.TenantEmail, Phone: ctx.TenantPhone },
          group: { Name: ctx.GroupName },
          system: { LoginUrl: process.env.LOGIN_URL || process.env.FRONTEND_URL || '' }
        };

        // Resolve the recipient. 'Agent' campaigns deliver to the member's
        // assigned agent; 'Member' (default) delivers to the member.
        const toAgent = enrollment.RecipientType === 'Agent';
        const recipient = toAgent
          ? { id: ctx.AgentUserId, email: ctx.AgentEmail, phone: ctx.AgentPhone }
          : { id: enrollment.MemberId, email: ctx.Email, phone: ctx.Phone };

        // Agent campaign with no agent assigned — skip this enrollment's steps.
        if (toAgent && !recipient.id) {
          context.log(`Skipping agent campaign for member ${enrollment.MemberId} — no agent assigned`);
          continue;
        }

        const flags = await memberMarketingFlags(pool, enrollment.MemberId);

        let maxProcessedOrder = enrollment.CurrentStepOrder;

        for (const step of enrollment.steps) {
          // Process email
          if (step.EmailTemplateId) {
            const tpl = await pool.request()
              .input('templateId', sql.UniqueIdentifier, step.EmailTemplateId)
              .query(`
                SELECT Subject, Body, ReplyTo, ISNULL(MessageCategory, 'Marketing') AS MessageCategory
                FROM oe.MessageTemplates WHERE TemplateId = @templateId AND IsActive = 1
              `);

            if (tpl.recordset.length && recipient.email) {
              const t = tpl.recordset[0];
              const emailCat = t.MessageCategory || 'Marketing';
              // Marketing compliance is keyed to the member — only apply it when
              // the member is the recipient (agent-directed sends are notifications).
              if (!toAgent && emailCat === 'Marketing' && flags.emailMarketingBlocked) {
                await insertSkippedCampaignLog(pool, enrollmentId, step.StepId, 'Email');
              } else {
                const subject = substituteVars(t.Subject || '', varContext);
                let bodyHtml = substituteVars(t.Body || '', varContext);
                const replyTo = t.ReplyTo ? substituteVars(t.ReplyTo, varContext) : null;
                const postalParts = [ctx.TenantPrimaryAddress, ctx.TenantPrimaryCity, ctx.TenantPrimaryState, ctx.TenantPrimaryZip].filter(Boolean);
                const postalLine = postalParts.length ? postalParts.join(', ') : '';

                let listUnsubscribeUrl = null;
                if (!toAgent && emailCat === 'Marketing') {
                  const built = buildMarketingFooterAndUnsubscribeUrl(bodyHtml, {
                    memberId: enrollment.MemberId,
                    tenantId: enrollment.TenantId,
                    tenantName: ctx.TenantName,
                    postalLine
                  });
                  bodyHtml = built.htmlWithFooter;
                  listUnsubscribeUrl = built.listUnsubscribeUrl;
                }

                const meta = {};
                if (replyTo) meta.replyToEmail = replyTo;
                if (listUnsubscribeUrl) meta.listUnsubscribeUrl = listUnsubscribeUrl;
                const metaPrefix = Object.keys(meta).length ? `<!-- METADATA:${JSON.stringify(meta)} -->\n` : '';
                const bodyContent = `${metaPrefix}<!-- TEXT VERSION -->\n\n<!-- HTML VERSION -->\n${bodyHtml}`;

                const msgId = require('crypto').randomUUID();

                await pool.request()
                  .input('messageId', sql.UniqueIdentifier, msgId)
                  .input('tenantId', sql.UniqueIdentifier, enrollment.TenantId)
                  .input('recipientId', sql.UniqueIdentifier, recipient.id)
                  .input('recipientAddress', sql.NVarChar(500), recipient.email)
                  .input('subject', sql.NVarChar(200), subject)
                  .input('body', sql.NVarChar(sql.MAX), bodyContent)
                  .query(`
                    INSERT INTO oe.MessageQueue (MessageId, TenantId, RecipientId, MessageType, RecipientAddress, Subject, Body, Status, RetryCount, CreatedDate, QueuePriority)
                    VALUES (@messageId, @tenantId, @recipientId, 'Email', @recipientAddress, @subject, @body, 'Pending', 0, SYSUTCDATETIME(), 0)
                  `);

                await pool.request()
                  .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
                  .input('stepId', sql.UniqueIdentifier, step.StepId)
                  .input('messageId', sql.UniqueIdentifier, msgId)
                  .query(`
                    INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
                    VALUES (NEWID(), @enrollmentId, @stepId, 'Email', @messageId, SYSUTCDATETIME(), 'Sent')
                  `);

                totalQueued++;
              }
            }
          }

          // Process SMS
          if (step.SmsTemplateId && recipient.phone) {
            const tpl = await pool.request()
              .input('templateId', sql.UniqueIdentifier, step.SmsTemplateId)
              .query(`
                SELECT Body, ISNULL(MessageCategory, 'Marketing') AS MessageCategory
                FROM oe.MessageTemplates WHERE TemplateId = @templateId AND IsActive = 1
              `);

            if (tpl.recordset.length) {
              const smsCat = tpl.recordset[0].MessageCategory || 'Marketing';
              if (!toAgent && smsCat === 'Marketing' && flags.smsMarketingBlocked) {
                await insertSkippedCampaignLog(pool, enrollmentId, step.StepId, 'SMS');
              } else {
                const body = substituteVars(tpl.recordset[0].Body || '', varContext);
                const msgId = require('crypto').randomUUID();

                await pool.request()
                  .input('messageId', sql.UniqueIdentifier, msgId)
                  .input('tenantId', sql.UniqueIdentifier, enrollment.TenantId)
                  .input('recipientId', sql.UniqueIdentifier, recipient.id)
                  .input('recipientAddress', sql.NVarChar(500), recipient.phone)
                  .input('body', sql.NVarChar(sql.MAX), body)
                  .query(`
                    INSERT INTO oe.MessageQueue (MessageId, TenantId, RecipientId, MessageType, RecipientAddress, Subject, Body, Status, RetryCount, CreatedDate, QueuePriority)
                    VALUES (@messageId, @tenantId, @recipientId, 'SMS', @recipientAddress, NULL, @body, 'Pending', 0, SYSUTCDATETIME(), 0)
                  `);

                await pool.request()
                  .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
                  .input('stepId', sql.UniqueIdentifier, step.StepId)
                  .input('messageId', sql.UniqueIdentifier, msgId)
                  .query(`
                    INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
                    VALUES (NEWID(), @enrollmentId, @stepId, 'SMS', @messageId, SYSUTCDATETIME(), 'Sent')
                  `);

                totalQueued++;
              }
            }
          }

          maxProcessedOrder = Math.max(maxProcessedOrder, step.StepOrder);
        }

        // Check if campaign is complete
        const maxStepResult = await pool.request()
          .input('campaignId', sql.UniqueIdentifier, enrollment.CampaignId)
          .query(`SELECT MAX(StepOrder) AS MaxStep FROM oe.CampaignSteps WHERE CampaignId = @campaignId AND IsActive = 1`);

        const campaignMaxStep = maxStepResult.recordset[0]?.MaxStep || 0;

        if (maxProcessedOrder >= campaignMaxStep) {
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepOrder', sql.Int, maxProcessedOrder)
            .query(`
              UPDATE oe.CampaignEnrollments
              SET Status = 'Completed', CompletedDate = SYSUTCDATETIME(), CurrentStepOrder = @stepOrder
              WHERE CampaignEnrollmentId = @enrollmentId
            `);
        } else {
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepOrder', sql.Int, maxProcessedOrder)
            .query(`
              UPDATE oe.CampaignEnrollments SET CurrentStepOrder = @stepOrder
              WHERE CampaignEnrollmentId = @enrollmentId
            `);
        }

      } catch (stepErr) {
        context.log.error(`Error processing campaign enrollment ${enrollmentId}:`, stepErr);
      }
    }

    context.log(`Campaign processing complete: ${totalQueued} messages queued`);
  } catch (error) {
    context.log.error('Error in processCampaignSteps:', error);
  }
}

function formatTemplateDate(value) {
  if (value == null || value === '') return '';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

/**
 * Variable substitution for campaign templates.
 * Replaces {[variable.name]} placeholders with actual values.
 * Keep in sync with backend/services/shared/variableSubstitution.js (member.* keys).
 */
function substituteVars(str, context) {
  if (!str || typeof str !== 'string') return str;
  let s = str;
  const { member = {}, agent = {}, tenant = {}, group = {}, system = {} } = context;

  s = s.replace(/\{\[member\.FirstName\]\}/g, member.FirstName || '');
  s = s.replace(/\{\[member\.LastName\]\}/g, member.LastName || '');
  s = s.replace(/\{\[member\.Email\]\}/g, member.Email || '');
  s = s.replace(/\{\[member\.Phone\]\}/g, member.Phone || '');
  s = s.replace(/\{\[member\.FullName\]\}/g, [member.FirstName, member.LastName].filter(Boolean).join(' ').trim() || '');
  s = s.replace(/\{\[member\.TerminationDate\]\}/g, formatTemplateDate(member.TerminationDate));
  s = s.replace(/\{\[agent\.FirstName\]\}/g, agent.FirstName || '');
  s = s.replace(/\{\[agent\.LastName\]\}/g, agent.LastName || '');
  s = s.replace(/\{\[agent\.Name\]\}/g, [agent.FirstName, agent.LastName].filter(Boolean).join(' ').trim() || agent.Name || '');
  s = s.replace(/\{\[agent\.Email\]\}/g, agent.Email || '');
  s = s.replace(/\{\[agent\.Phone\]\}/g, agent.Phone || '');
  s = s.replace(/\{\[tenant\.Name\]\}/g, tenant.Name || '');
  s = s.replace(/\{\[tenant\.Email\]\}/g, tenant.Email || '');
  s = s.replace(/\{\[tenant\.Phone\]\}/g, tenant.Phone || '');
  s = s.replace(/\{\[group\.Name\]\}/g, group.Name || '');
  s = s.replace(/\{\[system\.CurrentDate\]\}/g, new Date().toLocaleDateString());
  s = s.replace(/\{\[system\.CurrentYear\]\}/g, new Date().getFullYear().toString());
  s = s.replace(/\{\[system\.CurrentMonth\]\}/g, new Date().toLocaleString('default', { month: 'long' }));
  s = s.replace(/\{\[system\.LoginUrl\]\}/g, system.LoginUrl || process.env.LOGIN_URL || process.env.FRONTEND_URL || '');

  return s;
}
