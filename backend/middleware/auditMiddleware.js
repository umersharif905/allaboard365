// backend/services/emailService.js
const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }

  async sendSubscriptionApproval(tenantEmail, productName, tenantName) {
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      to: tenantEmail,
      subject: `Product Subscription Approved - ${productName}`,
      html: `
        <h2>Subscription Approved</h2>
        <p>Dear ${tenantName},</p>
        <p>Your subscription request for <strong>${productName}</strong> has been approved.</p>
        <p>You can now start selling this product to your customers.</p>
        <p>Login to your dashboard to view pricing and product details.</p>
        <br>
        <p>Best regards,<br>AllAboard365 Team</p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`Approval email sent to ${tenantEmail}`);
    } catch (error) {
      console.error('Failed to send approval email:', error);
    }
  }

  async sendSubscriptionDenial(tenantEmail, productName, tenantName, reason) {
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      to: tenantEmail,
      subject: `Product Subscription Request - ${productName}`,
      html: `
        <h2>Subscription Request Update</h2>
        <p>Dear ${tenantName},</p>
        <p>Unfortunately, your subscription request for <strong>${productName}</strong> could not be approved at this time.</p>
        ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>Please contact support if you have any questions.</p>
        <br>
        <p>Best regards,<br>AllAboard365 Team</p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`Denial email sent to ${tenantEmail}`);
    } catch (error) {
      console.error('Failed to send denial email:', error);
    }
  }

  async sendNewSubscriptionRequest(adminEmails, productName, tenantName) {
    const mailOptions = {
      from: process.env.FROM_EMAIL,
      to: adminEmails.join(','),
      subject: `New Product Subscription Request - ${productName}`,
      html: `
        <h2>New Subscription Request</h2>
        <p><strong>Tenant:</strong> ${tenantName}</p>
        <p><strong>Product:</strong> ${productName}</p>
        <p>A new subscription request requires your review and approval.</p>
        <p><a href="https://app.allaboard365.com/admin/marketplace/requests">Review Request</a></p>
        <br>
        <p>AllAboard365 System</p>
      `
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`New request notification sent to admins`);
    } catch (error) {
      console.error('Failed to send request notification:', error);
    }
  }
}

module.exports = new EmailService();

// ============================================================================

// backend/services/auditService.js
const sql = require('mssql');

class AuditService {
  async logAction(userId, action, entityType, entityId, details, ipAddress, userAgent) {
    try {
      let pool = await sql.connect();
      let request = pool.request();
      
      request.input('userId', sql.UniqueIdentifier, userId);
      request.input('action', sql.NVarChar, action);
      request.input('entityType', sql.NVarChar, entityType);
      request.input('entityId', sql.UniqueIdentifier, entityId);
      request.input('details', sql.NVarChar, details);
      request.input('ipAddress', sql.NVarChar, ipAddress);
      request.input('userAgent', sql.NVarChar, userAgent);

      await request.query(`
        INSERT INTO oe.AuditLogs (
          UserId, Action, EntityType, EntityId, Details, IpAddress, UserAgent
        ) VALUES (
          @userId, @action, @entityType, @entityId, @details, @ipAddress, @userAgent
        )
      `);

    } catch (error) {
      console.error('Audit logging failed:', error);
      // Don't throw error - audit logging should not break main functionality
    }
  }

  async getAuditLogs(entityType, entityId, limit = 100) {
    try {
      let pool = await sql.connect();
      let request = pool.request();
      
      request.input('entityType', sql.NVarChar, entityType);
      request.input('entityId', sql.UniqueIdentifier, entityId);
      request.input('limit', sql.Int, limit);

      const result = await request.query(`
        SELECT TOP (@limit)
          al.AuditLogId,
          al.Action,
          al.Details,
          al.IpAddress,
          al.CreatedDate,
          u.FirstName + ' ' + u.LastName as UserName,
          u.Email as UserEmail
        FROM oe.AuditLogs al
        LEFT JOIN oe.Users u ON al.UserId = u.UserId
        WHERE al.EntityType = @entityType 
          AND al.EntityId = @entityId
        ORDER BY al.CreatedDate DESC
      `);

      return result.recordset;

    } catch (error) {
      console.error('Failed to fetch audit logs:', error);
      return [];
    }
  }
}

