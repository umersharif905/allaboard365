const { getPool, sql } = require('./shared/db');

async function verifyData() {
  console.log('🔍 Verifying Database Data...\n');
  
  let pool;
  try {
    pool = await getPool();
    console.log('✅ Database connected\n');
    
    // Query 1: Count active groups with recurring payment plans
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Query 1: Active Groups with Recurring Payment Plans');
    console.log('═══════════════════════════════════════════════════════════');
    
    const groupsQuery = `
      SELECT COUNT(DISTINCT g.GroupId) as TotalCount
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
      WHERE g.Status = 'Active' AND grp.IsActive = 1
    `;
    
    const groupsCountResult = await pool.request().query(groupsQuery);
    console.log(`Total Active Groups: ${groupsCountResult.recordset[0].TotalCount}`);
    console.log('');
    
    // Query 2: List all active groups with details
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Query 2: Active Groups Details');
    console.log('═══════════════════════════════════════════════════════════');
    
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
      console.log(`  - ${group.Name}`);
      console.log(`    GroupId: ${group.GroupId}`);
      console.log(`    Monthly Amount: $${group.MonthlyAmount}`);
      console.log(`    DIME Schedule: ${group.DimeScheduleId}`);
      console.log('');
    });
    
    // Query 3: Count enrollments for Topline Landscaping
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Query 3: Topline Landscaping Enrollments');
    console.log('═══════════════════════════════════════════════════════════');
    
    const enrollmentsQuery = `
      SELECT COUNT(*) as EnrollmentCount
      FROM oe.Enrollments
      WHERE GroupId = '71C4804C-C46F-4A52-BC17-C06038E8DF96'
        AND Status = 'Active'
        AND EffectiveDate <= GETUTCDATE()
        AND (TerminationDate IS NULL OR TerminationDate > GETUTCDATE())
    `;
    
    const enrollmentsResult = await pool.request().query(enrollmentsQuery);
    console.log(`Active Enrollments: ${enrollmentsResult.recordset[0].EnrollmentCount}`);
    console.log('');
    
    // Query 4: Calculate actual premium using stored procedure
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Query 4: Calculated Premium (using stored procedure)');
    console.log('═══════════════════════════════════════════════════════════');
    
    const billingDate = new Date(new Date().getFullYear(), new Date().getMonth(), 5);
    
    const calculatedPremiumResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, '71C4804C-C46F-4A52-BC17-C06038E8DF96')
      .input('billingDate', sql.DateTime2, billingDate)
      .execute('oe.sp_CalculateGroupTotalPremium');
    
    const premium = calculatedPremiumResult.recordset[0];
    console.log(`Total Premium: $${premium.TotalPremium}`);
    console.log(`Active Enrollment Count: ${premium.ActiveEnrollmentCount}`);
    console.log('');
    
    // Query 5: Latest execution log
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Query 5: Latest Execution Log');
    console.log('═══════════════════════════════════════════════════════════');
    
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
      const log = executionResult.recordset[0];
      console.log(`Job: ${log.JobName}`);
      console.log(`Status: ${log.Status}`);
      console.log(`Started: ${log.StartTime}`);
      console.log(`Ended: ${log.EndTime}`);
      if (log.ResultSummary) {
        const summary = JSON.parse(log.ResultSummary);
        console.log(`\nResults:`);
        console.log(`  Processed: ${summary.processed}`);
        console.log(`  Updated: ${summary.updated}`);
        console.log(`  Unchanged: ${summary.unchanged}`);
        console.log(`  Failed: ${summary.failed}`);
      }
    } else {
      console.log('No execution logs found');
    }
    console.log('');
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ Verification Complete!');
    console.log('═══════════════════════════════════════════════════════════');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (pool) {
      await pool.close();
      console.log('\n✅ Database connection closed');
    }
  }
}

verifyData();

