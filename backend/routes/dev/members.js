const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize: authMiddleware } = require('../../middleware/auth');

console.log('🔧 DEV: Loading dev members routes...');

/**
 * DELETE /api/dev/members/:memberId/household-enrollments
 * DEV ONLY: Delete all enrollments for a member's entire household
 * This includes the member and all their dependents
 */
console.log('🔧 DEV: Registering DELETE /:memberId/household-enrollments route...');
router.delete('/:memberId/household-enrollments', authMiddleware(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  console.log('🔧 DEV: Hard reset household enrollments endpoint called');
  console.log('🔧 DEV: Member ID:', req.params.memberId);
  console.log('🔧 DEV: User:', req.user?.UserId, req.user?.roles);
  console.log('🔧 DEV: Request URL:', req.url);
  console.log('🔧 DEV: Request method:', req.method);
  
  // Only allow in development mode or local production
  if (process.env.NODE_ENV === 'production' && !req.headers.host?.includes('localhost')) {
    console.log('❌ DEV: Hard reset blocked in production');
    return res.status(403).json({
      success: false,
      message: 'Hard reset enrollments is only available in development mode'
    });
  }

  try {
    const { memberId } = req.params;
    
    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: 'Member ID is required'
      });
    }

    const pool = await getPool();
    
    // First, get the member's household ID
    const memberQuery = `
      SELECT m.MemberId, m.HouseholdId, u.FirstName, u.LastName
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `;
    
    const memberRequest = pool.request();
    memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
    const memberResult = await memberRequest.query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }
    
    const member = memberResult.recordset[0];
    const householdId = member.HouseholdId;
    
    if (!householdId) {
      return res.status(400).json({
        success: false,
        message: 'Member does not belong to a household'
      });
    }
    
    console.log('🔧 DEV: Found member:', member.FirstName, member.LastName);
    console.log('🔧 DEV: Household ID:', householdId);
    
    // Get all household members for logging
    const householdMembersQuery = `
      SELECT m.MemberId, u.FirstName, u.LastName, m.RelationshipType
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.HouseholdId = @householdId
    `;
    
    const householdRequest = pool.request();
    householdRequest.input('householdId', sql.UniqueIdentifier, householdId);
    const householdResult = await householdRequest.query(householdMembersQuery);
    
    console.log('🔧 DEV: Household members:', householdResult.recordset.length);
    householdResult.recordset.forEach(member => {
      console.log(`  - ${member.RelationshipType}: ${member.FirstName} ${member.LastName}`);
    });
    
    // Get count of enrollments to be deleted
    const enrollmentCountQuery = `
      SELECT COUNT(*) as enrollmentCount
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE m.HouseholdId = @householdId
    `;
    
    const countRequest = pool.request();
    countRequest.input('householdId', sql.UniqueIdentifier, householdId);
    const countResult = await countRequest.query(enrollmentCountQuery);
    const enrollmentCount = countResult.recordset[0].enrollmentCount;
    
    console.log('🔧 DEV: Enrollments to delete:', enrollmentCount);
    
    if (enrollmentCount === 0) {
      return res.json({
        success: true,
        message: 'No enrollments found for this household',
        data: {
          householdId: householdId,
          membersAffected: householdResult.recordset.length,
          enrollmentsDeleted: 0
        }
      });
    }
    
    // Delete all enrollments for the household
    const deleteQuery = `
      DELETE e
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE m.HouseholdId = @householdId
    `;
    
    const deleteRequest = pool.request();
    deleteRequest.input('householdId', sql.UniqueIdentifier, householdId);
    const deleteResult = await deleteRequest.query(deleteQuery);
    
    console.log('🔧 DEV: Deleted enrollments:', deleteResult.rowsAffected[0]);
    
    res.json({
      success: true,
      message: `Successfully deleted ${deleteResult.rowsAffected[0]} enrollments for household`,
      data: {
        householdId: householdId,
        membersAffected: householdResult.recordset.length,
        enrollmentsDeleted: deleteResult.rowsAffected[0],
        members: householdResult.recordset.map(m => ({
          memberId: m.MemberId,
          name: `${m.FirstName} ${m.LastName}`,
          relationshipType: m.RelationshipType
        }))
      }
    });
    
  } catch (error) {
    console.error('❌ DEV: Error in hard reset household enrollments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset household enrollments',
      error: error.message
    });
  }
});

module.exports = router;
