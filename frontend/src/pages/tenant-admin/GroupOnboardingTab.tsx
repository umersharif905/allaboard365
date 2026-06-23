import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Card,
  CardContent,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Stack,
  Grid,
  IconButton,
  Tooltip,
  Stepper,
  Step,
  StepLabel,
  StepContent,
  useTheme,
  alpha,
  CircularProgress,
} from '@mui/material';
import {
  Send as SendIcon,
  Link as LinkIcon,
  CheckCircle as CheckCircleIcon,
  Person as PersonIcon,
  Business as BusinessIcon,
  Assignment as AssignmentIcon,
  CalendarToday as CalendarIcon,
  AccessTime as AccessTimeIcon,
  ContentCopy as CopyIcon,
  Refresh as RefreshIcon,
  AccountBalance as AccountBalanceIcon,
  Description as DocumentIcon,
  Shield as ShieldIcon,
} from '@mui/icons-material';
import { format, addHours, isPast } from 'date-fns';

// Types
interface OnboardingToken {
  TokenId: string;
  Token: string;
  GroupId: string;
  Email: string;
  ExpiresAt: string;
  Used: boolean;
  CreatedAt: string;
  CreatedBy: string;
  UsedAt?: string;
  Status: 'Active' | 'Expired' | 'Used';
}

interface OnboardingData {
  GroupId: string;
  ContactName: string;
  ContactEmail: string;
  ContactPhone: string;
  BillingAddress: string;
  BillingCity: string;
  BillingState: string;
  BillingZip: string;
  BankName: string;
  AccountNumber: string;
  RoutingNumber: string;
  Documents: {
    W9: boolean;
    ParticipationAgreement: boolean;
  };
  SignatureDate?: string;
  SignedBy?: string;
  CompletedAt?: string;
}

interface GroupOnboardingTabProps {
  groupId: string;
  groupName: string;
}

// Send Onboarding Link Dialog
interface SendOnboardingDialogProps {
  open: boolean;
  onClose: () => void;
  onSend: (email: string, contactName: string) => void;
}

