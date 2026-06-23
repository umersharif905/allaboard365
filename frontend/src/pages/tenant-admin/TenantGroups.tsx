// frontend/src/pages/tenant-admin/TenantGroups.tsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
  Menu,
  Chip,
  Alert,
  AlertTitle,
  Snackbar,
  Card,
  CardContent,
  Grid,
  Divider,
  Stack,
  Tooltip,
  useTheme,
  alpha,
  Slide,
  SlideProps,
} from '@mui/material';
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
  GridToolbar,
} from '@mui/x-data-grid';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Archive as ArchiveIcon,
  MoreVert as MoreVertIcon,
  Visibility as ViewIcon,
  Business as BusinessIcon,
  People as PeopleIcon,
  Email as EmailIcon,
  AttachMoney as MoneyIcon,
  CalendarToday as CalendarIcon,
  TrendingUp as TrendingUpIcon,
  Assessment as AssessmentIcon,
} from '@mui/icons-material';
import { format } from 'date-fns';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import type { TenantGroup } from '../../types/index';

// Types
interface CreateGroupData {
  name: string;
  ein: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
  billingType: 'Monthly' | 'Quarterly' | 'Annual';
}

interface EditGroupData extends CreateGroupData {
  groupId: string;
  status: 'Active' | 'Inactive' | 'Archived';
}

interface GroupStats {
  totalGroups: number;
  /** Distinct active groups with at least one non-terminated enrollment (matches tenant dashboard). */
  enrolledGroups: number;
  activeGroups: number;
  inactiveGroups: number;
  totalMembers: number;
  totalRevenue: number;
  averageGroupSize: number;
}

// Slide transition for Snackbar
function SlideTransition(props: SlideProps) {
  return <Slide {...props} direction="down" />;
}

