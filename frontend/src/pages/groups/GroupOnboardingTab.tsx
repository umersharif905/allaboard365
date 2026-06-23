import {
    AccessTime as AccessTimeIcon,
    Business as BusinessIcon,
    CalendarToday as CalendarIcon,
    CheckCircle as CheckCircleIcon,
    ContentCopy as CopyIcon,
    Link as LinkIcon,
    Person as PersonIcon,
    Refresh as RefreshIcon,
    Send as SendIcon
} from '@mui/icons-material';
import {
    Alert,
    alpha,
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Paper,
    Snackbar,
    Stack,
    TextField,
    Typography,
    useTheme,
} from '@mui/material';
import { format } from 'date-fns';
import React, { useEffect, useState } from 'react';
import { GroupOnboardingService } from '../../services/group-onboarding.service';

// Types
interface OnboardingLink {
  linkId: string;
  groupId: string;
  linkToken: string;
  status: 'Active' | 'Expired' | 'Used';
  expiresAt: string;
  createdDate: string;
  usedDate?: string;
  createdBy: string;
  usedBy?: string;
  createdByName?: string;
  usedByName?: string;
  recipientEmail?: string;
  recipientName?: string;
}

interface OnboardingStatus {
  isOnboarded: boolean;
  groupAdmin?: {
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    onboardingCompletedDate: string;
  };
  completedDate?: string;
  currentLink?: OnboardingLink;
}

interface GroupOnboardingTabProps {
  groupId: string;
  groupName: string;
}

// Send Onboarding Link Dialog
interface SendOnboardingDialogProps {
  open: boolean;
  onClose: () => void;
  onSend: (email: string, contactFirstName: string, contactLastName: string) => void;
  initialEmail?: string;
  initialFirstName?: string;
  initialLastName?: string;
  isResend?: boolean;
}

