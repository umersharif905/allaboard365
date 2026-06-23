const express = require('express');
const router = express.Router();

// GET Auth Info
router.get('/info', (req, res) => {
    res.json({
        success: true,
        message: 'OAuth Authentication Required',
        oauth_service: process.env.OAUTH_BASE_URL,
        available_endpoints: {
            admin: ['GET/POST /api/admin/dashboard', 'GET /api/admin/tenants'],
            tenants: ['GET /api/tenants'],
            users: ['GET /api/users'],
            products: ['GET /api/products', 'POST /api/products', 'PUT /api/products/:id'],
            groups: ['GET /api/groups', 'POST /api/groups', 'PUT /api/groups/:id'],
            members: ['GET /api/members', 'GET /api/members/:id', 'POST /api/members', 'PUT /api/members/:id'],
            enrollments: ['GET /api/enrollments', 'POST /api/enrollments'],
            uploads: ['POST /api/uploads', 'GET /api/uploads']
        }
    });
});

module.exports = router;
