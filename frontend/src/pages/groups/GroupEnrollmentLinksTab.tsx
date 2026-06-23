import {
  AccessTime as AccessTimeIcon,
  CalendarToday as CalendarIcon,
  Campaign as CampaignIcon,
  CheckCircle as CheckCircleIcon,
  Close as CloseIcon,
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
  AlertTitle,
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
import { addDays, format, isPast } from 'date-fns';
import React, { useEffect, useState } from 'react';
import SetEnrollmentPeriodModal from '../../components/modals/SetEnrollmentPeriodModal';
import { useAuth } from '../../contexts/AuthContext';
import { useGroupPaymentValidation } from '../../hooks/useGroupPaymentValidation';
import { useMembers } from '../../hooks/useMembers';
import { usePaymentProcessorStatus } from '../../hooks/usePaymentProcessorStatus';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';

// Types
interface Member {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  Status: 'Active' | 'Inactive' | 'Terminated';
  HasActiveEnrollment: boolean;
}

interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: string;
  Description?: string;
  IsActive: boolean;
  LinkMetaData?: string | Record<string, any>;
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
  onSend: (memberIds: string[], templateId: string) => void;
  enrollmentPeriodActive?: boolean;
  enrollmentPeriodEndDate?: string | null;
  groupId: string;
}

