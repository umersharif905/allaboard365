const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const UserManagementService = require('../../../services/shared/user-management.service');

// GET Tenant Users - Get all users for the current tenant
router.get('/', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      userType: req.query.userType,
      status: req.query.status,
      sortBy: req.query.sortBy || 'FirstName',
      sortOrder: req.query.sortOrder || 'ASC',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50
    };

    console.log('🔍 Fetching tenant users with filters:', filters);

    const result = await UserManagementService.getUsers(req.user, filters);

    res.json({
      success: true,
      data: result.users,
      pagination: result.pagination
    });

  } catch (error) {
    console.error('❌ Error fetching tenant users:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch users'
    });
  }
});

// POST Create Tenant User
router.post('/', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      sendWelcomeEmail = true
    } = req.body;

    // Always create TenantAdmin users from this endpoint
    const roleName = 'TenantAdmin';

    console.log('📝 Creating tenant user:', {
      firstName,
      lastName,
      email,
      role: roleName,
      tenantId: req.tenantId || req.user.TenantId,
      requestedBy: req.user.currentRole
    });

    // Validation
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and email are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const result = await UserManagementService.createUser(req.user, {
      firstName,
      lastName,
      email,
      phoneNumber,
      userType: roleName, // Pass as userType for backward compatibility with service
      sendWelcomeEmail
    }, req);

    console.log(`🔗 Password Setup Link for ${email}: ${result.passwordSetupLink}`);

    let successMessage = 'User created successfully';
    if (result.crossTenantTenantAdminGranted) {
      successMessage =
        'This email already has an account. Tenant admin access was added for this organization—they can sign in with their existing credentials and use the organization switcher if they belong to more than one tenant.';
    } else if (result.alreadyHadTenantAdminAccessForOrg) {
      successMessage =
        'This email already has an Open Enroll account and already has tenant admin access for this organization. No changes were needed.';
    } else if (result.isExistingUser) {
      successMessage = result.existingAccountMatched
        ? 'This email already has an Open Enroll account. Tenant admin access was added to that account.'
        : 'Tenant admin access was granted to the existing user.';
    }

    res.json({
      success: true,
      message: successMessage,
      data: result
    });

  } catch (error) {
    console.error('❌ Error creating tenant user:', error);
    if (error.isAlreadyTenantAdmin) {
      return res.status(400).json({
        success: false,
        message: error.message,
        isAlreadyTenantAdmin: true
      });
    }
    if (error.isDifferentTenant) {
      return res.status(400).json({
        success: false,
        message: error.message,
        isDifferentTenant: true
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create user'
    });
  }
});

// POST Resend Password Setup Link
router.post('/:id/resend-link', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const { id } = req.params;

    console.log('📧 Resending password setup link for user:', id);

    const result = await UserManagementService.resendPasswordSetupLink(req.user, id, req);

    console.log(`🔗 New Password Setup Link: ${result.passwordSetupLink}`);

    res.json({
      success: true,
      message: 'Password setup link resent successfully',
      data: result
    });

  } catch (error) {
    console.error('❌ Error resending password setup link:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to resend password setup link'
    });
  }
});

// PUT Update User
router.put('/:id', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, email, phoneNumber } = req.body;

    console.log('✏️ Updating user:', { userId: id, updates: req.body });

    // Validation
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and email are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    await UserManagementService.updateUser(req.user, id, {
      firstName,
      lastName,
      email,
      phoneNumber
    });

    res.json({
      success: true,
      message: 'User updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating user:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update user'
    });
  }
});

// PUT Update User Status
router.put('/:id/status', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Active', 'Inactive', 'Suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be Active, Inactive, or Suspended'
      });
    }

    console.log('🔄 Updating user status:', { userId: id, status });

    await UserManagementService.updateUserStatus(req.user, id, status);

    res.json({
      success: true,
      message: 'User status updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update user status'
    });
  }
});

// DELETE — remove tenant admin access for this tenant (user account is not deleted)
router.delete('/:id', authorize(['TenantAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const activeTenantId = req.tenantId || req.user.TenantId;

    console.log('🗑️ Remove tenant admin access:', { userId: id, tenantId: activeTenantId, requestedBy: req.user.currentRole });

    const { getPool } = require('../../../config/database');
    const pool = await getPool();

    const result = await UserManagementService.removeTenantAdminForTenant(req.user, id, activeTenantId, pool);

    res.json({
      success: true,
      message: result.message,
      data: result.data
    });
  } catch (error) {
    console.error('❌ Error removing tenant admin access:', error);
    const msg = error.message || 'Failed to remove tenant admin access';
    const status = /not found|access denied/i.test(msg) ? 404 : /cannot remove your own/i.test(msg) ? 400 : 500;
    res.status(status).json({
      success: false,
      message: msg
    });
  }
});

module.exports = router;
