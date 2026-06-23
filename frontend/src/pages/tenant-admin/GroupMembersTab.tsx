// frontend/src/components/tenant-admin/GroupMembersTab.tsx
import {
    Add as AddIcon,
    Business as BusinessIcon,
    Delete as DeleteIcon,
    Edit as EditIcon,
    Email as EmailIcon,
    MoreVert as MoreVertIcon,
    Person as PersonIcon,
    Phone as PhoneIcon,
    Send as SendIcon,
    Upload as UploadIcon,
} from '@mui/icons-material';
import {
    Alert,
    AlertTitle,
    alpha,
    Autocomplete,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    InputLabel,
    Menu,
    MenuItem,
    Paper,
    Select,
    Slide,
    SlideProps,
    Snackbar,
    Stack,
    TextField,
    Tooltip,
    Typography,
    useTheme,
} from '@mui/material';
import {
    DataGrid,
    GridColDef,
    GridRenderCellParams,
    GridToolbar,
} from '@mui/x-data-grid';
import { format } from 'date-fns';
import React, { useEffect, useState } from 'react';
import { useBranding } from '../../contexts/BrandingContext';
import { GroupsService } from '../../services/groups.service';
import { MembersService } from '../../services/members.service';
import type { Member } from '../../types/member.types';
import { apiService } from '../../services/api.service';
import { getJobPositionLabel } from '../../constants/jobPositions';

// Types

interface CreateMemberData {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  dateOfBirth: string;
  gender: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  workLocation: string;
  relationshipType: 'P' | 'S' | 'C';
  householdId?: string;
}

interface GroupMembersTabProps {
  groupId: string;
  groupName: string;
}

// Slide transition for Snackbar
function SlideTransition(props: SlideProps) {
  return <Slide {...props} direction="down" />;
}

const US_STATES = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' }
];

