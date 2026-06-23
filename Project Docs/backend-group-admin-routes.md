# Backend API Routes for Group Admin Portal
# Add these routes to your Node.js Express server

```javascript
// routes/groupAdmin.js
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const groupAdminService = require('../services/groupAdminService');

// Middleware to ensure Group_Admin role
router.use(requireAuth);
router.use(requireRole(['Group_Admin']));

// Dashboard metrics
router.get('/dashboard-metrics', async (req, res) => {
  try {
    const metrics = await groupAdminService.getDashboardMetrics(req.user);
    res.json(metrics);
  } catch (error) {
    console.error('Error fetching dashboard metrics:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard metrics' });
  }
});

// Group information
router.get('/group-info', async (req, res) => {
  try {
    const groupInfo = await groupAdminService.getGroupInfo(req.user);
    res.json(groupInfo);
  } catch (error) {
    console.error('Error fetching group info:', error);
    res.status(500).json({ message: 'Failed to fetch group information' });
  }
});

// Employee management
router.get('/employees', async (req, res) => {
  try {
    const { search, status, enrollmentStatus, page = 1, pageSize = 20 } = req.query;
    const employees = await groupAdminService.getEmployees(req.user, {
      search,
      status,
      enrollmentStatus,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    });
    res.json(employees);
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
});

router.get('/employees/:memberId', async (req, res) => {
  try {
    const employee = await groupAdminService.getEmployee(req.user, req.params.memberId);
    res.json(employee);
  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({ message: 'Failed to fetch employee details' });
  }
});

router.post('/employees', async (req, res) => {
  try {
    const employee = await groupAdminService.addEmployee(req.user, req.body);
    res.status(201).json(employee);
  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ message: 'Failed to add employee' });
  }
});

router.put('/employees/:memberId', async (req, res) => {
  try {
    const employee = await groupAdminService.updateEmployee(req.user, req.params.memberId, req.body);
    res.json(employee);
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ message: 'Failed to update employee' });
  }
});

router.delete('/employees/:memberId', async (req, res) => {
  try {
    await groupAdminService.removeEmployee(req.user, req.params.memberId, req.body.terminationDate);
    res.status(204).send();
  } catch (error) {
    console.error('Error removing employee:', error);
    res.status(500).json({ message: 'Failed to remove employee' });
  }
});

router.post('/employees/bulk', async (req, res) => {
  try {
    const { operation, memberIds, data } = req.body;
    const result = await groupAdminService.bulkEmployeeOperation(req.user, operation, memberIds, data);
    res.json(result);
  } catch (error) {
    console.error('Error in bulk operation:', error);
    res.status(500).json({ message: 'Bulk operation failed' });
  }
});

// Enrollment links
router.post('/enrollment-links', async (req, res) => {
  try {
    const link = await groupAdminService.generateEnrollmentLink(req.user, req.body);
    res.status(201).json(link);
  } catch (error) {
    console.error('Error generating enrollment link:', error);
    res.status(500).json({ message: 'Failed to generate enrollment link' });
  }
});

router.get('/enrollment-links', async (req, res) => {
  try {
    const links = await groupAdminService.getEnrollmentLinks(req.user);
    res.json(links);
  } catch (error) {
    console.error('Error fetching enrollment links:', error);
    res.status(500).json({ message: 'Failed to fetch enrollment links' });
  }
});

// Enrollment status
router.get('/enrollment-status', async (req, res) => {
  try {
    const status = await groupAdminService.getEnrollmentStatus(req.user);
    res.json(status);
  } catch (error) {
    console.error('Error fetching enrollment status:', error);
    res.status(500).json({ message: 'Failed to fetch enrollment status' });
  }
});

// Enrollment emails
router.post('/enrollment-emails', async (req, res) => {
  try {
    const result = await groupAdminService.sendEnrollmentEmails(req.user, req.body);
    res.json(result);
  } catch (error) {
    console.error('Error sending enrollment emails:', error);
    res.status(500).json({ message: 'Failed to send enrollment emails' });
  }
});

// Reports
router.post('/reports', async (req, res) => {
  try {
    const { reportType, parameters } = req.body;
    const report = await groupAdminService.generateReport(req.user, reportType, parameters);
    res.json(report);
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ message: 'Failed to generate report' });
  }
});

router.get('/reports/:reportId/export', async (req, res) => {
  try {
    const { format } = req.query;
    const exportData = await groupAdminService.exportReport(req.user, req.params.reportId, format);
    
    // Set appropriate headers for file download
    const filename = `report-${req.params.reportId}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
    } else if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
    } else if (format === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    
    res.send(exportData);
  } catch (error) {
    console.error('Error exporting report:', error);
    res.status(500).json({ message: 'Failed to export report' });
  }
});

// Activity feed
router.get('/activity-feed', async (req, res) => {
  try {
    const { page = 1, pageSize = 10, dateRange } = req.query;
    const activities = await groupAdminService.getActivityFeed(req.user, {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      dateRange: dateRange ? JSON.parse(dateRange) : undefined
    });
    res.json(activities);
  } catch (error) {
    console.error('Error fetching activity feed:', error);
    res.status(500).json({ message: 'Failed to fetch activity feed' });
  }
});

// Enrollment deadlines
router.get('/enrollment-deadlines', async (req, res) => {
  try {
    const deadlines = await groupAdminService.getEnrollmentDeadlines(req.user);
    res.json(deadlines);
  } catch (error) {
    console.error('Error fetching enrollment deadlines:', error);
    res.status(500).json({ message: 'Failed to fetch enrollment deadlines' });
  }
});

// Available products
router.get('/available-products', async (req, res) => {
  try {
    const products = await groupAdminService.getAvailableProducts(req.user);
    res.json(products);
  } catch (error) {
    console.error('Error fetching available products:', error);
    res.status(500).json({ message: 'Failed to fetch available products' });
  }
});

module.exports = router;
```

# Add to your main app.js file:
```javascript
const groupAdminRoutes = require('./routes/groupAdmin');
app.use('/api/group-admin', groupAdminRoutes);
```