const SendEnrollmentDialog: React.FC<SendEnrollmentDialogProps> = ({
  open,
  onClose,
  members,
  onSend,
  enrollmentPeriodActive,
  enrollmentPeriodEndDate,
  groupId
}) => {
  const { user } = useAuth();
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectAll, setSelectAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<EnrollmentLinkTemplate | null>(null);
  const theme = useTheme();

  // Fetch templates when dialog opens
  useEffect(() => {
    if (open) {
      console.log('🚀 Dialog opened, fetching templates...');
      console.log('👤 Current user:', user);
      console.log('🎭 Current role:', user?.currentRole);
      
      // Only fetch if user and currentRole are available
      if (user && user.currentRole) {
        fetchTemplates();
      } else {
        console.warn('⚠️ User or currentRole not available, waiting...');
        // Set a small delay to allow user context to load
        const timer = setTimeout(() => {
          if (user && user.currentRole) {
            console.log('🔄 Retrying template fetch after delay...');
            fetchTemplates();
          } else {
            console.error('❌ User context still not available after delay');
            setTemplatesLoading(false);
          }
        }, 500);
        
        return () => clearTimeout(timer);
      }
    }
  }, [open, user, user?.currentRole]);

  // Fetch available Group-type enrollment link templates
  const fetchTemplates = async () => {
    try {
      setTemplatesLoading(true);
      
      if (!user?.currentRole) {
        console.error('❌ No user role available');
        setTemplatesLoading(false);
        return;
      }
      
      console.log('🔍 Fetching templates for role:', user.currentRole);
      console.log('🔍 User object:', user);
      
      // Use the proper service with role-specific endpoint
      const response = await EnrollmentLinkTemplatesService.getTemplates(
        { templateType: 'Group', isActive: true, groupId },
        user.currentRole
      );
      
      console.log('📡 Service response:', response);
      
      if (response.success) {
        // Filter for Group type templates (double-check)
        const groupTemplates = (response.data?.data || []).filter((template: any) =>
          template.TemplateType === 'Group' && template.IsActive
        );
        setTemplates(groupTemplates);
        // Auto-select the first (and typically only) template
        if (groupTemplates.length > 0) {
          setSelectedTemplate(groupTemplates[0].TemplateId);
        }
        console.log('📋 Found Group templates:', groupTemplates);
        console.log('📋 Total templates found:', response.data?.data?.length || 0);
      } else {
        console.error('❌ Service error:', response.message);
        console.error('❌ Service error details:', response.error);
        // Set empty templates array to show the error state
        setTemplates([]);
      }
    } catch (error) {
      console.error('❌ Error fetching templates:', error);
      console.error('❌ Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      // Set empty templates array to show the error state
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  };

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
    if (selectedMembers.length > 0 && selectedTemplate) {
      setSending(true);
      await onSend(selectedMembers, selectedTemplate);
      setSending(false);
      handleClose();
    }
  };

  const handleClose = () => {
    setSelectedMembers([]);
    setSelectedTemplate('');
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
            {enrollmentPeriodActive && enrollmentPeriodEndDate
              ? `Send secure enrollment links to selected members. Each link is unique and remains valid until the last day of the current enrollment period (${new Date(enrollmentPeriodEndDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}).`
              : 'Send secure enrollment links to selected members. Each link is unique and expires after 7 days.'}
          </Alert>

          {/* Enrollment Template (auto-selected) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Enrollment Template
            </label>
            {templatesLoading ? (
              <div className="animate-pulse h-10 bg-gray-200 rounded"></div>
            ) : templates.length === 0 ? (
              <div className="text-sm text-red-600 bg-red-50 p-3 rounded border border-red-200">
                <div className="font-medium mb-1">No enrollment template found for this group</div>
                <div className="text-xs text-gray-600">
                  Go to the Products tab and assign products — a template will be created automatically.
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-2 border border-gray-200 rounded-lg bg-gray-50">
                <div className="flex items-center space-x-2">
                  <LinkIcon fontSize="small" className="text-blue-600" />
                  <div>
                    <span className="text-sm font-medium text-gray-900">
                      {templates.find(t => t.TemplateId === selectedTemplate)?.TemplateName || templates[0]?.TemplateName}
                    </span>
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewTemplate(templates.find(t => t.TemplateId === selectedTemplate) || templates[0])}
                  className="text-xs text-oe-primary hover:text-blue-800 underline"
                >
                  Preview
                </button>
              </div>
            )}
          </div>

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
          disabled={selectedMembers.length === 0 || !selectedTemplate || sending}
          startIcon={sending ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          {sending ? 'Sending...' : `Send ${selectedMembers.length} Link${selectedMembers.length !== 1 ? 's' : ''}`}
        </Button>
      </DialogActions>

      {/* Template Preview Modal */}
      {previewTemplate && (() => {
        return (
          <Dialog open={true} onClose={() => setPreviewTemplate(null)} maxWidth="sm" fullWidth>
            <DialogTitle>
              <div className="flex items-center justify-between">
                <span>Enrollment Preview</span>
                <IconButton size="small" onClick={() => setPreviewTemplate(null)}><CloseIcon fontSize="small" /></IconButton>
              </div>
              <p className="text-xs text-gray-500 mt-1">What members will see when they open the enrollment link.</p>
            </DialogTitle>
            <DialogContent dividers>
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-medium text-gray-700 mb-2">Products</p>
                  <p className="text-xs text-gray-500">Products are automatically pulled from this group's assigned products at enrollment time. Check the Products tab to see the current product list.</p>
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setPreviewTemplate(null)} sx={{ textTransform: 'none' }}>Close</Button>
            </DialogActions>
          </Dialog>
        );
      })()}
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
  
  // Check if group has valid payment methods
  const { 
    data: paymentValidation = { hasValidPaymentMethod: false, paymentMethods: [] },
    isLoading: paymentLoading 
  } = useGroupPaymentValidation(groupId);

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
  const [enrollmentTokens, setEnrollmentTokens] = useState<EnrollmentToken[]>([]);
  const [stats, setStats] = useState<EnrollmentStats>({
    totalMembers: 0,
    enrolledMembers: 0,
    pendingInvitations: 0,
    completedEnrollments: 0,
  });
  const [tokensLoading, setTokensLoading] = useState(true);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [enrollmentPeriodModalOpen, setEnrollmentPeriodModalOpen] = useState(false);
  const [enrollmentPeriodStatus, setEnrollmentPeriodStatus] = useState<{
    needsEnrollmentPeriod: boolean;
    hasEnrolledMembers: boolean;
    currentPeriod: {
      startDate: string;
      endDate: string;
      isActive: boolean;
      isUpcoming: boolean;
      isEnded: boolean;
      status: 'upcoming' | 'active' | 'ended';
      benefitStartDate: string;
    } | null;
  } | null>(null);
  const [enrollmentPeriodLoading, setEnrollmentPeriodLoading] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // API Functions - now only fetches tokens since members come from useMembers hook
  const fetchTokens = async () => {
    try {
      setTokensLoading(true);

      // Fetch enrollment tokens
      try {
        const tokensData = await apiService.get<{ success: boolean; data?: any[] }>(`/api/groups/${groupId}/enrollment-tokens`);
        if (tokensData.success) {
          const tokens = (tokensData.data || []).map((token: any) => ({
            ...token,
            Status: token.Used ? 'Used' : isPast(new Date(token.ExpiresAt)) ? 'Expired' : 'Active',
          }));
          setEnrollmentTokens(tokens);
        }
      } catch (error: any) {
        if (error.status === 404) {
          // Mock data for demo
          setEnrollmentTokens([]);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('Error fetching enrollment tokens:', error);
      showSnackbar('Failed to load enrollment tokens', 'error');
    } finally {
      setTokensLoading(false);
    }
  };

  // Fetch enrollment period status
  const fetchEnrollmentPeriodStatus = async () => {
    try {
      setEnrollmentPeriodLoading(true);
      
      const data = await apiService.get<{ success: boolean; data?: any }>(`/api/groups/${groupId}/enrollment-period/status`);
      if (data.success) {
        setEnrollmentPeriodStatus(data.data);
      }
    } catch (error) {
      console.error('Error fetching enrollment period status:', error);
    } finally {
      setEnrollmentPeriodLoading(false);
    }
  };



  const { data: paymentProcessorStatus } = usePaymentProcessorStatus();
  
  const sendEnrollmentLinks = async (memberIds: string[], templateId: string) => {
    // Check payment processor status and show warning if needed
    if (!paymentProcessorStatus?.hasApiToken) {
      const proceed = window.confirm(
        '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\n' +
        'Enrollment links may not work properly without payment processing setup.\n\n' +
        'Do you want to continue anyway?'
      );
      if (!proceed) {
        return;
      }
    }
    
    try {
      const data = await apiService.post<{ success: boolean; data?: { templateName?: string; createdLinks?: any[] }; message?: string }>(`/api/groups/${groupId}/send-enrollment-links`, {
        memberIds,
        groupName,
        templateId,
      });

      if (data.success && data.data) {
        showSnackbar(`Successfully created ${memberIds.length} enrollment link(s) using template: ${data.data.templateName}`, 'success');
        
        // Add the newly created links to the tokens list
        if (data.data.createdLinks) {
          const newTokens = data.data.createdLinks.map((link: any) => {
            const member = members.find(m => m.MemberId === link.memberId);
            return {
              TokenId: `new-${Date.now()}-${link.memberId}`,
              Token: link.linkToken,
              MemberId: link.memberId,
              GroupId: groupId,
              MemberName: member ? `${member.FirstName} ${member.LastName}` : 'Unknown',
              MemberEmail: member?.Email || '',
              ExpiresAt: addDays(new Date(), 3).toISOString(),
              Used: false,
              CreatedAt: new Date().toISOString(),
              CreatedBy: 'current-user',
              Status: 'Active' as const,
            };
          });
          
          setEnrollmentTokens([...newTokens, ...enrollmentTokens]);
        }
      } else {
        throw new Error(data.message || 'Failed to send links');
      }
    } catch (error: any) {
      // Handle validation errors from backend
      if (error.status === 400 || error.message?.includes('Primary Contact')) {
        showSnackbar('Group must have Primary Contact and Contact Email set up before sending enrollment links. Please update the group details in the Overview tab.', 'error');
      } else if (error.status === 404) {
        // Show placeholder success for demo
        showSnackbar('Enrollment links functionality coming soon', 'info');
        
        // Add mock tokens for demo
        const mockTokens = memberIds.map(memberId => {
          const member = members.find(m => m.MemberId === memberId);
          return {
            TokenId: `mock-${Date.now()}-${memberId}`,
            Token: `token-${memberId}`,
            MemberId: memberId,
            GroupId: groupId,
            MemberName: member ? `${member.FirstName} ${member.LastName}` : 'Unknown',
            MemberEmail: member?.Email || '',
            ExpiresAt: addDays(new Date(), 3).toISOString(),
            Used: false,
            CreatedAt: new Date().toISOString(),
            CreatedBy: 'current-user',
            Status: 'Active' as const,
          };
        });
        setEnrollmentTokens([...mockTokens, ...enrollmentTokens]);
      } else {
        showSnackbar(error.message || 'Failed to send enrollment links', 'error');
      }
    }
  };

  const copyEnrollmentLink = (token: string, _memberId: string) => {
    const link = `https://allaboard365.com/enroll/${token}`;
    navigator.clipboard.writeText(link);
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
        return 'primary';
      case 'Used':
        return 'success';
      case 'Expired':
        return 'error';
      default:
        return 'default';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'Active':
        return 'Link sent';
      case 'Used':
        return 'Enrolled';
      case 'Expired':
        return 'Link expired';
      default:
        return status;
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
    fetchTokens();
    fetchEnrollmentPeriodStatus();
  }, [groupId]);

  // Calculate stats when members or tokens change
  useEffect(() => {
    if (!membersLoading && !tokensLoading) {
      const enrolled = members.filter(m => m.HasActiveEnrollment).length;
      const pending = enrollmentTokens.filter(t => t.Status === 'Active').length;
      const completed = enrollmentTokens.filter(t => t.Status === 'Used').length;

      setStats({
        totalMembers: members.length,
        enrolledMembers: enrolled,
        pendingInvitations: pending,
        completedEnrollments: completed,
      });
    }
  }, [members.length, enrollmentTokens.length, membersLoading, tokensLoading]);

  // Combined loading state
  const loading = membersLoading || tokensLoading || paymentLoading;

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
              fetchTokens();
              fetchEnrollmentPeriodStatus();
            }} 
            size="small"
            title="Refresh data"
          >
            <RefreshIcon />
          </IconButton>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={() => {
              // Check if enrollment period needs to be set
              if (enrollmentPeriodStatus?.needsEnrollmentPeriod) {
                setEnrollmentPeriodModalOpen(true);
              } else if (enrollmentPeriodStatus?.currentPeriod?.isUpcoming) {
                showSnackbar('Enrollment links cannot be sent until the enrollment period begins', 'warning');
              } else {
                setSendDialogOpen(true);
              }
            }}
            disabled={
              members.filter(m => m.Status === 'Active' && !m.HasActiveEnrollment).length === 0 ||
              !paymentValidation.hasValidPaymentMethod ||
              paymentLoading ||
              enrollmentPeriodLoading ||
              enrollmentPeriodStatus?.currentPeriod?.isUpcoming
            }
            title={
              !paymentValidation.hasValidPaymentMethod 
                ? 'Add a payment method in the Billing tab before sending enrollment links'
                : members.filter(m => m.Status === 'Active' && !m.HasActiveEnrollment).length === 0
                ? 'No eligible members to send links to'
                : 'Send enrollment links to eligible members'
            }
            sx={{ 
              textTransform: 'none',
              '&:disabled': {
                backgroundColor: '#e5e7eb',
                color: '#9ca3af',
              }
            }}
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
                    {enrollmentTokens.length}
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

      {/* Initial Enrollment Period Banner */}
      {enrollmentPeriodStatus?.needsEnrollmentPeriod && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <AlertTitle>Initial Enrollment Period Required</AlertTitle>
          <Typography variant="body2">
            Before sending enrollment links for the first time, you must set up your group's initial enrollment period. 
            This determines when members can enroll and when their benefits will start.
          </Typography>
          <button
            onClick={() => setEnrollmentPeriodModalOpen(true)}
            className="mt-2 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors text-sm font-medium"
          >
            Set Enrollment Period
          </button>
        </Alert>
      )}

      {/* Current/Past/Upcoming Enrollment Period Banner */}
      {enrollmentPeriodStatus?.currentPeriod && !enrollmentPeriodStatus.needsEnrollmentPeriod && (
        <Alert 
          severity={
            enrollmentPeriodStatus.currentPeriod.isActive ? "success" : 
            enrollmentPeriodStatus.currentPeriod.isUpcoming ? "warning" :
            "info"
          } 
          sx={{ mb: 3 }}
        >
          <div className="flex items-center justify-between">
            <div>
              {enrollmentPeriodStatus.currentPeriod.isUpcoming ? (
                <>
                  <AlertTitle>Enrollment Period Scheduled</AlertTitle>
                  <Typography variant="body2">
                    <strong>Period:</strong> {new Date(enrollmentPeriodStatus.currentPeriod.startDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - {new Date(enrollmentPeriodStatus.currentPeriod.endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    <br />
                    <strong>Benefits Will Start:</strong> {new Date(enrollmentPeriodStatus.currentPeriod.benefitStartDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    <br />
                    <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic', color: 'text.secondary' }}>
                      Enrollment links cannot be sent until the period begins.
                    </Typography>
                  </Typography>
                </>
              ) : enrollmentPeriodStatus.currentPeriod.isActive ? (
                <>
                  <AlertTitle>Enrollment Period Active</AlertTitle>
                  <Typography variant="body2">
                    <strong>Period:</strong> {new Date(enrollmentPeriodStatus.currentPeriod.startDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - {new Date(enrollmentPeriodStatus.currentPeriod.endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    <br />
                    <strong>Benefits Start Date:</strong> {new Date(enrollmentPeriodStatus.currentPeriod.benefitStartDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Typography>
                </>
              ) : (
                <>
                  <AlertTitle>Enrollment Period ended on {new Date(enrollmentPeriodStatus.currentPeriod.endDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</AlertTitle>
                  <Typography variant="body2">
                    Benefits started on {new Date(enrollmentPeriodStatus.currentPeriod.benefitStartDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Typography>
                </>
              )}
            </div>
            {(enrollmentPeriodStatus.currentPeriod.isActive || enrollmentPeriodStatus.currentPeriod.isUpcoming) && (
              <button
                onClick={() => {
                  console.log('🔍 Edit Period clicked - currentPeriod:', enrollmentPeriodStatus?.currentPeriod);
                  setEnrollmentPeriodModalOpen(true);
                }}
                className={`ml-4 px-3 py-1.5 text-sm rounded-lg transition-colors font-medium ${
                  enrollmentPeriodStatus.currentPeriod.isActive 
                    ? 'bg-white border border-green-300 text-green-700 hover:bg-green-50'
                    : 'bg-white border border-orange-300 text-orange-700 hover:bg-orange-50'
                }`}
              >
                Edit
              </button>
            )}
          </div>
        </Alert>
      )}

      {/* Payment Method Warning */}
      {!paymentLoading && !paymentValidation.hasValidPaymentMethod && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <AlertTitle>Payment Method Required</AlertTitle>
          <Typography variant="body2">
            You must add a valid payment method in the <strong>Billing</strong> tab before sending enrollment links to members. 
            This ensures proper billing setup for employee enrollments.
          </Typography>
        </Alert>
      )}

      {/* Info Alert */}
      {stats.totalMembers > 0 && stats.enrolledMembers < stats.totalMembers && paymentValidation.hasValidPaymentMethod && (
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
              {enrollmentTokens.length === 0 ? (
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
                        onClick={() => {
                          if (enrollmentPeriodStatus?.needsEnrollmentPeriod) {
                            setEnrollmentPeriodModalOpen(true);
                          } else if (enrollmentPeriodStatus?.currentPeriod?.isUpcoming) {
                            showSnackbar('Enrollment links cannot be sent until the enrollment period begins', 'warning');
                          } else {
                            setSendDialogOpen(true);
                          }
                        }}
                        disabled={
                          enrollmentPeriodStatus?.needsEnrollmentPeriod || 
                          enrollmentPeriodStatus?.currentPeriod?.isUpcoming ||
                          !paymentValidation.hasValidPaymentMethod
                        }
                        sx={{ textTransform: 'none' }}
                      >
                        Send First Links
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ) : (
                enrollmentTokens
                  .sort((a, b) => new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime())
                  .map((token) => (
                    <TableRow key={token.TokenId}>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <PersonIcon fontSize="small" color="action" />
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {token.MemberName}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {token.MemberEmail}
                            </Typography>
                          </Box>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <CalendarIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                          <Typography variant="body2">
                            {format(new Date(token.CreatedAt), 'MMM dd, yyyy h:mm a')}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <AccessTimeIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                          <Typography variant="body2">
                            {token.Status === 'Active' ? getTimeRemaining(token.ExpiresAt) : '-'}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={getStatusLabel(token.Status)}
                          color={getStatusColor(token.Status) as any}
                          size="small"
                          sx={{ fontWeight: 500 }}
                        />
                      </TableCell>
                      <TableCell align="center">
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          {token.Status === 'Active' && (
                            <>
                              <Tooltip title="Copy Link">
                                <IconButton
                                  size="small"
                                  onClick={() => copyEnrollmentLink(token.Token, token.MemberId)}
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
                          {token.Status === 'Used' && token.UsedAt && (
                            <Typography variant="caption" color="text.secondary">
                              Enrolled {format(new Date(token.UsedAt), 'MMM dd')}
                            </Typography>
                          )}
                          {token.Status === 'Expired' && (
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
        enrollmentPeriodActive={enrollmentPeriodStatus?.currentPeriod?.isActive ?? false}
        enrollmentPeriodEndDate={enrollmentPeriodStatus?.currentPeriod?.endDate ?? null}
        groupId={groupId}
      />

      {/* Set Enrollment Period Modal */}
      <SetEnrollmentPeriodModal
        isOpen={enrollmentPeriodModalOpen}
        onClose={() => {
          console.log('🔍 Closing modal');
          setEnrollmentPeriodModalOpen(false);
        }}
        groupId={groupId}
        groupName={groupName}
        existingPeriod={enrollmentPeriodStatus?.currentPeriod}
        onPeriodSet={() => {
          console.log('🔍 Period set, fetching status...');
          fetchEnrollmentPeriodStatus();
          showSnackbar(
            `Initial enrollment period ${enrollmentPeriodStatus?.currentPeriod ? 'updated' : 'set'} successfully`, 
            'success'
          );
        }}
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
