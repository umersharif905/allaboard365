const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const encryptionService = require('../../../services/encryptionService');
const {
  getEffectiveUserId,
  isSpouseDelegate,
} = require('../../../middleware/attachMemberHouseholdContext');

/** Same behavior as backend/routes/members.js — decrypt then last 4 for display. */
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

/** Nine-digit string for member self-service (no dashes); never send ciphertext to the client. */
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

/** Same storage format as backend/routes/members.js */
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

/**
 * @route GET /api/me/member/profile
 * @desc Get the current member's profile from oe.Members table
 * @access Private (Member role)
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    
    // Get member's profile from the database - query oe.Members table
    // Join with Users table to get info based on current user's ID
    const query = `
      SELECT
        m.MemberId as Id,
        u.FirstName,
        u.LastName,
        u.Email,
        u.EmailVerified,
        u.EmailVerifiedDate,
        u.PhoneNumber as Phone,
        m.Address,
        m.City,
        m.State,
        m.Zip as ZipCode,
        m.Status as MemberStatus,
        m.DateOfBirth,
        m.TobaccoUse,
        m.Tier,
        m.RelationshipType,
        m.JobPosition,
        m.SSN,
        DATEDIFF(YEAR, m.DateOfBirth, GETDATE()) as Age,
        m.CreatedDate as EnrollmentDate,
        m.GroupId,
        m.TenantId,
        m.HouseholdMemberID,
        m.AgentId,
        CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
        g.Name as GroupName,
        g.AllowPlanModifications,
        ten.MemberIDPrefix as TenantMemberIDPrefix,
        ten.IndividualMemberIDPrefix as TenantIndividualMemberIDPrefix
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants ten ON u.TenantId = ten.TenantId
      WHERE m.UserId = @userId
    `;
    
    const effectiveUserId = getEffectiveUserId(req);
    request.input('userId', sql.UniqueIdentifier, effectiveUserId);
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member profile not found',
        error: {
          message: 'No member record found for this user',
          code: 'MEMBER_NOT_FOUND'
        }
      });
    }
    
    // Convert PascalCase database fields to camelCase for API response
    const profile = {
      id: result.recordset[0].Id,
      firstName: result.recordset[0].FirstName,
      lastName: result.recordset[0].LastName,
      email: result.recordset[0].Email,
      phone: result.recordset[0].Phone || '',
      address: result.recordset[0].Address || '',
      city: result.recordset[0].City || '',
      state: result.recordset[0].State || '',
      zipCode: result.recordset[0].ZipCode || '',
      memberStatus: result.recordset[0].MemberStatus || '',
      dateOfBirth: result.recordset[0].DateOfBirth,
      tobaccoUse: result.recordset[0].TobaccoUse || 'No',
      tier: result.recordset[0].Tier || 'EE',
      relationshipType: result.recordset[0].RelationshipType || 'P',
      isPrimaryMember: isSpouseDelegate(req) || (result.recordset[0].RelationshipType || 'P') === 'P',
      isSpouseDelegate: isSpouseDelegate(req),
      actorRelationshipType: req.memberContext?.actorRelationshipType || result.recordset[0].RelationshipType || 'P',
      emailVerified: Boolean(result.recordset[0].EmailVerified),
      emailVerifiedDate: result.recordset[0].EmailVerifiedDate || null,
      jobPosition: result.recordset[0].JobPosition || null,
      ssn: getSSNDigitsPlain(result.recordset[0].SSN),
      ssnLast4: getSSNLast4(result.recordset[0].SSN) || null,
      age: result.recordset[0].Age || 35,
      enrollmentDate: result.recordset[0].EnrollmentDate,
      groupId: result.recordset[0].GroupId,
      tenantId: result.recordset[0].TenantId,
      householdMemberId: result.recordset[0].HouseholdMemberID || null,
      tenantMemberIDPrefix: result.recordset[0].TenantMemberIDPrefix ?? null,
      tenantIndividualMemberIDPrefix: result.recordset[0].TenantIndividualMemberIDPrefix ?? null,
      billType: result.recordset[0].BillType || 'SB',
      groupName: result.recordset[0].GroupName || null,
      allowPlanModifications: result.recordset[0].AllowPlanModifications === true || result.recordset[0].AllowPlanModifications === 1,
      nextBillingDate: null // Will be calculated below
    };
    
    // Calculate next billing date based on payments and enrollments
    // 1. Check if there's a recurring payment with NextBillingDate set
    const recurringPaymentQuery = `
      SELECT TOP 1 
        p.NextBillingDate,
        p.RecurringScheduleId
      FROM oe.Payments p
      INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      WHERE e.MemberId = @memberId
        AND p.RecurringScheduleId IS NOT NULL
        AND p.NextBillingDate IS NOT NULL
        AND p.Status IN ('APPROVAL', 'succeeded', 'SUCCESS', 'COMPLETED')
      ORDER BY p.PaymentDate DESC
    `;
    
    const recurringPaymentRequest = pool.request();
    recurringPaymentRequest.input('memberId', sql.UniqueIdentifier, profile.id);
    const recurringPaymentResult = await recurringPaymentRequest.query(recurringPaymentQuery);
    
    if (recurringPaymentResult.recordset.length > 0) {
      // Use NextBillingDate from recurring payment
      profile.nextBillingDate = recurringPaymentResult.recordset[0].NextBillingDate;
      console.log('✅ Using NextBillingDate from recurring payment:', profile.nextBillingDate);
    } else {
      // No recurring payment - calculate based on enrollments and first payment
      
      // Get earliest effective date from active enrollments
      const enrollmentQuery = `
        SELECT TOP 1 e.EffectiveDate
        FROM oe.Enrollments e
        WHERE e.MemberId = @memberId
          AND e.Status = 'Active'
        ORDER BY e.EffectiveDate ASC
      `;
      
      const enrollmentRequest = pool.request();
      enrollmentRequest.input('memberId', sql.UniqueIdentifier, profile.id);
      const enrollmentResult = await enrollmentRequest.query(enrollmentQuery);
      
      if (enrollmentResult.recordset.length > 0) {
        const effectiveDate = new Date(enrollmentResult.recordset[0].EffectiveDate);
        
        // Check if first payment has been made
        const firstPaymentQuery = `
          SELECT TOP 1 p.PaymentId, p.PaymentDate, p.Status
          FROM oe.Payments p
          INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
          WHERE e.MemberId = @memberId
            AND p.Status IN ('APPROVAL', 'succeeded', 'SUCCESS', 'COMPLETED')
          ORDER BY p.PaymentDate ASC
        `;
        
        const firstPaymentRequest = pool.request();
        firstPaymentRequest.input('memberId', sql.UniqueIdentifier, profile.id);
        const firstPaymentResult = await firstPaymentRequest.query(firstPaymentQuery);
        
        if (firstPaymentResult.recordset.length > 0) {
          // First payment made - it covers the first month (effective date)
          // Next billing is effective date + 1 month
          const nextBilling = new Date(effectiveDate);
          nextBilling.setMonth(nextBilling.getMonth() + 1);
          
          // If the calculated next billing date is in the past, keep adding months until we get a future date
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          while (nextBilling < today) {
            nextBilling.setMonth(nextBilling.getMonth() + 1);
          }
          
          profile.nextBillingDate = nextBilling.toISOString().split('T')[0];
          console.log('✅ First payment made, next billing calculated:', profile.nextBillingDate);
        } else {
          // No payment yet - next billing is the effective date (first month)
          profile.nextBillingDate = effectiveDate.toISOString().split('T')[0];
          console.log('✅ No payment yet, next billing = effective date:', profile.nextBillingDate);
        }
      } else {
        // No active enrollments - fallback to 1st of next month
        const today = new Date();
        const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        profile.nextBillingDate = nextMonth.toISOString().split('T')[0];
        console.log('⚠️ No active enrollments, using fallback (1st of next month):', profile.nextBillingDate);
      }
    }
    
    // Get agent information if available
    const agentQuery = `
      SELECT TOP 1
        a.AgentId,
        a.AgentCode,
        u.FirstName as AgentFirstName,
        u.LastName as AgentLastName,
        u.Email as AgentEmail,
        u.PhoneNumber as AgentPhone
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId = (
        SELECT AgentId
        FROM oe.Members
        WHERE MemberId = @memberId
          AND AgentId IS NOT NULL
      )
    `;
    
    const agentRequest = pool.request();
    agentRequest.input('memberId', sql.UniqueIdentifier, profile.id);
    const agentResult = await agentRequest.query(agentQuery);
    
    if (agentResult.recordset.length > 0) {
      profile.agent = {
        id: agentResult.recordset[0].AgentId,
        agentCode: agentResult.recordset[0].AgentCode || null,
        firstName: agentResult.recordset[0].AgentFirstName,
        lastName: agentResult.recordset[0].AgentLastName,
        email: agentResult.recordset[0].AgentEmail,
        phone: agentResult.recordset[0].AgentPhone || ''
      };
    }
    
    res.json({
      success: true,
      data: profile
    });
    
  } catch (error) {
    console.error('❌ Error fetching member profile:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching member profile',
      error: {
        message: error.message,
        code: 'PROFILE_ERROR'
      }
    });
  }
});

/**
 * @route PUT /api/me/member/profile
 * @desc Update the current member's profile
 * @access Private (Member role)
 */
