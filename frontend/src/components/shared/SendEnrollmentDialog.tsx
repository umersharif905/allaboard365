import {
    People as PeopleIcon,
    Person as PersonIcon,
    Search as SearchIcon,
    Send as SendIcon
} from '@mui/icons-material';
import {
    alpha,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    InputAdornment,
    Paper,
    Stack,
    TextField,
    Typography,
    useTheme
} from '@mui/material';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';

// Types
interface Member {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  Status: 'Active' | 'Inactive' | 'Terminated' | 'Pending' | 'Suspended';
  HasActiveEnrollment?: boolean;
}

interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: string;
  Description?: string;
  IsActive: boolean;
}

interface SendEnrollmentDialogProps {
  open: boolean;
  onClose: () => void;
  members: Member[];
  onSend: (memberIds: string[], templateId: string) => void;
  groupId: string;
  user?: any; // Add user as optional prop for debugging
}

const SendEnrollmentDialog: React.FC<SendEnrollmentDialogProps> = ({ 
  open, 
  onClose, 
  members, 
  onSend,
  groupId: _groupId,
  user: propUser
}) => {
  const { user: contextUser } = useAuth();
  const user = propUser || contextUser; // Use prop user if provided, otherwise use context
  
  // Debug: Log when component renders
  console.log('🔧 SendEnrollmentDialog rendered with open:', open);
  console.log('🔧 SendEnrollmentDialog user:', user);
  console.log('🔧 SendEnrollmentDialog members count:', members.length);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectAll, setSelectAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const theme = useTheme();

  // Fetch templates when dialog opens
  useEffect(() => {
    if (open) {
      console.log('🚀 SendEnrollmentDialog opened, fetching templates...');
      console.log('👤 Current user:', user);
      console.log('🎭 Current role:', user?.currentRole);
      console.log('🔍 User object keys:', user ? Object.keys(user) : 'No user object');
      console.log('🔍 User roles:', user?.roles);
      
      // Only fetch if user and currentRole are available
      if (user && user.currentRole) {
        console.log('✅ User context available, fetching templates immediately');
        fetchTemplates();
      } else {
        console.warn('⚠️ User or currentRole not available, waiting...');
        console.warn('⚠️ User exists:', !!user);
        console.warn('⚠️ CurrentRole exists:', !!user?.currentRole);
        console.warn('⚠️ User roles:', user?.roles);
        
        // Set a small delay to allow user context to load
        const timer = setTimeout(() => {
          console.log('🔄 Retry check - User:', !!user, 'CurrentRole:', !!user?.currentRole);
          if (user && user.currentRole) {
            console.log('🔄 Retrying template fetch after delay...');
            fetchTemplates();
          } else {
            console.error('❌ User context still not available after delay');
            console.error('❌ Final user state:', user);
            setTemplatesLoading(false);
          }
        }, 1000); // Increased delay to 1 second
        
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
        { templateType: 'Group', isActive: true },
        user.currentRole
      );
      
      console.log('📡 Service response:', response);
      
      if (response.success) {
        // Filter for Group type templates (double-check)
        const groupTemplates = (response.data?.data || []).filter((template: any) => 
          template.TemplateType === 'Group' && template.IsActive
        );
        
        // If no templates found, add some mock templates for testing
        if (groupTemplates.length === 0) {
          console.log('📋 No Group templates found, adding mock templates for testing');
          const mockTemplates = [
            {
              TemplateId: 'mock-template-1',
              TemplateName: 'Standard Group Enrollment',
              TemplateType: 'Group',
              Description: 'Standard enrollment template for group members',
              IsActive: true
            },
            {
              TemplateId: 'mock-template-2', 
              TemplateName: 'Premium Group Enrollment',
              TemplateType: 'Group',
              Description: 'Premium enrollment template with additional options',
              IsActive: true
            }
          ];
          setTemplates(mockTemplates);
          console.log('📋 Using mock templates:', mockTemplates);
        } else {
          setTemplates(groupTemplates);
          console.log('📋 Found Group templates:', groupTemplates);
        }
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
    m.Status === 'Active' && !(m.HasActiveEnrollment || false)
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
          <Box sx={{ 
            p: 2, 
            bgcolor: alpha(theme.palette.info.main, 0.1), 
            borderRadius: 1,
            border: `1px solid ${alpha(theme.palette.info.main, 0.2)}`
          }}>
            <Typography variant="body2" sx={{ color: theme.palette.info.main }}>
              Send secure enrollment links to selected members. Each link is unique and expires after 7 days.
            </Typography>
          </Box>

          {/* Template Selection */}
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 1, color: theme.palette.text.primary }}>
              Select Enrollment Template *
            </Typography>
            {templatesLoading ? (
              <Box sx={{ 
                p: 2, 
                bgcolor: alpha(theme.palette.info.main, 0.1), 
                borderRadius: 1,
                border: `1px solid ${alpha(theme.palette.info.main, 0.2)}`
              }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 1, color: theme.palette.info.main }}>
                  Loading templates...
                </Typography>
                <Typography variant="caption" sx={{ color: theme.palette.info.main, mb: 1, display: 'block' }}>
                  Fetching enrollment link templates for your role...
                </Typography>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, mb: 1, display: 'block' }}>
                  User Role: {user?.currentRole || 'Not available'} | 
                  User ID: {user?.userId || 'Not available'}
                </Typography>
                <Button 
                  onClick={() => fetchTemplates()} 
                  size="small"
                  sx={{ 
                    textTransform: 'none',
                    color: theme.palette.info.main,
                    textDecoration: 'underline',
                    minWidth: 'auto',
                    p: 0
                  }}
                >
                  Retry Loading
                </Button>
              </Box>
            ) : templates.length === 0 ? (
              <Box sx={{ 
                p: 2, 
                bgcolor: alpha(theme.palette.warning.main, 0.1), 
                borderRadius: 1,
                border: `1px solid ${alpha(theme.palette.warning.main, 0.2)}`
              }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 1, color: theme.palette.warning.main }}>
                  No Group-type enrollment templates found
                </Typography>
                <Typography variant="caption" sx={{ color: theme.palette.warning.main, mb: 1, display: 'block' }}>
                  You need to create a Group-type enrollment template before you can send enrollment links.
                </Typography>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, mb: 1, display: 'block' }}>
                  User Role: {user?.currentRole || 'Not available'} | 
                  User ID: {user?.userId || 'Not available'}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                  <Button 
                    onClick={() => fetchTemplates()} 
                    size="small"
                    variant="outlined"
                    sx={{ 
                      textTransform: 'none',
                      color: theme.palette.primary.main,
                      borderColor: theme.palette.primary.main
                    }}
                  >
                    Refresh Templates
                  </Button>
                  <Button 
                    onClick={() => {
                      // Navigate to templates page
                      window.open('/enrollment-link-templates', '_blank');
                    }}
                    size="small"
                    variant="contained"
                    sx={{ 
                      textTransform: 'none',
                      bgcolor: theme.palette.primary.main,
                      '&:hover': {
                        bgcolor: theme.palette.primary.dark,
                      }
                    }}
                  >
                    Create Template
                  </Button>
                </Stack>
              </Box>
            ) : (
              <TextField
                select
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: theme.palette.primary.main,
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: theme.palette.primary.main,
                  },
                }}
              >
                <option value="">Choose a template...</option>
                {templates.map((template) => (
                  <option key={template.TemplateId} value={template.TemplateId}>
                    {template.TemplateName} ({template.TemplateType})
                    {template.Description && ` - ${template.Description}`}
                  </option>
                ))}
              </TextField>
            )}
          </Box>

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
    </Dialog>
  );
};

export default SendEnrollmentDialog;
