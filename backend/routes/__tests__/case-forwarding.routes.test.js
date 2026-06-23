const request = require('supertest');
const express = require('express');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { UserId: 'u1', currentRole: req.headers['x-role'] || 'VendorAdmin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../middleware/shareRequestAccess', () => ({
  attachVendorContext: (req, _res, next) => { req.vendor = { VendorId: 'vendor1' }; next(); },
}));
jest.mock('../../services/caseForwardingService', () => ({
  listTargets: jest.fn(async () => [{ TargetId: 't1' }]),
  createTarget: jest.fn(async () => ({ TargetId: 'new' })),
}));

const router = require('../me/vendor/case-forwarding');
const app = express();
app.use(express.json());
app.use('/api/me/vendor/case-forwarding', router);

test('GET /targets returns list', async () => {
  const res = await request(app).get('/api/me/vendor/case-forwarding/targets');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(1);
});

test('POST /targets rejected for VendorAgent', async () => {
  const res = await request(app)
    .post('/api/me/vendor/case-forwarding/targets')
    .set('x-role', 'VendorAgent')
    .send({ planVendorId: 'v', label: 'ARM', forwardingEmails: 'a@a.com' });
  expect(res.status).toBe(403);
});