const SendOnboardingDialog: React.FC<SendOnboardingDialogProps> = ({ open, onClose, onSend }) => {
  const [email, setEmail] = useState('');
  const [contactName, setContactName] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (email && contactName) {
      setSending(true);
      await onSend(email, contactName);
      setSending(false);
      handleClose();
    }
  };

  const handleClose = () => {
    setEmail('');
    setContactName('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Send Onboarding Link
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 2 }}>
          <Alert severity="info">
            A secure onboarding link will be sent to the Group Admin. The link will expire in 7 days.
          </Alert>
          
          <TextField
            label="Contact Name"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            fullWidth
            required
            placeholder="John Smith"
          />
          
          <TextField
            label="Email Address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            fullWidth
            required
            placeholder="admin@company.com"
          />
          
          <Box sx={{ bgcolor: alpha('#2196f3', 0.05), p: 2, borderRadius: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
              The onboarding form will collect:
            </Typography>
            <Stack spacing={0.5}>
              <Typography variant="body2">• Group contact information & address</Typography>
              <Typography variant="body2">• Business type & tax ID number</Typography>
              <Typography variant="body2">• Credit card & ACH banking details</Typography>
              <Typography variant="body2">• Agent Service Agreement (if required)</Typography>
              <Typography variant="body2">• Account password setup</Typography>
            </Stack>
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
          disabled={!email || !contactName || sending}
          startIcon={sending ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          {sending ? 'Sending...' : 'Send Link'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const GroupOnboardingTab: React.FC<GroupOnboardingTabProps> = ({ groupId, groupName }) => {
  const theme = useTheme();
  
  // State
  const [onboardingTokens, setOnboardingTokens] = useState<OnboardingToken[]>([]);
  const [onboardingData, setOnboardingData] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // API Functions
  const fetchOnboardingStatus = async () => {
    try {
      setLoading(true);
      
      // Fetch onboarding tokens
      const tokensResponse = await fetch(`/api/groups/${groupId}/onboarding-tokens`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'Content-Type': 'application/json',
        },
      });

      if (tokensResponse.ok) {
        const tokensData = await tokensResponse.json();
        if (tokensData.success) {
          const tokens = (tokensData.data || []).map((token: any) => ({
            ...token,
            Status: token.Used ? 'Used' : isPast(new Date(token.ExpiresAt)) ? 'Expired' : 'Active',
          }));
          setOnboardingTokens(tokens);
        }
      } else if (tokensResponse.status === 404) {
        // API not implemented - use mock data
        setOnboardingTokens([]);
      }

      // Fetch onboarding data
      const dataResponse = await fetch(`/api/groups/${groupId}/onboarding-data`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'Content-Type': 'application/json',
        },
      });

      if (dataResponse.ok) {
        const data = await dataResponse.json();
        if (data.success && data.data) {
          setOnboardingData(data.data);
          setIsOnboarded(!!data.data.CompletedAt);
        }
      }
    } catch (error) {
      console.error('Error fetching onboarding status:', error);
      showSnackbar('Failed to load onboarding status', 'error');
    } finally {
      setLoading(false);
    }
  };

  const sendOnboardingLink = async (email: string, contactName: string) => {
    try {
      const response = await fetch(`/api/groups/${groupId}/send-onboarding-link`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          contactName,
          groupName,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          showSnackbar('Onboarding link sent successfully', 'success');
          fetchOnboardingStatus();
        } else {
          throw new Error(data.message || 'Failed to send link');
        }
      } else if (response.status === 404) {
        // Show placeholder success for demo
        showSnackbar('Onboarding link functionality coming soon', 'info');
        
        // Add mock token for demo
        const mockToken: OnboardingToken = {
          TokenId: `mock-${Date.now()}`,
          Token: 'abc123def456',
          GroupId: groupId,
          Email: email,
          ExpiresAt: addHours(new Date(), 72).toISOString(),
          Used: false,
          CreatedAt: new Date().toISOString(),
          CreatedBy: 'current-user',
          Status: 'Active',
        };
        setOnboardingTokens([mockToken, ...onboardingTokens]);
      } else {
        throw new Error('Failed to send onboarding link');
      }
    } catch (error) {
      console.error('Error sending onboarding link:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to send link', 'error');
    }
  };

  const copyOnboardingLink = (token: string) => {
    const link = `https://allaboard365.com/onboard/group?token=${token}`;
    navigator.clipboard.writeText(link);
    showSnackbar('Link copied to clipboard', 'success');
  };

  const resendOnboardingLink = async (tokenId: string) => {
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

  // Onboarding steps for the stepper
  const onboardingSteps = [
    {
      label: 'Send Onboarding Link',
      description: 'Send a secure link to the Group Admin',
      icon: <SendIcon />,
      completed: onboardingTokens.length > 0,
    },
    {
      label: 'Group Admin Completes Form',
      description: 'Contact info, billing address, ACH details',
      icon: <AssignmentIcon />,
      completed: onboardingData?.BillingAddress ? true : false,
    },
    {
      label: 'Upload Documents',
      description: 'W-9, Participation Agreement',
      icon: <DocumentIcon />,
      completed: onboardingData?.Documents?.W9 && onboardingData?.Documents?.ParticipationAgreement,
    },
    {
      label: 'Digital Signature',
      description: 'Sign and submit the onboarding form',
      icon: <ShieldIcon />,
      completed: onboardingData?.SignatureDate ? true : false,
    },
  ];

  const activeStep = onboardingSteps.findIndex(step => !step.completed);

  // Effects
  useEffect(() => {
    fetchOnboardingStatus();
  }, [groupId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Group Onboarding
          </Typography>
          <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
            Securely onboard {groupName} with digital forms and document collection
          </Typography>
        </Box>
        {!isOnboarded && (
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={() => setSendDialogOpen(true)}
            sx={{ textTransform: 'none' }}
          >
            Send Onboarding Link
          </Button>
        )}
      </Stack>

      {/* Onboarding Status */}
      {isOnboarded ? (
        <Alert 
          severity="success" 
          sx={{ mb: 3 }}
          icon={<CheckCircleIcon />}
        >
          <Stack>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Onboarding Complete!
            </Typography>
            <Typography variant="body2">
              {groupName} was successfully onboarded on {onboardingData?.CompletedAt && format(new Date(onboardingData.CompletedAt), 'MMMM dd, yyyy')}
            </Typography>
          </Stack>
        </Alert>
      ) : (
        <Alert 
          severity="info" 
          sx={{ mb: 3 }}
        >
          <Stack>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Onboarding In Progress
            </Typography>
            <Typography variant="body2">
              Send a secure link to the Group Admin to complete the onboarding process.
            </Typography>
          </Stack>
        </Alert>
      )}

      {/* Progress Stepper */}
      <Paper sx={{ p: 3, mb: 3, borderRadius: 2 }}>
        <Typography variant="h6" sx={{ mb: 3, fontWeight: 600 }}>
          Onboarding Progress
        </Typography>
        <Stepper activeStep={activeStep} orientation="vertical">
          {onboardingSteps.map((step, index) => (
            <Step key={step.label} completed={step.completed}>
              <StepLabel
                StepIconComponent={() => (
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: step.completed 
                        ? theme.palette.success.main 
                        : index === activeStep 
                        ? theme.palette.primary.main 
                        : theme.palette.grey[300],
                      color: 'white',
                    }}
                  >
                    {step.completed ? <CheckCircleIcon /> : step.icon}
                  </Box>
                )}
              >
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {step.label}
                </Typography>
              </StepLabel>
              <StepContent>
                <Typography variant="body2" color="text.secondary">
                  {step.description}
                </Typography>
              </StepContent>
            </Step>
          ))}
        </Stepper>
      </Paper>

      {/* Onboarding Links History */}
      <Paper sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ p: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Onboarding Links
            </Typography>
            <IconButton onClick={fetchOnboardingStatus} size="small">
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Box>
        
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Recipient</TableCell>
                <TableCell>Sent Date</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {onboardingTokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Stack alignItems="center" spacing={2}>
                      <LinkIcon sx={{ fontSize: 48, color: theme.palette.text.secondary }} />
                      <Typography variant="body1" color="text.secondary">
                        No onboarding links sent yet
                      </Typography>
                      <Button
                        variant="outlined"
                        startIcon={<SendIcon />}
                        onClick={() => setSendDialogOpen(true)}
                        sx={{ textTransform: 'none' }}
                      >
                        Send First Link
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ) : (
                onboardingTokens.map((token) => (
                  <TableRow key={token.TokenId}>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <PersonIcon fontSize="small" color="action" />
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {token.Email}
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
                        label={token.Status}
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
                                onClick={() => copyOnboardingLink(token.Token)}
                              >
                                <CopyIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Resend">
                              <IconButton
                                size="small"
                                onClick={() => resendOnboardingLink(token.TokenId)}
                              >
                                <SendIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </>
                        )}
                        {token.Status === 'Used' && token.UsedAt && (
                          <Typography variant="caption" color="text.secondary">
                            Used {format(new Date(token.UsedAt), 'MMM dd')}
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

      {/* Onboarding Data Summary (if completed) */}
      {isOnboarded && onboardingData && (
        <Grid container spacing={3} sx={{ mt: 3 }}>
          <Grid size={12}>
            <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
              Onboarding Information
            </Typography>
          </Grid>
          
          <Grid size={{ xs: 12, md: 6 }}>
            <Card sx={{ height: '100%', borderRadius: 2 }}>
              <CardContent>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
                  <BusinessIcon color="primary" />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    Contact Information
                  </Typography>
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="body2">
                    <strong>Name:</strong> {onboardingData.ContactName}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Email:</strong> {onboardingData.ContactEmail}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Phone:</strong> {onboardingData.ContactPhone}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          
          <Grid size={{ xs: 12, md: 6 }}>
            <Card sx={{ height: '100%', borderRadius: 2 }}>
              <CardContent>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
                  <AccountBalanceIcon color="primary" />
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    Banking Information
                  </Typography>
                </Stack>
                <Stack spacing={1}>
                  <Typography variant="body2">
                    <strong>Bank:</strong> {onboardingData.BankName}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Account:</strong> ••••{onboardingData.AccountNumber?.slice(-4)}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Routing:</strong> ••••{onboardingData.RoutingNumber?.slice(-4)}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* Send Onboarding Dialog */}
      <SendOnboardingDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        onSend={sendOnboardingLink}
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

export default GroupOnboardingTab;
