import {
    AccessTime as AccessTimeIcon,
    CalendarToday as CalendarIcon,
    Campaign as CampaignIcon,
    CheckCircle as CheckCircleIcon,
    ContentCopy as CopyIcon,
    Groups as GroupsIcon,
    Link as LinkIcon,
    People as PeopleIcon,
    Person as PersonIcon,
    Refresh as RefreshIcon,
    Schedule as ScheduleIcon,
    Search as SearchIcon,
    Send as SendIcon
} from '@mui/icons-material';
import {
    Alert,
    alpha,
    Box,
    Button,
    Card,
    CardContent,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Grid,
    IconButton,
    InputAdornment,
    Paper,
    Skeleton,
    Snackbar,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
    useTheme,
} from '@mui/material';
import { addDays, format } from 'date-fns';
import React, { useEffect, useState } from 'react';
import { useMembers } from '../../hooks/useMembers';
import { GroupsService } from '../../services/groups.service';

// Types
interface Member {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  Status: 'Active' | 'Inactive' | 'Terminated';
  HasActiveEnrollment: boolean;
}

interface EnrollmentToken {
  TokenId: string;
  Token: string;
  MemberId: string;
  GroupId: string;
  MemberName: string;
  MemberEmail: string;
  ExpiresAt: string;
  Used: boolean;
  CreatedAt: string;
  CreatedBy: string;
  UsedAt?: string;
  Status: 'Active' | 'Expired' | 'Used';
}

interface EnrollmentStats {
  totalMembers: number;
  enrolledMembers: number;
  pendingInvitations: number;
  completedEnrollments: number;
}

interface GroupEnrollmentLinksTabProps {
  groupId: string;
  groupName: string;
}

// Send Enrollment Links Dialog
interface SendEnrollmentDialogProps {
  open: boolean;
  onClose: () => void;
  members: Member[];
  onSend: (memberIds: string[]) => void;
}

