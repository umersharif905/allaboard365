const express = require('express');
const router = express.Router();
const { getActorUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');
const UserRolesService = require('../../../services/shared/user-roles.service');
const encryptionService = require('../../../services/encryptionService');

function decryptSSN(encryptedSSN) {
  if (!encryptedSSN) return null;
  try {
    if (String(encryptedSSN).match(/^\d{3}-\d{2}-\d{4}$/)) return encryptedSSN;
    return encryptionService.decrypt(encryptedSSN);
  } catch (err) {
    return null;
  }
}

function getSSNLast4(encryptedSSN) {
  if (!encryptedSSN) return null;
  const decrypted = decryptSSN(encryptedSSN);
  const digits = (decrypted || encryptedSSN).toString().replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function getSSNDigitsPlain(rawSsn) {
  if (!rawSsn) return null;
  const decrypted = decryptSSN(rawSsn);
  if (decrypted) {
    const d = String(decrypted).replace(/\D/g, '');
    if (d.length === 9) return d;
  }
  const rawDigits = String(rawSsn).replace(/\D/g, '');
  if (rawDigits.length === 9) return rawDigits;
  return null;
}

function formatAndEncryptSSN(ssn) {
  if (!ssn || typeof ssn !== 'string') return null;
  const digits = ssn.replace(/\D/g, '');
  if (digits.length !== 9) return null;
  const formatted = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
  try {
    return encryptionService.encrypt(formatted);
  } catch (err) {
    return null;
  }
}

function mapHouseholdMemberRow(row) {
  if (!row) return row;
  const rawSsn = row.SSN;
  const { SSN, ...rest } = row;
  return {
    ...rest,
    ssn: getSSNDigitsPlain(rawSsn),
    ssnLast4: getSSNLast4(rawSsn) || null
  };
}

/**
 * @route GET /api/me/member/household
 * @desc Get the current member's entire household (including themselves)
 * @access Private (Member role)
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    
    // First get the current member's household ID
    const memberQuery = `
      SELECT HouseholdId, RelationshipType 
      FROM oe.Members 
      WHERE UserId = @userId
    `;
    
    request.input('userId', sql.UniqueIdentifier, getActorUserId(req));
    const memberResult = await request.query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member profile not found',
        error: {
          message: 'No member record found for this user',
          code: 'MEMBER_NOT_FOUND'
        }
      });
    }
    
    const { HouseholdId, RelationshipType } = memberResult.recordset[0];
    const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === true;

    // Get all household members (excluding expired members)
    // IMPORTANT: Dependents (Spouse/Children) don't typically log in, so we return them
    // if their MemberStatus is Active, regardless of UserStatus.
    // Primary members need both MemberStatus and UserStatus to be Active (they must log in).
    // When includeInactive=true, also return dependents with Status = 'Inactive'.
    const householdQuery = `
      SELECT 
        m.MemberId,
        m.UserId,
        m.GroupId,
        m.RelationshipType,
        m.MemberSequence,
        m.HouseholdMemberID,
        m.Status,
        m.DateOfBirth,
        m.Gender,
        m.Address,
        m.City,
        m.State,
        m.Zip,
        m.TerminationDate,
        m.SSN,
        u.FirstName,
        u.LastName,
        u.Email,
        u.PhoneNumber,
        u.Status as UserStatus,
        u.TerminationDate as UserTerminationDate,
        CASE m.RelationshipType
          WHEN 'P' THEN 'Primary'
          WHEN 'S' THEN 'Spouse'
          WHEN 'C' THEN 'Child'
          ELSE 'Unknown'
        END as RelationshipDescription,
        CASE 
          WHEN m.UserId = @userId THEN 1 
          ELSE 0 
        END as IsCurrentUser,
        CASE 
          WHEN m.TerminationDate IS NOT NULL AND m.TerminationDate <= GETDATE() THEN 1
          WHEN u.TerminationDate IS NOT NULL AND u.TerminationDate <= GETDATE() THEN 1
          ELSE 0
        END as IsExpired,
        CASE 
          WHEN m.TerminationDate IS NOT NULL AND m.TerminationDate > GETDATE() THEN 1
          WHEN u.TerminationDate IS NOT NULL AND u.TerminationDate > GETDATE() THEN 1
          ELSE 0
        END as IsPendingTermination,
        CASE 
          WHEN m.TerminationDate IS NOT NULL AND m.TerminationDate > GETDATE() THEN m.TerminationDate
          WHEN u.TerminationDate IS NOT NULL AND u.TerminationDate > GETDATE() THEN u.TerminationDate
          ELSE NULL
        END as EffectiveTerminationDate,
        t.MemberIDPrefix as TenantMemberIDPrefix,
        t.IndividualMemberIDPrefix as TenantIndividualMemberIDPrefix
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
      WHERE m.HouseholdId = @householdId
        AND (
          -- Primary members: require both MemberStatus and UserStatus to be Active (they must log in)
          (m.RelationshipType = 'P' AND m.Status = 'Active' AND u.Status = 'Active')
          OR
          -- Dependents (Spouse/Children): only require MemberStatus to be Active (they don't need to log in)
          (m.RelationshipType IN ('S', 'C') AND m.Status = 'Active')
          OR
          -- Include inactive dependents when requested (for "Show inactive" toggle)
          (${includeInactive ? "m.RelationshipType IN ('S', 'C') AND m.Status = 'Inactive'" : '0=1'})
          OR
          -- Include members pending termination (not yet expired)
          (m.Status = 'Pending Termination' AND m.TerminationDate > GETDATE())
          OR
          -- Include users pending termination (not yet expired)
          (u.Status = 'Pending Termination' AND u.TerminationDate > GETDATE())
        )
      ORDER BY m.MemberSequence
    `;
    
    const householdRequest = pool.request();
    householdRequest.input('userId', sql.UniqueIdentifier, getActorUserId(req));
    householdRequest.input('householdId', sql.UniqueIdentifier, HouseholdId);
    
    const householdResult = await householdRequest.query(householdQuery);
    
    // Check permissions for household management
    const canManageHousehold = RelationshipType === 'P' || RelationshipType === 'S';

    const householdMembers = householdResult.recordset.map((row) => mapHouseholdMemberRow(row));
    
    res.json({
      success: true,
      data: {
        householdMembers,
        currentMemberRelationship: RelationshipType,
        canManageHousehold: canManageHousehold
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching household:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching household',
      error: {
        message: error.message,
        code: 'HOUSEHOLD_FETCH_ERROR'
      }
    });
  }
});

/**
 * @route POST /api/me/member/household/members
 * @desc Add a new dependent to the current member's household
 * @access Private (Member role - Primary or Spouse only)
 */
router.post('/members', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth,
      gender,
      ssn,
      relationshipType // 'S' for Spouse, 'C' for Child
    } = req.body;
    
    // Validation (children get a system-generated email; spouse requires a real email)
    if (!firstName || !lastName || !relationshipType) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and relationship type are required',
        error: {
          message: 'Missing required fields',
          code: 'VALIDATION_ERROR'
        }
      });
    }
    if (relationshipType === 'S' && (!email || !String(email).trim())) {
      return res.status(400).json({
        success: false,
        message: 'Email is required when adding a spouse',
        error: {
          message: 'Missing email for spouse',
          code: 'VALIDATION_ERROR'
        }
      });
    }
    
    // Validate relationship type
    if (!['S', 'C'].includes(relationshipType)) {
      return res.status(400).json({
        success: false,
        message: 'Relationship type must be S (Spouse) or C (Child)',
        error: {
          message: 'Invalid relationship type',
          code: 'INVALID_RELATIONSHIP_TYPE'
        }
      });
    }
    
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      // Get current member's info and verify permissions
      const memberRequest = transaction.request();
      memberRequest.input('userId', sql.UniqueIdentifier, getActorUserId(req));
      
      const memberResult = await memberRequest.query(`
        SELECT 
          m.MemberId,
          m.HouseholdId, 
          m.RelationshipType, 
          m.TenantId, 
          m.GroupId,
          (SELECT COUNT(*) FROM oe.Members WHERE HouseholdId = m.HouseholdId) as HouseholdSize
        FROM oe.Members m
        WHERE m.UserId = @userId
      `);
      
      if (memberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Member profile not found'
        });
      }
      
      const currentMember = memberResult.recordset[0];
      
      // CRITICAL: Check if current member has a household ID
      if (!currentMember.HouseholdId) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Cannot add dependents: Member has no household ID. Please contact support to fix your account.',
          error: {
            message: 'Missing household ID',
            code: 'NO_HOUSEHOLD_ID'
          }
        });
      }
      
      // Check permissions - only Primary or Spouse can add dependents
      if (!['P', 'S'].includes(currentMember.RelationshipType)) {
        await transaction.rollback();
        return res.status(403).json({
          success: false,
          message: 'Only primary members and spouses can add dependents',
          error: {
            message: 'Insufficient permissions',
            code: 'PERMISSION_DENIED'
          }
        });
      }
      
      // ENHANCED: Get the primary member's household ID to ensure consistency
      // This handles cases where a spouse might have a different household ID
      let primaryHouseholdId = currentMember.HouseholdId;
      
      console.log('🔍 DEBUG - Current member data:', {
        MemberId: currentMember.MemberId,
        HouseholdId: currentMember.HouseholdId,
        RelationshipType: currentMember.RelationshipType,
        TenantId: currentMember.TenantId,
        GroupId: currentMember.GroupId,
        HouseholdSize: currentMember.HouseholdSize
      });
      
      if (currentMember.RelationshipType === 'S') {
        // If current user is a spouse, find the primary member's household ID
        const primaryRequest = transaction.request();
        primaryRequest.input('householdId', sql.UniqueIdentifier, currentMember.HouseholdId);
        
        const primaryResult = await primaryRequest.query(`
          SELECT HouseholdId 
          FROM oe.Members 
          WHERE HouseholdId = @householdId AND RelationshipType = 'P'
        `);
        
        if (primaryResult.recordset.length > 0) {
          primaryHouseholdId = primaryResult.recordset[0].HouseholdId;
          console.log('🔍 DEBUG - Found primary household ID:', primaryHouseholdId);
        }
      }
      
      console.log('🔍 DEBUG - Final primaryHouseholdId:', primaryHouseholdId);
      
      // CRITICAL VALIDATION: Ensure we have a valid household ID
      if (!primaryHouseholdId) {
        await transaction.rollback();
        return res.status(500).json({
          success: false,
          message: 'CRITICAL ERROR: Cannot determine household ID for dependent',
          error: {
            message: 'Primary household ID is null or undefined',
            code: 'INVALID_HOUSEHOLD_ID',
            debug: {
              currentMemberHouseholdId: currentMember.HouseholdId,
              currentMemberRelationshipType: currentMember.RelationshipType
            }
          }
        });
      }
      
      // Check if adding spouse when one already exists
      if (relationshipType === 'S') {
        const spouseCheckRequest = transaction.request();
        spouseCheckRequest.input('householdId', sql.UniqueIdentifier, primaryHouseholdId);
        
        const spouseCheck = await spouseCheckRequest.query(`
          SELECT COUNT(*) as SpouseCount 
          FROM oe.Members 
          WHERE HouseholdId = @householdId AND RelationshipType = 'S'
        `);
        
        if (spouseCheck.recordset[0].SpouseCount > 0) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'A spouse already exists in this household',
            error: {
              message: 'Spouse already exists',
              code: 'SPOUSE_EXISTS'
            }
          });
        }
      }
      
      // Generate IDs first so children can use a unique dependent-{userId}@noemail.com address
      const newUserId = require('crypto').randomUUID();
      const newMemberId = require('crypto').randomUUID();
      const resolvedEmail =
        relationshipType === 'C'
          ? `dependent-${newUserId}@noemail.com`
          : String(email).trim();

      // Check if email already exists in oe.Users
      const emailCheckRequest = transaction.request();
      emailCheckRequest.input('email', sql.NVarChar, resolvedEmail);
      const emailCheck = await emailCheckRequest.query(`
        SELECT COUNT(*) as EmailCount FROM oe.Users WHERE Email = @email
      `);

      if (emailCheck.recordset[0].EmailCount > 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'A user with this email address already exists',
          error: {
            message: 'Email already exists',
            code: 'EMAIL_EXISTS'
          }
        });
      }

      // Dependents use the primary member's address (single household address)
      const primaryAddrRequest = transaction.request();
      primaryAddrRequest.input('householdId', sql.UniqueIdentifier, primaryHouseholdId);
      const primaryAddrResult = await primaryAddrRequest.query(`
        SELECT TOP 1 Address, City, State, Zip
        FROM oe.Members
        WHERE HouseholdId = @householdId AND RelationshipType = 'P'
      `);
      const primaryAddr = primaryAddrResult.recordset[0] || {};
      const resolvedAddress = primaryAddr.Address ?? null;
      const resolvedCity = primaryAddr.City ?? null;
      const resolvedState = primaryAddr.State ?? null;
      const resolvedZip = primaryAddr.Zip ?? null;
      
      // Get accurate household size using the primary household ID
      const householdSizeRequest = transaction.request();
      householdSizeRequest.input('householdId', sql.UniqueIdentifier, primaryHouseholdId);
      const householdSizeResult = await householdSizeRequest.query(`
        SELECT COUNT(*) as HouseholdSize FROM oe.Members WHERE HouseholdId = @householdId
      `);
      const memberSequence = householdSizeResult.recordset[0].HouseholdSize + 1;
      
      // Create User record
      const userRequest = transaction.request();
      userRequest.input('userId', sql.UniqueIdentifier, newUserId);
      userRequest.input('email', sql.NVarChar, resolvedEmail);
      userRequest.input('firstName', sql.NVarChar, firstName);
      userRequest.input('lastName', sql.NVarChar, lastName);
      userRequest.input('phoneNumber', sql.NVarChar, phone || null);
      userRequest.input('userType', sql.NVarChar, 'Member');
      userRequest.input('roles', sql.NVarChar, 'Member'); // FIXED: Add Roles field
      userRequest.input('status', sql.NVarChar, 'Active');
      userRequest.input('tenantId', sql.UniqueIdentifier, currentMember.TenantId);
      
      console.log('🔍 DEBUG - Creating User with data:', {
        userId: newUserId,
        email: resolvedEmail,
        firstName: firstName,
        lastName: lastName,
        phoneNumber: phone || null,
        status: 'Active',
        tenantId: currentMember.TenantId
      });
      
      await userRequest.query(`
        INSERT INTO oe.Users (
          UserId, Email, FirstName, LastName, PhoneNumber, 
          Status, TenantId, CreatedDate, ModifiedDate
        ) VALUES (
          @userId, @email, @firstName, @lastName, @phoneNumber,
          @status, @tenantId, GETDATE(), GETDATE()
        )
      `);
      
      console.log('✅ DEBUG - User created successfully');
      
      // Assign Member role using UserRolesService
      await UserRolesService.assignRoleToUser(newUserId, 'Member', currentMember.UserId);
      
      // Create Member record
      const memberInsertRequest = transaction.request();
      memberInsertRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
      memberInsertRequest.input('userId', sql.UniqueIdentifier, newUserId);
      memberInsertRequest.input('groupId', sql.UniqueIdentifier, currentMember.GroupId || null);
      memberInsertRequest.input('householdId', sql.UniqueIdentifier, primaryHouseholdId);
      memberInsertRequest.input('relationshipType', sql.NVarChar, relationshipType);
      memberInsertRequest.input('memberSequence', sql.Int, memberSequence);
      memberInsertRequest.input('status', sql.NVarChar, 'Active');
      memberInsertRequest.input('dateOfBirth', sql.Date, dateOfBirth || null);
      memberInsertRequest.input('gender', sql.NVarChar, gender || null);
      memberInsertRequest.input('address', sql.NVarChar, resolvedAddress);
      memberInsertRequest.input('city', sql.NVarChar, resolvedCity);
      memberInsertRequest.input('state', sql.NVarChar, resolvedState);
      memberInsertRequest.input('zip', sql.NVarChar, resolvedZip);
      memberInsertRequest.input('tenantId', sql.UniqueIdentifier, currentMember.TenantId);
      const newSsnDigits = ssn != null && ssn !== undefined ? String(ssn).replace(/\D/g, '') : '';
      const newSsnEncrypted = newSsnDigits.length === 9 ? formatAndEncryptSSN(newSsnDigits) : null;
      memberInsertRequest.input('ssn', sql.NVarChar, newSsnEncrypted);
      
      console.log('🔍 DEBUG - Creating Member with data:', {
        memberId: newMemberId,
        userId: newUserId,
        groupId: currentMember.GroupId || null,
        householdId: primaryHouseholdId,
        relationshipType: relationshipType,
        memberSequence: memberSequence,
        status: 'Active',
        tenantId: currentMember.TenantId
      });
      
      // CRITICAL VALIDATION: Double-check household ID before insertion
      if (!primaryHouseholdId) {
        await transaction.rollback();
        return res.status(500).json({
          success: false,
          message: 'CRITICAL ERROR: Attempting to create member with NULL household ID',
          error: {
            message: 'Household ID cannot be null',
            code: 'NULL_HOUSEHOLD_ID_INSERTION'
          }
        });
      }
      
      await memberInsertRequest.query(`
        INSERT INTO oe.Members (
          MemberId, UserId, GroupId, HouseholdId, RelationshipType, MemberSequence,
          Status, DateOfBirth, Gender, Address, City, State, Zip, TenantId, SSN,
          CreatedDate, ModifiedDate
        ) VALUES (
          @memberId, @userId, @groupId, @householdId, @relationshipType, @memberSequence,
          @status, @dateOfBirth, @gender, @address, @city, @state, @zip, @tenantId, @ssn,
          GETDATE(), GETDATE()
        )
      `);
      
      // Generate HouseholdMemberID using the stored procedure
      const householdMemberIdRequest = transaction.request();
      householdMemberIdRequest.input('TenantId', sql.UniqueIdentifier, currentMember.TenantId);
      householdMemberIdRequest.input('MemberId', sql.UniqueIdentifier, newMemberId);
      householdMemberIdRequest.output('HouseholdMemberID', sql.NVarChar(50));
      
      await householdMemberIdRequest.execute('oe.GenerateHouseholdMemberID');
      const generatedHouseholdMemberID = householdMemberIdRequest.parameters.HouseholdMemberID.value;
      
      // Update the member with the generated HouseholdMemberID
      const updateHouseholdIdRequest = transaction.request();
      updateHouseholdIdRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
      updateHouseholdIdRequest.input('householdMemberID', sql.NVarChar(50), generatedHouseholdMemberID);
      
      await updateHouseholdIdRequest.query(`
        UPDATE oe.Members 
        SET HouseholdMemberID = @householdMemberID, ModifiedDate = GETDATE()
        WHERE MemberId = @memberId
      `);
      
      console.log('✅ DEBUG - Member created successfully');
      console.log('✅ DEBUG - Transaction committing...');
      
      await transaction.commit();
      
      console.log('✅ DEBUG - Transaction committed successfully');
      
      // Return the created member
      const returnRequest = pool.request();
      returnRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
      
      const newMemberResult = await returnRequest.query(`
        SELECT 
          m.MemberId,
          m.UserId,
          m.RelationshipType,
          m.MemberSequence,
          m.HouseholdMemberID,
          m.Status,
          m.DateOfBirth,
          m.Gender,
          m.Address,
          m.City,
          m.State,
          m.Zip,
          m.SSN,
          u.FirstName,
          u.LastName,
          u.Email,
          u.PhoneNumber,
          CASE m.RelationshipType
            WHEN 'P' THEN 'Primary'
            WHEN 'S' THEN 'Spouse'
            WHEN 'C' THEN 'Child'
            ELSE 'Unknown'
          END as RelationshipDescription
        FROM oe.Members m
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
      
      res.status(201).json({
        success: true,
        data: mapHouseholdMemberRow(newMemberResult.recordset[0]),
        message: `${relationshipType === 'S' ? 'Spouse' : 'Child'} added successfully`
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error adding dependent:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while adding dependent',
      error: {
        message: error.message,
        code: 'ADD_DEPENDENT_ERROR'
      }
    });
  }
});

/**
 * @route PUT /api/me/member/household/members/:memberId
 * @desc Update a dependent in the current member's household
 * @access Private (Member role - Primary or Spouse only)
 */
router.put('/members/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params;
    const {
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth,
      gender,
      hireDate,
      ssn
    } = req.body;

    // Validation (dependents: children never change email via portal; spouse email optional = keep existing)
    if (!firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: 'First name and last name are required',
        error: {
          message: 'Missing required fields',
          code: 'VALIDATION_ERROR'
        }
      });
    }
    
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      // Get current member's info and verify permissions
      const currentMemberRequest = transaction.request();
      currentMemberRequest.input('userId', sql.UniqueIdentifier, getActorUserId(req));
      
      const currentMemberResult = await currentMemberRequest.query(`
        SELECT HouseholdId, RelationshipType FROM oe.Members WHERE UserId = @userId
      `);
      
      if (currentMemberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Current member not found'
        });
      }
      
      const currentMember = currentMemberResult.recordset[0];
      
      // Check permissions
      if (!['P', 'S'].includes(currentMember.RelationshipType)) {
        await transaction.rollback();
        return res.status(403).json({
          success: false,
          message: 'Only primary members and spouses can update dependents',
          error: {
            message: 'Insufficient permissions',
            code: 'PERMISSION_DENIED'
          }
        });
      }
      
      // Get the dependent to update and verify it's in the same household
      const dependentRequest = transaction.request();
      dependentRequest.input('memberId', sql.UniqueIdentifier, memberId);
      dependentRequest.input('householdId', sql.UniqueIdentifier, currentMember.HouseholdId);
      
      const dependentResult = await dependentRequest.query(`
        SELECT m.UserId, m.RelationshipType 
        FROM oe.Members m 
        WHERE m.MemberId = @memberId AND m.HouseholdId = @householdId
      `);
      
      if (dependentResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Dependent not found or not in your household',
          error: {
            message: 'Dependent not found',
            code: 'DEPENDENT_NOT_FOUND'
          }
        });
      }
      
      const dependent = dependentResult.recordset[0];
      
      // Cannot update Primary member through this endpoint
      if (dependent.RelationshipType === 'P') {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Cannot update primary member through this endpoint',
          error: {
            message: 'Invalid operation',
            code: 'CANNOT_UPDATE_PRIMARY'
          }
        });
      }

      const isChild = dependent.RelationshipType === 'C';
      const emailTrimmed =
        email !== undefined && email !== null ? String(email).trim() : '';
      let spouseEmailToSet = null;
      if (!isChild && dependent.RelationshipType === 'S') {
        if (emailTrimmed.length > 0) {
          spouseEmailToSet = emailTrimmed;
          const emailCheckRequest = transaction.request();
          emailCheckRequest.input('email', sql.NVarChar, spouseEmailToSet);
          emailCheckRequest.input('userId', sql.UniqueIdentifier, dependent.UserId);

          const emailCheck = await emailCheckRequest.query(`
            SELECT COUNT(*) as EmailCount
            FROM oe.Users
            WHERE Email = @email AND UserId != @userId
          `);

          if (emailCheck.recordset[0].EmailCount > 0) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: 'A user with this email address already exists',
              error: {
                message: 'Email already exists',
                code: 'EMAIL_EXISTS'
              }
            });
          }
        }
      }

      // Update User record (children: never change Email from this endpoint)
      const updateUserRequest = transaction.request();
      updateUserRequest.input('userId', sql.UniqueIdentifier, dependent.UserId);
      updateUserRequest.input('firstName', sql.NVarChar, firstName);
      updateUserRequest.input('lastName', sql.NVarChar, lastName);
      updateUserRequest.input('phoneNumber', sql.NVarChar, phone || null);

      if (isChild) {
        await updateUserRequest.query(`
          UPDATE oe.Users
          SET
            FirstName = @firstName,
            LastName = @lastName,
            PhoneNumber = @phoneNumber,
            ModifiedDate = GETDATE()
          WHERE UserId = @userId
        `);
      } else if (spouseEmailToSet) {
        updateUserRequest.input('email', sql.NVarChar, spouseEmailToSet);
        await updateUserRequest.query(`
          UPDATE oe.Users
          SET
            FirstName = @firstName,
            LastName = @lastName,
            Email = @email,
            PhoneNumber = @phoneNumber,
            ModifiedDate = GETDATE()
          WHERE UserId = @userId
        `);
      } else {
        await updateUserRequest.query(`
          UPDATE oe.Users
          SET
            FirstName = @firstName,
            LastName = @lastName,
            PhoneNumber = @phoneNumber,
            ModifiedDate = GETDATE()
          WHERE UserId = @userId
        `);
      }

      // Update Member record (address follows primary household; not edited for dependents here)
      const updateMemberRequest = transaction.request();
      updateMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      updateMemberRequest.input('dateOfBirth', sql.Date, dateOfBirth || null);
      updateMemberRequest.input('gender', sql.NVarChar, gender || null);
      updateMemberRequest.input('hireDate', sql.Date, hireDate || null);
      const updateSsnDigits = ssn != null && ssn !== undefined ? String(ssn).replace(/\D/g, '') : '';
      const updateSsnEncrypted = updateSsnDigits.length === 9 ? formatAndEncryptSSN(updateSsnDigits) : null;
      updateMemberRequest.input('ssnEncrypted', sql.NVarChar, updateSsnEncrypted);

      await updateMemberRequest.query(`
        UPDATE oe.Members
        SET
          DateOfBirth = @dateOfBirth,
          Gender = @gender,
          HireDate = @hireDate,
          SSN = COALESCE(@ssnEncrypted, SSN),
          ModifiedDate = GETDATE()
        WHERE MemberId = @memberId
      `);
      
      await transaction.commit();
      
      // Return updated member
      const returnRequest = pool.request();
      returnRequest.input('memberId', sql.UniqueIdentifier, memberId);
      
      const updatedMemberResult = await returnRequest.query(`
        SELECT 
          m.MemberId,
          m.UserId,
          m.RelationshipType,
          m.MemberSequence,
          m.Status,
          m.DateOfBirth,
          m.Gender,
          m.Address,
          m.City,
          m.State,
          m.Zip,
          m.SSN,
          u.FirstName,
          u.LastName,
          u.Email,
          u.PhoneNumber,
          CASE m.RelationshipType
            WHEN 'P' THEN 'Primary'
            WHEN 'S' THEN 'Spouse'
            WHEN 'C' THEN 'Child'
            ELSE 'Unknown'
          END as RelationshipDescription
        FROM oe.Members m
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `);
      
      res.json({
        success: true,
        data: mapHouseholdMemberRow(updatedMemberResult.recordset[0]),
        message: 'Dependent updated successfully'
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error updating dependent:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating dependent',
      error: {
        message: error.message,
        code: 'UPDATE_DEPENDENT_ERROR'
      }
    });
  }
});

/**
 * @route DELETE /api/me/member/household/members/:memberId
 * @desc Remove a dependent from the current member's household
 * @access Private (Member role - Primary or Spouse only)
 */
router.delete('/members/:memberId', async (req, res) => {
  try {
    const { memberId } = req.params;
    
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      // Get current member's info and verify permissions
      const currentMemberRequest = transaction.request();
      currentMemberRequest.input('userId', sql.UniqueIdentifier, getActorUserId(req));
      
      const currentMemberResult = await currentMemberRequest.query(`
        SELECT HouseholdId, RelationshipType FROM oe.Members WHERE UserId = @userId
      `);
      
      if (currentMemberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Current member not found'
        });
      }
      
      const currentMember = currentMemberResult.recordset[0];
      
      // Check permissions
      if (!['P', 'S'].includes(currentMember.RelationshipType)) {
        await transaction.rollback();
        return res.status(403).json({
          success: false,
          message: 'Only primary members and spouses can remove dependents',
          error: {
            message: 'Insufficient permissions',
            code: 'PERMISSION_DENIED'
          }
        });
      }
      
      // Get the dependent to delete and verify it's in the same household
      const dependentRequest = transaction.request();
      dependentRequest.input('memberId', sql.UniqueIdentifier, memberId);
      dependentRequest.input('householdId', sql.UniqueIdentifier, currentMember.HouseholdId);
      
      const dependentResult = await dependentRequest.query(`
        SELECT m.UserId, m.RelationshipType, u.FirstName, u.LastName
        FROM oe.Members m 
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId AND m.HouseholdId = @householdId
      `);
      
      if (dependentResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Dependent not found or not in your household',
          error: {
            message: 'Dependent not found',
            code: 'DEPENDENT_NOT_FOUND'
          }
        });
      }
      
      const dependent = dependentResult.recordset[0];
      
      // Cannot delete Primary member
      if (dependent.RelationshipType === 'P') {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Cannot delete primary member',
          error: {
            message: 'Invalid operation',
            code: 'CANNOT_DELETE_PRIMARY'
          }
        });
      }
      
      // Calculate next billing cycle date for termination
      const currentDate = new Date();
      const nextBillingCycle = new Date(currentDate);
      nextBillingCycle.setMonth(nextBillingCycle.getMonth() + 1);
      nextBillingCycle.setDate(1); // Set to first day of next month
      
      // Set member to be terminated on next billing cycle
      const deleteMemberRequest = transaction.request();
      deleteMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      deleteMemberRequest.input('terminationDate', sql.Date, nextBillingCycle.toISOString().split('T')[0]);
      
      await deleteMemberRequest.query(`
        UPDATE oe.Members
        SET 
          Status = 'Pending Termination',
          TerminationDate = @terminationDate,
          ModifiedDate = GETDATE()
        WHERE MemberId = @memberId
      `);
      
      // Keep user account active until termination date
      const updateUserRequest = transaction.request();
      updateUserRequest.input('userId', sql.UniqueIdentifier, dependent.UserId);
      updateUserRequest.input('terminationDate', sql.Date, nextBillingCycle.toISOString().split('T')[0]);
      
      await updateUserRequest.query(`
        UPDATE oe.Users
        SET 
          Status = 'Pending Termination',
          TerminationDate = @terminationDate,
          ModifiedDate = GETDATE()
        WHERE UserId = @userId
      `);
      
      await transaction.commit();
      
      res.json({
        success: true,
        message: `${dependent.FirstName} ${dependent.LastName} will be removed from the household on ${nextBillingCycle.toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })} (next billing cycle)`
      });
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error removing dependent:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while removing dependent',
      error: {
        message: error.message,
        code: 'REMOVE_DEPENDENT_ERROR'
      }
    });
  }
});

module.exports = router;