module.exports = new AuditService();

// ============================================================================

// backend/middleware/auditMiddleware.js
const auditService = require('../services/auditService');

const auditMiddleware = (action, entityType) => {
  return (req, res, next) => {
    // Store original send method
    const originalSend = res.send;
    
    res.send = function(body) {
      // Log the action after successful response
      if (res.statusCode < 400) {
        const entityId = req.params.id || req.body.productId || req.body.subscriptionId;
        const details = JSON.stringify({
          method: req.method,
          url: req.originalUrl,
          body: req.body,
          query: req.query
        });
        
        if (req.user && entityId) {
          auditService.logAction(
            req.user.userId,
            action,
            entityType,
            entityId,
            details,
            req.ip,
            req.get('User-Agent')
          );
        }
      }
      
      // Call original send method
      return originalSend.call(this, body);
    };
    
    next();
  };
};

module.exports = auditMiddleware;

// ============================================================================

// backend/middleware/validation.js
const { body, query, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Validation errors',
      errors: errors.array()
    });
  }
  next();
};

const validateProductCreation = [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Product name is required (1-100 characters)'),
  body('description').trim().isLength({ min: 1, max: 1000 }).withMessage('Description is required (1-1000 characters)'),
  body('productType').trim().isLength({ min: 1, max: 50 }).withMessage('Product type is required'),
  body('basePremium').isFloat({ min: 0 }).withMessage('Base premium must be a positive number'),
  body('productOwnerId').isUUID().withMessage('Valid product owner ID is required'),
  body('salesType').optional().isIn(['Individual', 'Group', 'Both']).withMessage('Sales type must be Individual, Group, or Both'),
  body('minAge').optional().isInt({ min: 0, max: 120 }).withMessage('Minimum age must be 0-120'),
  body('maxAge').optional().isInt({ min: 0, max: 120 }).withMessage('Maximum age must be 0-120'),
  body('isPublic').optional().isBoolean().withMessage('isPublic must be boolean'),
  body('isBundle').optional().isBoolean().withMessage('isBundle must be boolean'),
  handleValidationErrors
];

const validateProductUpdate = [
  body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Product name must be 1-100 characters'),
  body('description').optional().trim().isLength({ min: 1, max: 1000 }).withMessage('Description must be 1-1000 characters'),
  body('status').optional().isIn(['Active', 'Inactive', 'Draft']).withMessage('Status must be Active, Inactive, or Draft'),
  body('basePremium').optional().isFloat({ min: 0 }).withMessage('Base premium must be a positive number'),
  body('salesType').optional().isIn(['Individual', 'Group', 'Both']).withMessage('Sales type must be Individual, Group, or Both'),
  body('minAge').optional().isInt({ min: 0, max: 120 }).withMessage('Minimum age must be 0-120'),
  body('maxAge').optional().isInt({ min: 0, max: 120 }).withMessage('Maximum age must be 0-120'),
  handleValidationErrors
];

const validateSubscriptionRequest = [
  body('productId').isUUID().withMessage('Valid product ID is required'),
  body('notes').optional().trim().isLength({ max: 500 }).withMessage('Notes must be less than 500 characters'),
  handleValidationErrors
];

const validateSubscriptionApproval = [
  body('status').isIn(['Approved', 'Denied']).withMessage('Status must be Approved or Denied'),
  body('denialReason').optional().trim().isLength({ max: 500 }).withMessage('Denial reason must be less than 500 characters'),
  body('discountAmount').optional().isFloat({ min: 0 }).withMessage('Discount amount must be positive'),
  handleValidationErrors
];

const validateQueryPagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term must be less than 100 characters'),
  handleValidationErrors
];

module.exports = {
  validateProductCreation,
  validateProductUpdate,
  validateSubscriptionRequest,
  validateSubscriptionApproval,
  validateQueryPagination,
  handleValidationErrors
};

// ============================================================================

// backend/middleware/errorHandler.js
const errorHandler = (err, req, res, next) => {
  // Log error details
  console.error('Error occurred:', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    user: req.user?.userId,
    timestamp: new Date().toISOString()
  });

  // Default error response
  let status = err.status || 500;
  let message = err.message || 'Internal server error';
  let details = {};

  // Handle specific error types
  if (err.name === 'ValidationError') {
    status = 400;
    message = 'Validation failed';
    details = err.errors;
  } else if (err.name === 'UnauthorizedError') {
    status = 401;
    message = 'Authentication required';
  } else if (err.code === 'ECONNREFUSED') {
    status = 503;
    message = 'Database connection failed';
  } else if (err.number) {
    // SQL Server errors
    switch (err.number) {
      case 2: // Invalid object name
        status = 404;
        message = 'Resource not found';
        break;
      case 515: // Cannot insert NULL
        status = 400;
        message = 'Required field is missing';
        break;
      case 2627: // Unique constraint violation
        status = 409;
        message = 'Record already exists';
        break;
      default:
        status = 500;
        message = 'Database error occurred';
    }
  }

  // Response object
  const response = {
    success: false,
    message,
    timestamp: new Date().toISOString(),
    path: req.originalUrl
  };

  // Add details in development mode
  if (process.env.NODE_ENV === 'development') {
    response.details = details;
    response.stack = err.stack;
  }

  res.status(status).json(response);
};

module.exports = errorHandler;

// ============================================================================

// backend/utils/responseHelpers.js
const createSuccessResponse = (data, message = 'Success', meta = {}) => {
  return {
    success: true,
    message,
    data,
    meta,
    timestamp: new Date().toISOString()
  };
};

const createErrorResponse = (message, details = null) => {
  const response = {
    success: false,
    message,
    timestamp: new Date().toISOString()
  };
  
  if (details) {
    response.details = details;
  }
  
  return response;
};

const createPaginatedResponse = (data, page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
  
  return {
    success: true,
    data,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    },
    timestamp: new Date().toISOString()
  };
};

module.exports = {
  createSuccessResponse,
  createErrorResponse,
  createPaginatedResponse
};

// ============================================================================

// backend/config/constants.js
const USER_TYPES = {
  ADMIN: 'Admin',
  MEMBER: 'Member',
  AFFILIATE_AGENT: 'Affiliate_Agent',
  AFFILIATE_ADMIN: 'Affiliate_Admin',
  AFFILIATE_ACCOUNTING: 'Affiliate_Accounting'
};

const PRODUCT_STATUSES = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  DRAFT: 'Draft'
};

const SUBSCRIPTION_STATUSES = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  SUSPENDED: 'Suspended'
};

const SALES_TYPES = {
  INDIVIDUAL: 'Individual',
  GROUP: 'Group',
  BOTH: 'Both'
};

const REQUIRED_LICENSES = {
  LIFE: 'Life',
  HEALTH: 'Health',
  ACCIDENT: 'Accident',
  PROPERTY_CASUALTY: 'PropertyCasualty'
};

const EFFECTIVE_DATE_LOGIC = {
  SAME_DAY: 'SameDay',
  FIRST_OF_MONTH: 'FirstOfMonth',
  SELECTED_DAY: 'SelectedDay'
};

module.exports = {
  USER_TYPES,
  PRODUCT_STATUSES,
  SUBSCRIPTION_STATUSES,
  SALES_TYPES,
  REQUIRED_LICENSES,
  EFFECTIVE_DATE_LOGIC
};