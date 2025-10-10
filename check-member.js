const fs = require('fs');
const path = require('path');

// Load environment variables from local.settings.json
const settingsPath = path.join(__dirname, 'local.settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

Object.keys(settings.Values).forEach(key => {
  process.env[key] = settings.Values[key];
});

const { getPool, sql } = require('./shared/db');

async function checkMember() {
  const output = [];
  const log = (msg) => {
    console.log(msg);
    output.push(msg);
  };
  
  log('🔍 Checking member@open-enroll.com...\n');
  
  let pool;
  try {
    pool = await getPool();
    log('✅ Database connected\n');
    
    // Query 1: Find the user
    log('═══════════════════════════════════════════════════════════');
    log('Query 1: User Information');
    log('═══════════════════════════════════════════════════════════');
    
    const userQuery = `
      SELECT UserId, Email, FirstName, LastName, Status, Role
      FROM oe.Users
      WHERE Email = 'member@open-enroll.com'
    `;
    
    const userResult = await pool.request().query(userQuery);
    if (userResult.recordset.length === 0) {
      log('❌ User not found');
      return;
    }
    
    const user = userResult.recordset[0];
    log(`User ID: ${user.UserId}`);
    log(`Name: ${user.FirstName} ${user.LastName}`);
    log(`Email: ${user.Email}`);
    log(`Status: ${user.Status}`);
    log(`Role: ${user.Role}`);
    log('');
    
    // Query 2: Check enrollments
    log('═══════════════════════════════════════════════════════════');
    log('Query 2: Enrollments');
    log('═══════════════════════════════════════════════════════════');
    
    const enrollmentsQuery = `
      SELECT 
        e.EnrollmentId,
        e.Status,
        e.EffectiveDate,
        e.TerminationDate,
        p.PlanName,
        p.Premium,
        g.Name as GroupName
      FROM oe.Enrollments e
      LEFT JOIN oe.Plans p ON e.PlanId = p.PlanId
      LEFT JOIN oe.Groups g ON e.GroupId = g.GroupId
      WHERE e.MemberId = @userId
      ORDER BY e.EffectiveDate DESC
    `;
    
    const enrollmentsResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .query(enrollmentsQuery);
    
    if (enrollmentsResult.recordset.length === 0) {
      log('❌ No enrollments found');
    } else {
      log(`Found ${enrollmentsResult.recordset.length} enrollment(s):\n`);
      enrollmentsResult.recordset.forEach((enrollment, idx) => {
        log(`Enrollment ${idx + 1}:`);
        log(`  Enrollment ID: ${enrollment.EnrollmentId}`);
        log(`  Status: ${enrollment.Status}`);
        log(`  Plan: ${enrollment.PlanName || 'N/A'}`);
        log(`  Premium: $${enrollment.Premium || 0}`);
        log(`  Group: ${enrollment.GroupName || 'N/A'}`);
        log(`  Effective Date: ${enrollment.EffectiveDate}`);
        log(`  Termination Date: ${enrollment.TerminationDate || 'None'}`);
        log('');
      });
    }
    
    // Query 3: Active enrollments only
    log('═══════════════════════════════════════════════════════════');
    log('Query 3: Active Enrollments Only');
    log('═══════════════════════════════════════════════════════════');
    
    const activeEnrollmentsQuery = `
      SELECT COUNT(*) as ActiveCount
      FROM oe.Enrollments
      WHERE MemberId = @userId
        AND Status = 'Active'
        AND EffectiveDate <= GETUTCDATE()
        AND (TerminationDate IS NULL OR TerminationDate > GETUTCDATE())
    `;
    
    const activeResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .query(activeEnrollmentsQuery);
    
    log(`Active Enrollments: ${activeResult.recordset[0].ActiveCount}`);
    log('');
    
    // Query 4: Check if user is in any group
    log('═══════════════════════════════════════════════════════════');
    log('Query 4: Group Memberships');
    log('═══════════════════════════════════════════════════════════');
    
    const groupMembershipQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.Name as GroupName,
        g.Status as GroupStatus
      FROM oe.Groups g
      INNER JOIN oe.Enrollments e ON g.GroupId = e.GroupId
      WHERE e.MemberId = @userId
    `;
    
    const groupsResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .query(groupMembershipQuery);
    
    if (groupsResult.recordset.length === 0) {
      log('❌ Not a member of any groups');
    } else {
      log(`Member of ${groupsResult.recordset.length} group(s):\n`);
      groupsResult.recordset.forEach(group => {
        log(`  - ${group.GroupName} (${group.GroupStatus})`);
        log(`    GroupId: ${group.GroupId}`);
      });
    }
    log('');
    
    log('═══════════════════════════════════════════════════════════');
    log('✅ Verification Complete!');
    log('═══════════════════════════════════════════════════════════');
    
    // Write to file
    fs.writeFileSync('member-check-results.txt', output.join('\n'));
    log('\n📄 Results saved to: member-check-results.txt');
    
  } catch (error) {
    log('❌ Error: ' + error.message);
    log('Stack: ' + error.stack);
    fs.writeFileSync('member-check-results.txt', output.join('\n'));
  } finally {
    if (pool) {
      await pool.close();
      log('\n✅ Database connection closed');
      fs.writeFileSync('member-check-results.txt', output.join('\n'));
    }
  }
}

checkMember();