const SendOnboardingDialog: React.FC<SendOnboardingDialogProps> = ({ 
  open, 
  onClose, 
  onSend, 
  initialEmail = '', 
  initialFirstName = '', 
  initialLastName = '',
  isResend = false 
}) => {
  const [email, setEmail] = useState('');
  const [contactFirstName, setContactFirstName] = useState('');
  const [contactLastName, setContactLastName] = useState('');
  const [sending, setSending] = useState(false);

  // Populate form fields when dialog opens with initial values
  useEffect(() => {
    if (open) {
      setEmail(initialEmail);
      setContactFirstName(initialFirstName);
      setContactLastName(initialLastName);
    }
  }, [open, initialEmail, initialFirstName, initialLastName]);

  const handleSend = async () => {
    console.log('🚀 Dialog: handleSend called with:', { email, contactFirstName, contactLastName });
    if (email && contactFirstName && contactLastName) {
      console.log('✅ Dialog: All fields filled, calling onSend');
      setSending(true);
      try {
        await onSend(email, contactFirstName, contactLastName);
        console.log('✅ Dialog: onSend completed successfully');
        handleClose();
      } catch (error) {
        console.error('❌ Dialog: Error in handleSend:', error);
      } finally {
        setSending(false);
      }
    } else {
      console.log('❌ Dialog: Missing fields:', { email, contactFirstName, contactLastName });
    }
  };

  const handleClose = () => {
    setEmail('');
    setContactFirstName('');
    setContactLastName('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {isResend ? 'Resend Onboarding Link' : 'Send Onboarding Link'}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 2 }}>
          <Alert severity="info">
            A secure onboarding link will be sent to the Group Admin. The link will expire in 7 days.
          </Alert>
          
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label="First Name"
              value={contactFirstName}
              onChange={(e) => setContactFirstName(e.target.value)}
              fullWidth
              required
              placeholder="John"
            />
            
            <TextField
              label="Last Name"
              value={contactLastName}
              onChange={(e) => setContactLastName(e.target.value)}
              fullWidth
              required
              placeholder="Smith"
            />
          </Box>
          
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
          disabled={!email || !contactFirstName || !contactLastName || sending}
          startIcon={sending ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          {sending ? (isResend ? 'Resending...' : 'Sending...') : (isResend ? 'Resend Link' : 'Send Link')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};


const GroupOnboardingTab: React.FC<GroupOnboardingTabProps> = ({ groupId, groupName }) => {
  const theme = useTheme();
  
  // State
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyingLink, setCopyingLink] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // API Functions
  const fetchOnboardingStatus = async () => {
    try {
      setLoading(true);
      
      // Fetch onboarding status (includes current link info)
      const statusResponse = await GroupOnboardingService.getOnboardingStatus(groupId);
      console.log('📊 Frontend: fetchOnboardingStatus response:', statusResponse);
      if (statusResponse.success) {
        console.log('📊 Frontend: Setting onboarding status data:', statusResponse.data);
        setOnboardingStatus(statusResponse.data);
      }
    } catch (error) {
      console.error('Error fetching onboarding status:', error);
      showSnackbar('Failed to load onboarding status', 'error');
    } finally {
      setLoading(false);
    }
  };

  const sendOnboardingLink = async (email: string, contactFirstName: string, contactLastName: string) => {
    try {
      const contactName = `${contactFirstName} ${contactLastName}`.trim();
      console.log('🚀 Frontend: Sending onboarding link with:', {
        groupId,
        email,
        contactName,
        contactFirstName,
        contactLastName
      });
      
      const response = await GroupOnboardingService.createOnboardingLink(
        groupId, 
        true, // sendEmail
        email,
        contactName
      );
      
      console.log('📥 Frontend: Received response:', response);

      if (response.success) {
        const isResend = !!onboardingStatus?.currentLink;
        showSnackbar(isResend ? 'Onboarding link resent successfully!' : 'Onboarding link sent successfully!', 'success');
        // Add a small delay to ensure database is updated before fetching status
        setTimeout(() => {
          fetchOnboardingStatus();
        }, 500);
      } else {
        throw new Error(response.message || 'Failed to create onboarding link');
      }
    } catch (error) {
      console.error('Error sending onboarding link:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to send link', 'error');
    }
  };

  const copyOnboardingLink = async (token: string) => {
    const currentLink = onboardingStatus?.currentLink;
    
    // Check if link is expired
    const isExpired = currentLink?.status === 'Expired' || 
      (currentLink?.expiresAt && new Date(currentLink.expiresAt) < new Date());
    
    if (isExpired) {
      // Generate a new link if expired
      setCopyingLink(true);
      try {
        const recipientEmail = currentLink?.recipientEmail || '';
        const recipientName = currentLink?.recipientName || '';
        
        // Split name into first and last name
        const nameParts = recipientName.trim().split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        
        const response = await GroupOnboardingService.createOnboardingLink(
          groupId,
          false, // Don't send email when generating for copy
          recipientEmail || undefined,
          recipientName || undefined
        );
        
        if (response.success && response.data?.linkToken) {
          const newLink = `${window.location.origin}/group-onboarding/${response.data.linkToken}`;
          navigator.clipboard.writeText(newLink);
          showSnackbar('New link generated and copied to clipboard', 'success');
          // Refresh status to show the new link
          setTimeout(() => {
            fetchOnboardingStatus();
          }, 500);
        } else {
          throw new Error(response.message || 'Failed to generate new link');
        }
      } catch (error) {
        console.error('Error generating new link:', error);
        showSnackbar(error instanceof Error ? error.message : 'Failed to generate new link', 'error');
      } finally {
        setCopyingLink(false);
      }
    } else {
      // Link is still valid, just copy it
      const link = `${window.location.origin}/group-onboarding/${token}`;
      navigator.clipboard.writeText(link);
      showSnackbar('Link copied to clipboard', 'success');
    }
  };


  const resendOnboardingLink = async () => {
    // Open the send dialog with current recipient info pre-filled
    setSendDialogOpen(true);
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
        return 'Onboarded';
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

  // Calculate onboarding completion status

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
            Onboard Group Admin accounts to {groupName} with digital forms and document collection
          </Typography>
        </Box>
        {!onboardingStatus?.isOnboarded && (
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
      {onboardingStatus?.isOnboarded ? (
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
              {groupName} was successfully onboarded on {onboardingStatus.completedDate ? 
                format(new Date(onboardingStatus.completedDate), 'MMMM dd, yyyy') : 
                'Date not available'}
              {onboardingStatus.groupAdmin && (
                <span> by {onboardingStatus.groupAdmin.firstName} {onboardingStatus.groupAdmin.lastName}</span>
              )}
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


      {/* Current Onboarding Link */}
      <Paper sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ p: 3, borderBottom: `1px solid ${theme.palette.divider}` }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Onboarding Link
            </Typography>
            <IconButton onClick={fetchOnboardingStatus} size="small">
              <RefreshIcon />
            </IconButton>
          </Stack>
        </Box>
        
        {!onboardingStatus?.currentLink ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Stack alignItems="center" spacing={2}>
              <LinkIcon sx={{ fontSize: 48, color: theme.palette.text.secondary }} />
              <Typography variant="body1" color="text.secondary">
                No onboarding link sent yet
              </Typography>
              <Button
                variant="outlined"
                startIcon={<SendIcon />}
                onClick={() => setSendDialogOpen(true)}
                sx={{ textTransform: 'none' }}
              >
                Send Onboarding Link
              </Button>
            </Stack>
          </Box>
        ) : (
          <Box sx={{ p: 3 }}>
            <Stack spacing={3}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={3}>
                <Box sx={{ flex: 1 }}>
                  <Stack spacing={2}>
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                        Recipient
                      </Typography>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <PersonIcon fontSize="small" color="action" />
                        <Stack>
                          <Typography variant="body1" sx={{ fontWeight: 500 }}>
                            {onboardingStatus.currentLink.recipientName || 'No recipient specified'}
                          </Typography>
                          {onboardingStatus.currentLink.recipientEmail ? (
                            <Typography variant="body2" color="text.secondary">
                              {onboardingStatus.currentLink.recipientEmail}
                            </Typography>
                          ) : (
                            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                              No email specified
                            </Typography>
                          )}
                        </Stack>
                      </Stack>
                    </Box>
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                        Sent Date
                      </Typography>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <CalendarIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                        <Typography variant="body2">
                          {onboardingStatus.currentLink.createdDate ? 
                            format(new Date(onboardingStatus.currentLink.createdDate), 'MMM dd, yyyy h:mm a') : 
                            'Date not available'}
                        </Typography>
                      </Stack>
                    </Box>
                  </Stack>
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Stack spacing={2}>
                    <Box>
                      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                        Status
                      </Typography>
                      <Chip
                        label={onboardingStatus.isOnboarded ? 'Onboarding Complete' : getStatusLabel(onboardingStatus.currentLink.status)}
                        color={onboardingStatus.isOnboarded ? 'success' : getStatusColor(onboardingStatus.currentLink.status) as any}
                        size="small"
                        sx={{ fontWeight: 500 }}
                      />
                    </Box>
                    {onboardingStatus.currentLink.status === 'Active' && (
                      <Box>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                          Expires
                        </Typography>
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <AccessTimeIcon sx={{ fontSize: 16, color: theme.palette.text.secondary }} />
                          <Typography variant="body2">
                            {getTimeRemaining(onboardingStatus.currentLink.expiresAt)}
                          </Typography>
                        </Stack>
                      </Box>
                    )}
                    {onboardingStatus.isOnboarded && onboardingStatus.completedDate && (
                      <Box>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                          Completed Date
                        </Typography>
                        <Typography variant="body2">
                          {format(new Date(onboardingStatus.completedDate), 'MMM dd, yyyy h:mm a')}
                        </Typography>
                      </Box>
                    )}
                  </Stack>
                </Box>
              </Stack>
              <Box>
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {onboardingStatus.currentLink.status === 'Active' && (
                    <>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={copyingLink ? <CircularProgress size={16} /> : <CopyIcon />}
                        onClick={() => copyOnboardingLink(onboardingStatus.currentLink!.linkToken)}
                        disabled={copyingLink}
                        sx={{ textTransform: 'none' }}
                      >
                        {copyingLink ? 'Generating...' : 'Copy Link'}
                      </Button>
                      <Button
                        variant="contained"
                        size="small"
                        startIcon={<SendIcon />}
                        onClick={resendOnboardingLink}
                        sx={{ textTransform: 'none' }}
                      >
                        Resend Link
                      </Button>
                    </>
                  )}
                  {onboardingStatus.currentLink.status === 'Expired' && (
                    <Button
                      variant="contained"
                      size="small"
                      startIcon={<SendIcon />}
                      onClick={resendOnboardingLink}
                      sx={{ textTransform: 'none' }}
                    >
                      Resend Link
                    </Button>
                  )}
                  {onboardingStatus.currentLink.status === 'Used' && (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<SendIcon />}
                      onClick={resendOnboardingLink}
                      sx={{ textTransform: 'none' }}
                    >
                      Send New Link
                    </Button>
                  )}
                </Stack>
              </Box>
            </Stack>
          </Box>
        )}
      </Paper>

      {/* Onboarding Data Summary (if completed) */}
      {onboardingStatus?.isOnboarded && onboardingStatus.groupAdmin && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
            Onboarding Information
          </Typography>
          
          <Card sx={{ borderRadius: 2, maxWidth: 600 }}>
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
                <BusinessIcon color="primary" />
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Group Administrator
                </Typography>
              </Stack>
              <Stack spacing={1}>
                <Typography variant="body2">
                  <strong>Name:</strong> {onboardingStatus.groupAdmin.firstName} {onboardingStatus.groupAdmin.lastName}
                </Typography>
                <Typography variant="body2">
                  <strong>Email:</strong> {onboardingStatus.groupAdmin.email}
                </Typography>
                <Typography variant="body2">
                  <strong>Completed:</strong> {onboardingStatus.groupAdmin.onboardingCompletedDate ? 
                    format(new Date(onboardingStatus.groupAdmin.onboardingCompletedDate), 'MMMM dd, yyyy') : 
                    'Date not available'}
                </Typography>
              </Stack>
            </CardContent>
          </Card>
        </Box>
      )}

      {/* Send Onboarding Dialog */}
      <SendOnboardingDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        onSend={sendOnboardingLink}
        initialEmail={onboardingStatus?.currentLink?.recipientEmail || ''}
        initialFirstName={onboardingStatus?.currentLink?.recipientName?.split(' ')[0] || ''}
        initialLastName={onboardingStatus?.currentLink?.recipientName?.split(' ').slice(1).join(' ') || ''}
        isResend={!!onboardingStatus?.currentLink}
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

