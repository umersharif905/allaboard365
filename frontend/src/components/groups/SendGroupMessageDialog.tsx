// frontend/src/components/groups/SendGroupMessageDialog.tsx
import {
  Close as CloseIcon,
  Person as PersonIcon,
  Phone as PhoneIcon,
  Search as SearchIcon,
  Send as SendIcon
} from '@mui/icons-material';
import {
  Alert,
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
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
  useTheme
} from '@mui/material';
import { Eye as EyeIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { GroupsService } from '../../services/groups.service';
import { messageTemplateService, type MessageTemplate } from '../../services/messageCenter.service';
import { ApiResponse } from '../../types/api.types';
import { Member } from '../../types/member.types';
import RichTextEditor, { RichTextEditorRef } from '../common/RichTextEditor';

interface SendGroupMessageDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (message: string) => void;
  groupId: string;
  groupName: string;
  initialFilters?: {
    enrollmentStatus?: string;
    locationId?: string;
    showTerminated?: boolean;
    search?: string;
  };
}

interface SenderOption {
  type: 'current_user' | 'agent' | 'group_admin' | 'custom';
  email: string;
  name: string;
}

interface TemplatePreview {
  subject: string;
  body: string;
}

const SendGroupMessageDialog: React.FC<SendGroupMessageDialogProps> = ({
  open,
  onClose,
  onSuccess,
  groupId,
  groupName,
  initialFilters,
}) => {
  const { user } = useAuth();
  const theme = useTheme();

  // State
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [customSubject, setCustomSubject] = useState<string>('');
  const [customBody, setCustomBody] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>(initialFilters?.search || '');
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [sendSMS, setSendSMS] = useState(false);
  const [phoneNumbers, setPhoneNumbers] = useState<Record<string, string>>({});
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [loadingAllMembers, setLoadingAllMembers] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [memberFilter, setMemberFilter] = useState<string>(initialFilters?.enrollmentStatus || 'all');
  const [locationFilter, setLocationFilter] = useState<string>(initialFilters?.locationId || 'all');
  const [showTerminated] = useState<boolean>(false); // Always show only active members
  const [useFilterMode, setUseFilterMode] = useState<boolean>(false); // If true, send to all matching members via filters
  const [locations, setLocations] = useState<Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string; IsPrimary?: boolean }>>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  
  // Reply-to and From options
  const [senderOptions, setSenderOptions] = useState<SenderOption[]>([]);
  const [selectedReplyTo, setSelectedReplyTo] = useState<string>('current_user');
  const [customReplyToEmail, setCustomReplyToEmail] = useState<string>('');
  const [selectedFromName, setSelectedFromName] = useState<string>('current_user');
  const [customFromName, setCustomFromName] = useState<string>('');
  const [loadingSenderOptions, setLoadingSenderOptions] = useState(false);
  
  // Template preview
  const [templatePreview, setTemplatePreview] = useState<TemplatePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  
  // Rich text editor ref
  const richTextEditorRef = React.useRef<RichTextEditorRef>(null);

  // Fetch members and locations when dialog opens or filters change
  useEffect(() => {
    if (open && groupId) {
      fetchMembers();
      fetchTemplates();
      fetchSenderOptions();
      fetchLocations();
    }
  }, [open, groupId, memberFilter, locationFilter, showTerminated, searchTerm]);
  
  // Fetch locations for location filter
  const fetchLocations = async () => {
    try {
      setLocationsLoading(true);
      const response = await apiService.get<ApiResponse<Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string; IsPrimary?: boolean; Status?: string }>>>(
        `/api/groups/${groupId}/locations`
      );
      if (response.success && response.data) {
        // Filter to only Active locations
        const activeLocations = response.data.filter(loc => !loc.Status || loc.Status === 'Active');
        setLocations(activeLocations);
      }
    } catch (error) {
      console.error('Error fetching locations:', error);
      setLocations([]);
    } finally {
      setLocationsLoading(false);
    }
  };

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedMembers([]);
      setSelectedTemplate('');
      setCustomSubject('');
      setCustomBody('');
      setSearchTerm(initialFilters?.search || '');
      setMemberFilter(initialFilters?.enrollmentStatus || 'all');
      setLocationFilter(initialFilters?.locationId || 'all');
      setUseFilterMode(false);
      setSendEmail(true);
      setSendSMS(false);
      setPhoneNumbers({});
      setSelectedReplyTo('current_user');
      setCustomReplyToEmail('');
      setSelectedFromName('current_user');
      setCustomFromName('');
      setTemplatePreview(null);
      setShowPreview(false);
    }
  }, [open, initialFilters]);

  // Fetch members using message-recipients endpoint with filters (server-side filtering)
  const fetchMembers = async () => {
    try {
      setLoadingAllMembers(true);
      
      // Use message-recipients endpoint which supports server-side filtering
      const response = await GroupsService.getGroupMessageRecipients(groupId, {
        enrollmentStatus: memberFilter !== 'all' ? memberFilter : undefined,
        locationId: locationFilter !== 'all' ? locationFilter : undefined,
        showTerminated: showTerminated,
        search: searchTerm.trim() || undefined,
      });

      if (response.success && response.data) {
        // Store members (already filtered server-side)
        setAllMembers(response.data.members || []);
      } else {
        setAllMembers([]);
      }
      
      // Also fetch status counts for filter dropdown (need all members for counts)
      try {
        const countsResponse = await apiService.get<ApiResponse<{ members: Member[]; statusCounts: any; pagination: any }>>(
          `/api/groups/${groupId}/members?page=1&pageSize=10000&showTerminated=${showTerminated}`
        );
        
        if (countsResponse.success && countsResponse.data?.statusCounts) {
          setStatusCounts(countsResponse.data.statusCounts);
        } else {
          // Calculate status counts from members if not provided
          const allPrimaryMembers = countsResponse.data?.members?.filter((m: Member) => m.RelationshipType === 'P') || [];
          const counts: Record<string, number> = {};
          allPrimaryMembers.forEach((m: Member) => {
            const status = m.EnrollmentStatus || 'Not Enrolled';
            counts[status] = (counts[status] || 0) + 1;
          });
          setStatusCounts(counts);
        }
      } catch (error) {
        console.error('Error fetching status counts:', error);
      }
    } catch (error) {
      console.error('Error fetching members:', error);
      setAllMembers([]);
    } finally {
      setLoadingAllMembers(false);
    }
  };

  const fetchTemplates = async () => {
    try {
      setTemplatesLoading(true);
      
      if (!user?.currentRole) {
        setTemplatesLoading(false);
        return;
      }

      const response = await messageTemplateService.getTemplates({
        page: 1,
        limit: 100,
        isActive: true,
      });

      if (response.success && response.data) {
        // Filter to Email and SMS templates
        const filteredTemplates = (response.data.data || []).filter(
          (template: MessageTemplate) => template.messageType === 'Email' || template.messageType === 'SMS'
        );
        setTemplates(filteredTemplates);
      } else {
        setTemplates([]);
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const fetchSenderOptions = async () => {
    try {
      setLoadingSenderOptions(true);
      const response = await GroupsService.getGroupMessageSenderOptions(groupId);
      
      if (response.success && response.data) {
        const options = (response.data.options || []).map((opt: any) => ({
          type: (opt.type === 'current_user' || opt.type === 'agent' || opt.type === 'group_admin' || opt.type === 'custom') 
            ? opt.type 
            : 'custom' as const,
          email: opt.email || '',
          name: opt.name || '',
        }));
        setSenderOptions(options);
      } else {
        // Set default options if API fails
        setSenderOptions([
          {
            type: 'current_user' as const,
            email: user?.email || '',
            name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Current User',
          },
        ]);
      }
    } catch (error) {
      console.error('Error fetching sender options:', error);
      // Set default options on error
      setSenderOptions([
        {
          type: 'current_user',
          email: user?.email || '',
          name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Current User',
        },
      ]);
    } finally {
      setLoadingSenderOptions(false);
    }
  };

  const handlePreviewTemplate = async () => {
    if (!selectedTemplate) return;

    try {
      setPreviewLoading(true);
      const response = await GroupsService.previewGroupMessageTemplate(groupId, selectedTemplate);
      
      if (response.success && response.data) {
        setTemplatePreview({
          subject: response.data.subject || '',
          body: response.data.body || '',
        });
        setShowPreview(true);
      }
    } catch (error) {
      console.error('Error previewing template:', error);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Members are already filtered server-side, so just use allMembers
  // Client-side filtering is only for display/search within the loaded set
  const getFilteredMembers = () => {
    // Additional client-side search if needed (server already did search, but this helps with typing)
    if (searchTerm.trim()) {
      return allMembers.filter(m =>
        `${m.FirstName} ${m.LastName} ${m.Email} ${m.PhoneNumber || ''}`.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    return allMembers;
  };
  
  const filteredMembers = getFilteredMembers();
  
  // Determine if we should use filter mode (send to all matching, not just selected)
  // Use filter mode if:
  // 1. No members are manually selected, OR
  // 2. A filter is active (not "all") and we want to send to all matching members
  const shouldUseFilterMode = () => {
    // If filters are active (not "all"), use filter mode to send to all matching members
    if (memberFilter !== 'all' || locationFilter !== 'all' || searchTerm.trim()) {
      return useFilterMode || selectedMembers.length === 0;
    }
    // If no filters, use member selection mode
    return false;
  };

  // Count members with phone numbers
  const membersWithPhone = filteredMembers.filter(m => m.PhoneNumber && m.PhoneNumber.trim() !== '').length;

  const handleSelectMember = (memberId: string, checked: boolean) => {
    if (checked) {
      setSelectedMembers([...selectedMembers, memberId]);
    } else {
      setSelectedMembers(selectedMembers.filter(id => id !== memberId));
    }
  };

  const handleSend = async () => {
    // Validate: either selectedMembers or filters must be provided
    const usingFilterMode = shouldUseFilterMode();
    
    if (!usingFilterMode && selectedMembers.length === 0) {
      return; // Need either selected members or active filters
    }
    
    // Validate delivery methods
    if (!sendEmail && !sendSMS) {
      return;
    }

    // Validate SMS phone numbers (only for manually selected members)
    if (sendSMS && !usingFilterMode) {
      const membersWithoutPhone = selectedMembers.filter(memberId => {
        const member = filteredMembers.find(m => m.MemberId === memberId);
        return !member?.PhoneNumber && !phoneNumbers[memberId];
      });
      
      if (membersWithoutPhone.length > 0) {
        return; // Show error
      }
    }

    // Validate template or custom content
    // If template is selected, backend will validate it
    // If no template, custom subject and body are required
    if (!selectedTemplate && (!customSubject.trim() || !customBody.trim())) {
      return; // No template selected but custom content is missing
    }

    // Get reply-to and from email/name
    const replyToOption = senderOptions.find(opt => opt.type === selectedReplyTo);
    const fromNameOption = senderOptions.find(opt => opt.type === selectedFromName);
    
    const replyToEmail = selectedReplyTo === 'custom' 
      ? customReplyToEmail 
      : (replyToOption?.email || user?.email || '');
    
    const fromEmail = replyToEmail; // From email same as reply-to
    const fromName = selectedFromName === 'custom'
      ? customFromName
      : (fromNameOption?.name || `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Current User');

    try {
      setSending(true);
      
      // Build request data - use filters if in filter mode, otherwise use memberIds
      const requestData: any = {
        templateId: selectedTemplate || undefined,
        subject: selectedTemplate ? undefined : customSubject,
        body: selectedTemplate ? undefined : customBody,
        deliveryPreferences: {
          sendEmail,
          sendSMS,
        },
        phoneNumbers: sendSMS && !usingFilterMode ? phoneNumbers : undefined, // Only pass phoneNumbers for manually selected members
        replyToEmail,
        fromEmail,
        fromName,
      };
      
      if (usingFilterMode) {
        // Send to all members matching filters (server-side)
        requestData.filters = {
          enrollmentStatus: memberFilter !== 'all' ? memberFilter : undefined,
          locationId: locationFilter !== 'all' ? locationFilter : undefined,
          showTerminated: showTerminated,
          search: searchTerm.trim() || undefined,
        };
      } else {
        // Send to manually selected members
        requestData.memberIds = selectedMembers;
      }
      
      const response = await GroupsService.sendGroupMessage(groupId, requestData);

      if (response.success) {
        const deliveryMethods = [];
        if (sendEmail) deliveryMethods.push('email');
        if (sendSMS) deliveryMethods.push('text message');
        const methodsText = deliveryMethods.join(' and ');
        
        const totalSentTo = response.data?.totalMembers || (usingFilterMode ? allMembers.length : selectedMembers.length);
        const messagesQueued = response.data?.messagesQueued || 0;
        const emailsQueued = response.data?.emailsQueued || 0;
        const smsQueued = response.data?.smsQueued || 0;
        const successMessage = `Successfully queued ${messagesQueued} message(s) (${emailsQueued} email${emailsQueued !== 1 ? 's' : ''}, ${smsQueued} SMS${smsQueued !== 1 ? 'es' : ''}) to ${totalSentTo} member${totalSentTo !== 1 ? 's' : ''}`;
        
        if (onSuccess) {
          onSuccess(successMessage);
        }
        onClose();
      } else {
        console.error('Failed to send message:', response.message);
        // Error feedback will be handled by parent component if needed
      }
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  const handlePhoneNumberChange = (memberId: string, phoneNumber: string) => {
    setPhoneNumbers(prev => ({
      ...prev,
      [memberId]: phoneNumber,
    }));
  };

  const getSelectedTemplate = () => {
    return templates.find(t => t.templateId === selectedTemplate);
  };

  const selectedTemplateData = getSelectedTemplate();

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Send Message to Group Members
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 1 }}>
          <Alert severity="info">
            Send email or text messages to selected group members. You can use a template or create a custom message.
          </Alert>

          {/* Template Selection */}
          <Box>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Template (Optional)
            </label>
              {templatesLoading ? (
                <div className="animate-pulse h-10 bg-gray-200 rounded"></div>
              ) : templates.length === 0 ? (
                <div className="text-sm text-gray-600 bg-gray-50 p-3 rounded border border-gray-200">
                  <div className="font-medium mb-1">No templates available</div>
                  <div className="text-xs text-gray-500">
                    You can create a template in the Message Center or use custom subject/body below.
                  </div>
                </div>
              ) : (
                <Stack spacing={2}>
                  <Select
                    value={selectedTemplate}
                    onChange={(e) => setSelectedTemplate(e.target.value)}
                    displayEmpty
                    fullWidth
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: '#1f8dbf',
                        },
                      },
                    }}
                  >
                    <MenuItem value="">
                      <em>No template (use custom message below)</em>
                    </MenuItem>
                    {templates.map((template) => (
                      <MenuItem key={template.templateId} value={template.templateId}>
                        {template.templateName} ({template.messageType})
                        {template.category && ` - ${template.category}`}
                      </MenuItem>
                    ))}
                  </Select>
                  
                  {selectedTemplate && (
                    <Button
                      variant="outlined"
                      startIcon={<EyeIcon />}
                      onClick={handlePreviewTemplate}
                      disabled={previewLoading}
                      sx={{ textTransform: 'none' }}
                    >
                      {previewLoading ? 'Loading Preview...' : 'Preview Template'}
                    </Button>
                  )}

                  {showPreview && templatePreview && (
                    <Paper sx={{ p: 2, bgcolor: alpha('#1f8dbf', 0.05) }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                        Template Preview
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                        Subject: {templatePreview.subject}
                      </Typography>
                      <Box
                        sx={{
                          mt: 1,
                          p: 2,
                          bgcolor: 'white',
                          border: `1px solid ${theme.palette.divider}`,
                          borderRadius: 1,
                          maxHeight: 300,
                          overflow: 'auto',
                        }}
                        dangerouslySetInnerHTML={{ __html: templatePreview.body }}
                      />
                      <Button
                        size="small"
                        onClick={() => setShowPreview(false)}
                        sx={{ mt: 1, textTransform: 'none' }}
                      >
                        Close Preview
                      </Button>
                    </Paper>
                  )}
                </Stack>
              )}
            </Box>

          {/* Custom Subject/Body - shown when no template selected */}
          {!selectedTemplate && (
            <Stack spacing={2}>
              <TextField
                label="Subject *"
                value={customSubject}
                onChange={(e) => setCustomSubject(e.target.value)}
                fullWidth
                required
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#1f8dbf',
                    },
                  },
                }}
              />
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                  Message Body *
                </Typography>
                
                {/* Variable Insert Buttons */}
                <Box sx={{ mb: 2, p: 1.5, bgcolor: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb' }}>
                  <Typography variant="caption" sx={{ fontWeight: 600, mb: 1, display: 'block', color: '#374151' }}>
                    Insert Variables:
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[member.FirstName]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Member First Name
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[member.LastName]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Member Last Name
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[member.FullName]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Member Full Name
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[member.Email]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Member Email
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[member.Phone]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Member Phone
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[group.Name]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Group Name
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[system.CurrentDate]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Current Date
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => richTextEditorRef.current?.insertText('{[system.CurrentYear]}')}
                      sx={{
                        textTransform: 'none',
                        fontSize: '0.75rem',
                        py: 0.5,
                        px: 1,
                        borderColor: '#d1d5db',
                        color: '#374151',
                        '&:hover': {
                          borderColor: '#1f8dbf',
                          bgcolor: '#f0f9ff',
                        },
                      }}
                    >
                      Current Year
                    </Button>
                  </Stack>
                </Box>
                
                <RichTextEditor
                  ref={richTextEditorRef}
                  value={customBody}
                  onChange={setCustomBody}
                  placeholder="Enter your message here. Click the buttons above to insert variables, or use the toolbar to format your text."
                  minHeight={250}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  Tip: Click the variable buttons above to insert placeholders. Use the formatting toolbar to add bold text, headings, links, and lists.
                </Typography>
              </Box>
            </Stack>
          )}

          {/* Reply-to Email */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Reply-to Email *
            </Typography>
            <Stack spacing={2}>
              {loadingSenderOptions ? (
                <div className="animate-pulse h-10 bg-gray-200 rounded"></div>
              ) : (
                <>
                  <Select
                    value={selectedReplyTo}
                    onChange={(e) => setSelectedReplyTo(e.target.value)}
                    fullWidth
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: '#1f8dbf',
                        },
                      },
                    }}
                  >
                    {senderOptions.map((option) => (
                      <MenuItem key={option.type} value={option.type}>
                        {option.name} ({option.email})
                      </MenuItem>
                    ))}
                    <MenuItem value="custom">Custom Email</MenuItem>
                  </Select>
                </>
              )}
              
              {selectedReplyTo === 'custom' && (
                <TextField
                  label="Custom Reply-to Email *"
                  type="email"
                  value={customReplyToEmail}
                  onChange={(e) => setCustomReplyToEmail(e.target.value)}
                  fullWidth
                  required
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      '&.Mui-focused fieldset': {
                        borderColor: '#1f8dbf',
                      },
                    },
                  }}
                />
              )}
            </Stack>
          </Box>

          {/* From Name */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              From Name *
            </Typography>
            <Stack spacing={2}>
              {loadingSenderOptions ? (
                <div className="animate-pulse h-10 bg-gray-200 rounded"></div>
              ) : (
                <>
                  <Select
                    value={selectedFromName}
                    onChange={(e) => setSelectedFromName(e.target.value)}
                    fullWidth
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: '#1f8dbf',
                        },
                      },
                    }}
                  >
                    {senderOptions.map((option) => (
                      <MenuItem key={option.type} value={option.type}>
                        {option.name}
                      </MenuItem>
                    ))}
                    <MenuItem value="custom">Custom Name</MenuItem>
                  </Select>
                </>
              )}
              
              {selectedFromName === 'custom' && (
                <TextField
                  label="Custom From Name *"
                  value={customFromName}
                  onChange={(e) => setCustomFromName(e.target.value)}
                  fullWidth
                  required
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      '&.Mui-focused fieldset': {
                        borderColor: '#1f8dbf',
                      },
                    },
                  }}
                />
              )}
            </Stack>
          </Box>

          {/* Delivery Method Selection */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Delivery Method *
            </Typography>
            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                  />
                }
                label="Send via Email"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={sendSMS}
                    onChange={(e) => setSendSMS(e.target.checked)}
                    disabled={membersWithPhone === 0}
                  />
                }
                label={
                  <span>
                    Send via Text Message (SMS)
                    {filteredMembers.length > 0 && (
                      <span className="text-xs text-gray-500 ml-1">
                        ({membersWithPhone}/{filteredMembers.length} members have phone numbers)
                      </span>
                    )}
                  </span>
                }
              />
            </Stack>
            {!sendEmail && !sendSMS && (
              <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
                Please select at least one delivery method
              </Typography>
            )}
          </Box>

          {/* Filters Section */}
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
              Filter Recipients
            </Typography>
            <Stack spacing={2}>
              {/* Enrollment Status Filter */}
              <FormControl fullWidth>
                <InputLabel>Filter Recipients</InputLabel>
                <Select
                  value={memberFilter}
                  onChange={(e) => {
                    setMemberFilter(e.target.value);
                    setSelectedMembers([]); // Clear selection when filter changes
                  }}
                  label="Filter Recipients"
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      '&.Mui-focused fieldset': {
                        borderColor: '#1f8dbf',
                      },
                    },
                  }}
                >
                  <MenuItem value="all">
                    All Members ({statusCounts['Enrolled'] ? Object.values(statusCounts).reduce((a, b) => a + b, 0) : allMembers.length})
                  </MenuItem>
                  <MenuItem value="Enrolled">
                    Enrolled ({((statusCounts['Enrolled'] || 0) + (statusCounts['Pending Login'] || 0))})
                  </MenuItem>
                  <MenuItem value="Pending Login">
                    Pending Login ({statusCounts['Pending Login'] || 0})
                  </MenuItem>
                  {Object.entries(statusCounts)
                    .filter(([status]) => status !== 'Enrolled' && status !== 'Pending Login')
                    .map(([status, count]) => (
                      <MenuItem key={status} value={status}>
                        {status} ({count})
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>

              {/* Location Filter */}
              {locations.length > 1 && (
                <FormControl fullWidth>
                  <InputLabel>Location</InputLabel>
                  <Select
                    value={locationFilter}
                    onChange={(e) => {
                    setLocationFilter(e.target.value);
                    setSelectedMembers([]); // Clear selection when filter changes
                    }}
                    label="Location"
                    disabled={locationsLoading}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        '&.Mui-focused fieldset': {
                          borderColor: '#1f8dbf',
                        },
                      },
                    }}
                  >
                    <MenuItem value="all">
                      All Locations ({allMembers.length} members)
                    </MenuItem>
                    {locations
                      .sort((a, b) => (b.IsPrimary ? 1 : 0) - (a.IsPrimary ? 1 : 0))
                      .map((location) => {
                        const locationMemberCount = allMembers.filter(
                          (m) => (m as any).LocationId === location.LocationId
                        ).length;
                        return (
                          <MenuItem key={location.LocationId} value={location.LocationId}>
                            {location.Name || 'Unnamed Location'}{' '}
                            {location.IsPrimary && '(Primary)'} ({locationMemberCount})
                          </MenuItem>
                        );
                      })}
                  </Select>
                </FormControl>
              )}

              {/* Search Box */}
              <TextField
                placeholder="Search members by name, email, or phone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                fullWidth
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon />
                    </InputAdornment>
                  ),
                  endAdornment: searchTerm && (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        onClick={() => setSearchTerm('')}
                        sx={{ padding: '4px' }}
                      >
                        <CloseIcon sx={{ fontSize: '1rem' }} />
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />

              {/* Filter Mode Toggle - Send to all filtered members vs selected only */}
              {(memberFilter !== 'all' || locationFilter !== 'all' || searchTerm.trim()) && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={useFilterMode}
                      onChange={(e) => {
                            setUseFilterMode(e.target.checked);
                            if (e.target.checked) {
                              setSelectedMembers([]); // Clear manual selection when switching to filter mode
                            }
                      }}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      Include all {filteredMembers.length}{' '}
                      {memberFilter !== 'all' 
                        ? memberFilter.toLowerCase() + ' members'
                        : locationFilter !== 'all' 
                          ? 'members from selected location'
                          : 'matching members'}
                    </Typography>
                  }
                />
              )}
            </Stack>
          </Box>

          {/* Members List */}
          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
            {loadingAllMembers ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            ) : filteredMembers.length === 0 ? (
              <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
                <PersonIcon sx={{ fontSize: 48, color: theme.palette.text.secondary }} />
                <Typography variant="body1" color="text.secondary">
                  No members found
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
                    <Stack spacing={1}>
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
                            {member.JobPosition && (
                              <span style={{ color: theme.palette.text.secondary, fontWeight: 'normal', marginLeft: '4px' }}>
                                ({DEFAULT_JOB_POSITIONS.find(p => p.id === member.JobPosition)?.label || member.JobPosition})
                              </span>
                            )}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {member.Email}
                          </Typography>
                          {member.PhoneNumber && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              📱 {member.PhoneNumber}
                            </Typography>
                          )}
                        </Box>
                        {member.EnrollmentStatus && (
                          <Chip
                            label={member.EnrollmentStatus}
                            size="small"
                            color={
                              member.EnrollmentStatus === 'Enrolled' ? 'success' :
                              member.EnrollmentStatus === 'Pending Login' ? 'warning' :
                              member.EnrollmentStatus === 'Declined Coverage' ? 'error' :
                              'default'
                            }
                            variant="outlined"
                          />
                        )}
                      </Stack>
                      {/* Phone Number Input for SMS */}
                      {sendSMS && selectedMembers.includes(member.MemberId) && !member.PhoneNumber && (
                        <Box sx={{ pl: 6, pr: 2 }}>
                          <TextField
                            label="Phone Number (required for SMS)"
                            value={phoneNumbers[member.MemberId] || ''}
                            onChange={(e) => handlePhoneNumberChange(member.MemberId, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            fullWidth
                            size="small"
                            placeholder="(555) 123-4567"
                            required
                            error={sendSMS && selectedMembers.includes(member.MemberId) && !member.PhoneNumber && !phoneNumbers[member.MemberId]}
                            helperText={sendSMS && selectedMembers.includes(member.MemberId) && !member.PhoneNumber && !phoneNumbers[member.MemberId] ? 'Phone number required for SMS' : ''}
                            InputProps={{
                              startAdornment: (
                                <InputAdornment position="start">
                                  <PhoneIcon />
                                </InputAdornment>
                              ),
                            }}
                          />
                        </Box>
                      )}
                      {sendSMS && selectedMembers.includes(member.MemberId) && member.PhoneNumber && (
                        <Box sx={{ pl: 6, pr: 2 }}>
                          <TextField
                            label="Phone Number"
                            value={phoneNumbers[member.MemberId] || member.PhoneNumber}
                            onChange={(e) => handlePhoneNumberChange(member.MemberId, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            fullWidth
                            size="small"
                            placeholder="(555) 123-4567"
                            InputProps={{
                              startAdornment: (
                                <InputAdornment position="start">
                                  <PhoneIcon />
                                </InputAdornment>
                              ),
                            }}
                          />
                        </Box>
                      )}
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Box>

          {/* Summary */}
          <Box sx={{ bgcolor: alpha(theme.palette.primary.main, 0.05), p: 2, borderRadius: 1 }}>
            {useFilterMode ? (
              <>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                  Will send to all {filteredMembers.length} filtered member{filteredMembers.length !== 1 ? 's' : ''}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Recipients: {filteredMembers.slice(0, 15).map(m => `${m.FirstName} ${m.LastName}`).join(', ')}
                  {filteredMembers.length > 15 && ` and ${filteredMembers.length - 15} more`}
                </Typography>
              </>
            ) : (
              <>
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                  {selectedMembers.length} member{selectedMembers.length !== 1 ? 's' : ''} selected
                </Typography>
                {selectedMembers.length > 0 && (
                  <>
                    <Typography variant="body2" color="text.secondary">
                      Recipients: {filteredMembers
                        .filter(m => selectedMembers.includes(m.MemberId))
                        .slice(0, 15)
                        .map(m => `${m.FirstName} ${m.LastName}`)
                        .join(', ')}
                      {selectedMembers.length > 15 && ` and ${selectedMembers.length - 15} more`}
                    </Typography>
                  </>
                )}
              </>
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
          disabled={
            (!useFilterMode && selectedMembers.length === 0) ||
            (useFilterMode && filteredMembers.length === 0) ||
            sending ||
            (!sendEmail && !sendSMS) ||
            (!selectedTemplate && (!customSubject.trim() || !customBody.trim())) ||
            (selectedReplyTo === 'custom' && !customReplyToEmail.trim()) ||
            (selectedFromName === 'custom' && !customFromName.trim()) ||
            (sendSMS && !useFilterMode && selectedMembers.some(memberId => {
              const member = filteredMembers.find(m => m.MemberId === memberId);
              return !member?.PhoneNumber && !phoneNumbers[memberId];
            }))
          }
          startIcon={sending ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{
            textTransform: 'none',
            bgcolor: '#1f8dbf',
            '&:hover': {
              bgcolor: '#175a7a',
            },
          }}
        >
          {sending 
            ? 'Sending...' 
            : useFilterMode 
              ? `Send to All ${filteredMembers.length} Filtered Member${filteredMembers.length !== 1 ? 's' : ''}`
              : `Send to ${selectedMembers.length} Member${selectedMembers.length !== 1 ? 's' : ''}`
          }
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SendGroupMessageDialog;