export const TenantGroups: React.FC = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  
  // State
  const [groups, setGroups] = useState<TenantGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [userTenantId, setUserTenantId] = useState<string | null>(null);
  const [stats, setStats] = useState<GroupStats>({
    totalGroups: 0,
    enrolledGroups: 0,
    activeGroups: 0,
    inactiveGroups: 0,
    totalMembers: 0,
    totalRevenue: 0,
    averageGroupSize: 0,
  });
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
    title: '' as string | undefined,
  });

  // Fetch user's tenant ID from the database (same pattern as TenantSettings)
  const fetchUserTenantId = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        throw new Error('No authentication token found');
      }
      
      // Get tenant ID from the tenant-admin settings endpoint
      const settingsResponse = await TenantAdminService.getTenantSettings();
      
      if (!settingsResponse.success) {
        throw new Error(settingsResponse.message || 'Failed to get tenant info');
      }
      
      const tenantId = settingsResponse.data?.tenantId;
      if (!tenantId) {
        throw new Error('Tenant ID not found in settings response');
      }
      
      console.log('✅ Retrieved tenantId from database:', tenantId);
      setUserTenantId(tenantId);
      return tenantId;
    } catch (error) {
      console.error('❌ Error fetching tenant ID:', error);
      throw error;
    }
  };

  // Form data
  const [createFormData, setCreateFormData] = useState<CreateGroupData>({
    name: '',
    ein: '',
    adminName: '',
    adminEmail: '',
    adminPhone: '',
    billingType: 'Monthly',
  });

  const [editFormData, setEditFormData] = useState<EditGroupData>({
    groupId: '',
    name: '',
    ein: '',
    adminName: '',
    adminEmail: '',
    adminPhone: '',
    billingType: 'Monthly',
    status: 'Active',
  });

  // Calculate stats from groups data; enrolledGroups comes from /api/tenant-admin/metrics (same as dashboard)
  const calculateStats = (groupsData: TenantGroup[], enrolledGroups: number): GroupStats => {
    const totalGroups = groupsData.length;
    const activeGroups = groupsData.filter(g => g.Status === 'Active').length;
    const inactiveGroups = groupsData.filter(g => g.Status === 'Inactive').length;
    const totalMembers = groupsData.reduce((sum, g) => sum + (g.TotalMembers || 0), 0);
    const totalRevenue = groupsData.reduce((sum, g) => sum + (g.MonthlyPremium || 0), 0);
    const averageGroupSize = totalGroups > 0 ? totalMembers / totalGroups : 0;

    return {
      totalGroups,
      enrolledGroups,
      activeGroups,
      inactiveGroups,
      totalMembers,
      totalRevenue,
      averageGroupSize,
    };
  };

  // API Functions
  const fetchGroups = async () => {
    try {
      setLoading(true);
      
      // Ensure we have tenantId before fetching groups
      const tenantId = userTenantId || await fetchUserTenantId();
      
      console.log('📋 Fetching groups for tenant:', tenantId);
      
      const [response, metricsResponse] = await Promise.all([
        TenantAdminService.getTenantGroups(),
        TenantAdminService.getTenantMetrics(),
      ]);
      
      if (response.success && response.data) {
        const enrolledGroups =
          metricsResponse.success && metricsResponse.data
            ? metricsResponse.data.groupCount
            : 0;
        setGroups(response.data);
        setStats(calculateStats(response.data, enrolledGroups));
        console.log('✅ Successfully loaded groups:', response.data.length);
      } else {
        const errorMessage = typeof response.error === 'string' ? response.error : response.error?.message || 'Failed to fetch groups';
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to load groups', 'error', 'Error');
    } finally {
      setLoading(false);
    }
  };

  const createGroup = async (groupData: CreateGroupData) => {
    try {
      // Ensure we have tenantId before creating group
      const tenantId = userTenantId || await fetchUserTenantId();
      
      console.log('📋 Creating group for tenant:', tenantId);
      
      const response = await TenantAdminService.createTenantGroup({
        name: groupData.name,
        contactEmail: groupData.adminEmail,
        primaryContact: groupData.adminName,
        contactPhone: groupData.adminPhone,
        taxIdNumber: groupData.ein,
      });

      if (response.success) {
        showSnackbar('Group created successfully', 'success', 'Success');
        fetchGroups();
        setAddDialogOpen(false);
        resetCreateForm();
      } else {
        const errorMessage = typeof response.error === 'string' ? response.error : response.error?.message || 'Failed to create group';
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error creating group:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to create group', 'error', 'Error');
    }
  };

  const updateGroup = async (groupData: EditGroupData) => {
    try {
      // Ensure we have tenantId before updating group
      const tenantId = userTenantId || await fetchUserTenantId();
      
      console.log('📋 Updating group for tenant:', tenantId);
      
      const response = await TenantAdminService.updateTenantGroup(groupData.groupId, {
        name: groupData.name,
        primaryContact: groupData.adminName,
        contactEmail: groupData.adminEmail,
        contactPhone: groupData.adminPhone,
        taxIdNumber: groupData.ein,
        status: groupData.status as 'Active' | 'Inactive',
      });

      if (response.success) {
        showSnackbar('Group updated successfully', 'success', 'Success');
        fetchGroups();
        setEditDialogOpen(false);
      } else {
        const errorMessage = typeof response.error === 'string' ? response.error : response.error?.message || 'Failed to update group';
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error updating group:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to update group', 'error', 'Error');
    }
  };

  const archiveGroup = async (groupId: string) => {
    try {
      const group = groups.find(g => g.GroupId === groupId);
      if (group && group.TotalMembers > 0) {
        showSnackbar('Cannot archive group with active members', 'error', 'Error');
        return;
      }

      // Ensure we have tenantId before archiving group
      const tenantId = userTenantId || await fetchUserTenantId();
      
      console.log('📋 Archiving group for tenant:', tenantId);
      
      const response = await TenantAdminService.updateTenantGroup(groupId, {
        status: 'Inactive', // Use 'Inactive' instead of 'Archived' since that's what the type allows
      });

      if (response.success) {
        showSnackbar('Group archived successfully', 'success', 'Success');
        fetchGroups();
      } else {
        const errorMessage = typeof response.error === 'string' ? response.error : response.error?.message || 'Failed to archive group';
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error archiving group:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to archive group', 'error', 'Error');
    }
  };

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info', title?: string) => {
    setSnackbar({ open: true, message, severity, title });
  };

  const resetCreateForm = () => {
    setCreateFormData({
      name: '',
      ein: '',
      adminName: '',
      adminEmail: '',
      adminPhone: '',
      billingType: 'Monthly',
    });
  };

  const handleViewGroup = (groupId: string) => {
    navigate(`/tenant-admin/groups/${groupId}`);
  };

  const handleEditGroup = (group: TenantGroup) => {
    setEditFormData({
      groupId: group.GroupId,
      name: group.Name,
      ein: group.TaxIdNumber || '',
      adminName: group.PrimaryContact || '',
      adminEmail: group.ContactEmail || '',
      adminPhone: group.ContactPhone || '',
      billingType: 'Monthly', // Default value since it's not in the API
      status: group.Status === 'Pending' ? 'Active' : group.Status as 'Active' | 'Inactive' | 'Archived',
    });
    setEditDialogOpen(true);
  };

  const handleMenuClick = (event: React.MouseEvent<HTMLElement>, groupId: string) => {
    setAnchorEl(event.currentTarget);
    setSelectedGroupId(groupId);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedGroupId(null);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'success';
      case 'Inactive':
        return 'warning';
      case 'Archived':
        return 'error';
      default:
        return 'default';
    }
  };

  const getBillingTypeColor = (billingType: string) => {
    switch (billingType) {
      case 'Monthly':
        return '#1f8dbf';
      case 'Quarterly':
        return '#f59e0b';
      case 'Annual':
        return '#10b981';
      default:
        return '#6b7280';
    }
  };

  // DataGrid columns
  const columns: GridColDef[] = [
    {
      field: 'Name',
      headerName: 'Group Name',
      flex: 1,
      minWidth: 220,
      renderCell: (params: GridRenderCellParams) => (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ height: '100%' }}>
          <BusinessIcon 
            sx={{ 
              color: '#1f8dbf',
              fontSize: '1.2rem',
            }} 
          />
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, color: theme.palette.text.primary }}>
              {params.value}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    {
      field: 'Status',
      headerName: 'Status',
      width: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Chip
            label={params.value}
            color={getStatusColor(params.value) as any}
            size="small"
            sx={{ fontWeight: 500 }}
          />
        </Box>
      ),
    },
    {
      field: 'PrimaryContact',
      headerName: 'Administrator',
      minWidth: 180,
      flex: 0.8,
      renderCell: (params: GridRenderCellParams) => (
        <Stack spacing={0.5} sx={{ height: '100%', justifyContent: 'center' }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {params.row.PrimaryContact || 'Not assigned'}
          </Typography>
          {params.row.ContactEmail && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <EmailIcon sx={{ fontSize: '0.75rem', color: theme.palette.text.secondary }} />
              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                {params.row.ContactEmail}
              </Typography>
            </Stack>
          )}
        </Stack>
      ),
    },
    {
      field: 'TotalMembers',
      headerName: 'Members',
      width: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ height: '100%' }}>
          <PeopleIcon sx={{ color: theme.palette.action.active, fontSize: '1rem' }} />
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {params.value || 0}
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'BillingType',
      headerName: 'Billing',
      width: 100,
      renderCell: (_params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Chip
            label="Monthly" // Default value since billing type is not in the API
            size="small"
            variant="outlined"
            sx={{ 
              color: getBillingTypeColor('Monthly'),
              borderColor: getBillingTypeColor('Monthly'),
              fontWeight: 500,
            }}
          />
        </Box>
      ),
    },
    {
      field: 'MonthlyPremium',
      headerName: 'Monthly Premium',
      width: 140,
      renderCell: (params: GridRenderCellParams) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
          <MoneyIcon sx={{ color: '#10b981', fontSize: '0.9rem' }} />
          <Typography variant="body2" sx={{ fontWeight: 600, color: '#10b981' }}>
            ${params.value?.toLocaleString() || '0'}
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'CreatedDate',
      headerName: 'Created',
      width: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ height: '100%' }}>
          <CalendarIcon sx={{ color: theme.palette.text.secondary, fontSize: '0.8rem' }} />
          <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
            {format(new Date(params.value), 'MMM dd, yyyy')}
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 80,
      sortable: false,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Tooltip title="More actions">
            <IconButton
              onClick={(e) => handleMenuClick(e, params.row.GroupId)}
              size="small"
              sx={{
                '&:hover': {
                  backgroundColor: alpha('#1f8dbf', 0.1),
                },
              }}
            >
              <MoreVertIcon />
            </IconButton>
          </Tooltip>
        </Box>
      ),
    },
  ];

  // Effects
  useEffect(() => {
    // Initialize by fetching tenant ID and then groups
    const initializePage = async () => {
      try {
        await fetchUserTenantId();
        await fetchGroups();
      } catch (error) {
        console.error('Error initializing page:', error);
        showSnackbar('Failed to initialize page', 'error', 'Error');
      }
    };

    initializePage();
  }, []);

  // Show loading spinner while fetching tenant ID
  if (loading && !userTenantId) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
        <Typography>Loading tenant information...</Typography>
      </Box>
    );
  }

  // Show error if no tenant ID could be retrieved
  if (!userTenantId && !loading) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ borderRadius: 2 }}>
          Unable to retrieve tenant information. Please refresh the page or contact support.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ 
      p: 3, 
      height: '100vh', 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <Grid container spacing={3} alignItems="center" sx={{ mb: 4, flexShrink: 0 }}>
        <Grid size="grow">
          <Typography variant="h4" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
            Groups Management
          </Typography>
          <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
            Manage group enrollment and administration
          </Typography>
        </Grid>
        <Grid size="auto">
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setAddDialogOpen(true)}
            sx={{
              bgcolor: '#1f8dbf',
              '&:hover': {
                bgcolor: '#175a7a',
              },
              borderRadius: 2,
              px: 3,
              py: 1.5,
              textTransform: 'none',
              fontWeight: 600,
            }}
          >
            Add Group
          </Button>
        </Grid>
      </Grid>

      {/* Stats Cards */}
      <Grid container spacing={3} sx={{ mb: 4, flexShrink: 0 }}>
        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#1f8dbf', 0.05),
              border: `1px solid ${alpha('#1f8dbf', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#1f8dbf',
                    color: 'white',
                  }}
                >
                  <BusinessIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    {stats.enrolledGroups.toLocaleString()} / {stats.totalGroups.toLocaleString()}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block' }}>
                    Enrolled / Total groups
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#10b981', 0.05),
              border: `1px solid ${alpha('#10b981', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#10b981',
                    color: 'white',
                  }}
                >
                  <TrendingUpIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    {stats.activeGroups}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    Active Groups
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#f59e0b', 0.05),
              border: `1px solid ${alpha('#f59e0b', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#f59e0b',
                    color: 'white',
                  }}
                >
                  <BusinessIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    {stats.inactiveGroups}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    Inactive Groups
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#3b82f6', 0.05),
              border: `1px solid ${alpha('#3b82f6', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#3b82f6',
                    color: 'white',
                  }}
                >
                  <PeopleIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    {stats.totalMembers}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    Total Members
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#10b981', 0.05),
              border: `1px solid ${alpha('#10b981', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#10b981',
                    color: 'white',
                  }}
                >
                  <MoneyIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    ${stats.totalRevenue.toLocaleString()}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    Monthly Revenue
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 2 }}>
          <Card 
            sx={{ 
              bgcolor: alpha('#8b5cf6', 0.05),
              border: `1px solid ${alpha('#8b5cf6', 0.1)}`,
              borderRadius: 2,
            }}
          >
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: '#8b5cf6',
                    color: 'white',
                  }}
                >
                  <AssessmentIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    {stats.averageGroupSize.toFixed(1)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    Avg Group Size
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* DataGrid - Now with proper flex layout */}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Paper 
          sx={{ 
            borderRadius: 2,
            border: `1px solid ${theme.palette.divider}`,
            overflow: 'hidden',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <DataGrid
            rows={groups}
            columns={columns}
            loading={loading}
            getRowId={(row) => row.GroupId}
            initialState={{
              pagination: {
                paginationModel: { pageSize: 10 },
              },
            }}
            pageSizeOptions={[10, 25, 50]}
            disableRowSelectionOnClick
            slots={{ toolbar: GridToolbar }}
            slotProps={{
              toolbar: {
                showQuickFilter: true,
                quickFilterProps: { debounceMs: 500 },
              },
            }}
            sx={{
              flex: 1,
              border: 'none',
              '& .MuiDataGrid-columnHeader': {
                backgroundColor: alpha('#1f8dbf', 0.05),
                borderBottom: `1px solid ${theme.palette.divider}`,
                color: theme.palette.text.primary,
                fontWeight: 600,
              },
              '& .MuiDataGrid-cell': {
                borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
              },
              '& .MuiDataGrid-row': {
                '&:hover': {
                  backgroundColor: alpha('#1f8dbf', 0.02),
                },
              },
              '& .MuiDataGrid-footerContainer': {
                borderTop: `1px solid ${theme.palette.divider}`,
                backgroundColor: alpha('#1f8dbf', 0.02),
                minHeight: 52,
              },
              '& .MuiDataGrid-virtualScroller': {
                // Ensure proper scrolling behavior
                overflowY: 'auto',
              },
              '& .MuiDataGrid-main': {
                // Ensure main content area respects container height
                minHeight: 0,
              },
            }}
          />
        </Paper>
      </Box>

      {/* Actions Menu */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleMenuClose}
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: theme.shadows[8],
            border: `1px solid ${theme.palette.divider}`,
          },
        }}
      >
        <MenuItem 
          onClick={() => {
            if (selectedGroupId) {
              handleViewGroup(selectedGroupId);
              handleMenuClose();
            }
          }}
          sx={{ minWidth: 150 }}
        >
          <ViewIcon sx={{ mr: 1.5, color: '#1f8dbf' }} />
          View Details
        </MenuItem>
        <MenuItem 
          onClick={() => {
            const group = groups.find(g => g.GroupId === selectedGroupId);
            if (group && group.Status !== 'Inactive') {
              handleEditGroup(group);
              handleMenuClose();
            }
          }}
          disabled={groups.find(g => g.GroupId === selectedGroupId)?.Status === 'Inactive'}
        >
          <EditIcon sx={{ mr: 1.5, color: '#f59e0b' }} />
          Edit Group
        </MenuItem>
        <Divider />
        <MenuItem 
          onClick={() => {
            if (selectedGroupId) {
              archiveGroup(selectedGroupId);
              handleMenuClose();
            }
          }}
          disabled={groups.find(g => g.GroupId === selectedGroupId)?.Status === 'Inactive'}
          sx={{ color: '#ef4444' }}
        >
          <ArchiveIcon sx={{ mr: 1.5 }} />
          Archive Group
        </MenuItem>
      </Menu>

      {/* Add Group Dialog - FIXED: Removed nested Typography from DialogTitle */}
      <Dialog 
        open={addDialogOpen} 
        onClose={() => setAddDialogOpen(false)} 
        maxWidth="md" 
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: theme.shadows[24],
          },
        }}
      >
        <DialogTitle sx={{ pb: 1, fontWeight: 600 }}>
          Add New Group
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={3} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Group Name"
                value={createFormData.name}
                onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
                fullWidth
                required
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="EIN"
                value={createFormData.ein}
                onChange={(e) => setCreateFormData({ ...createFormData, ein: e.target.value })}
                fullWidth
                placeholder="XX-XXXXXXX"
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Name"
                value={createFormData.adminName}
                onChange={(e) => setCreateFormData({ ...createFormData, adminName: e.target.value })}
                fullWidth
                required
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Email"
                type="email"
                value={createFormData.adminEmail}
                onChange={(e) => setCreateFormData({ ...createFormData, adminEmail: e.target.value })}
                fullWidth
                required
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Phone"
                value={createFormData.adminPhone}
                onChange={(e) => setCreateFormData({ ...createFormData, adminPhone: e.target.value })}
                fullWidth
                placeholder="(555) 123-4567"
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <FormControl fullWidth required variant="outlined" sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: '#1f8dbf',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: '#1f8dbf',
                },
              }}>
                <InputLabel>Billing Type</InputLabel>
                <Select
                  value={createFormData.billingType}
                  onChange={(e) => setCreateFormData({ ...createFormData, billingType: e.target.value as any })}
                  label="Billing Type"
                >
                  <MenuItem value="Monthly">Monthly</MenuItem>
                  <MenuItem value="Quarterly">Quarterly</MenuItem>
                  <MenuItem value="Annual">Annual</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={() => setAddDialogOpen(false)}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => createGroup(createFormData)}
            variant="contained"
            disabled={!createFormData.name || !createFormData.adminName || !createFormData.adminEmail}
            sx={{ 
              textTransform: 'none', 
              fontWeight: 600,
              bgcolor: '#1f8dbf',
              '&:hover': {
                bgcolor: '#175a7a',
              },
            }}
          >
            Create Group
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Group Dialog - FIXED: Removed nested Typography from DialogTitle */}
      <Dialog 
        open={editDialogOpen} 
        onClose={() => setEditDialogOpen(false)} 
        maxWidth="md" 
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: theme.shadows[24],
          },
        }}
      >
        <DialogTitle sx={{ pb: 1, fontWeight: 600 }}>
          Edit Group
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={3} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Group Name"
                value={editFormData.name}
                onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                fullWidth
                required
                disabled={editFormData.status === 'Archived'}
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="EIN"
                value={editFormData.ein}
                onChange={(e) => setEditFormData({ ...editFormData, ein: e.target.value })}
                fullWidth
                placeholder="XX-XXXXXXX"
                disabled={editFormData.status === 'Archived'}
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Name"
                value={editFormData.adminName}
                onChange={(e) => setEditFormData({ ...editFormData, adminName: e.target.value })}
                fullWidth
                required
                disabled={editFormData.status === 'Archived'}
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Email"
                type="email"
                value={editFormData.adminEmail}
                onChange={(e) => setEditFormData({ ...editFormData, adminEmail: e.target.value })}
                fullWidth
                required
                disabled={editFormData.status === 'Archived'}
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Admin Phone"
                value={editFormData.adminPhone}
                onChange={(e) => setEditFormData({ ...editFormData, adminPhone: e.target.value })}
                fullWidth
                placeholder="(555) 123-4567"
                disabled={editFormData.status === 'Archived'}
                variant="outlined"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#1f8dbf',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <FormControl fullWidth required variant="outlined" sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: '#1f8dbf',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: '#1f8dbf',
                },
              }}>
                <InputLabel>Billing Type</InputLabel>
                <Select
                  value={editFormData.billingType}
                  onChange={(e) => setEditFormData({ ...editFormData, billingType: e.target.value as any })}
                  disabled={editFormData.status === 'Archived'}
                  label="Billing Type"
                >
                  <MenuItem value="Monthly">Monthly</MenuItem>
                  <MenuItem value="Quarterly">Quarterly</MenuItem>
                  <MenuItem value="Annual">Annual</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <FormControl fullWidth variant="outlined" sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: '#1f8dbf',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: '#1f8dbf',
                },
              }}>
                <InputLabel>Status</InputLabel>
                <Select
                  value={editFormData.status}
                  onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value as any })}
                  disabled={editFormData.status === 'Archived'}
                  label="Status"
                >
                  <MenuItem value="Active">Active</MenuItem>
                  <MenuItem value="Inactive">Inactive</MenuItem>
                  <MenuItem value="Archived">Archived</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={() => setEditDialogOpen(false)}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => updateGroup(editFormData)}
            variant="contained"
            disabled={!editFormData.name || !editFormData.adminName || !editFormData.adminEmail}
            sx={{ 
              textTransform: 'none', 
              fontWeight: 600,
              bgcolor: '#1f8dbf',
              '&:hover': {
                bgcolor: '#175a7a',
              },
            }}
          >
            Update Group
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        TransitionComponent={SlideTransition}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert 
          onClose={() => setSnackbar({ ...snackbar, open: false })} 
          severity={snackbar.severity}
          sx={{ 
            borderRadius: 2,
            boxShadow: 3,
            '& .MuiAlert-icon': {
              fontSize: '1.5rem'
            }
          }}
          variant="filled"
          elevation={6}
        >
          {snackbar.title && <AlertTitle>{snackbar.title}</AlertTitle>}
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default TenantGroups;