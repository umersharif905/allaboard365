const fs = require('fs');
const path = require('path');

// Load environment variables from local.settings.json
const settingsPath = path.join(__dirname, 'local.settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Set environment variables
Object.keys(settings.Values).forEach(key => {
  process.env[key] = settings.Values[key];
});

const { getPool, sql } = require('./shared/db');

async function verifyData() {
  const output = [];
  const log = (msg) => {
    console.log(msg);
    output.push(msg);
  };
  
  log('🔍 Verifying Database Data...\n');
  
  let pool;
  try {
    pool = await getPool();
    log('✅ Database connected\n');
    
    // Query 1: Count active groups with recurring payment plans
    log('═══════════════════════════════════════════════════════════');
    log('Query 1: Active Groups with Recurring Payment Plans');
    log('═══════════════════════════════════════════════════════════');
    
    const groupsQuery = `
      SELECT COUNT(DISTINCT g.GroupId) as TotalCount
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
      WHERE g.Status = 'Active' AND grp.IsActive = 1
    `;
    
    const groupsCountResult = await pool.request().query(groupsQuery);
    log(`Total Active Groups: ${groupsCountResult.recordset[0].TotalCount}`);
    log('');
    
    // Query 2: List all active groups with details
    log('═══════════════════════════════════════════════════════════');
    log('Query 2: Active Groups Details');
    log('═══════════════════════════════════════════════════════════');
    
    const groupsListQuery = `
      SELECT 
        g.GroupId,
        g.Name,
        grp.MonthlyAmount,
        grp.DimeScheduleId,
        grp.IsActive
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
      WHERE g.Status = 'Active' AND grp.IsActive = 1
      ORDER BY g.Name
    `;
    
    const groupsListResult = await pool.request().query(groupsListQuery);
    groupsListResult.recordset.forEach(group => {
      log(`  - ${group.Name}`);
      log(`    GroupId: ${group.GroupId}`);
      log(`    Monthly Amount: $${group.MonthlyAmount}`);
      log(`    DIME Schedule: ${group.DimeScheduleId}`);
      log('');
    });
    
    // Query 3: Count enrollments for Topline Landscaping
    log('═══════════════════════════════════════════════════════════');
    log('Query 3: Topline Landscaping Enrollments');
    log('═══════════════════════════════════════════════════════════');
    
    const enrollmentsQuery = `
      SELECT COUNT(*) as EnrollmentCount
      FROM oe.Enrollments
      WHERE GroupId = '71C4804C-C46F-4A52-BC17-C06038E8DF96'
        AND Status = 'Active'
        AND EffectiveDate <= GETUTCDATE()
        AND (TerminationDate IS NULL OR TerminationDate > GETUTCDATE())
    `;
    
    const enrollmentsResult = await pool.request().query(enrollmentsQuery);
    log(`Active Enrollments: ${enrollmentsResult.recordset[0].EnrollmentCount}`);
    log('');
    
    // Query 4: Calculate actual premium using stored procedure
    log('═══════════════════════════════════════════════════════════');
    log('Query 4: Calculated Premium (using stored procedure)');
    log('═══════════════════════════════════════════════════════════');
    
    const billingDate = new Date(new Date().getFullYear(), new Date().getMonth(), 5);
    
    const calculatedPremiumResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, '71C4804C-C46F-4A52-BC17-C06038E8DF96')
      .input('billingDate', sql.DateTime2, billingDate)
      .execute('oe.sp_CalculateGroupTotalPremium');
    
    const premium = calculatedPremiumResult.recordset[0];
    log(`Total Premium: $${premium.TotalPremium}`);
    log(`Active Enrollment Count: ${premium.ActiveEnrollmentCount}`);
    log('');
    
    // Query 5: Latest execution log
    log('═══════════════════════════════════════════════════════════');
    log('Query 5: Latest Execution Log');
    log('═══════════════════════════════════════════════════════════');
    
    const executionLogQuery = `
      SELECT TOP 1 
        JobName,
        StartTime,
        EndTime,
        Status,
        ResultSummary
      FROM oe.ScheduledJobExecutions
      ORDER BY StartTime DESC
    `;
    
    const executionResult = await pool.request().query(executionLogQuery);
    if (executionResult.recordset.length > 0) {
      const logEntry = executionResult.recordset[0];
      log(`Job: ${logEntry.JobName}`);
      log(`Status: ${logEntry.Status}`);
      log(`Started: ${logEntry.StartTime}`);
      log(`Ended: ${logEntry.EndTime}`);
      if (logEntry.ResultSummary) {
        const summary = JSON.parse(logEntry.ResultSummary);
        log(`\nResults:`);
        log(`  Processed: ${summary.processed}`);
        log(`  Updated: ${summary.updated}`);
        log(`  Unchanged: ${summary.unchanged}`);
        log(`  Failed: ${summary.failed}`);
      }
    } else {
      log('No execution logs found');
    }
    log('');
    
    // Query 6: Check for ALL groups (not just active recurring)
    log('═══════════════════════════════════════════════════════════');
    log('Query 6: ALL Active Groups (Any Status)');
    log('═══════════════════════════════════════════════════════════');
    
    const allGroupsQuery = `
      SELECT COUNT(*) as TotalActiveGroups
      FROM oe.Groups
      WHERE Status = 'Active'
    `;
    
    const allGroupsResult = await pool.request().query(allGroupsQuery);
    log(`Total Active Groups (all types): ${allGroupsResult.recordset[0].TotalActiveGroups}`);
    log('');
    
    log('═══════════════════════════════════════════════════════════');
    log('✅ Verification Complete!');
    log('═══════════════════════════════════════════════════════════');
    
    // Write to file
    fs.writeFileSync('verification-results.txt', output.join('\n'));
    log('\n📄 Results saved to: verification-results.txt');
    
  } catch (error) {
    log('❌ Error: ' + error.message);
    log('Stack: ' + error.stack);
    fs.writeFileSync('verification-results.txt', output.join('\n'));
  } finally {
    if (pool) {
      await pool.close();
      log('\n✅ Database connection closed');
      fs.writeFileSync('verification-results.txt', output.join('\n'));
    }
  }
}

verifyData();
