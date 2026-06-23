const request = require('supertest');
const express = require('express');

const mockPoolRequest = {
  input: jest.fn().mockReturnThis(),
  query: jest.fn()
};

const mockTransactionRequest = {
  input: jest.fn().mockReturnThis(),
  query: jest.fn()
};

const mockTransaction = {
  begin: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  request: jest.fn(() => mockTransactionRequest)
};

const mockPool = {
  request: jest.fn(() => mockPoolRequest),
  transaction: jest.fn(() => mockTransaction)
};

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn().mockResolvedValue(mockPool),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Date: 'Date',
    Decimal: 'Decimal'
  }
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'test-uuid-123')
}));

const planChangesRoutes = require('../plan-changes');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { UserId: 'user-123' };
  next();
});
app.use('/plan-changes', planChangesRoutes);

describe('Plan Changes API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.request.mockImplementation(() => mockPoolRequest);
    mockTransaction.request.mockImplementation(() => mockTransactionRequest);
    mockTransactionRequest.query.mockReset();
    mockPoolRequest.query.mockReset();
  });

  describe('POST /plan-changes', () => {
    it('should create a plan change request successfully', async () => {
      mockTransactionRequest.query
        .mockResolvedValueOnce({
          recordset: [{
            MemberId: 'member-123',
            TenantId: 'tenant-123',
            GroupId: 'group-123',
            AgentId: 'agent-123',
            EnrollmentId: 'enrollment-123',
            ProductId: 'product-123',
            EnrollmentStatus: 'Active',
            FirstName: 'John',
            LastName: 'Doe'
          }]
        })
        .mockResolvedValueOnce({});

      const requestData = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' },
        addProducts: ['product-456'],
        removeProducts: [],
        effectiveDate: '2024-02-01'
      };

      const response = await request(app)
        .post('/plan-changes')
        .send(requestData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Plan change request submitted successfully. Pending approval.');
      expect(response.body.data.changeRequestId).toBe('test-uuid-123');
      expect(response.body.data.status).toBe('Pending');
    });

    it('should return 400 if enrollmentId is missing', async () => {
      const requestData = {
        configFieldChanges: { deductible: 'High' }
      };

      const response = await request(app)
        .post('/plan-changes')
        .send(requestData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Enrollment ID is required');
    });

    it('should return 404 if enrollment not found', async () => {
      mockTransactionRequest.query.mockResolvedValueOnce({
        recordset: []
      });

      const requestData = {
        enrollmentId: 'nonexistent-enrollment',
        configFieldChanges: { deductible: 'High' }
      };

      const response = await request(app)
        .post('/plan-changes')
        .send(requestData)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Active enrollment not found or access denied');
    });

    it('should return 403 if enrollment is not active', async () => {
      mockTransactionRequest.query.mockResolvedValueOnce({
        recordset: [{
          MemberId: 'member-123',
          TenantId: 'tenant-123',
          GroupId: 'group-123',
          AgentId: 'agent-123',
          EnrollmentId: 'enrollment-123',
          ProductId: 'product-123',
          EnrollmentStatus: 'Pending',
          FirstName: 'John',
          LastName: 'Doe'
        }]
      });

      const requestData = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { deductible: 'High' }
      };

      const response = await request(app)
        .post('/plan-changes')
        .send(requestData)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Only active enrollments can be modified');
    });
  });

  describe('GET /plan-changes', () => {
    it('should return plan change requests successfully', async () => {
      mockPoolRequest.query.mockResolvedValueOnce({
        recordset: [{
          ChangeRequestId: 'change-123',
          EnrollmentId: 'enrollment-123',
          ConfigFieldChanges: '{"deductible":"High"}',
          AddProducts: '["product-456"]',
          RemoveProducts: '[]',
          EffectiveDate: '2024-02-01',
          Status: 'Pending',
          CreatedDate: '2024-01-15',
          ModifiedDate: '2024-01-15',
          ProductId: 'product-123',
          ProductName: 'Premium Health Plan',
          ProductType: 'Healthcare'
        }]
      });

      const response = await request(app)
        .get('/plan-changes')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].changeRequestId).toBe('change-123');
      expect(response.body.data[0].status).toBe('Pending');
      expect(response.body.data[0].configFieldChanges).toEqual({ deductible: 'High' });
      expect(response.body.data[0].addProducts).toEqual(['product-456']);
    });

    it('should return empty array when no plan change requests exist', async () => {
      mockPoolRequest.query.mockResolvedValueOnce({
        recordset: []
      });

      const response = await request(app)
        .get('/plan-changes')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(0);
    });
  });

  describe('PUT /plan-changes/:id/cancel', () => {
    it('should cancel a pending plan change request successfully', async () => {
      mockPoolRequest.query.mockResolvedValueOnce({
        rowsAffected: [1]
      });

      const response = await request(app)
        .put('/plan-changes/change-123/cancel')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Plan change request cancelled successfully');
    });

    it('should return 404 if plan change request not found', async () => {
      mockPoolRequest.query.mockResolvedValueOnce({
        rowsAffected: [0]
      });

      const response = await request(app)
        .put('/plan-changes/nonexistent-change/cancel')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Plan change request not found or cannot be cancelled');
    });
  });

  describe('POST /plan-changes/pricing-impact', () => {
    it('should calculate pricing impact successfully', async () => {
      const mockMemberRequest = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValueOnce({
          recordset: [{
            MemberId: 'member-123',
            TenantId: 'tenant-123',
            ProductId: 'product-123',
            CurrentPremium: 150.00,
            FirstName: 'John',
            LastName: 'Doe',
            DateOfBirth: '1990-01-01'
          }]
        })
      };
      const mockPricingRequest = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValueOnce({
          recordset: [{
            ProductPricingId: 'pricing-123',
            TierType: 'EE',
            TobaccoStatus: 'No',
            MinAge: 18,
            MaxAge: 99,
            NetRate: 100.00,
            OverrideRate: 50.00,
            MSRPRate: 150.00,
            ConfigValue1: 'High',
            ConfigValue2: null,
            ConfigValue3: null,
            ConfigValue4: null,
            ConfigValue5: null
          }]
        })
      };

      mockPool.request
        .mockReturnValueOnce(mockMemberRequest)
        .mockReturnValueOnce(mockPricingRequest);

      const requestData = {
        enrollmentId: 'enrollment-123',
        configFieldChanges: { configField1: 'High' },
        addProducts: ['product-456'],
        removeProducts: []
      };

      const response = await request(app)
        .post('/plan-changes/pricing-impact')
        .send(requestData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('currentPremium');
      expect(response.body.data).toHaveProperty('newPremium');
      expect(response.body.data).toHaveProperty('difference');
      expect(response.body.data).toHaveProperty('breakdown');
      expect(response.body.data).toHaveProperty('hasChanges');
    });

    it('should return 400 if enrollmentId is missing', async () => {
      const requestData = {
        configFieldChanges: { deductible: 'High' }
      };

      const response = await request(app)
        .post('/plan-changes/pricing-impact')
        .send(requestData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Enrollment ID is required');
    });

    it('should return 404 if enrollment not found', async () => {
      mockPoolRequest.query.mockResolvedValueOnce({
        recordset: []
      });

      const requestData = {
        enrollmentId: 'nonexistent-enrollment',
        configFieldChanges: { deductible: 'High' }
      };

      const response = await request(app)
        .post('/plan-changes/pricing-impact')
        .send(requestData)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Active enrollment not found');
    });
  });
});

