const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize } = require('../../middleware/auth');

/**
 * @route POST /api/admin/update-member-household-id
 * @desc Update a specific member's HouseholdMemberID using the stored procedure
 * @access Private (Admin only)
 */
router.post('/', authorize(['Admin', 'SysAdmin']), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }
    
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      // Get member info
      const memberRequest = transaction.request();
      memberRequest.input('userId', sql.UniqueIdentifier, userId);
      
      const memberResult = await memberRequest.query(`
        SELECT 
          m.MemberId,
          m.TenantId,
          m.HouseholdMemberID,
          u.FirstName,
          u.LastName
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.UserId = @userId
      `);
      
      if (memberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        });
      }
      
      const member = memberResult.recordset[0];
      console.log('🔍 Found member:', member.FirstName, member.LastName);
      console.log('   Current HouseholdMemberID:', member.HouseholdMemberID || 'NULL');
      
      // Generate new HouseholdMemberID using the stored procedure
      const spRequest = transaction.request();
      spRequest.input('TenantId', sql.UniqueIdentifier, member.TenantId);
      spRequest.input('MemberId', sql.UniqueIdentifier, member.MemberId);
      spRequest.output('HouseholdMemberID', sql.NVarChar(50));
      
      await spRequest.execute('oe.GenerateHouseholdMemberID');
      const newHouseholdMemberID = spRequest.parameters.HouseholdMemberID.value;
      
      console.log('✅ Generated HouseholdMemberID:', newHouseholdMemberID);
      
      // Update the member with the new HouseholdMemberID
      const updateRequest = transaction.request();
      updateRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      updateRequest.input('householdMemberID', sql.NVarChar(50), newHouseholdMemberID);
      
      await updateRequest.query(`
        UPDATE oe.Members 
        SET HouseholdMemberID = @householdMemberID, ModifiedDate = GETDATE()
        WHERE MemberId = @memberId
      `);
      
      await transaction.commit();
      
      res.json({
        success: true,
        message: 'HouseholdMemberID updated successfully',
        data: {
          memberId: member.MemberId,
          firstName: member.FirstName,
          lastName: member.LastName,
          oldHouseholdMemberID: member.HouseholdMemberID,
          newHouseholdMemberID: newHouseholdMemberID
        }
      });
      
      console.log('✅ Successfully updated member with HouseholdMemberID:', newHouseholdMemberID);
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error updating member HouseholdMemberID:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update member HouseholdMemberID',
      error: error.message
    });
  }
});

module.exports = router;