router.put('/', async (req, res) => {
  try {
    let {
      firstName,
      lastName,
      phone,
      address,
      city,
      state,
      zipCode,
      ssn
    } = req.body;

    // Basic validation
    if (!firstName || !lastName) {
      return res.status(400).json({
        success: false,
        message: 'First name and last name are required',
        error: {
          message: 'First name and last name are required',
          code: 'VALIDATION_ERROR'
        }
      });
    }

    // Normalize ZIP to 5-digit (accept ZIP+4). Rules live in
    // backend/utils/memberDataValidation.js and match the enrollment wizard.
    const memberDataValidation = require('../../../utils/memberDataValidation');
    if (zipCode != null && String(zipCode).trim() !== '') {
      const normalizedZip = memberDataValidation.normalizeZip(zipCode);
      if (!normalizedZip) {
        return res.status(400).json({
          success: false,
          message: 'ZIP Code must be 5 digits or 9 digits (ZIP+4).',
          error: { code: 'VALIDATION_ERROR' }
        });
      }
      zipCode = normalizedZip;
    }
    if (address != null && String(address).trim() !== '') {
      const { address: normalizedAddress, error: addressError } = memberDataValidation.normalizeStreetAddress(
        address,
        { city, state, zip: zipCode, phone }
      );
      if (addressError) {
        return res.status(400).json({
          success: false,
          message: `${addressError.field}: ${addressError.reason}`,
          error: { code: 'VALIDATION_ERROR' }
        });
      }
      address = normalizedAddress;
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // First, get the member ID from the user ID
    const getMemberIdQuery = `
      SELECT MemberId FROM oe.Members WHERE UserId = @userId
    `;
    
    const effectiveUserId = getEffectiveUserId(req);
    request.input('userId', sql.UniqueIdentifier, effectiveUserId);
    const memberResult = await request.query(getMemberIdQuery);
    
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
    
    const memberId = memberResult.recordset[0].MemberId;

    const ssnDigits = ssn != null && ssn !== undefined ? String(ssn).replace(/\D/g, '') : '';
    const ssnEncrypted = ssnDigits.length === 9 ? formatAndEncryptSSN(ssnDigits) : null;
    
    // Update both Users and Members tables
    const updateQuery = `
      -- Update Users table for name, email, phone
      UPDATE oe.Users
      SET 
        FirstName = @firstName,
        LastName = @lastName,
        PhoneNumber = @phone,
        ModifiedDate = GETDATE()
      WHERE UserId = @userId;
      
      -- Update Members table for address info and SSN (encrypt like members route; omit update if not 9 digits)
      UPDATE oe.Members
      SET 
        Address = @address,
        City = @city,
        State = @state,
        Zip = @zipCode,
        SSN = COALESCE(@ssnEncrypted, SSN),
        ModifiedDate = GETDATE()
      WHERE MemberId = @memberId;
      
      SELECT 
        m.MemberId as Id,
        u.FirstName,
        u.LastName,
        u.Email,
        u.PhoneNumber as Phone,
        m.Address,
        m.City,
        m.State,
        m.Zip as ZipCode,
        m.SSN,
        m.Status as MemberStatus,
        m.DateOfBirth,
        m.CreatedDate as EnrollmentDate,
        m.GroupId
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId = @memberId
    `;
    
    request.input('firstName', sql.NVarChar, firstName);
    request.input('lastName', sql.NVarChar, lastName);
    request.input('phone', sql.NVarChar, phone || null);
    request.input('address', sql.NVarChar, address || null);
    request.input('city', sql.NVarChar, city || null);
    request.input('state', sql.NVarChar, state || null);
    request.input('zipCode', sql.NVarChar, zipCode || null);
    request.input('ssnEncrypted', sql.NVarChar, ssnEncrypted);
    request.input('memberId', sql.UniqueIdentifier, memberId);
    
    const result = await request.query(updateQuery);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member profile not found',
        error: {
          message: 'Member profile not found after update',
          code: 'NOT_FOUND'
        }
      });
    }
    
    // Convert PascalCase database fields to camelCase for API response
    const updatedProfile = {
      id: result.recordset[0].Id,
      firstName: result.recordset[0].FirstName,
      lastName: result.recordset[0].LastName,
      email: result.recordset[0].Email,
      phone: result.recordset[0].Phone || '',
      address: result.recordset[0].Address || '',
      city: result.recordset[0].City || '',
      state: result.recordset[0].State || '',
      zipCode: result.recordset[0].ZipCode || '',
      ssn: getSSNDigitsPlain(result.recordset[0].SSN),
      ssnLast4: getSSNLast4(result.recordset[0].SSN) || null,
      memberStatus: result.recordset[0].MemberStatus || '',
      dateOfBirth: result.recordset[0].DateOfBirth,
      enrollmentDate: result.recordset[0].EnrollmentDate,
      groupId: result.recordset[0].GroupId
    };
    
    res.json({
      success: true,
      data: updatedProfile,
      message: 'Profile updated successfully'
    });
    
  } catch (error) {
    console.error('❌ Error updating member profile:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating member profile',
      error: {
        message: error.message,
        code: 'PROFILE_UPDATE_ERROR'
      }
    });
  }
});

module.exports = router; 