const GroupMembersTab: React.FC<GroupMembersTabProps> = ({ groupId, groupName }) => {
  const theme = useTheme();
  
  // State
  const { colors } = useBranding();
  const [members, setMembers] = useState<Member[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [sendLinksDialogOpen, setSendLinksDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
    title: '' as string | undefined,
  });

  // Locations state
  const [locations, setLocations] = useState<Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string }>>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);

  // Fetch locations when groupId is available
  React.useEffect(() => {
    const fetchLocations = async () => {
      if (!groupId) return;
      try {
        setLocationsLoading(true);
        const response = await apiService.get<{ success: boolean; data: Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string }> }>(
          `/api/groups/${groupId}/locations`
        );
        if (response.success && response.data) {
          setLocations(response.data);
        }
      } catch (error) {
        console.error('Error fetching locations:', error);
        setLocations([]);
      } finally {
        setLocationsLoading(false);
      }
    };
    fetchLocations();
  }, [groupId]);

  // Form data
  const [createFormData, setCreateFormData] = useState<CreateMemberData & { locationId?: string }>({
    firstName: '',
    lastName: '',
    email: '',
    phoneNumber: '',
    dateOfBirth: '',
    gender: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    workLocation: '',
    locationId: '',
    relationshipType: 'P',
  });

  const [editFormData, setEditFormData] = useState<CreateMemberData & { memberId: string; locationId?: string }>({
    memberId: '',
    firstName: '',
    lastName: '',
    email: '',
    phoneNumber: '',
    dateOfBirth: '',
    gender: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    workLocation: '',
    locationId: '',
    relationshipType: 'P',
  });

  // API Functions
  const fetchMembers = async () => {
    try {
      setLoading(true);
      
      // Use the tenant-admin specific endpoint for group members
      const data = await GroupsService.getGroupMembers(groupId);

      if (data.success) {
        setMembers(data.data?.members || []);
        setStatusCounts(data.data?.statusCounts || {});
        console.log('✅ Successfully loaded members for group:', data.data?.members?.length || 0);
        console.log('✅ Status counts:', data.data?.statusCounts);
      } else {
        throw new Error(data.message || 'Failed to fetch members');
      }
    } catch (error) {
      console.error('Error fetching members:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to load members', 'error', 'Error');
    } finally {
      setLoading(false);
    }
  };

  const createMember = async (memberData: CreateMemberData) => {
    try {
      // Use MembersService instead of direct fetch
      const response = await MembersService.createMember({
        ...memberData,
        groupId: groupId, // Add groupId to the member data
      });

      if (response.success) {
        showSnackbar('Member created successfully', 'success', 'Success');
        fetchMembers();
        setAddDialogOpen(false);
        resetCreateForm();
      } else {
        throw new Error(response.message || 'Failed to create member');
      }
    } catch (error) {
      console.error('Error creating member:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to create member', 'error', 'Error');
    }
  };

  const updateMember = async (memberData: CreateMemberData & { memberId: string }) => {
    try {
      const { memberId, ...updateData } = memberData;
      
      // Use MembersService
      const data = await MembersService.updateMember(memberId, updateData);

      if (data.success) {
        showSnackbar('Member updated successfully', 'success', 'Success');
        fetchMembers();
        setEditDialogOpen(false);
      } else {
        throw new Error(data.message || 'Failed to update member');
      }
    } catch (error) {
      console.error('Error updating member:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to update member', 'error', 'Error');
    }
  };

  const terminateMember = async (memberId: string) => {
    try {
      // Use MembersService to terminate member
      const data = await MembersService.terminateMember(memberId);

      if (data.success) {
        showSnackbar('Member terminated successfully', 'success', 'Success');
        fetchMembers();
      } else {
        throw new Error(data.message || 'Failed to terminate member');
      }
    } catch (error) {
      console.error('Error terminating member:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to terminate member', 'error', 'Error');
    }
  };

  const importMembers = async (file: File) => {
    try {
      // TODO: Implement backend API for /api/groups/:groupId/members/import
      showSnackbar('Import functionality not yet implemented in backend', 'warning', 'Warning');
      setImportDialogOpen(false);
      setSelectedFile(null);
    } catch (error) {
      console.error('Error importing members:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to import members', 'error', 'Error');
    }
  };

  const sendEnrollmentLinks = async (memberIds: string[]) => {
    try {
      // TODO: Implement backend API for /api/groups/:groupId/send-enrollment-links
      showSnackbar('Send enrollment links functionality not yet implemented in backend', 'warning', 'Warning');
      setSendLinksDialogOpen(false);
    } catch (error) {
      console.error('Error sending enrollment links:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to send enrollment links', 'error', 'Error');
    }
  };

  const downloadTemplate = () => {
    // Create Excel template download
    const templateData = [
      ['First Name', 'Last Name', 'Email', 'Phone', 'Date of Birth (YYYY-MM-DD)', 'Gender', 'Address', 'City', 'State', 'ZIP', 'Relationship (P/S/C)'],
      ['John', 'Doe', 'john.doe@company.com', '555-123-4567', '1985-03-15', 'Male', '123 Main St', 'Anytown', 'TX', '75001', 'P'],
      ['Jane', 'Doe', 'jane.doe@company.com', '555-123-4568', '1987-08-22', 'Female', '123 Main St', 'Anytown', 'TX', '75001', 'S'],
    ];

    const csvContent = templateData.map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${groupName}_member_template.csv`;
    link.click();
    window.URL.revokeObjectURL(url);
  };

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info', title?: string) => {
    setSnackbar({ open: true, message, severity, title });
  };

  const resetCreateForm = () => {
    setCreateFormData({
      firstName: '',
      lastName: '',
      email: '',
      phoneNumber: '',
      dateOfBirth: '',
      gender: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      workLocation: '',
      relationshipType: 'P',
    });
  };

  const handleEditMember = (member: Member) => {
    setEditFormData({
      memberId: member.MemberId,
      firstName: member.FirstName,
      lastName: member.LastName,
      email: member.Email,
      phoneNumber: member.PhoneNumber || '',
      dateOfBirth: member.DateOfBirth ? format(new Date(member.DateOfBirth), 'yyyy-MM-dd') : '',
      gender: member.Gender || '',
      address: member.Address || '',
      city: member.City || '',
      state: member.State || '',
      zip: member.Zip || '',
      workLocation: member.WorkLocation || '',
      locationId: (member as any).LocationId || '',
      relationshipType: member.RelationshipType,
    });
    setEditDialogOpen(true);
  };

  const handleMenuClick = (event: React.MouseEvent<HTMLElement>, memberId: string) => {
    setAnchorEl(event.currentTarget);
    setSelectedMemberId(memberId);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedMemberId(null);
  };



  const formatCurrency = (amount: number | null | undefined): string => {
    if (amount === null || amount === undefined || isNaN(amount)) {
      return '$0';
    }
    return `$${amount.toLocaleString()}`;
  };

  // DataGrid columns
  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: 'Member Name',
      flex: 1,
      minWidth: 200,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          height: '100%', 
          width: '100%',
          py: 1
        }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
            <PersonIcon 
              sx={{ 
                color: 'var(--oe-primary)',
                fontSize: '1.2rem',
                flexShrink: 0
              }} 
            />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography 
                variant="body2" 
                sx={{ 
                  fontWeight: 600, 
                  color: theme.palette.text.primary,
                  lineHeight: 1.2
                }}
              >
                {`${params.row.FirstName} ${params.row.LastName} (${params.row.RelationshipDescription})`}
              </Typography>
            </Box>
          </Stack>
        </Box>
      ),
    },
    {
      field: 'JobPosition',
      headerName: 'Job Position',
      width: 180,
      minWidth: 150,
      sortable: true,
      filterable: true,
      hideable: true,
      valueGetter: (value, row) => row.JobPosition || '',
      renderCell: (params: GridRenderCellParams) => {
        const jobPosition = params.row.JobPosition || params.value;
        const jobPositionLabel = getJobPositionLabel(jobPosition);
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', height: '100%', width: '100%', px: 1 }}>
            <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontWeight: 500 }}>
              {jobPositionLabel || '-'}
            </Typography>
          </Box>
        );
      },
    },
    {
      field: 'EnrollmentStatus',
      headerName: 'Enrollment Status',
      width: 200,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Chip
            label={params.value}
            color={params.row.EnrollmentStatusColor as any}
            size="small"
            variant="filled"
            sx={{ 
              fontWeight: 600,
              minWidth: 120,
              '& .MuiChip-label': {
                fontSize: '0.75rem',
                px: 1,
              }
            }}
          />
        </Box>
      ),
    },
    {
      field: 'Email',
      headerName: 'Contact',
      minWidth: 220,
      flex: 1,
      renderCell: (params: GridRenderCellParams) => (
        <Stack spacing={0.5} sx={{ height: '100%', justifyContent: 'center' }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <EmailIcon sx={{ fontSize: '0.75rem', color: theme.palette.text.secondary }} />
            <Typography variant="body2" sx={{ color: 'var(--oe-primary)' }}>
              {params.value}
            </Typography>
          </Stack>
          {params.row.PhoneNumber && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <PhoneIcon sx={{ fontSize: '0.75rem', color: theme.palette.text.secondary }} />
              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                {params.row.PhoneNumber}
              </Typography>
            </Stack>
          )}
        </Stack>
      ),
    },

    {
      field: 'TotalEnrollments',
      headerName: 'Enrollments',
      width: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ height: '100%' }}>
          <BusinessIcon sx={{ color: theme.palette.action.active, fontSize: '1rem' }} />
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {params.row.ActiveEnrollments}/{params.value}
          </Typography>
        </Stack>
      ),
    },
    {
      field: 'MonthlyPremium',
      headerName: 'Monthly Premium',
      width: 140,
      renderCell: (params: GridRenderCellParams) => (
        <Typography variant="body2" sx={{ fontWeight: 600, color: '#10b981' }}>
          {formatCurrency(params.value)}
        </Typography>
      ),
    },
    {
      field: 'CreatedDate',
      headerName: 'Added',
      width: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
          {format(new Date(params.value), 'MMM dd, yyyy')}
        </Typography>
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
              onClick={(e) => handleMenuClick(e, params.row.MemberId)}
              size="small"
              sx={{
                '&:hover': {
                  backgroundColor: alpha(colors.primary, 0.1),
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

  // Debug: Log columns to verify JobPosition is included
  useEffect(() => {
    console.log('📊 DataGrid Columns:', columns.map(c => ({ field: c.field, headerName: c.headerName })));
  }, []);

  // Effects
  useEffect(() => {
    fetchMembers();
  }, [groupId]);

  return (
    <Box>
      {/* Header */}
      <Grid container spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <Grid size="grow">
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Group Members
          </Typography>
        </Grid>
        <Grid size="auto">
          <Stack direction="row" spacing={1}>
            {/* window.location.hostname === 'localhost' && (
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={downloadTemplate}
                sx={{
                  textTransform: 'none',
                  borderColor: '#d1d5db',
                  color: '#374151',
                  '&:hover': {
                    borderColor: '#9ca3af',
                    backgroundColor: '#f9fafb',
                  }
                }}
              >
                Template
              </Button>
            ) */}
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => setImportDialogOpen(true)}
              sx={{ 
                textTransform: 'none',
                borderColor: '#d1d5db',
                color: '#374151',
                '&:hover': {
                  borderColor: '#9ca3af',
                  backgroundColor: '#f9fafb',
                }
              }}
            >
              Import
            </Button>
            <Button
              variant="outlined"
              startIcon={<SendIcon />}
              onClick={() => setSendLinksDialogOpen(true)}
              disabled={members.filter(m => m.Status === 'Active').length === 0}
              sx={{ 
                textTransform: 'none',
                borderColor: '#d1d5db',
                color: '#374151',
                '&:hover': {
                  borderColor: '#9ca3af',
                  backgroundColor: '#f9fafb',
                }
              }}
            >
              Send Links
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setAddDialogOpen(true)}
              sx={{ 
                textTransform: 'none',
                bgcolor: 'var(--oe-primary)',
                '&:hover': {
                  bgcolor: 'var(--oe-primary-dark)',
                },
              }}
            >
              Add Member
            </Button>
          </Stack>
        </Grid>
      </Grid>

      {/* Enrollment Status Summary */}
      {Object.keys(statusCounts).length > 0 && (
        <Box sx={{ mb: 3 }}>
          <Paper 
            sx={{ 
              p: 2, 
              borderRadius: 2,
              border: `1px solid ${theme.palette.divider}`,
              bgcolor: alpha(colors.primary, 0.02)
            }}
          >
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2, color: theme.palette.text.primary }}>
              Enrollment Status Summary
            </Typography>
            <Grid container spacing={2}>
              {['Active', 'Pending Approval', 'Enrollment Link Sent', 'Enrollment Link Used', 'Not Enrolled'].map((status) => {
                const count = statusCounts[status] || 0;
                if (count === 0) return null;
                
                // Get color from the first member with this status, or use default
                const statusColor = members.find(m => m.EnrollmentStatus === status)?.EnrollmentStatusColor || 'default';
                
                return (
                  <Grid size="auto" key={status}>
                    <Chip
                      label={`${status}: ${count}`}
                      color={statusColor as any}
                      size="small"
                      variant="outlined"
                      sx={{ fontWeight: 500 }}
                    />
                  </Grid>
                );
              })}
            </Grid>
          </Paper>
        </Box>
      )}

      {/* DataGrid */}
      <Paper 
        sx={{ 
          borderRadius: 2,
          border: `1px solid ${theme.palette.divider}`,
          overflow: 'hidden',
          height: 600,
        }}
      >
        <DataGrid
          rows={members}
          columns={columns}
          loading={loading}
          getRowId={(row) => row.MemberId}
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
            border: 'none',
            '& .MuiDataGrid-columnHeader': {
              backgroundColor: alpha(colors.primary, 0.05),
              borderBottom: `1px solid ${theme.palette.divider}`,
              color: theme.palette.text.primary,
              fontWeight: 600,
            },
            '& .MuiDataGrid-cell': {
              borderBottom: `1px solid ${alpha(theme.palette.divider, 0.5)}`,
            },
            '& .MuiDataGrid-row': {
              '&:hover': {
                backgroundColor: alpha(colors.primary, 0.02),
              },
            },
            '& .MuiDataGrid-footerContainer': {
              borderTop: `1px solid ${theme.palette.divider}`,
              backgroundColor: alpha(colors.primary, 0.02),
            },
          }}
        />
      </Paper>

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
            const member = members.find(m => m.MemberId === selectedMemberId);
            if (member) {
              handleEditMember(member);
              handleMenuClose();
            }
          }}
          sx={{ minWidth: 150 }}
        >
          <EditIcon sx={{ mr: 1.5, color: 'var(--oe-primary)' }} />
          Edit Member
        </MenuItem>
        <MenuItem 
          onClick={() => {
            if (selectedMemberId) {
              terminateMember(selectedMemberId);
              handleMenuClose();
            }
          }}
          sx={{ color: '#ef4444' }}
        >
          <DeleteIcon sx={{ mr: 1.5 }} />
          Terminate
        </MenuItem>
      </Menu>

      {/* Add Member Dialog */}
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
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Add New Member
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="First Name"
                value={createFormData.firstName}
                onChange={(e) => setCreateFormData({ ...createFormData, firstName: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Last Name"
                value={createFormData.lastName}
                onChange={(e) => setCreateFormData({ ...createFormData, lastName: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Email"
                type="email"
                value={createFormData.email}
                onChange={(e) => setCreateFormData({ ...createFormData, email: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Phone Number"
                value={createFormData.phoneNumber}
                onChange={(e) => setCreateFormData({ ...createFormData, phoneNumber: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Date of Birth"
                type="date"
                value={createFormData.dateOfBirth}
                onChange={(e) => setCreateFormData({ ...createFormData, dateOfBirth: e.target.value })}
                fullWidth
                InputLabelProps={{ shrink: true }}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <FormControl fullWidth sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>Gender</InputLabel>
                <Select
                  value={createFormData.gender}
                  onChange={(e) => setCreateFormData({ ...createFormData, gender: e.target.value })}
                  label="Gender"
                >
                  <MenuItem value="Male">Male</MenuItem>
                  <MenuItem value="Female">Female</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <TextField
                label="Address"
                value={createFormData.address}
                onChange={(e) => setCreateFormData({ ...createFormData, address: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="City"
                value={createFormData.city}
                onChange={(e) => setCreateFormData({ ...createFormData, city: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <FormControl fullWidth sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>State</InputLabel>
                <Select
                  value={createFormData.state}
                  onChange={(e) => setCreateFormData({ ...createFormData, state: e.target.value })}
                  label="State"
                >
                  {US_STATES.map((state) => (
                    <MenuItem key={state.code} value={state.code}>
                      {state.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="ZIP Code"
                value={createFormData.zip}
                onChange={(e) => setCreateFormData({ ...createFormData, zip: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={12}>
              <Autocomplete
                options={locations}
                getOptionLabel={(option) => {
                  const locationName = option.Name || 'Unnamed Location';
                  const address = `${option.City}, ${option.State}`;
                  return `${locationName} - ${address}`;
                }}
                loading={locationsLoading}
                value={locations.find(loc => loc.LocationId === createFormData.locationId) || null}
                onChange={(_, newValue) => {
                  setCreateFormData({
                    ...createFormData,
                    locationId: newValue?.LocationId || '',
                    workLocation: newValue ? (newValue.Name || `${newValue.City}, ${newValue.State}`) : ''
                  });
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Work Location / Branch"
                    placeholder="Search for a location..."
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: 'var(--oe-primary)',
                        },
                      },
                      '& .MuiInputLabel-root.Mui-focused': {
                        color: 'var(--oe-primary)',
                      },
                    }}
                  />
                )}
                noOptionsText={locationsLoading ? "Loading locations..." : "No locations found"}
                fullWidth
              />
            </Grid>
            <Grid size={12}>
              <FormControl fullWidth required sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>Relationship</InputLabel>
                <Select
                  value={createFormData.relationshipType}
                  onChange={(e) => setCreateFormData({ ...createFormData, relationshipType: e.target.value as 'P' | 'S' | 'C' })}
                  label="Relationship"
                >
                  <MenuItem value="P">Primary (Employee)</MenuItem>
                  <MenuItem value="S">Spouse</MenuItem>
                  <MenuItem value="C">Child</MenuItem>
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
            onClick={() => createMember(createFormData)}
            variant="contained"
            disabled={!createFormData.firstName || !createFormData.lastName || !createFormData.email}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            Add Member
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Member Dialog */}
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
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Edit Member
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="First Name"
                value={editFormData.firstName}
                onChange={(e) => setEditFormData({ ...editFormData, firstName: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Last Name"
                value={editFormData.lastName}
                onChange={(e) => setEditFormData({ ...editFormData, lastName: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Email"
                type="email"
                value={editFormData.email}
                onChange={(e) => setEditFormData({ ...editFormData, email: e.target.value })}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Phone Number"
                value={editFormData.phoneNumber}
                onChange={(e) => setEditFormData({ ...editFormData, phoneNumber: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <TextField
                label="Date of Birth"
                type="date"
                value={editFormData.dateOfBirth}
                onChange={(e) => setEditFormData({ ...editFormData, dateOfBirth: e.target.value })}
                fullWidth
                InputLabelProps={{ shrink: true }}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <FormControl fullWidth sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>Gender</InputLabel>
                <Select
                  value={editFormData.gender}
                  onChange={(e) => setEditFormData({ ...editFormData, gender: e.target.value })}
                  label="Gender"
                >
                  <MenuItem value="Male">Male</MenuItem>
                  <MenuItem value="Female">Female</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <TextField
                label="Address"
                value={editFormData.address}
                onChange={(e) => setEditFormData({ ...editFormData, address: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="City"
                value={editFormData.city}
                onChange={(e) => setEditFormData({ ...editFormData, city: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <FormControl fullWidth sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>State</InputLabel>
                <Select
                  value={editFormData.state}
                  onChange={(e) => setEditFormData({ ...editFormData, state: e.target.value })}
                  label="State"
                >
                  {US_STATES.map((state) => (
                    <MenuItem key={state.code} value={state.code}>
                      {state.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="ZIP Code"
                value={editFormData.zip}
                onChange={(e) => setEditFormData({ ...editFormData, zip: e.target.value })}
                fullWidth
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: 'var(--oe-primary)',
                  },
                }}
              />
            </Grid>
            <Grid size={12}>
              <Autocomplete
                options={locations}
                getOptionLabel={(option) => {
                  const locationName = option.Name || 'Unnamed Location';
                  const address = `${option.City}, ${option.State}`;
                  return `${locationName} - ${address}`;
                }}
                loading={locationsLoading}
                value={locations.find(loc => loc.LocationId === editFormData.locationId) || null}
                onChange={(_, newValue) => {
                  setEditFormData({
                    ...editFormData,
                    locationId: newValue?.LocationId || '',
                    workLocation: newValue ? (newValue.Name || `${newValue.City}, ${newValue.State}`) : ''
                  });
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Work Location / Branch"
                    placeholder="Search for a location..."
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: 'var(--oe-primary)',
                        },
                      },
                      '& .MuiInputLabel-root.Mui-focused': {
                        color: 'var(--oe-primary)',
                      },
                    }}
                  />
                )}
                noOptionsText={locationsLoading ? "Loading locations..." : "No locations found"}
                fullWidth
              />
            </Grid>
            <Grid size={12}>
              <FormControl fullWidth required sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
                '& .MuiInputLabel-root.Mui-focused': {
                  color: 'var(--oe-primary)',
                },
              }}>
                <InputLabel>Relationship</InputLabel>
                <Select
                  value={editFormData.relationshipType}
                  onChange={(e) => setEditFormData({ ...editFormData, relationshipType: e.target.value as 'P' | 'S' | 'C' })}
                  label="Relationship"
                >
                  <MenuItem value="P">Primary (Employee)</MenuItem>
                  <MenuItem value="S">Spouse</MenuItem>
                  <MenuItem value="C">Child</MenuItem>
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
            onClick={() => updateMember(editFormData)}
            variant="contained"
            disabled={!editFormData.firstName || !editFormData.lastName || !editFormData.email}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            Update Member
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import Census Dialog */}
      <Dialog 
        open={importDialogOpen} 
        onClose={() => setImportDialogOpen(false)} 
        maxWidth="sm" 
        fullWidth
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Import Member Census
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Alert severity="info" sx={{ mb: 3 }}>
              Upload an Excel file with member information. Download the template to see the required format.
            </Alert>
            
            <Button
              variant="outlined"
              fullWidth
              component="label"
              sx={{ 
                height: 100, 
                borderStyle: 'dashed',
                borderWidth: 2,
                mb: 2,
                borderColor: '#d1d5db',
                color: '#374151',
                '&:hover': {
                  borderColor: '#9ca3af',
                  backgroundColor: '#f9fafb',
                }
              }}
            >
              <Stack alignItems="center" spacing={1}>
                <UploadIcon sx={{ fontSize: '2rem' }} />
                <Typography>
                  {selectedFile ? selectedFile.name : 'Click to select file or drag and drop'}
                </Typography>
              </Stack>
              <input
                type="file"
                hidden
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              />
            </Button>

            {selectedFile && (
              <Alert severity="success" sx={{ mt: 2 }}>
                Selected: {selectedFile.name}
              </Alert>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={() => {
              setImportDialogOpen(false);
              setSelectedFile(null);
            }}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => selectedFile && importMembers(selectedFile)}
            variant="contained"
            disabled={!selectedFile}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            Import Members
          </Button>
        </DialogActions>
      </Dialog>

      {/* Send Enrollment Links Dialog */}
      <Dialog 
        open={sendLinksDialogOpen} 
        onClose={() => setSendLinksDialogOpen(false)} 
        maxWidth="sm" 
        fullWidth
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Send Enrollment Links
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Alert severity="info" sx={{ mb: 3 }}>
              This will send secure enrollment links to all active members via email. 
              Each link will be unique and expire after 30 days.
            </Alert>
            
            <Typography variant="body2" sx={{ mb: 2 }}>
              <strong>Email will be sent to:</strong>
            </Typography>
            
            <Box sx={{ maxHeight: 200, overflow: 'auto', mb: 2 }}>
              {members.filter(m => m.Status === 'Active').map((member) => (
                <Stack key={member.MemberId} direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
                  <PersonIcon sx={{ fontSize: '1rem', color: theme.palette.text.secondary }} />
                  <Typography variant="body2">
                    {member.FirstName} {member.LastName} - {member.Email}
                  </Typography>
                </Stack>
              ))}
            </Box>
            
            <Typography variant="caption" color="text.secondary">
              Total: {members.filter(m => m.Status === 'Active').length} active members
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={() => setSendLinksDialogOpen(false)}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => sendEnrollmentLinks(members.filter(m => m.Status === 'Active').map(m => m.MemberId))}
            variant="contained"
            disabled={members.filter(m => m.Status === 'Active').length === 0}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            Send Links
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

export default GroupMembersTab;
