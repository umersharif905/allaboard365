const adminRoutes = require('./routes/admin');
const groupsRoutes = require('./routes/groups');
app.use('/api/admin', adminRoutes);
app.use('/api/groups', authenticateMiddleware, groupsRoutes); 