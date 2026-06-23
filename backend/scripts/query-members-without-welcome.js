/**
 * Query production database to find members and their email history.
 * Shows who has/hasn't received emails and what kind.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
const sql = require('mssql');

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    connectionTimeout: 30000,
    requestTimeout: 60000,
  }
};

async function run() {
  let pool;
  try {
    console.log(`Connecting to ${process.env.DB_NAME} on ${process.env.DB_SERVER}...`);
    pool = await new sql.ConnectionPool(dbConfig).connect();
    console.log('Connected.\n');

    // 1. Get all active members with enrollments
    console.log('=== ALL ACTIVE MEMBERS WITH ENROLLMENTS ===\n');
    const members = await pool.request().query(`
      SELECT
        m.MemberId,
        m.UserId,
        u.FirstName,
        u.LastName,
        u.Email,
        m.TenantId,
        t.Name as TenantName,
        m.GroupId,
        g.Name as GroupName,
        m.Status as MemberStatus,
        m.CreatedDate as MemberCreatedDate,
        COUNT(DISTINCT e.EnrollmentId) as EnrollmentCount,
        MIN(e.EffectiveDate) as FirstEnrollmentDate,
        MAX(e.EffectiveDate) as LatestEnrollmentDate
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Tenants t ON m.TenantId = t.TenantId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Enrollments e ON m.MemberId = e.MemberId
      WHERE m.Status = 'Active'
        AND u.Email IS NOT NULL AND u.Email <> ''
      GROUP BY m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email,
               m.TenantId, t.Name, m.GroupId, g.Name, m.Status, m.CreatedDate
      ORDER BY m.CreatedDate DESC
    `);

    console.log(`Found ${members.recordset.length} active members with email addresses.\n`);

    // 2. Get ALL MessageHistory records grouped by RecipientId
    console.log('=== MESSAGE HISTORY BY RECIPIENT ===\n');
    const history = await pool.request().query(`
      SELECT
        mh.RecipientId,
        mh.MessageType,
        mh.Subject,
        mh.Status,
        mh.RecipientAddress,
        mh.SentDate
      FROM oe.MessageHistory mh
      WHERE mh.RecipientId IS NOT NULL
        AND mh.RecipientId <> '00000000-0000-0000-0000-000000000000'
      ORDER BY mh.RecipientId, mh.SentDate DESC
    `);

    // Build a map: UserId -> list of emails sent
    const emailsByUser = {};
    for (const row of history.recordset) {
      const key = row.RecipientId;
      if (!emailsByUser[key]) emailsByUser[key] = [];
      emailsByUser[key].push({
        type: row.MessageType,
        subject: row.Subject,
        status: row.Status,
        address: row.RecipientAddress,
        date: row.SentDate
      });
    }

    // 3. Also check MessageQueue for pending messages
    const queue = await pool.request().query(`
      SELECT
        mq.RecipientId,
        mq.MessageType,
        mq.Subject,
        mq.Status,
        mq.RecipientAddress,
        mq.CreatedDate
      FROM oe.MessageQueue mq
      WHERE mq.RecipientId IS NOT NULL
        AND mq.RecipientId <> '00000000-0000-0000-0000-000000000000'
      ORDER BY mq.RecipientId
    `);

    const queueByUser = {};
    for (const row of queue.recordset) {
      const key = row.RecipientId;
      if (!queueByUser[key]) queueByUser[key] = [];
      queueByUser[key].push({
        type: row.MessageType,
        subject: row.Subject,
        status: row.Status,
        address: row.RecipientAddress,
        date: row.CreatedDate
      });
    }

    // 4. Display each member and their email history
    console.log('=== MEMBER EMAIL REPORT ===\n');

    let noEmailCount = 0;
    let hasEmailCount = 0;
    const membersWithoutEmails = [];

    for (const m of members.recordset) {
      const sent = emailsByUser[m.UserId] || [];
      const queued = queueByUser[m.UserId] || [];

      if (sent.length === 0 && queued.length === 0) {
        noEmailCount++;
        membersWithoutEmails.push(m);
      } else {
        hasEmailCount++;
      }

      // Print every member
      const enrollInfo = m.EnrollmentCount > 0
        ? `${m.EnrollmentCount} enrollment(s), effective ${m.FirstEnrollmentDate ? new Date(m.FirstEnrollmentDate).toLocaleDateString() : 'N/A'}`
        : 'No enrollments';

      console.log(`${m.FirstName} ${m.LastName} <${m.Email}>`);
      console.log(`  Member since: ${new Date(m.MemberCreatedDate).toLocaleDateString()} | Tenant: ${m.TenantName || 'N/A'} | Group: ${m.GroupName || 'N/A'}`);
      console.log(`  Enrollments: ${enrollInfo}`);
      console.log(`  MemberId: ${m.MemberId} | UserId: ${m.UserId}`);

      if (sent.length === 0 && queued.length === 0) {
        console.log(`  Emails: *** NONE — NO EMAILS EVER SENT ***`);
      } else {
        if (sent.length > 0) {
          console.log(`  Sent emails (${sent.length}):`);
          for (const e of sent) {
            console.log(`    - [${e.status}] ${e.type}: "${e.subject}" → ${e.address} (${new Date(e.date).toLocaleDateString()})`);
          }
        }
        if (queued.length > 0) {
          console.log(`  Queued (${queued.length}):`);
          for (const e of queued) {
            console.log(`    - [${e.status}] ${e.type}: "${e.subject}" → ${e.address} (${new Date(e.date).toLocaleDateString()})`);
          }
        }
      }
      console.log('');
    }

    // 5. Summary
    console.log('=============================================');
    console.log('SUMMARY');
    console.log('=============================================');
    console.log(`Total active members with email: ${members.recordset.length}`);
    console.log(`Members WITH email history:      ${hasEmailCount}`);
    console.log(`Members WITHOUT any emails:      ${noEmailCount}`);
    console.log('');

    if (membersWithoutEmails.length > 0) {
      console.log('=== MEMBERS WHO NEVER RECEIVED ANY EMAIL ===\n');
      membersWithoutEmails.forEach((m, i) => {
        console.log(`${i + 1}. ${m.FirstName} ${m.LastName} <${m.Email}> | Tenant: ${m.TenantName} | Group: ${m.GroupName || 'N/A'} | MemberId: ${m.MemberId}`);
      });
    }

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    if (pool) await pool.close();
    process.exit(0);
  }
}

run();
