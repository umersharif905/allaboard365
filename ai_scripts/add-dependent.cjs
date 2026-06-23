#!/usr/bin/env node

/**
 * Script to add Ashton Anderson as a dependent to Chris Anderson's household
 * Usage: node add-dependent.cjs
 */

const path = require('path');

// Change to backend directory to access node_modules BEFORE requiring mssql
process.chdir(path.join(__dirname, '..', 'backend'));

// Now require mssql from backend directory
const sql = require('mssql');

// Load .env from ai_scripts directory
require('dotenv').config({ path: path.join(__dirname, '..', 'ai_scripts', '.env') });

// Database configuration
const dbConfig = {
  user: process.env.DB_USER || 'oe-sqladmin',
  password: process.env.DB_PASSWORD || 'PT$r8u7G21@$',
  server: process.env.DB_SERVER || 'oe-sql-srvr.database.windows.net',
  database: process.env.DB_NAME || 'open-enroll-dev',
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function addDependent() {
  let pool;
  let transaction;
  
  try {
    console.log('🔍 Connecting to database...');
    pool = await sql.connect(dbConfig);
    console.log('✅ Connected successfully');
    
    transaction = pool.transaction();
    await transaction.begin();
    
    // Step 1: Find Chris Anderson
    console.log('\n📋 Step 1: Finding Chris Anderson...');
    const chrisRequest = transaction.request();
    chrisRequest.input('email', sql.NVarChar, 'chris@mightywell.us');
    
    const chrisResult = await chrisRequest.query(`
      SELECT 
        m.MemberId,
        m.HouseholdId,
        m.HouseholdMemberID,
        m.RelationshipType,
        m.GroupId,
        m.TenantId,
        m.MemberSequence,
        u.FirstName,
        u.LastName,
        u.Email,
        u.UserId
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE u.Email = @email AND m.Status = 'Active'
    `);
    
    if (chrisResult.recordset.length === 0) {
      throw new Error('❌ Chris Anderson not found with email chris@mightywell.us');
    }
    
    const chris = chrisResult.recordset[0];
    console.log('✅ Found Chris Anderson:');
    console.log(`   MemberId: ${chris.MemberId}`);
    console.log(`   HouseholdId: ${chris.HouseholdId}`);
    console.log(`   HouseholdMemberID: ${chris.HouseholdMemberID}`);
    console.log(`   RelationshipType: ${chris.RelationshipType}`);
    console.log(`   TenantId: ${chris.TenantId}`);
    console.log(`   GroupId: ${chris.GroupId || 'NULL'}`);
    
    if (!chris.HouseholdId) {
      throw new Error('❌ Chris Anderson has no HouseholdId. Cannot add dependent.');
    }
    
    // Step 2: Get household members to understand structure
    console.log('\n📋 Step 2: Checking household members...');
    const householdRequest = transaction.request();
    householdRequest.input('householdId', sql.UniqueIdentifier, chris.HouseholdId);
    
    const householdResult = await householdRequest.query(`
      SELECT 
        m.MemberId,
        m.HouseholdMemberID,
        m.RelationshipType,
        m.MemberSequence,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.HouseholdId = @householdId AND m.Status = 'Active'
      ORDER BY 
        CASE m.RelationshipType
          WHEN 'P' THEN 1
          WHEN 'S' THEN 2
          WHEN 'C' THEN 3
          ELSE 4
        END,
        m.MemberSequence
    `);
    
    console.log(`✅ Found ${householdResult.recordset.length} household member(s):`);
    householdResult.recordset.forEach((member, idx) => {
      console.log(`   ${idx + 1}. ${member.FirstName} ${member.LastName} (${member.RelationshipType === 'P' ? 'Primary' : member.RelationshipType === 'S' ? 'Spouse' : 'Child'}) - ${member.HouseholdMemberID || 'No ID'}`);
    });
    
    // Step 3: Check if Ashton already exists
    console.log('\n📋 Step 3: Checking if Ashton Anderson already exists...');
    const ashtonCheckRequest = transaction.request();
    ashtonCheckRequest.input('firstName', sql.NVarChar, 'Ashton');
    ashtonCheckRequest.input('lastName', sql.NVarChar, 'Anderson');
    ashtonCheckRequest.input('householdId', sql.UniqueIdentifier, chris.HouseholdId);
    
    const ashtonCheckResult = await ashtonCheckRequest.query(`
      SELECT m.MemberId, m.HouseholdMemberID, u.FirstName, u.LastName
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.HouseholdId = @householdId 
        AND u.FirstName = @firstName 
        AND u.LastName = @lastName
        AND m.Status = 'Active'
    `);
    
    if (ashtonCheckResult.recordset.length > 0) {
      console.log('⚠️  Ashton Anderson already exists in this household:');
      console.log(`   MemberId: ${ashtonCheckResult.recordset[0].MemberId}`);
      console.log(`   HouseholdMemberID: ${ashtonCheckResult.recordset[0].HouseholdMemberID}`);
      throw new Error('Ashton Anderson already exists in this household');
    }
    
    // Step 4: Calculate member sequence
    const householdSizeRequest = transaction.request();
    householdSizeRequest.input('householdId', sql.UniqueIdentifier, chris.HouseholdId);
    const householdSizeResult = await householdSizeRequest.query(`
      SELECT COUNT(*) as HouseholdSize 
      FROM oe.Members 
      WHERE HouseholdId = @householdId
    `);
    const memberSequence = householdSizeResult.recordset[0].HouseholdSize + 1;
    console.log(`\n📋 Step 4: Member sequence will be: ${memberSequence}`);
    
    // Step 5: Generate IDs
    const newUserId = require('crypto').randomUUID();
    const newMemberId = require('crypto').randomUUID();
    console.log(`\n📋 Step 5: Generated IDs:`);
    console.log(`   UserId: ${newUserId}`);
    console.log(`   MemberId: ${newMemberId}`);
    
    // Step 6: Create User record
    console.log('\n📋 Step 6: Creating User record for Ashton...');
    const userRequest = transaction.request();
    userRequest.input('userId', sql.UniqueIdentifier, newUserId);
    userRequest.input('email', sql.NVarChar, `ashton-${newUserId.substring(0, 8)}@noemail.com`);
    userRequest.input('firstName', sql.NVarChar, 'Ashton');
    userRequest.input('lastName', sql.NVarChar, 'Anderson');
    userRequest.input('status', sql.NVarChar, 'Active');
    userRequest.input('tenantId', sql.UniqueIdentifier, chris.TenantId);
    
    await userRequest.query(`
      INSERT INTO oe.Users (
        UserId, Email, FirstName, LastName, 
        Status, TenantId, CreatedDate, ModifiedDate
      ) VALUES (
        @userId, @email, @firstName, @lastName,
        @status, @tenantId, GETDATE(), GETDATE()
      )
    `);
    console.log('✅ User record created');
    
    // Step 7: Assign Member role
    console.log('\n📋 Step 7: Assigning Member role...');
    const UserRolesService = require('./services/shared/user-roles.service');
    await UserRolesService.assignRoleToUser(newUserId, 'Member', chris.UserId);
    console.log('✅ Member role assigned');
    
    // Step 8: Create Member record
    console.log('\n📋 Step 8: Creating Member record for Ashton...');
    const memberRequest = transaction.request();
    memberRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
    memberRequest.input('userId', sql.UniqueIdentifier, newUserId);
    memberRequest.input('groupId', sql.UniqueIdentifier, chris.GroupId || null);
    memberRequest.input('householdId', sql.UniqueIdentifier, chris.HouseholdId);
    memberRequest.input('relationshipType', sql.NVarChar, 'C'); // Child
    memberRequest.input('memberSequence', sql.Int, memberSequence);
    memberRequest.input('status', sql.NVarChar, 'Active');
    memberRequest.input('dateOfBirth', sql.Date, '2006-10-10');
    memberRequest.input('ssn', sql.NVarChar, '123-456-0987');
    memberRequest.input('tenantId', sql.UniqueIdentifier, chris.TenantId);
    
    await memberRequest.query(`
      INSERT INTO oe.Members (
        MemberId, UserId, GroupId, HouseholdId, RelationshipType, MemberSequence,
        Status, DateOfBirth, SSN, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        @memberId, @userId, @groupId, @householdId, @relationshipType, @memberSequence,
        @status, @dateOfBirth, @ssn, @tenantId,
        GETDATE(), GETDATE()
      )
    `);
    console.log('✅ Member record created');
    
    // Step 9: Generate HouseholdMemberID using stored procedure
    console.log('\n📋 Step 9: Generating HouseholdMemberID...');
    const householdMemberIdRequest = transaction.request();
    householdMemberIdRequest.input('TenantId', sql.UniqueIdentifier, chris.TenantId);
    householdMemberIdRequest.input('MemberId', sql.UniqueIdentifier, newMemberId);
    householdMemberIdRequest.output('HouseholdMemberID', sql.NVarChar(50));
    
    await householdMemberIdRequest.execute('oe.GenerateHouseholdMemberID');
    const generatedHouseholdMemberID = householdMemberIdRequest.parameters.HouseholdMemberID.value;
    console.log(`✅ Generated HouseholdMemberID: ${generatedHouseholdMemberID}`);
    
    // Step 10: Update member with HouseholdMemberID
    console.log('\n📋 Step 10: Updating member with HouseholdMemberID...');
    const updateRequest = transaction.request();
    updateRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
    updateRequest.input('householdMemberID', sql.NVarChar(50), generatedHouseholdMemberID);
    
    await updateRequest.query(`
      UPDATE oe.Members 
      SET HouseholdMemberID = @householdMemberID, ModifiedDate = GETDATE()
      WHERE MemberId = @memberId
    `);
    console.log('✅ Member updated with HouseholdMemberID');
    
    // Commit transaction
    console.log('\n📋 Committing transaction...');
    await transaction.commit();
    console.log('✅ Transaction committed successfully');
    
    // Step 11: Verify the new member
    console.log('\n📋 Step 11: Verifying new member...');
    const verifyRequest = pool.request();
    verifyRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT 
        m.MemberId,
        m.HouseholdMemberID,
        m.RelationshipType,
        m.MemberSequence,
        m.DateOfBirth,
        m.SSN,
        m.Status,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `);
    
    const newMember = verifyResult.recordset[0];
    console.log('\n✅ SUCCESS! Ashton Anderson has been added as a dependent:');
    console.log(`   Name: ${newMember.FirstName} ${newMember.LastName}`);
    console.log(`   MemberId: ${newMember.MemberId}`);
    console.log(`   HouseholdMemberID: ${newMember.HouseholdMemberID}`);
    console.log(`   RelationshipType: ${newMember.RelationshipType} (Child)`);
    console.log(`   MemberSequence: ${newMember.MemberSequence}`);
    console.log(`   DateOfBirth: ${newMember.DateOfBirth}`);
    console.log(`   SSN: ${newMember.SSN}`);
    console.log(`   Status: ${newMember.Status}`);
    console.log(`   Email: ${newMember.Email}`);
    
  } catch (error) {
    if (transaction) {
      console.log('\n❌ Rolling back transaction...');
      await transaction.rollback();
    }
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    if (pool) {
      await pool.close();
      console.log('\n✅ Database connection closed');
    }
  }
}

// Run the script
addDependent();