const SendEnrollmentDialog: React.FC<SendEnrollmentDialogProps> = ({ 
  open, 
  onClose, 
  members, 
  onSend 
}) => {
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectAll, setSelectAll] = useState(false);
  const [sending, setSending] = useState(false);
  const theme = useTheme();

  // Filter eligible members (active and not enrolled)
  const eligibleMembers = members.filter(m => 
    m.Status === 'Active' && !m.HasActiveEnrollment
  );

  // Filter by search term
  const filteredMembers = eligibleMembers.filter(m =>
    `${m.FirstName} ${m.LastName} ${m.Email}`.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelectAll = (checked: boolean) => {
    setSelectAll(checked);
    if (checked) {
      setSelectedMembers(filteredMembers.map(m => m.MemberId));
    } else {
      setSelectedMembers([]);
    }
  };

  const handleSelectMember = (memberId: string, checked: boolean) => {
    if (checked) {
      setSelectedMembers([...selectedMembers, memberId]);
    } else {
      setSelectedMembers(selectedMembers.filter(id => id !== memberId));
      setSelectAll(false);
    }
  };

  const handleSend = async () => {
    if (selectedMembers.length > 0) {
      setSending(true);
      await onSend(selectedMembers);
      setSending(false);
      handleClose();
    }
  };

  const handleClose = () => {
    setSelectedMembers([]);
    setSearchTerm('');
    setSelectAll(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Send Enrollment Links
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3}>
          <Alert severity="info">
            Send secure enrollment links to selected members. Each link is unique and expires after 7 days.
          </Alert>

          {/* Search Box */}
          <TextField
            placeholder="Search members by name or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
            }}
          />

          {/* Select All Checkbox */}
          <FormControlLabel
            control={
              <Checkbox
                checked={selectAll}
                onChange={(e) => handleSelectAll(e.target.checked)}
                disabled={filteredMembers.length === 0}
              />
            }
            label={`Select all ${filteredMembers.length} eligible members`}
          />

          {/* Members List */}
          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
            {filteredMembers.length === 0 ? (
              <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
                <PeopleIcon sx={{ fontSize: 48, color: theme.palette.text.secondary }} />
                <Typography variant="body1" color="text.secondary">
                  No eligible members found
                </Typography>
                <Typography variant="caption" color="text.secondary" textAlign="center">
                  All active members may have already enrolled or received invitation links.
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={1}>
                {filteredMembers.map((member) => (
                  <Paper
                    key={member.MemberId}
                    sx={{
                      p: 2,
                      cursor: 'pointer',
                      bgcolor: selectedMembers.includes(member.MemberId)
                        ? alpha(theme.palette.primary.main, 0.08)
                        : 'background.paper',
                      border: `1px solid ${
                        selectedMembers.includes(member.MemberId)
                          ? theme.palette.primary.main
                          : theme.palette.divider
                      }`,
                      '&:hover': {
                        bgcolor: alpha(theme.palette.primary.main, 0.04),
                      },
                    }}
                    onClick={() => handleSelectMember(
                      member.MemberId,
                      !selectedMembers.includes(member.MemberId)
                    )}
                  >
                    <Stack direction="row" alignItems="center" spacing={2}>
                      <Checkbox
                        checked={selectedMembers.includes(member.MemberId)}
                        onChange={(e) => handleSelectMember(member.MemberId, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <PersonIcon color="action" />
                      <Box sx={{ flex: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {member.FirstName} {member.LastName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {member.Email}
                        </Typography>
                      </Box>
                      <Chip
                        label="Not Enrolled"
                        size="small"
                        color="warning"
                        variant="outlined"
                      />
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Box>

          {/* Summary */}
          <Box sx={{ bgcolor: alpha(theme.palette.primary.main, 0.05), p: 2, borderRadius: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {selectedMembers.length} member{selectedMembers.length !== 1 ? 's' : ''} selected
            </Typography>
            {selectedMembers.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                Each member will receive a personalized enrollment link via email
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button onClick={handleClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          onClick={handleSend}
          variant="contained"
          disabled={selectedMembers.length === 0 || sending}
          startIcon={sending ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          {sending ? 'Sending...' : `Send ${selectedMembers.length} Link${selectedMembers.length !== 1 ? 's' : ''}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const GroupEnrollmentLinksTab: React.FC<GroupEnrollmentLinksTabProps> = ({ groupId, groupName }) => {
  const theme = useTheme();
  
  // Use the new useMembers hook to fetch group members
  const { 
    data: membersData, 
    isLoading: membersLoading, 
    isError: membersError,
    error: membersErrorDetails,
    refetch: refetchMembers 
  } = useMembers({ groupId });

  // Extract members from hook data and add enrollment status
  const members = (membersData?.members || []).map(m => ({
    MemberId: m.MemberId,
    FirstName: m.FirstName,
    LastName: m.LastName,
    Email: m.Email,
    Status: m.Status as 'Active' | 'Inactive' | 'Terminated',
    HasActiveEnrollment: (m.ActiveEnrollments || 0) > 0,
  }));
  
  // State
  const [enrollmentLinks, setEnrollmentLinks] = useState<any[]>([]);
  const [stats, setStats] = useState<EnrollmentStats>({
    totalMembers: 0,
    enrolledMembers: 0,
    pendingInvitations: 0,
    completedEnrollments: 0,
  });
  const [linksLoading, setLinksLoading] = useState(true);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // API Functions - now fetches enrollment links since members come from useMembers hook
  const fetchEnrollmentLinks = async () => {
    try {
      setLinksLoading(true);
      console.log('🔍 Fetching enrollment links for group:', groupId);

      // Fetch enrollment links using the new service method
      const response = await GroupsService.getGroupEnrollmentLinks(groupId);
      
      console.log('📡 Enrollment links response:', response);
      
      if (response.success) {
        console.log('✅ Successfully fetched enrollment links:', response.data?.length || 0, 'links');
        setEnrollmentLinks(response.data || []);
      } else {
        console.error('❌ Failed to fetch enrollment links:', response.message);
        showSnackbar(response.message || 'Failed to load enrollment links', 'error');
        setEnrollmentLinks([]);
      }

    } catch (error) {
      console.error('❌ Error fetching enrollment links:', error);
      showSnackbar('Failed to load enrollment links', 'error');
      setEnrollmentLinks([]);
    } finally {
      setLinksLoading(false);
    }
  };



  const sendEnrollmentLinks = async (memberIds: string[]) => {
    try {
      const data = await GroupsService.sendEnrollmentLinks(groupId, memberIds, '');

      if (data.success) {
        showSnackbar(`Successfully sent ${memberIds.length} enrollment link(s)`, 'success');
        fetchEnrollmentLinks();
      } else if (data.message && data.message.includes('coming soon')) {
        // Show placeholder success for demo
        showSnackbar('Enrollment links functionality coming soon', 'info');
        
        // Add mock links for demo
        const mockLinks = memberIds.map(memberId => {
          const member = members.find(m => m.MemberId === memberId);
          return {
            linkId: `mock-${Date.now()}-${memberId}`,
            linkToken: `enroll_${Date.now()}_${memberId}`,
            linkUrl: `https://allaboard365.com/enroll/enroll_${Date.now()}_${memberId}`,
            memberId: memberId,
            memberName: member ? `${member.FirstName} ${member.LastName}` : 'Unknown',
            memberEmail: member?.Email || '',
            expiresAt: addDays(new Date(), 3).toISOString(),
            isActive: true,
            usageCount: 0,
            maxUsage: 1,
            createdDate: new Date().toISOString(),
            status: 'Active' as const,
          };
        });
        setEnrollmentLinks([...mockLinks, ...enrollmentLinks]);
      } else {
        throw new Error('Failed to send enrollment links');
      }
    } catch (error) {
      console.error('Error sending enrollment links:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to send links', 'error');
    }
  };

  const copyEnrollmentLink = (linkUrl: string) => {
    navigator.clipboard.writeText(linkUrl);
    showSnackbar('Link copied to clipboard', 'success');
  };

  const resendEnrollmentLink = async () => {
    try {
      showSnackbar('Resend functionality coming soon', 'info');
    } catch (error) {
      console.error('Error resending link:', error);
      showSnackbar('Failed to resend link', 'error');
    }
  };

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'success';
      case 'Used':
        return 'info';
      case 'Expired':
        return 'error';
      default:
        return 'default';
    }
  };

  const getTimeRemaining = (expiresAt: string) => {
    const now = new Date();
    const expiry = new Date(expiresAt);
    const hoursRemaining = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60));
    
    if (hoursRemaining < 0) return 'Expired';
    if (hoursRemaining < 24) return `${hoursRemaining} hours`;
    return `${Math.floor(hoursRemaining / 24)} days`;
  };

  // Effects
  useEffect(() => {
    fetchEnrollmentLinks();
  }, [groupId]);

  // Calculate stats when members or links change
  useEffect(() => {
    if (!membersLoading && !linksLoading) {
      const enrolled = members.filter(m => m.HasActiveEnrollment).length;
      const pending = enrollmentLinks.filter(l => l.status === 'Active').length;
      const completed = enrollmentLinks.filter(l => l.status === 'Used').length;

      setStats({
        totalMembers: members.length,
        enrolledMembers: enrolled,
        pendingInvitations: pending,
        completedEnrollments: completed,
      });
    }
  }, [members.length, enrollmentLinks.length, membersLoading, linksLoading]);

  // Combined loading state
  const loading = membersLoading || linksLoading;

  if (loading) {
    return (
      <Box>
        <Grid container spacing={3}>
          {[1, 2, 3, 4].map((i) => (
            <Grid size={3} key={i}>
              <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 2 }} />
            </Grid>
          ))}
          <Grid size={12}>
            <Skeleton variant="rectangular" height={400} sx={{ borderRadius: 2 }} />
          </Grid>
        </Grid>
      </Box>
    );
  }

  // Show error if members failed to load
  if (membersError) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ borderRadius: 2, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>Failed to load group members</Typography>
          <Typography variant="body2">
            {membersErrorDetails instanceof Error ? membersErrorDetails.message : 'Unable to load member data for enrollment links.'}
          </Typography>
        </Alert>
        <Button
          variant="outlined"
          onClick={() => refetchMembers()}
          startIcon={<RefreshIcon />}
          sx={{ textTransform: 'none' }}
        >
          Try Again
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Employee Enrollment Links
          </Typography>
          <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
            Send secure enrollment invitations to employees
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <IconButton 
            onClick={() => {
              refetchMembers();
              fetchEnrollmentLinks();
            }} 
            size="small"
            title="Refresh data"
          >
            <RefreshIcon />
          </IconButton>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={() => setSendDialogOpen(true)}
            disabled={members.filter(m => m.Status === 'Active' && !m.HasActiveEnrollment).length === 0}
            sx={{ textTransform: 'none' }}
          >
            Send Enrollment Links
          </Button>
        </Stack>
      </Stack>

      {/* Stats Cards */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Card sx={{ height: '100%', borderRadius: 2 }}>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.primary.main, 0.1),
                    color: theme.palette.primary.main,
                  }}
                >
                  <GroupsIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    {stats.totalMembers}
                  </Typography>
                  <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                    Total Members
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Card sx={{ height: '100%', borderRadius: 2 }}>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.success.main, 0.1),
                    color: theme.palette.success.main,
                  }}
                >
                  <CheckCircleIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    {stats.enrolledMembers}
                  </Typography>
                  <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                    Enrolled
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Card sx={{ height: '100%', borderRadius: 2 }}>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.warning.main, 0.1),
                    color: theme.palette.warning.main,
                  }}
                >
                  <ScheduleIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    {stats.pendingInvitations}
                  </Typography>
                  <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                    Pending Links
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Card sx={{ height: '100%', borderRadius: 2 }}>
            <CardContent sx={{ p: 2.5 }}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.info.main, 0.1),
                    color: theme.palette.info.main,
                  }}
                >
                  <CampaignIcon sx={{ fontSize: '1.5rem' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    {enrollmentLinks.length}
                  </Typography>
                  <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                    Links Sent
                  </Typography>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Info Alert */}
      {stats.totalMembers > 0 && stats.enrolledMembers < stats.totalMembers && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <Stack>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {stats.totalMembers - stats.enrolledMembers} members haven't enrolled yet
            </Typography>
            <Typography variant="body2">
              Send them secure enrollment links to help them choose their benefits and complete enrollment online.
            </Typography>
          </Stack>
        </Alert>
      )}

      {/* Enrollment Links Table */}
      <Paper sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ p: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Enrollment Link History
          </Typography>
        </Box>
        
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Member</TableCell>
                <TableCell>Sent Date</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {enrollmentLinks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Stack alignItems="center" spacing={2}>
                      <LinkIcon sx={{ fontSize: 48, color: theme.palette.text.secondary }} />
                      <Typography variant="body1" color="text.secondary">
                        No enrollment links sent yet
                      </Typography>
                      <Button
                        variant="outlined"
                        startIcon={<SendIcon />}
                        onClick={() => setSendDialogOpen(true)}
                        sx={{ textTransform: 'none' }}
                      >
                        Send First Links
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ) : (
                enrollmentLinks
                  .sort((a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime())
                  .map((link) => (
                    <TableRow key={link.linkId}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <PersonIcon fontSize="small" color="action" />
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {link.memberName}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {link.memberEmail}
                            </Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <CalendarIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                          <Typography variant="body2">
                            {format(new Date(link.createdDate), 'MMM dd, yyyy h:mm a')}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <AccessTimeIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                          <Typography variant="body2">
                            {link.status === 'Active' ? getTimeRemaining(link.expiresAt) : '-'}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={link.status}
                          color={getStatusColor(link.status) as any}
                          size="small"
                          sx={{ fontWeight: 500 }}
                        />
                      </TableCell>
                      <TableCell align="center">
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          {link.status === 'Active' && (
                            <>
                              <Tooltip title="Copy Link">
                                <IconButton
                                  size="small"
                                  onClick={() => copyEnrollmentLink(link.linkUrl)}
                                >
                                  <CopyIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Resend">
                                <IconButton
                                  size="small"
                                  onClick={() => resendEnrollmentLink()}
                                >
                                  <SendIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </>
                          )}
                          {link.status === 'Used' && (
                            <Typography variant="caption" color="text.secondary">
                              Enrolled
                            </Typography>
                          )}
                          {link.status === 'Expired' && (
                            <Typography variant="caption" color="text.secondary">
                              Link expired
                            </Typography>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Send Enrollment Dialog */}
      <SendEnrollmentDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        members={members}
        onSend={sendEnrollmentLinks}
      />

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert 
          onClose={() => setSnackbar({ ...snackbar, open: false })} 
          severity={snackbar.severity}
          sx={{ borderRadius: 2 }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default GroupEnrollmentLinksTab;
