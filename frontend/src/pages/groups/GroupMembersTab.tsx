// frontend/src/pages/groups/GroupMembersTab.tsx
import {
    Add as AddIcon,
    Assessment as AssessmentIcon,
    Event as CalendarIcon,
    CheckCircle as CheckCircleIcon,
    Close as CloseIcon,
    ContentCopy as ContentCopyIcon,
    Delete as DeleteIcon,
    Download as DownloadIcon,
    Edit as EditIcon,
    Email as EmailIcon,
    Error as ErrorIcon,
    LocationOn as LocationIcon,
    MoreVert as MoreVertIcon,
    People as PeopleIcon,
    Person as PersonIcon,
    Phone as PhoneIcon,
    Search as SearchIcon,
    Send as SendIcon,
    Upload as UploadIcon
} from '@mui/icons-material';
import {
    Alert,
    AlertTitle,
    alpha,
    Autocomplete,
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
    Grid,
    IconButton,
    InputAdornment,
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
    GridSortModel,
    GridToolbar,
} from '@mui/x-data-grid';
import { format } from 'date-fns';
import React, { useState } from 'react';
import CensusImportPreview from '../../components/census/CensusImportPreview';
import SendGroupMessageDialog from '../../components/groups/SendGroupMessageDialog';
import SetEnrollmentPeriodModal from '../../components/modals/SetEnrollmentPeriodModal';
import IndividualEnrollmentLinkModal from '../../components/shared/IndividualEnrollmentLinkModal';
import MemberEdit from '../../components/shared/MemberEdit';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';
import { MAX_LARGE_UPLOAD_BYTES, MAX_LARGE_UPLOAD_MB } from '../../constants/uploads';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { useGroupDetails } from '../../hooks/useGroupDetails';
import { useGroupEmployeeDocs, downloadEmployeeDocToNewTab } from '../../hooks/groups/useGroupEmployeeDocs';
import { useGroupMembers } from '../../hooks/useGroupMembers';
import { useGroupPaymentValidation } from '../../hooks/useGroupPaymentValidation';
import { usePaymentProcessorStatus } from '../../hooks/usePaymentProcessorStatus';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import GroupsService from '../../services/groups.service';
import { MembersService } from '../../services/members.service';
import { ApiResponse } from '../../types/api.types';
import { CreateMemberData, Member } from '../../types/member.types';
import { COHORT_FIFTEENTH, COHORT_FIRST, cohortLabel, getCohortFromDate } from '../../utils/billingCohort';
import { formatRelativeTimeAgo } from '../../utils/formatRelativeTimeAgo';
import { normalizeDateToYYYYMMDD, normalizePhoneToE164Storage } from '../../utils/helpers';
import MemberManagementModal from '../members/MemberManagementModal';

// Types

// Extend the shared Member type locally so the group-members list can surface the
// latest product enrollment's EffectiveDate (used for cohort column + filter).
type GroupMember = Member & { EffectiveDate?: string | null };

interface GroupMembersTabProps {
  groupId: string;
  groupName: string;
  /** Optional group data from parent - avoids redundant useGroupDetails fetch */
  groupData?: Record<string, unknown> | null;
}

/** Matches backend `normalizeZip`: optional empty, else exactly 5 or 9 digits (ZIP+4). */
function isOptionalUsZipValid(zip: string | undefined | null): boolean {
  const digits = String(zip ?? '').replace(/\D/g, '');
  if (digits.length === 0) return true;
  return digits.length === 5 || digits.length === 9;
}

function sanitizeMemberZipInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 9);
}

/** ApiService throws plain `{ message, status, code }` objects, not `Error` instances. */
function getApiErrorDisplayMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  const anyErr = error as {
    response?: { data?: { message?: unknown } };
    responseData?: { message?: unknown };
  };
  const nested = anyErr?.response?.data?.message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  const rd = anyErr?.responseData;
  if (rd && typeof rd === 'object' && rd !== null && 'message' in rd) {
    const dm = (rd as { message?: unknown }).message;
    if (typeof dm === 'string' && dm.trim()) return dm;
  }
  return fallback;
}

// Default section order for auto-generated templates (match EnrollmentLinkTemplateForm / wizard: Healthcare first)
const ENROLLMENT_SECTION_ORDER = ['Healthcare', 'Medical', 'Dental', 'Vision', 'Other'];

const REPORT_MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function sortProductSectionsByDefaultOrder<T extends { productType?: string }>(sections: T[]): T[] {
  return [...sections].sort((a, b) => {
    const i = ENROLLMENT_SECTION_ORDER.indexOf(a.productType || '');
    const j = ENROLLMENT_SECTION_ORDER.indexOf(b.productType || '');
    const orderA = i === -1 ? ENROLLMENT_SECTION_ORDER.length : i;
    const orderB = j === -1 ? ENROLLMENT_SECTION_ORDER.length : j;
    if (orderA !== orderB) return orderA - orderB;
    return (a.productType || '').localeCompare(b.productType || '');
  });
}

// Send Enrollment Links Dialog
interface SendEnrollmentDialogProps {
  open: boolean;
  onClose: () => void;
  members: Member[];
  onSend: (memberIds: string[], templateId: string, deliveryPreferences: { sendEmail: boolean; sendSMS: boolean }, phoneNumbers?: Record<string, string>, linkBaseUrl?: string) => void;
  groupId: string; // Need groupId to lookup AgentId on backend
  groupName: string; // Group name for creating new template
  groupAgentId?: string | null; // Group's AgentId - required for auto-create template (TenantAdmin/SysAdmin/GroupAdmin)
  groupTenantId?: string | null; // Group's TenantId - required for SysAdmin auto-create
  enrollmentPeriodActive?: boolean;
  enrollmentPeriodEndDate?: string | null;
  /** When on localhost: options for link domain (current, production, tenant custom). Empty when not localhost. */
  linkBaseUrlOptions?: Array<{ label: string; value: string }>;
  /** Default link base URL (e.g. current origin) when on localhost */
  defaultLinkBaseUrl?: string;
}

const SendEnrollmentDialog: React.FC<SendEnrollmentDialogProps> = ({ 
  open, 
  onClose, 
  members, 
  onSend,
  groupId,
  groupName,
  groupAgentId,
  groupTenantId,
  enrollmentPeriodActive,
  enrollmentPeriodEndDate,
  linkBaseUrlOptions = [],
  defaultLinkBaseUrl = ''
}) => {
  const { user } = useAuth();
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectAll, setSelectAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [sendEmail, setSendEmail] = useState(true); // Email checked by default
  const [sendSMS, setSendSMS] = useState(false);
  const [employerSendAuthorizationConfirmed, setEmployerSendAuthorizationConfirmed] = useState(false);
  const [phoneNumbers, setPhoneNumbers] = useState<Record<string, string>>({}); // memberId -> phone number
  const [selectedLinkBaseUrl, setSelectedLinkBaseUrl] = useState<string>(defaultLinkBaseUrl);
  const [allEligibleMembers, setAllEligibleMembers] = useState<Member[]>([]);
  const [loadingAllMembers, setLoadingAllMembers] = useState(false);
  const theme = useTheme();

  // Keep selectedLinkBaseUrl in sync when defaultLinkBaseUrl or options change (e.g. dialog reopen)
  React.useEffect(() => {
    if (defaultLinkBaseUrl && linkBaseUrlOptions.some(o => o.value === defaultLinkBaseUrl)) {
      setSelectedLinkBaseUrl(defaultLinkBaseUrl);
    }
  }, [defaultLinkBaseUrl, linkBaseUrlOptions]);

  // Fetch all eligible members when dialog opens (not just current page)
  React.useEffect(() => {
    if (open && groupId) {
      fetchAllEligibleMembers();
    }
  }, [open, groupId]);

  const fetchAllEligibleMembers = async () => {
    try {
      setLoadingAllMembers(true);
      // Fetch all eligible members (active, not enrolled, not declined)
      const response = await apiService.get<ApiResponse<{ members: Member[]; statusCounts: any; pagination: any }>>(
        `/api/groups/${groupId}/members?page=1&pageSize=10000&showTerminated=true`
      );
      
      if (response.success && response.data?.members) {
        // Filter to only eligible members: active, not enrolled (including future-effective), not declined
        const eligible = response.data.members.filter(m => 
          m.Status === 'Active' && 
          (m.EnrollmentStatus as string) !== 'Enrolled' &&
          (m.EnrollmentStatus as string) !== 'Pending Login' &&
          (m.EnrollmentStatus as string) !== 'Declined Coverage' &&
          (m.EnrollmentStatus as string) !== 'Terminated' &&
          m.RelationshipType === 'P' // Only primary members
        );
        setAllEligibleMembers(eligible);
        console.log(`✅ Fetched ${eligible.length} eligible members for enrollment links`);
      }
    } catch (error) {
      console.error('Error fetching all eligible members:', error);
      // Fallback to using the members prop if API call fails
      const eligible = members.filter(m => 
        m.Status === 'Active' && 
        !(m.ActiveEnrollments || 0) &&
        (m.EnrollmentStatus as string) !== 'Declined Coverage'
      );
      setAllEligibleMembers(eligible);
    } finally {
      setLoadingAllMembers(false);
    }
  };


  // Fetch templates when dialog opens
  React.useEffect(() => {
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
          }
        }, 500);
        
        return () => clearTimeout(timer);
      }
    }
  }, [open, user, user?.currentRole]);

  // Fetch the group's Group-type enrollment template and auto-select it.
  // There's no UI selector anymore — the agent never chooses; we just need
  // `selectedTemplate` populated so handleSend() can submit a templateId.
  const fetchTemplates = async () => {
    try {
      if (!user?.currentRole) {
        console.error('❌ No user role available');
        return;
      }

      const response = await EnrollmentLinkTemplatesService.getTemplates(
        { templateType: 'Group', isActive: true, groupId },
        user.currentRole
      );

      if (response.success) {
        const groupTemplates = (response.data?.data || []).filter((template: any) =>
          template.TemplateType === 'Group' && template.IsActive
        );
        if (groupTemplates.length === 0) {
          setSelectedTemplate('NEW_TEMPLATE'); // handleSend will auto-create one
        } else {
          setSelectedTemplate(groupTemplates[0].TemplateId);
        }
      } else {
        console.error('❌ Template fetch error:', response.message);
      }
    } catch (error) {
      console.error('❌ Error fetching templates:', error);
    }
  };

  // Use all eligible members from API (not just current page)
  const eligibleMembers = allEligibleMembers.length > 0 ? allEligibleMembers : members.filter(m => 
    m.Status === 'Active' && (m.EnrollmentStatus as string) !== 'Enrolled' && (m.EnrollmentStatus as string) !== 'Pending Login' && (m.EnrollmentStatus as string) !== 'Declined Coverage' && (m.EnrollmentStatus as string) !== 'Terminated'
  );

  // Filter by search term
  const filteredMembers = eligibleMembers.filter(m =>
    `${m.FirstName} ${m.LastName} ${m.Email}`.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Count members with phone numbers
  const membersWithPhone = filteredMembers.filter(m => m.PhoneNumber && m.PhoneNumber.trim() !== '').length;

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

  // Helper function to create a new enrollment link template with group products
  const createNewEnrollmentLinkTemplate = async (): Promise<string | null> => {
    try {
      setCreatingTemplate(true);
      
      // Fetch group products
      const productsResponse = await GroupsService.getGroupProducts(groupId);
      if (!productsResponse.success || !productsResponse.data) {
        throw new Error('Failed to fetch group products');
      }
      
      const groupProducts = Array.isArray(productsResponse.data) 
        ? productsResponse.data 
        : (productsResponse.data as any).groupProducts || [];
      
      console.log('📦 Group products for template:', groupProducts);
      
      // Check if there are any products
      if (!groupProducts || groupProducts.length === 0) {
        throw new Error('No products are assigned to this group. Please assign products to the group before creating an enrollment link.');
      }
      
      // Group products by ProductType; do not create a separate "Bundle" section (legacy).
      // Merge bundle product IDs into the Healthcare/Medical section so bundles show there like the template creator.
      const productsByType = new Map<string, any[]>();
      let bundleProductIds: string[] = [];
      groupProducts.forEach((product: any) => {
        const productType = product.ProductType || 'Other';
        if (productType === 'Bundle') {
          bundleProductIds.push(product.ProductId);
          return;
        }
        if (!productsByType.has(productType)) productsByType.set(productType, []);
        productsByType.get(productType)!.push(product);
      });
      const productSections: any[] = [];
      productsByType.forEach((products, productType) => {
        const allProductIds = products.map((p: any) => p.ProductId);
        if (allProductIds.length === 0) return;
        const isHealthcareOrMedical = productType === 'Healthcare' || productType === 'Medical';
        const specificProducts = isHealthcareOrMedical && bundleProductIds.length > 0
          ? [...allProductIds, ...bundleProductIds]
          : allProductIds;
        if (isHealthcareOrMedical) bundleProductIds = []; // merge bundles only into first such section
        productSections.push({
          page: productType,
          header: `Select Your ${productType} Coverage`,
          productType,
          sectionType: 'products',
          includePdfLinks: true,
          includeVideos: false,
          effectiveDateRules: { type: 'GroupDefined' },
          specificProducts
        });
      });
      // If we had only bundles (no Healthcare/Medical), create one Healthcare section with just bundle IDs
      if (bundleProductIds.length > 0) {
        productSections.push({
          page: 'Healthcare',
          header: 'Select Your Healthcare Coverage',
          productType: 'Healthcare',
          sectionType: 'products',
          includePdfLinks: true,
          includeVideos: false,
          effectiveDateRules: { type: 'GroupDefined' },
          specificProducts: bundleProductIds
        });
      }
      const orderedSections = sortProductSectionsByDefaultOrder(productSections);

      // Build LinkMetaData structure
      const linkMetaData = {
        household: {
          header: "Employee Information",
          fields: ["FirstName", "LastName", "Email", "Phone", "DateOfBirth", "HouseholdSize"],
          prepopulate: false
        },
        products: orderedSections,
        additionalDetails: {
          header: "Additional Information",
          fields: ["Address", "Dependents"]
        }
      };
      
      // Create the template (TenantAdmin/SysAdmin/GroupAdmin require agentId; Agent infers from user but we pass groupId for Group type)
      const templateName = `${groupName} Enrollment Link`;
      const createPayload: Parameters<typeof EnrollmentLinkTemplatesService.createTemplate>[0] = {
        templateName,
        templateType: 'Group',
        groupId: groupId,
        linkMetaData: JSON.stringify(linkMetaData),
        description: `Auto-generated enrollment link template for ${groupName}`
      };
      if (groupAgentId && (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin' || user?.currentRole === 'GroupAdmin')) {
        createPayload.agentId = groupAgentId;
      }
      if (user?.currentRole === 'SysAdmin' && groupTenantId) {
        createPayload.tenantId = groupTenantId;
      }
      const createResponse = await EnrollmentLinkTemplatesService.createTemplate(
        createPayload,
        user?.currentRole
      );
      
      if (!createResponse.success || !createResponse.data?.templateId) {
        throw new Error(createResponse.message || 'Failed to create enrollment link template');
      }
      
      console.log('✅ Created new enrollment link template:', createResponse.data.templateId);
      return createResponse.data.templateId;
    } catch (error) {
      console.error('❌ Error creating enrollment link template:', error);
      throw error;
    } finally {
      setCreatingTemplate(false);
    }
  };

  const handleSend = async () => {
    if (selectedMembers.length > 0 && selectedTemplate) {
      // At least one delivery method required. If SMS is selected, backend sends SMS only to members with phone numbers; others get email only.
      // Validate that at least one delivery method is selected
      if (!sendEmail && !sendSMS) {
        return;
      }
      
      setSending(true);
      
      try {
        let templateIdToUse = selectedTemplate;
        
        // If "New Enrollment Link" is selected, create the template first
        if (selectedTemplate === 'NEW_TEMPLATE') {
          try {
            const newTemplateId = await createNewEnrollmentLinkTemplate();
            if (!newTemplateId) {
              throw new Error('Failed to create enrollment link template');
            }
            templateIdToUse = newTemplateId;
          } catch (templateError) {
            // Error creating template - show error and stop
            const errorMessage = templateError instanceof Error ? templateError.message : 'Failed to create enrollment link template';
            console.error('Error creating enrollment link template:', templateError);
            // The error will be caught by the parent's sendEnrollmentLinks function
            throw new Error(errorMessage);
          }
        }
        
        await onSend(selectedMembers, templateIdToUse, { sendEmail, sendSMS }, phoneNumbers, selectedLinkBaseUrl || undefined);
        handleClose();
      } catch (error) {
        console.error('Error in handleSend:', error);
        // Re-throw so parent component can handle it via showSnackbar
        throw error;
      } finally {
        setSending(false);
      }
    }
  };

  const handleClose = () => {
    setSelectedMembers([]);
    setSelectedTemplate('');
    setSearchTerm('');
    setSelectAll(false);
    setSendEmail(true);
    setSendSMS(false);
    setEmployerSendAuthorizationConfirmed(false);
    setPhoneNumbers({});
    setSelectedLinkBaseUrl(defaultLinkBaseUrl);
    onClose();
  };

  const handlePhoneNumberChange = (memberId: string, phoneNumber: string) => {
    setPhoneNumbers(prev => ({
      ...prev,
      [memberId]: phoneNumber
    }));
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

          {/* Enrollment Template selector removed — there's always a single
              active Group-type template per group; `selectedTemplate` is
              auto-populated by fetchTemplates() and consumed by handleSend().
              Agents don't need to choose. */}

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

          {/* Employer authorization (required for TCPA compliance) */}
          <FormControlLabel
            control={
              <Checkbox
                checked={employerSendAuthorizationConfirmed}
                onChange={(e) => setEmployerSendAuthorizationConfirmed(e.target.checked)}
              />
            }
            label="I confirm I have authorization to send enrollment links to these members"
          />

          {/* Link domain (localhost only) */}
          {linkBaseUrlOptions.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Link domain
              </Typography>
              <FormControl size="small" fullWidth>
                <Select
                  value={selectedLinkBaseUrl || defaultLinkBaseUrl}
                  onChange={(e) => setSelectedLinkBaseUrl(e.target.value)}
                  displayEmpty
                >
                  {linkBaseUrlOptions.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          )}

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
                        <Chip
                          label="Not Enrolled"
                          size="small"
                          color="warning"
                          variant="outlined"
                        />
                      </Stack>
                      {/* Phone Number Input for SMS when member doesn't have phone */}
                      {sendSMS && selectedMembers.includes(member.MemberId) && !member.PhoneNumber && (
                        <Box sx={{ pl: 6, pr: 2 }}>
                          <TextField
                            label="Phone Number (optional – add for SMS)"
                            value={phoneNumbers[member.MemberId] || ''}
                            onChange={(e) => handlePhoneNumberChange(member.MemberId, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            fullWidth
                            size="small"
                            placeholder="(555) 123-4567"
                            helperText="Leave blank to send via email only"
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
                      {/* Show existing phone number if SMS is selected and member has phone */}
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
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              {selectedMembers.length} member{selectedMembers.length !== 1 ? 's' : ''} selected
            </Typography>
            {selectedMembers.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                {sendEmail && sendSMS && 'Each member will receive a personalized enrollment link via email; SMS will be sent only to members with phone numbers.'}
                {sendEmail && !sendSMS && 'Each member will receive a personalized enrollment link via email'}
                {!sendEmail && sendSMS && 'Each member will receive a personalized enrollment link via text message (only to members with phone numbers).'}
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
          disabled={
            selectedMembers.length === 0 || 
            !selectedTemplate || 
            sending || 
            creatingTemplate ||
            (!sendEmail && !sendSMS) ||
            !employerSendAuthorizationConfirmed
          }
          startIcon={(sending || creatingTemplate) ? <CircularProgress size={16} /> : <SendIcon />}
          sx={{ textTransform: 'none' }}
        >
          {creatingTemplate ? 'Creating Template...' : sending ? 'Sending...' : `Send ${selectedMembers.length} Link${selectedMembers.length !== 1 ? 's' : ''}`}
        </Button>
      </DialogActions>

    </Dialog>
  );
};

// Slide transition for Snackbar
function SlideTransition(props: SlideProps) {
  return <Slide {...props} direction="down" />;
}

const US_STATES = [
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' }
];

const GroupMembersTab: React.FC<GroupMembersTabProps> = ({ groupId, groupName, groupData: parentGroupData }) => {
  const theme = useTheme();
  const { user } = useAuth();
  const { data: paymentProcessorStatus } = usePaymentProcessorStatus();
  
  // Check if user has access to send messages feature
  const canSendMessages =
    user?.currentRole === 'Agent' ||
    user?.currentRole === 'TenantAdmin' ||
    user?.currentRole === 'SysAdmin';
  
  // State for filters (must be declared before useGroupMembers)
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [showTerminated, setShowTerminated] = useState(true); // Default to true to show terminated members
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<string>('all');
  const [cohortFilter, setCohortFilter] = useState<'all' | 'FIRST' | 'FIFTEENTH'>('all');
  const [newestMemberId, setNewestMemberId] = useState<string | null>(null);
  
  // State for server-side pagination and sorting
  const [paginationModel, setPaginationModel] = React.useState({
    page: 0, // MUI DataGrid uses 0-based indexing
    pageSize: 10,
  });
  const [sortModel, setSortModel] = React.useState<GridSortModel>([]);
  
  const handleSortModelChange = React.useCallback((model: GridSortModel) => {
    setSortModel(model);
  }, []);

  // Reset to first page when search term or filters change
  React.useEffect(() => {
    setPaginationModel(prev => ({ ...prev, page: 0 }));
  }, [searchTerm, locationFilter, enrollmentStatusFilter, showTerminated]);
  
  // Use the hook to fetch members with server-side pagination and sorting
  const { 
    data: membersData = { members: [], statusCounts: {}, pagination: { page: 1, pageSize: 10, totalCount: 0, totalPages: 0 } }, 
    isLoading: loading, 
    isError, 
    error: fetchError,
    refetch 
  } = useGroupMembers(groupId, {
    page: paginationModel.page + 1, // Backend uses 1-based indexing
    pageSize: paginationModel.pageSize,
    sortBy: sortModel[0]?.field || 'LastName',
    sortOrder: sortModel[0]?.sort || 'asc',
    locationFilter: locationFilter,
    showTerminated: showTerminated,
    showInactive: enrollmentStatusFilter === '__inactive_roster__',
    search: searchTerm.trim() || undefined,
    enrollmentStatusFilter:
      enrollmentStatusFilter === '__inactive_roster__' ? 'all' : enrollmentStatusFilter
  });

  // Clear newest member highlight after data is refreshed
  React.useEffect(() => {
    if (newestMemberId && !loading && membersData.members.length > 0) {
      // Check if the newest member is in the current data
      const memberExists = membersData.members.some(m => m.MemberId === newestMemberId);
      if (memberExists) {
        // Clear highlight after a delay to allow user to see it
        const timer = setTimeout(() => {
          setNewestMemberId(null);
        }, 5000); // Clear after 5 seconds
        return () => clearTimeout(timer);
      }
    }
  }, [newestMemberId, loading, membersData.members]);
  
  // Use parent group data when provided to avoid redundant fetch; otherwise fetch
  const { data: fetchedGroupDetails } = useGroupDetails(groupId, { enabled: !parentGroupData });
  const groupDetails = parentGroupData ?? fetchedGroupDetails;
  const { colors } = useBranding();
  
  // Check if group has valid payment methods
  const {
    data: paymentValidation = { hasValidPaymentMethod: false, paymentMethods: [] },
    isLoading: paymentLoading
  } = useGroupPaymentValidation(groupId);

  // Employee docs for Download Employee Doc button
  const { data: employeeDocs = [] } = useGroupEmployeeDocs(groupId);
  const [empDocMenuAnchor, setEmpDocMenuAnchor] = useState<HTMLElement | null>(null);
  const [empDocGenerating, setEmpDocGenerating] = useState(false);
  const handleEmpDocDownload = React.useCallback(async (docId: string) => {
    setEmpDocGenerating(true);
    try {
      await downloadEmployeeDocToNewTab(groupId, docId);
    } catch (err) {
      // Logged to console for developer diagnostics; user-facing error surfacing is intentionally silent.
      console.error('Employee doc download failed:', err);
    } finally {
      setEmpDocGenerating(false);
    }
  }, [groupId]);

  // Extract members and status counts from the response
  const rawMembers = membersData.members || [];
  const statusCounts = membersData.statusCounts || {};
  
  // Remove duplicates by MemberId (keep the first occurrence)
  const allMembers = rawMembers.filter((member, index, array) => 
    array.findIndex(m => m.MemberId === member.MemberId) === index
  );
  
  // Duplicates are removed by allMembers filter above
  

  
  // State
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addMemberLoading, setAddMemberLoading] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  // MemberManagementModal state
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [memberEnrollments, setMemberEnrollments] = useState<any[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState<boolean>(false);
  const [householdMembers, setHouseholdMembers] = useState<Member[]>([]);
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importLoadingModal, setImportLoadingModal] = useState<{
    open: boolean;
    progress: number;
    current: string;
    errors: string[];
    skippedMembers: string[];
    success: boolean;
    existingUsersNotImported: Array<{ firstName: string; lastName: string; email: string }>;
    totalAttempted: number;
    totalImported: number;
    totalHouseholdsAttempted: number;
    totalHouseholdsImported: number;
    totalHouseholdsFailed: number;
    existingMembersInGroup: number;
  }>({
    open: false,
    progress: 0,
    current: '',
    errors: [],
    skippedMembers: [],
    success: false,
    existingUsersNotImported: [],
    totalAttempted: 0,
    totalImported: 0,
    totalHouseholdsAttempted: 0,
    totalHouseholdsImported: 0,
    totalHouseholdsFailed: 0,
    existingMembersInGroup: 0,
  });
  const [closeImportConfirmOpen, setCloseImportConfirmOpen] = useState(false);
  const [sendLinksDialogOpen, setSendLinksDialogOpen] = useState(false);
  const [sendMessageDialogOpen, setSendMessageDialogOpen] = useState(false);
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
  
  // Debug: Log when sendLinksDialogOpen state changes
  React.useEffect(() => {
    console.log('🔄 sendLinksDialogOpen state changed to:', sendLinksDialogOpen);
  }, [sendLinksDialogOpen]);
  const [individualLinkDialogOpen, setIndividualLinkDialogOpen] = useState(false);
  const [selectedMemberForLink, setSelectedMemberForLink] = useState<Member | null>(null);
  const [declinedSendLinkConfirmOpen, setDeclinedSendLinkConfirmOpen] = useState(false);
  const [declinedSendLinkConfirmMember, setDeclinedSendLinkConfirmMember] = useState<Member | null>(null);
  
  // Dependents modal state
  const [dependentsModalOpen, setDependentsModalOpen] = useState(false);
  const [selectedMemberForDependents, setSelectedMemberForDependents] = useState<Member | null>(null);
  const [dependents, setDependents] = useState<Array<{
    MemberId: string;
    RelationshipType: string;
    DateOfBirth: string | null;
    Gender: string | null;
    FirstName: string;
    LastName: string;
    Email: string;
    PhoneNumber: string | null;
    RelationshipDescription: string;
  }>>([]);
  const [dependentsLoading, setDependentsLoading] = useState(false);
  
  // Debug: Log when individual link dialog state changes
  React.useEffect(() => {
    console.log('🔄 individualLinkDialogOpen state changed to:', individualLinkDialogOpen);
    console.log('🔄 selectedMemberForLink changed to:', selectedMemberForLink);
  }, [individualLinkDialogOpen, selectedMemberForLink]);
  
  // Termination dialog state
  const [terminationDialogOpen, setTerminationDialogOpen] = useState(false);
  const [memberToTerminate, setMemberToTerminate] = useState<Member | null>(null);
  const [terminationDate, setTerminationDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [terminationLoading, setTerminationLoading] = useState(false);
  
  // Password reset confirmation dialog state
  const [passwordResetDialogOpen, setPasswordResetDialogOpen] = useState(false);
  const [memberForPasswordReset, setMemberForPasswordReset] = useState<Member | null>(null);
  const [passwordResetLoading, setPasswordResetLoading] = useState(false);
  
  // Terminated members state
  const [unterminateDialogOpen, setUnterminateDialogOpen] = useState(false);
  const [memberToUnterminate, setMemberToUnterminate] = useState<Member | null>(null);
  const [unterminateLoading, setUnterminateLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [employerAuthorizationConfirmed, setEmployerAuthorizationConfirmed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportScope, setReportScope] = useState<'active' | 'all'>('active');
  const [reportIncludeDependents, setReportIncludeDependents] = useState(false);
  const [reportIncludeDateOfBirth, setReportIncludeDateOfBirth] = useState(false);
  const [reportIncludeHireDate, setReportIncludeHireDate] = useState(false);
  const [reportIncludeTotalPremium, setReportIncludeTotalPremium] = useState(true);
  const [reportIncludeContributions, setReportIncludeContributions] = useState(false);
  const [reportIncludePlanDetails, setReportIncludePlanDetails] = useState(false);
  const [reportIncludeFees, setReportIncludeFees] = useState(false);
  const [reportIncludeLocation, setReportIncludeLocation] = useState(false);
  const [reportIncludeCompanyRole, setReportIncludeCompanyRole] = useState(false);
  const [reportIncludeTobacco, setReportIncludeTobacco] = useState(false);
  const [reportIncludeGender, setReportIncludeGender] = useState(false);
  /** Report CSV: enrollments active as of end of selected month (UTC) only — no future-only fallback */
  const [reportYear, setReportYear] = useState(() => new Date().getUTCFullYear());
  const [reportMonth, setReportMonth] = useState(() => new Date().getUTCMonth() + 1);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [_successMessage, setSuccessMessage] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
    title: '' as string | undefined,
  });
  
  // AI Parsing state
  const [importMode, setImportMode] = useState<'intelligent' | 'standard'>('intelligent'); // Default to intelligent
  const [aiParsingLoading, setAiParsingLoading] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [parsedCensusData, setParsedCensusData] = useState<{
    households: Array<{
      primaryMember: CreateMemberData & { locationId?: string; locationName?: string };
      dependents: Array<CreateMemberData & { locationId?: string; locationName?: string }>;
    }>;
    warnings?: string[];
    statistics: {
      totalMembers: number;
      households: number;
      primaryMembers: number;
      dependents: number;
    };
  } | null>(null);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);

  // Locations state
  const [locations, setLocations] = useState<Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string; IsPrimary?: boolean }>>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);

  // Fetch locations when groupId is available
  React.useEffect(() => {
    const fetchLocations = async () => {
      if (!groupId) return;
      try {
        setLocationsLoading(true);
        const response = await apiService.get<{ success: boolean; data: Array<{ LocationId: string; Name?: string; Address: string; City: string; State: string; IsPrimary?: boolean; Status?: string }> }>(
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
    fetchLocations();
  }, [groupId]);

  // Set default location to primary location when locations are loaded or dialog opens
  React.useEffect(() => {
    if (locations.length > 0 && addDialogOpen) {
      const primaryLocation = locations.find(loc => loc.IsPrimary);
      if (primaryLocation) {
        setCreateFormData(prev => {
          // Only set if locationId is empty (to avoid overwriting user selection)
          if (!prev.locationId) {
            return {
              ...prev,
              locationId: primaryLocation.LocationId,
              workLocation: primaryLocation.Name || `${primaryLocation.City}, ${primaryLocation.State}`
            };
          }
          return prev;
        });
      }
    }
  }, [locations, addDialogOpen]);

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
    hireDate: new Date().toISOString().split('T')[0], // Default to today
    tier: 'EE', // Default tier to EE
    jobPosition: undefined,
  });

  // Backend applies showTerminated (excludes Terminated when false), so use server result directly for grid
  const members = allMembers;
  // Cohort filter (1st vs 15th effective dates) — client-side filter on current page.
  // Only exposed in UI when the group has AllowMidMonthEffective enabled.
  const cohortFilteredMembers = members.filter((m) => {
    if (cohortFilter === 'all') return true;
    return getCohortFromDate((m as GroupMember).EffectiveDate) === cohortFilter;
  });
  const activePrimaryMembers = allMembers.filter(member => member.Status !== 'Terminated');
  const terminatedPrimaryMembers = allMembers.filter(member => member.Status === 'Terminated');
  
  // Use DependentCount from backend response (already calculated)
  // No need to calculate from allMembers since backend provides it
  
  // Fetch dependents for a member
  const handleViewDependents = async (member: Member) => {
    setSelectedMemberForDependents(member);
    setDependentsModalOpen(true);
    setDependentsLoading(true);
    setDependents([]);
    
    try {
      const response = await MembersService.getDependents(member.MemberId);
      if (response.success && response.data) {
        setDependents(response.data);
      } else {
        console.error('Failed to fetch dependents:', response.message);
        setDependents([]);
      }
    } catch (error) {
      console.error('Error fetching dependents:', error);
      setDependents([]);
    } finally {
      setDependentsLoading(false);
    }
  };

  // API Functions - refactored to use MembersService
  const createMember = async (memberData: CreateMemberData) => {
    try {
      // Transform the data to match backend expectations
      const phoneNormalized = normalizePhoneToE164Storage(memberData.phoneNumber || '');
      const requestData = {
        firstName: memberData.firstName,
        lastName: memberData.lastName,
        email: memberData.email,
        phone: phoneNormalized || null, // Backend expects 'phone', not 'phoneNumber'
        dateOfBirth: memberData.dateOfBirth || null,
        gender: memberData.gender || null,
        address: memberData.address || null,
        city: memberData.city || null,
        state: memberData.state || null,
        zip: memberData.zip || null,
        groupId: groupId, // Add groupId to the member data
        relationshipType: memberData.relationshipType,
        hireDate: memberData.hireDate || null,
        tier: memberData.tier || null,
        tobaccoUse: memberData.tobaccoUse || null,
        department: memberData.department || null,
        workLocation: memberData.workLocation || null,
        locationId: (memberData as any).locationId || null, // Include locationId if available
        // Assign the group's agent to the member
        agentId: groupDetails?.AgentId || null,
        agentUserId: groupDetails?.AgentUserId || null,
        // Add primaryMemberId for dependents
        ...(memberData.primaryMemberId && { primaryMemberId: memberData.primaryMemberId }),
        // Do NOT automatically confirm - we want to track existing users separately
      };

      // Log request data, especially for dependents
      if (memberData.relationshipType !== 'P') {
        console.log(`📤 Creating DEPENDENT - Request data:`, {
          firstName: requestData.firstName,
          lastName: requestData.lastName,
          relationshipType: requestData.relationshipType,
          primaryMemberId: requestData.primaryMemberId,
          hasPrimaryMemberId: !!requestData.primaryMemberId,
          email: requestData.email
        });
      } else {
        console.log('Sending member data to backend:', requestData);
      }

      const result = await MembersService.createMember(requestData);
      
      // Log response for dependents
      if (memberData.relationshipType !== 'P') {
        console.log(`📥 DEPENDENT creation response:`, {
          success: result.success,
          data: result.data,
          message: result.message,
          error: result.error
        });
      }
      
      if (result.success) {
        console.log('Member operation successful:', result);
        return result; // Return the response data for import function
      } else {
        // Handle actual errors (non-success responses)
        console.error('Backend error response:', result);
        throw new Error(result.message || 'Failed to create member');
      }
    } catch (error) {
      console.error('Error creating member:', error);
      throw error; // Re-throw for import function to handle
    }
  };


  const terminateMember = async (memberId: string, terminationDate?: string) => {
    try {
      setTerminationLoading(true);
      const result = await MembersService.terminateMember(memberId, terminationDate);

      if (result.success) {
        showSnackbar('Member terminated successfully', 'success', 'Success');
        refetch(); // Use refetch from the hook
        setTerminationDialogOpen(false);
        setMemberToTerminate(null);
      } else {
        throw new Error(result.message || 'Failed to terminate member');
      }
    } catch (error) {
      console.error('Error terminating member:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to terminate member', 'error', 'Error');
    } finally {
      setTerminationLoading(false);
    }
  };

  const openUnterminateDialog = (member: Member) => {
    setMemberToUnterminate(member);
    setUnterminateDialogOpen(true);
  };

  const unterminateMember = async (memberId: string) => {
    try {
      setUnterminateLoading(true);
      const result = await MembersService.unterminateMember(memberId);

      if (result.success) {
        showSnackbar('Member unterminated successfully', 'success', 'Success');
        refetch(); // Use refetch from the hook
        setUnterminateDialogOpen(false);
        setMemberToUnterminate(null);
      } else {
        throw new Error(result.message || 'Failed to unterminate member');
      }
    } catch (error) {
      console.error('Error unterminating member:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to unterminate member', 'error', 'Error');
    } finally {
      setUnterminateLoading(false);
    }
  };

  // Location matching state for CSV import
  const [locationMatchModal, setLocationMatchModal] = useState<{
    open: boolean;
    uncertainMembers: Array<{
      rowIndex: number;
      memberData: CreateMemberData;
      csvLocationValue: string;
      selectedLocationId: string;
    }>;
    allHouseholds: CreateMemberData[][];
  }>({
    open: false,
    uncertainMembers: [],
    allHouseholds: []
  });

  const importMembers = async (file: File) => {
    try {
      // Use loading state from Material-UI DataGrid
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim() !== '');
      
      if (lines.length < 2) {
        throw new Error('CSV file must contain at least a header row and one data row');
      }
      
      // Parse CSV (handle quoted values and commas within quotes)
      const parseCSVLine = (line: string): string[] => {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        
        result.push(current.trim());
        return result;
      };
      
      // Parse header row
      const headerRow = parseCSVLine(lines[0]);
      const expectedHeaders = [
        'Name', 'DoB', 'Gender', 'Hire Date', 'Tier', 
        'Address1', 'Address2', 'City', 'State', 'Zipcode', 
        'Phone', 'Email', 'Work Location', 'Tobacco Use'
      ];
      
      // Validate header format
      if (headerRow.length !== expectedHeaders.length) {
        throw new Error(`Expected ${expectedHeaders.length} columns, found ${headerRow.length}`);
      }
      
      // Parse data rows and group into households
      const households: CreateMemberData[][] = [];
      let currentHousehold: CreateMemberData[] = [];
      const errors: string[] = [];
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const row = parseCSVLine(line);
        
        if (row.length !== expectedHeaders.length) {
          errors.push(`Row ${i + 1}: Expected ${expectedHeaders.length} columns, found ${row.length}`);
          continue;
        }
        
        // Map CSV columns to member data
        const [
          fullName, dateOfBirth, gender, hireDate, tier,
          address1, address2, city, state, zipcode,
          phone, email, workLocation, tobaccoUse
        ] = row;
        
        // Split full name into first and last name
        const nameParts = fullName.trim().split(' ');
        let firstName = '';
        let lastName = '';
        
        if (nameParts.length === 1) {
          firstName = nameParts[0];
          lastName = '';
        } else if (nameParts.length > 1) {
          firstName = nameParts[0];
          lastName = nameParts.slice(1).join(' ');
        }

        // Validate required fields
        if (!fullName?.trim() || !email?.trim()) {
          errors.push(`Row ${i + 1}: Name and email are required`);
          continue;
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
          errors.push(`Row ${i + 1}: Invalid email format`);
          continue;
        }
        
        // Validate tier
        if (tier?.trim()) {
          const validTiers = ['EE', 'ES', 'EC', 'EF'];
          const normalizedTier = tier.trim().toUpperCase();
          
          if (!validTiers.includes(normalizedTier)) {
            errors.push(`Row ${i + 1}: Tier must be one of: EE, ES, EC, EF`);
            continue;
          }
        }
        
        // Map tier to relationship type
        const tierToRelationship: Record<string, 'P' | 'S' | 'C'> = {
          'EE': 'P',  // Employee -> Primary
          'ES': 'S',  // Employee+Spouse -> Spouse
          'EC': 'C',  // Employee+Child -> Child
          'EF': 'C',  // Employee+Family -> Child (for children in a family)
        };
        
        const tierKey = (tier?.trim() ? tier.trim().toUpperCase() : 'EE') as keyof typeof tierToRelationship;
        const relationshipType = tierToRelationship[tierKey] ?? 'P';
        
        // Normalize date format (YYYY-MM-DD) for DoB
        // Accept various formats and normalize to YYYY-MM-DD to avoid timezone/parsing issues
        let validatedDateOfBirth = '';
        if (dateOfBirth?.trim()) {
          const normalized = normalizeDateToYYYYMMDD(dateOfBirth.trim());
          if (!normalized) {
            errors.push(`Row ${i + 1}: Date of birth format is invalid or unparseable: ${dateOfBirth.trim()}`);
            continue;
          }
          validatedDateOfBirth = normalized;
        }
        
        // Normalize hire date format (YYYY-MM-DD)
        // Accept various formats and normalize to YYYY-MM-DD to avoid timezone/parsing issues
        let validatedHireDate = '';
        if (hireDate?.trim()) {
          const normalized = normalizeDateToYYYYMMDD(hireDate.trim());
          if (!normalized) {
            errors.push(`Row ${i + 1}: Hire date format is invalid or unparseable: ${hireDate.trim()}`);
            continue;
          }
          validatedHireDate = normalized;
        }
        
        // Validate gender
        let validatedGender = '';
        if (gender?.trim()) {
          const validGenders = ['Male', 'Female', 'M', 'F'];
          const normalizedGender = gender.trim();
          
          if (validGenders.includes(normalizedGender)) {
            // Convert to standard format
            validatedGender = normalizedGender === 'M' ? 'Male' : 
                             normalizedGender === 'F' ? 'Female' : 
                             normalizedGender;
          } else {
            errors.push(`Row ${i + 1}: Gender must be Male/Female or M/F`);
            continue;
          }
        }
        
        // Validate state (must be 2-letter code)
        let validatedState = '';
        if (state?.trim()) {
          if (state.trim().length !== 2) {
            errors.push(`Row ${i + 1}: State must be a 2-letter code (e.g., TX, CA)`);
            continue;
          }
          validatedState = state.trim().toUpperCase();
        }
        
        // Handle tobacco use field (Y/N/U)
        let validatedTobaccoUse = 'U'; // Default to Unknown
        if (tobaccoUse?.trim()) {
          const normalizedTobaccoUse = tobaccoUse.trim().toUpperCase();
          if (['Y', 'N', 'U'].includes(normalizedTobaccoUse)) {
            validatedTobaccoUse = normalizedTobaccoUse;
          } else if (normalizedTobaccoUse === 'YES') {
            validatedTobaccoUse = 'Y';
          } else if (normalizedTobaccoUse === 'NO') {
            validatedTobaccoUse = 'N';
          } else {
            errors.push(`Row ${i + 1}: Tobacco Use must be Y, N, or U`);
            continue;
          }
        }
        
        // Create full address from address1 and address2
        const fullAddress = address1?.trim() ? 
          (address2?.trim() ? `${address1.trim()}, ${address2.trim()}` : address1.trim()) : 
          (address2?.trim() || '');
          
        // Create member data object
        const memberData: CreateMemberData = {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phoneNumber: normalizePhoneToE164Storage(phone || ''),
          dateOfBirth: validatedDateOfBirth,
          gender: validatedGender,
          address: fullAddress,
          city: city?.trim() || '',
          state: validatedState,
          zip: zipcode?.trim() || '',
          workLocation: workLocation?.trim() || '',
          relationshipType: relationshipType,
          hireDate: validatedHireDate,
          tier: tier?.trim().toUpperCase() || 'EE',
          tobaccoUse: validatedTobaccoUse
        };
        
        // Group into households based on relationship type
        if (memberData.relationshipType === 'P') {
          // Save previous household if exists
          if (currentHousehold.length > 0) {
            households.push([...currentHousehold]);
          }
          // Start new household with this primary member
          currentHousehold = [memberData];
        } else {
          // Add dependent to current household
          if (currentHousehold.length === 0) {
            errors.push(`Row ${i + 1}: Dependent (${memberData.relationshipType}) must come after a Primary member`);
            continue;
          }
          currentHousehold.push(memberData);
        }
      }
      
      // Don't forget the last household
      if (currentHousehold.length > 0) {
        households.push([...currentHousehold]);
      }
      
      // Validate household structure
      for (let i = 0; i < households.length; i++) {
        const household = households[i];
        const primaryMembers = household.filter(m => m.relationshipType === 'P');
        
        if (primaryMembers.length === 0) {
          errors.push(`Household ${i + 1}: No primary member found`);
        } else if (primaryMembers.length > 1) {
          errors.push(`Household ${i + 1}: Multiple primary members found (should be only one)`);
        }
      }
      
      // Show errors if any
      if (errors.length > 0) {
        const errorMessage = `Import failed with ${errors.length} error(s):\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n... and ${errors.length - 5} more errors` : ''}`;
        showSnackbar(errorMessage, 'error', 'Import Errors');
        return;
      }
      
      if (households.length === 0) {
        showSnackbar('No valid members found in the file', 'warning', 'No Data');
        return;
      }
      
      // Match locations and identify uncertain members
      const primaryLocation = locations.find(loc => loc.IsPrimary);
      const uncertainMembers: Array<{
        rowIndex: number;
        memberData: CreateMemberData;
        csvLocationValue: string;
        selectedLocationId: string;
      }> = [];
      
      // Flatten households to process all members
      const allMembers = households.flat();
      
      for (let i = 0; i < allMembers.length; i++) {
        const member = allMembers[i];
        const csvLocation = member.workLocation?.trim() || '';
        
        if (!csvLocation) {
          // Empty location - mark as uncertain, default to primary
          uncertainMembers.push({
            rowIndex: i + 1,
            memberData: member,
            csvLocationValue: '(empty)',
            selectedLocationId: primaryLocation?.LocationId || ''
          });
          continue;
        }
        
        // Try to match to existing locations (case-insensitive)
        const matchedLocation = locations.find(loc => 
          (loc.Name || '').toLowerCase() === csvLocation.toLowerCase()
        );
        
        if (matchedLocation) {
          // Match found! Set the locationId
          (member as any).locationId = matchedLocation.LocationId;
        } else {
          // No match - mark as uncertain, default to primary
          uncertainMembers.push({
            rowIndex: i + 1,
            memberData: member,
            csvLocationValue: csvLocation,
            selectedLocationId: primaryLocation?.LocationId || ''
          });
        }
      }
      
      // If there are uncertain members, show the modal for confirmation
      if (uncertainMembers.length > 0) {
        setLocationMatchModal({
          open: true,
          uncertainMembers,
          allHouseholds: households
        });
        setImportDialogOpen(false); // Close the import dialog
        return; // Stop here and wait for user confirmation
      }
      
      // If all locations matched, proceed directly with import
      await proceedWithImport(households);
      
    } catch (error) {
      console.error('Error importing members:', error);
      showSnackbar(
        error instanceof Error ? error.message : 'Failed to import members',
        'error',
        'Import Error'
      );
    }
  };

  // Helper function to calculate default hire date
  const getDefaultHireDate = (): string => {
    const today = new Date();
    const firstOfYear = new Date(today.getFullYear(), 0, 1); // January 1st of this year
    const threeMonthsAgo = new Date(today);
    threeMonthsAgo.setMonth(today.getMonth() - 3);
    
    // If first of year is at least 3 months ago, use it
    if (firstOfYear <= threeMonthsAgo) {
      return `${today.getFullYear()}-01-01`;
    }
    
    // Otherwise, use 3 months ago
    const year = threeMonthsAgo.getFullYear();
    const month = String(threeMonthsAgo.getMonth() + 1).padStart(2, '0');
    const day = String(threeMonthsAgo.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Separate function to handle the actual import after location confirmation
  const proceedWithImport = async (households: CreateMemberData[][]) => {
    // Calculate total members to import
    const totalMembersToImport = households.reduce((sum, h) => sum + h.length, 0);
    
    // Open loading modal
      setImportLoadingModal({
      open: true,
      progress: 0,
      current: 'Starting import...',
      errors: [],
      skippedMembers: [],
      success: false,
      existingUsersNotImported: [],
      totalAttempted: totalMembersToImport,
      totalImported: 0,
      totalHouseholdsAttempted: households.length,
      totalHouseholdsImported: 0,
      totalHouseholdsFailed: 0,
      existingMembersInGroup: 0,
    });
    
    try {
      // Create households sequentially
      let totalFailureCount = 0;
      let existingMembersCount = 0;
      let newMembersCount = 0;
      let successfulHouseholds = 0;
      let failedHouseholds = 0;
      const importErrors: string[] = [];
      const skippedMembers: string[] = [];
      const existingUsersNotImported: Array<{ firstName: string; lastName: string; email: string }> = [];
      
      // Calculate default hire date once
      const defaultHireDate = getDefaultHireDate();
      
      for (let i = 0; i < households.length; i++) {
        const household = households[i];
        const primaryMember = { ...household.find(m => m.relationshipType === 'P')! };
        primaryMember.phoneNumber = normalizePhoneToE164Storage(primaryMember.phoneNumber || '');
        
        if (!primaryMember || !primaryMember.firstName) {
          console.error(`❌ ERROR: Household ${i + 1} has no valid primary member!`, household);
          continue; // Skip this household
        }
        
        // Update progress
        const progress = Math.round(((i + 1) / households.length) * 100);
        setImportLoadingModal(prev => ({
          ...prev,
          progress,
          current: `Importing household ${i + 1} of ${households.length}: ${primaryMember.firstName || ''} ${primaryMember.lastName || ''}`,
        }));
        const dependents = household.filter(m => m.relationshipType !== 'P').map(d => ({
          ...d,
          phoneNumber: normalizePhoneToE164Storage(d.phoneNumber || ''),
        }));
        
        // Log household structure for debugging
        console.log(`📋 Household ${i + 1} structure:`, {
          primaryMember: `${primaryMember.firstName} ${primaryMember.lastName}`,
          dependentsCount: dependents.length,
          dependents: dependents.map(d => `${d.firstName} ${d.lastName} (${d.relationshipType})`)
        });
        
        // Log dependents for this household
        if (dependents.length > 0) {
          console.log(`📋 Household ${i + 1} (${primaryMember.firstName} ${primaryMember.lastName}) has ${dependents.length} dependent(s) to create:`, dependents.map(d => `${d.firstName} ${d.lastName} (${d.relationshipType})`));
        } else {
          console.log(`⚠️ Household ${i + 1} (${primaryMember.firstName} ${primaryMember.lastName}) has NO dependents`);
        }
        
        // Set default hire date for primary member if missing
        if (!primaryMember.hireDate || primaryMember.hireDate.trim() === '') {
          primaryMember.hireDate = defaultHireDate;
        }
        
        // Set default hire date for dependents if missing
        dependents.forEach(dependent => {
          if (!dependent.hireDate || dependent.hireDate.trim() === '') {
            dependent.hireDate = defaultHireDate;
          }
        });
        
        // CRITICAL: Set groupId on primary member and all dependents
        // This ensures all members are created with the correct GroupId
        (primaryMember as any).groupId = groupId;
        dependents.forEach(dependent => {
          (dependent as any).groupId = groupId;
        });
        
        let householdNewCount = 0;
        let householdFailedCount = 0;
        
        try {
          // Create entire household atomically (primary + dependents)
          // If any member fails, the entire household is rolled back
          console.log(`🏠 Creating household atomically: Primary: ${primaryMember.firstName} ${primaryMember.lastName}, Dependents: ${dependents.length}, GroupId: ${groupId}`);
          
          const householdResult = await MembersService.createHouseholdAtomically(primaryMember, dependents);
          
          if (householdResult.success) {
            // Household created successfully
            const memberCount = householdResult.data?.members?.length || 1;
            householdNewCount++;
            newMembersCount += memberCount;
            successfulHouseholds++;
            console.log(`✅ Household created successfully with ${memberCount} member(s): ${primaryMember.firstName} ${primaryMember.lastName}`);
          } else {
            // Household creation failed - entire household rolled back
            const errorMessage = householdResult.message || householdResult.error?.message || 'Unknown error creating household';
            console.error(`❌ Failed to create household atomically: ${primaryMember.firstName} ${primaryMember.lastName}`, errorMessage);
            
            // Check if it's a "member already exists" error - treat as skipped, not error
            const isAlreadyExists = errorMessage.includes('already exists') || 
                                    errorMessage.includes('Member already') ||
                                    errorMessage.includes('already exists in this group') ||
                                    errorMessage.toLowerCase().includes('assignment to constant variable');
            
            if (isAlreadyExists) {
              // Member already exists - skip, don't count as error
              const skippedMsg = `Household ${i + 1}: ${primaryMember.firstName} ${primaryMember.lastName} - Member already added`;
              skippedMembers.push(skippedMsg);
              
              setImportLoadingModal(prev => ({
                ...prev,
                skippedMembers: [...prev.skippedMembers, skippedMsg],
              }));
              
              // Check if it's an existing user error (not in this group)
              if (errorMessage.includes('already exists in the system')) {
                existingUsersNotImported.push({
                  firstName: primaryMember.firstName,
                  lastName: primaryMember.lastName,
                  email: primaryMember.email || 'No email provided'
                });
              }
            } else {
              // Real error
              householdFailedCount++;
              totalFailureCount++;
              failedHouseholds++;
              const errorMsg = `Household ${i + 1}: ${primaryMember.firstName} ${primaryMember.lastName} - ${errorMessage}`;
              importErrors.push(errorMsg);
              
              setImportLoadingModal(prev => ({
                ...prev,
                errors: [...prev.errors, errorMsg],
              }));
            }
          }
          
        } catch (error) {
          console.error('Failed to create household:', primaryMember, error);
          const errorMessage = error instanceof Error ? error.message : 'Failed';
          
          // Check if it's a "member already exists" error - treat as skipped, not error
          const isAlreadyExists = errorMessage.includes('already exists') || 
                                  errorMessage.includes('Member already') ||
                                  errorMessage.includes('already exists in this group') ||
                                  errorMessage.toLowerCase().includes('assignment to constant variable');
          
          if (isAlreadyExists) {
            // Member already exists - skip, don't count as error
            const skippedMsg = `Household ${i + 1}: ${primaryMember.firstName} ${primaryMember.lastName} - Member already added`;
            skippedMembers.push(skippedMsg);
            
            setImportLoadingModal(prev => ({
              ...prev,
              skippedMembers: [...prev.skippedMembers, skippedMsg],
            }));
          } else {
            // Real error
            totalFailureCount++;
            failedHouseholds++;
            const errorMsg = `Household ${i + 1}: ${primaryMember.firstName} ${primaryMember.lastName} - ${errorMessage}`;
            importErrors.push(errorMsg);
            
            setImportLoadingModal(prev => ({
              ...prev,
              errors: [...prev.errors, errorMsg],
            }));
          }
        }
      }
      
      // Update modal with final results
      const totalImported = newMembersCount + existingMembersCount;
      const hasSuccess = totalImported > 0;
      setImportLoadingModal(prev => ({
        ...prev,
        progress: 100,
        current: hasSuccess ? 'Import completed!' : 'Import failed',
        success: hasSuccess && totalFailureCount === 0 && failedHouseholds === 0,
        existingUsersNotImported: existingUsersNotImported,
        totalImported: totalImported,
        totalHouseholdsImported: successfulHouseholds,
        totalHouseholdsFailed: failedHouseholds,
        existingMembersInGroup: existingMembersCount,
        skippedMembers: skippedMembers,
      }));
      
      // Refresh the members list
      if (hasSuccess) {
        await refetch();
      }
      
      // Keep modal open - user must manually close it
      // This allows them to see the import results and copy any reports
      setImportDialogOpen(false);
      setSelectedFile(null);
      
    } catch (error) {
      console.error('Error importing members:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to import members';
      setImportLoadingModal(prev => ({
        ...prev,
        progress: 100,
        current: 'Import failed',
        errors: [...prev.errors, errorMessage],
        success: false,
      }));
    }
  };

  // Handle location confirmation and proceed with import
  const handleLocationMatchConfirm = async () => {
    try {
      // Update the member data with selected locations
      const allMembers = locationMatchModal.allHouseholds.flat();
      
      locationMatchModal.uncertainMembers.forEach(uncertainMember => {
        const member = allMembers[uncertainMember.rowIndex - 1];
        if (member) {
          (member as any).locationId = uncertainMember.selectedLocationId;
        }
      });
      
      // Close the modal
      setLocationMatchModal({
        open: false,
        uncertainMembers: [],
        allHouseholds: []
      });
      
      // Proceed with the import
      await proceedWithImport(locationMatchModal.allHouseholds);
      
    } catch (error) {
      console.error('Error processing location match:', error);
      showSnackbar(
        error instanceof Error ? error.message : 'Failed to process location selection',
        'error',
        'Error'
      );
    }
  };

  const handleLocationMatchCancel = () => {
    setLocationMatchModal({
      open: false,
      uncertainMembers: [],
      allHouseholds: []
    });
    // Optionally reset selectedFile and reopen import dialog
    setSelectedFile(null);
  };

  const handleFileSelect = (file: File | null) => {
    if (file) {
      // Validate file type
      const validTypes = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ];
      
      if (!validTypes.includes(file.type) && !file.name.match(/\.(csv|xlsx|xls)$/i)) {
        showSnackbar('Please select a valid CSV or Excel file', 'error', 'Invalid File Type');
        return;
      }
      
      if (file.size > MAX_LARGE_UPLOAD_BYTES) {
        showSnackbar(`File size must be less than ${MAX_LARGE_UPLOAD_MB}MB`, 'error', 'File Too Large');
        return;
      }
      
      setSelectedFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  };

  const removeSelectedFile = () => {
    setSelectedFile(null);
  };

  // Fetch enrollment period status
  const fetchEnrollmentPeriodStatus = async () => {
    try {
      setEnrollmentPeriodLoading(true);
      console.log('🔍 Fetching enrollment period status for group:', groupId);
      
      const data = await GroupsService.getEnrollmentPeriodStatus(groupId);
      
      console.log('📡 Enrollment period status response:', data);
      
      if (data.success) {
        console.log('✅ Enrollment period status data:', data.data);
        setEnrollmentPeriodStatus(data.data);
      } else {
        console.error('❌ Failed to fetch enrollment period status:', data.message);
        // Set status to indicate no period is needed/available if API returns success: false
        setEnrollmentPeriodStatus({
          needsEnrollmentPeriod: true,
          hasEnrolledMembers: false,
          currentPeriod: null
        });
      }
    } catch (error) {
      console.error('❌ Error fetching enrollment period status:', error);
      // Set default status on error so UI can still show "needs enrollment period" message
      setEnrollmentPeriodStatus({
        needsEnrollmentPeriod: true,
        hasEnrolledMembers: false,
        currentPeriod: null
      });
    } finally {
      setEnrollmentPeriodLoading(false);
    }
  };

  // Auto-create group enrollment link template (used by Individual Enrollment Link modal when no templates exist)
  const createNewEnrollmentLinkTemplate = async (): Promise<string | null> => {
    try {
      const productsResponse = await GroupsService.getGroupProducts(groupId);
      if (!productsResponse.success || !productsResponse.data) {
        throw new Error('Failed to fetch group products');
      }
      const groupProducts = Array.isArray(productsResponse.data)
        ? productsResponse.data
        : (productsResponse.data as any).groupProducts || [];
      if (!groupProducts || groupProducts.length === 0) {
        throw new Error('No products are assigned to this group. Please assign products to the group before creating an enrollment link.');
      }
      const productsByType = new Map<string, any[]>();
      let bundleProductIds: string[] = [];
      groupProducts.forEach((product: any) => {
        const productType = product.ProductType || 'Other';
        if (productType === 'Bundle') {
          bundleProductIds.push(product.ProductId);
          return;
        }
        if (!productsByType.has(productType)) productsByType.set(productType, []);
        productsByType.get(productType)!.push(product);
      });
      const productSections: any[] = [];
      productsByType.forEach((products, productType) => {
        const allProductIds = products.map((p: any) => p.ProductId);
        if (allProductIds.length === 0) return;
        const isHealthcareOrMedical = productType === 'Healthcare' || productType === 'Medical';
        const specificProducts = isHealthcareOrMedical && bundleProductIds.length > 0
          ? [...allProductIds, ...bundleProductIds]
          : allProductIds;
        if (isHealthcareOrMedical) bundleProductIds = [];
        productSections.push({
          page: productType,
          header: `Select Your ${productType} Coverage`,
          productType,
          sectionType: 'products',
          includePdfLinks: true,
          includeVideos: false,
          effectiveDateRules: { type: 'GroupDefined' },
          specificProducts
        });
      });
      if (bundleProductIds.length > 0) {
        productSections.push({
          page: 'Healthcare',
          header: 'Select Your Healthcare Coverage',
          productType: 'Healthcare',
          sectionType: 'products',
          includePdfLinks: true,
          includeVideos: false,
          effectiveDateRules: { type: 'GroupDefined' },
          specificProducts: bundleProductIds
        });
      }
      const orderedSections = sortProductSectionsByDefaultOrder(productSections);
      const linkMetaData = {
        household: { header: 'Employee Information', fields: ['FirstName', 'LastName', 'Email', 'Phone', 'DateOfBirth', 'HouseholdSize'], prepopulate: false },
        products: orderedSections,
        additionalDetails: { header: 'Additional Information', fields: ['Address', 'Dependents'] }
      };
      const groupAgentId = (groupDetails as Record<string, unknown>)?.AgentId as string | undefined ?? undefined;
      const groupTenantId = (groupDetails as Record<string, unknown>)?.TenantId as string | undefined ?? undefined;
      const createPayload: Parameters<typeof EnrollmentLinkTemplatesService.createTemplate>[0] = {
        templateName: `${groupName} Enrollment Link`,
        templateType: 'Group',
        groupId,
        linkMetaData: JSON.stringify(linkMetaData),
        description: `Auto-generated enrollment link template for ${groupName}`
      };
      if (groupAgentId && (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin' || user?.currentRole === 'GroupAdmin')) {
        createPayload.agentId = groupAgentId;
      }
      if (user?.currentRole === 'SysAdmin' && groupTenantId) {
        createPayload.tenantId = groupTenantId;
      }
      const createResponse = await EnrollmentLinkTemplatesService.createTemplate(createPayload, user?.currentRole);
      if (!createResponse.success || !createResponse.data?.templateId) {
        throw new Error(createResponse.message || 'Failed to create enrollment link template');
      }
      return createResponse.data.templateId;
    } catch (error) {
      console.error('Error creating enrollment link template:', error);
      throw error;
    }
  };

  const sendEnrollmentLinks = async (
    memberIds: string[], 
    templateId: string, 
    deliveryPreferences: { sendEmail: boolean; sendSMS: boolean },
    phoneNumbers?: Record<string, string>,
    linkBaseUrl?: string
  ) => {
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
      const data = await GroupsService.sendEnrollmentLinks(
        groupId, 
        memberIds, 
        templateId,
        deliveryPreferences,
        phoneNumbers,
        linkBaseUrl
      );
      
      if (data.success) {
        const deliveryMethods = [];
        if (deliveryPreferences.sendEmail) deliveryMethods.push('email');
        if (deliveryPreferences.sendSMS) deliveryMethods.push('text message');
        const methodsText = deliveryMethods.join(' and ');
        
        showSnackbar(
          `Successfully sent ${memberIds.length} enrollment link(s) via ${methodsText} using template: ${data.data.templateName}`, 
          'success', 
          'Success'
        );
        setSendLinksDialogOpen(false);
        
        // Refresh the members list to show updated enrollment status
        await refetch();
      } else {
        // Handle validation errors
        if (data.message && data.message.includes('Primary Contact')) {
          showSnackbar(
            'Group must have Primary Contact and Contact Email set up before sending enrollment links. Please update the group details in the Overview tab.',
            'error',
            'Contact Information Required'
          );
        } else {
          showSnackbar(data.message || 'Failed to send enrollment links', 'error', 'Error');
        }
        setSendLinksDialogOpen(false);
      }
    } catch (error: any) {
      console.error('Error sending enrollment links:', error);
      
      // Extract error message from various error formats
      let errorMessage = 'Failed to send enrollment links';
      
      if (error?.response?.data?.message) {
        // Axios error with response data
        errorMessage = error.response.data.message;
      } else if (error?.message) {
        // Standard Error object or API service error
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      showSnackbar(errorMessage, 'error', 'Error');
    }
  };

  // Handle intelligent import (AI parsing)
  const handleIntelligentImport = async (file: File) => {
    try {
      // Create abort controller for cancellation
      const controller = new AbortController();
      setAbortController(controller);
      
      setAiParsingLoading(true);
      setParsedCensusData(null); // Clear previous data
      setPreviewDialogOpen(true); // Show preview dialog with loading state
      setImportDialogOpen(false); // Close import dialog
      
      console.log('🤖 Starting intelligent parsing for file:', file.name);
      
      // Call AI parsing service with abort signal
      const response = await MembersService.parseCensusWithAI(groupId, file, controller.signal);
      
      if (response.success && response.data) {
        console.log('✅ Parsing successful:', response.data);
        setParsedCensusData(response.data);
        // Preview dialog is already open, it will show the data
      } else {
        console.error('❌ Parsing failed:', response.message);
        setPreviewDialogOpen(false); // Close preview dialog on error
        showSnackbar(
          response.message || 'Failed to parse census file. Please try the Standard Import option or check your file format.',
          'error',
          'Parsing Failed'
        );
        // Reopen import dialog on error
        setImportDialogOpen(true);
      }
    } catch (error) {
      // Check if it was cancelled
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Parsing was cancelled')) {
        // Already handled by handleCancelAIProcessing
        return;
      }
      
      console.error('❌ Error during intelligent parsing:', error);
      setPreviewDialogOpen(false); // Close preview dialog on error
      showSnackbar(
        error instanceof Error ? error.message : 'Failed to parse census file. Please try the Standard Import option.',
        'error',
        'Parsing Error'
      );
      // Reopen import dialog on error
      setImportDialogOpen(true);
    } finally {
      setAiParsingLoading(false);
      setAbortController(null);
    }
  };
  
  // Handle cancel during AI processing
  const handleCancelAIProcessing = () => {
    if (abortController) {
      abortController.abort();
      console.log('🛑 AI processing cancelled by user');
      setAbortController(null);
      setAiParsingLoading(false);
      setPreviewDialogOpen(false);
      setParsedCensusData(null);
      showSnackbar('AI processing cancelled', 'info', 'Processing Cancelled');
      setImportDialogOpen(true); // Reopen import dialog
    }
  };

  // Handle confirm from preview dialog
  const handlePreviewConfirm = async (households: Array<{
    primaryMember: CreateMemberData & { locationId?: string; locationName?: string };
    dependents: Array<CreateMemberData & { locationId?: string; locationName?: string }>;
  }>) => {
    try {
      setPreviewDialogOpen(false);
      setAiParsingLoading(true);
      
      console.log('✅ Confirmed import for', households.length, 'households');
      
      // Convert households to the format expected by proceedWithImport
      // Calculate default hire date once
      const getDefaultHireDate = (): string => {
        const today = new Date();
        const firstOfYear = new Date(today.getFullYear(), 0, 1); // January 1st of this year
        const threeMonthsAgo = new Date(today);
        threeMonthsAgo.setMonth(today.getMonth() - 3);
        
        // If first of year is at least 3 months ago, use it
        if (firstOfYear <= threeMonthsAgo) {
          return `${today.getFullYear()}-01-01`;
        }
        
        // Otherwise, use 3 months ago
        const year = threeMonthsAgo.getFullYear();
        const month = String(threeMonthsAgo.getMonth() + 1).padStart(2, '0');
        const day = String(threeMonthsAgo.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      };
      
      const defaultHireDate = getDefaultHireDate();
      
      const householdsForImport: CreateMemberData[][] = households.map((household, index) => {
        // Debug logging
        if (index === 0) {
          console.log('🔍 DEBUG: First household structure:', {
            hasPrimaryMember: !!household.primaryMember,
            hasDependents: !!household.dependents,
            dependentsLength: household.dependents?.length || 0,
            dependents: household.dependents
          });
        }
        
        const primary: CreateMemberData = {
          firstName: household.primaryMember.firstName,
          lastName: household.primaryMember.lastName,
          email: household.primaryMember.email,
          phoneNumber: normalizePhoneToE164Storage(household.primaryMember.phoneNumber || ''),
          // Normalize dateOfBirth to YYYY-MM-DD format to avoid timezone/parsing issues
          dateOfBirth: household.primaryMember.dateOfBirth 
            ? normalizeDateToYYYYMMDD(household.primaryMember.dateOfBirth) 
            : '',
          gender: household.primaryMember.gender,
          address: household.primaryMember.address,
          city: household.primaryMember.city,
          state: household.primaryMember.state,
          zip: household.primaryMember.zip,
          relationshipType: 'P',
          // Normalize hireDate to YYYY-MM-DD format
          hireDate: household.primaryMember.hireDate 
            ? normalizeDateToYYYYMMDD(household.primaryMember.hireDate) || defaultHireDate
            : defaultHireDate,
          tier: household.primaryMember.tier || 'EE',
          tobaccoUse: household.primaryMember.tobaccoUse,
          workLocation: household.primaryMember.workLocation,
          jobPosition: household.primaryMember.jobPosition || undefined,
        };
        
        // Add locationId if available
        if (household.primaryMember.locationId) {
          (primary as any).locationId = household.primaryMember.locationId;
        }
        
        // Check if dependents exist and log
        if (!household.dependents || household.dependents.length === 0) {
          console.log(`⚠️ Household ${index + 1} (${primary.firstName} ${primary.lastName}) has NO dependents`);
        } else {
          console.log(`✅ Household ${index + 1} (${primary.firstName} ${primary.lastName}) has ${household.dependents.length} dependent(s)`);
        }
        
        const dependents: CreateMemberData[] = (household.dependents || []).map(dependent => {
          // For children, don't send email (backend will generate default)
          // For spouses, send email if provided, otherwise empty (backend will generate default)
          const emailToSend = dependent.relationshipType === 'C' 
            ? '' // Children: no email, backend generates
            : (dependent.email || ''); // Spouses: use provided email or empty, backend generates if empty
          
          const dep: CreateMemberData = {
            firstName: dependent.firstName,
            lastName: dependent.lastName,
            email: emailToSend,
            phoneNumber: normalizePhoneToE164Storage(dependent.phoneNumber || ''),
            // Normalize dateOfBirth to YYYY-MM-DD format to avoid timezone/parsing issues
            dateOfBirth: dependent.dateOfBirth 
              ? normalizeDateToYYYYMMDD(dependent.dateOfBirth) 
              : '',
            gender: dependent.gender,
            address: dependent.address,
            city: dependent.city,
            state: dependent.state,
            zip: dependent.zip,
            relationshipType: dependent.relationshipType || 'C',
            // Normalize hireDate to YYYY-MM-DD format
            hireDate: dependent.hireDate 
              ? normalizeDateToYYYYMMDD(dependent.hireDate) || defaultHireDate
              : defaultHireDate,
            tier: dependent.tier,
            tobaccoUse: dependent.tobaccoUse,
            workLocation: dependent.workLocation,
            jobPosition: dependent.jobPosition || undefined,
          };
          
          // Add locationId if available
          if (dependent.locationId) {
            (dep as any).locationId = dependent.locationId;
          }
          
          return dep;
        });
        
        const householdArray = [primary, ...dependents];
        
        // Log household composition
        if (dependents.length > 0) {
          console.log(`📋 Household ${index + 1}: ${primary.firstName} ${primary.lastName} + ${dependents.length} dependent(s)`);
        }
        
        return householdArray;
      });
      
      // Log total summary before import
      const totalDependents = householdsForImport.reduce((sum, h) => sum + (h.length - 1), 0);
      console.log(`📊 Import Summary: ${householdsForImport.length} households, ${totalDependents} total dependents to import`);
      
      // Use existing proceedWithImport function
      await proceedWithImport(householdsForImport);
      
      // Reset state
      setParsedCensusData(null);
      setSelectedFile(null);
      
    } catch (error) {
      console.error('❌ Error confirming import:', error);
      showSnackbar(
        error instanceof Error ? error.message : 'Failed to import members',
        'error',
        'Import Error'
      );
    } finally {
      setAiParsingLoading(false);
    }
  };

  const downloadTemplate = () => {
    // Create CSV template with exact headers expected by import function
    const templateData = [
      ['Name', 'DoB', 'Gender', 'Hire Date', 'Tier', 'Address1', 'Address2', 'City', 'State', 'Zipcode', 'Phone', 'Email', 'Work Location', 'Tobacco Use'],
      ['John Smith', '1985-03-15', 'Male', '2022-01-15', 'EE', '123 Main St', 'Apt 101', 'Anytown', 'TX', '75001', '555-123-4567', 'john.smith@company.com', 'Main Office', 'N'],
      ['Sarah Smith', '1987-08-22', 'Female', '2022-01-15', 'ES', '123 Main St', 'Apt 101', 'Anytown', 'TX', '75001', '555-123-4568', 'sarah.smith@company.com', 'Main Office', 'Y'],
      ['Tim Smith', '2010-12-25', 'Male', '2022-01-15', 'EC', '123 Main St', 'Apt 101', 'Anytown', 'TX', '75001', '', 'tim.smith@company.com', '', 'N'],
      ['Jane Doe', '1982-05-10', 'F', '2021-06-01', 'EE', '456 Oak Ave', '', 'Othertown', 'CA', '90210', '555-987-6543', 'jane.doe@company.com', 'Remote', 'N'],
      ['Bob Doe', '1980-11-30', 'M', '2021-06-01', 'ES', '456 Oak Ave', '', 'Othertown', 'CA', '90210', '555-987-6544', 'bob.doe@company.com', 'Remote', 'U'],
    ];

    const csvContent = templateData.map(row => 
      row.map(cell => {
        // Escape quotes and wrap in quotes if contains comma or quote
        const escaped = cell.replace(/"/g, '""');
        return cell.includes(',') || cell.includes('"') ? `"${escaped}"` : escaped;
      }).join(',')
    ).join('\n');
    
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

  // Effects - fetch enrollment period status on mount
  React.useEffect(() => {
    if (groupId) {
      fetchEnrollmentPeriodStatus();
    }
  }, [groupId]);


  // Separate function for adding member from dialog (with UI feedback)
  // When openSendLinkAfter is true, after success opens the Send Enrollment Link modal for the new member
  const addMemberFromDialog = async (memberData: CreateMemberData, openSendLinkAfter?: boolean) => {
    if (!isOptionalUsZipValid(memberData.zip)) {
      showSnackbar(
        'ZIP Code must be 5 digits or 9 digits (ZIP+4), or leave blank.',
        'error',
        'Error'
      );
      return;
    }
    setAddMemberLoading(true);
    try {
      const result = await createMember(memberData);
      
      if (result.data.alreadyExists && result.data.existingInGroup) {
        // Member already exists in this group
        showSnackbar(
          `Member ${memberData.firstName} ${memberData.lastName} already exists in this group`,
          'info',
          'Member Already Exists'
        );
      } else if (result.data.linkedExistingUser) {
        // Existing user was automatically linked to new member record
        showSnackbar(
          `Member ${memberData.firstName} ${memberData.lastName} added successfully (linked to existing user account)`,
          'success',
          'Member Added'
        );
        
        // Store the new member ID for highlighting
        if (result.data?.memberId) {
          const newMemberId = result.data.memberId;
          setNewestMemberId(newMemberId);
          
          // Set sort to CreatedDate descending to show newest first
          setSortModel([{ field: 'CreatedDate', sort: 'desc' }]);
          
          // Reset to first page
          setPaginationModel(prev => ({ ...prev, page: 0 }));
        }
      } else {
        // New member created
        showSnackbar(
          `Member ${memberData.firstName} ${memberData.lastName} added successfully`,
          'success',
          'Member Added'
        );
        
        // Store the new member ID for highlighting
        if (result.data?.memberId) {
          const newMemberId = result.data.memberId;
          setNewestMemberId(newMemberId);
          
          // Set sort to CreatedDate descending to show newest first
          setSortModel([{ field: 'CreatedDate', sort: 'desc' }]);
          
          // Reset to first page
          setPaginationModel(prev => ({ ...prev, page: 0 }));
        }
      }
      
      // Refresh the members list
      refetch(); // Use refetch instead of fetchMembers
      
      // Reset form data
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
        locationId: '',
        relationshipType: 'P',
        hireDate: new Date().toISOString().split('T')[0],
        tier: 'EE',
        jobPosition: undefined,
      });
      
      // Close the dialog
      setAddDialogOpen(false);

      // Optionally open Send Enrollment Link modal for the new member (same as 3-dots → Send enrollment link)
      if (openSendLinkAfter && result.data?.memberId) {
        try {
          const response = await apiService.get<{ success: boolean; data: Member }>(`/api/members/${result.data.memberId}`);
          if (response.success && response.data) {
            setSelectedMemberForLink(response.data);
            setIndividualLinkDialogOpen(true);
          }
        } catch (linkError) {
          console.error('Error loading member for enrollment link:', linkError);
          showSnackbar('Member added. Opening enrollment link failed.', 'warning', 'Notice');
        }
      }
      
    } catch (error: unknown) {
      console.error('Error adding member:', error);
      showSnackbar(
        getApiErrorDisplayMessage(error, 'Failed to add member'),
        'error',
        'Error'
      );
    } finally {
      setAddMemberLoading(false);
    }
  };

  const handleEditMember = async (member: Member) => {
    setSelectedMember(member);
    setEnrollmentsLoading(true);
    setMutationError(null);

    try {
      // Get member details and household members
      const householdResponse = await apiService.get<{ 
        success: boolean, 
        data: { 
          member: Member, 
          householdMembers: Member[] 
        } 
      }>(`/api/members/${member.MemberId}/with-household`);
      
      if (householdResponse.success) {
        setSelectedMember(householdResponse.data.member);
        setHouseholdMembers(householdResponse.data.householdMembers);
      }

      // Get enrollments
      const enrollmentsResponse = await apiService.get<{ 
        success: boolean, 
        data: any[] 
      }>(`/api/enrollments?memberId=${member.MemberId}`);
      
      if (enrollmentsResponse.success) {
        setMemberEnrollments(enrollmentsResponse.data);
      }
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to load member details');
      console.error('Error fetching member details:', err);
      // If fetching enhanced details fails, fall back to the basic member info we already have
      setSelectedMember(member);
      setHouseholdMembers([]);
      setMemberEnrollments([]);
    } finally {
      setEnrollmentsLoading(false);
    }
  };

  // Helper functions for MemberManagementModal
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'bg-green-100 text-green-800';
      case 'Inactive': return 'bg-gray-100 text-gray-800';
      case 'Pending': return 'bg-yellow-100 text-yellow-800';
      case 'Terminated': return 'bg-red-100 text-red-800';
      case 'Suspended': return 'bg-orange-100 text-orange-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return <PersonIcon sx={{ fontSize: '1rem', color: 'var(--oe-primary)' }} />;
      case 'S': return <PersonIcon sx={{ fontSize: '1rem', color: '#ec4899' }} />;
      case 'C': return <PersonIcon sx={{ fontSize: '1rem', color: '#10b981' }} />;
      default: return <PersonIcon sx={{ fontSize: '1rem', color: '#6b7280' }} />;
    }
  };

  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-pink-100 text-pink-800';
      case 'C': return 'bg-green-100 text-green-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const handleMenuClick = (event: React.MouseEvent<HTMLElement>, memberId: string) => {
    setAnchorEl(event.currentTarget);
    setSelectedMemberId(memberId);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedMemberId(null);
  };



  const formatCurrency = (amount: number | null | undefined | string): string => {
    if (amount === null || amount === undefined) {
      return '$0.00';
    }
    
    // Convert string to number if needed
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    
    if (isNaN(numAmount)) {
      console.warn('💰 Invalid amount for formatCurrency:', amount, 'type:', typeof amount);
      return '$0.00';
    }
    
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(numAmount);
  };

  // DataGrid columns (field names must match backend sortBy parameter)
  const columns: GridColDef[] = [
    {
      field: 'LastName', // Backend uses 'LastName' for sorting
      headerName: 'Member Name',
      flex: 1,
      minWidth: 160, // Reduced from 200
      maxWidth: 400,
      renderCell: (params: GridRenderCellParams) => {
        const row = params.row as Member;
        return (
          <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ width: '100%' }}>
            <PersonIcon 
              sx={{ 
                color: row.Status === 'Terminated' ? '#ef4444' : 'var(--oe-primary)',
                fontSize: '1rem',
                flexShrink: 0,
                mt: 0.25
              }} 
            />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                <Typography
                  component="button"
                  variant="body2"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditMember(row);
                  }}
                  sx={{
                    fontWeight: 500,
                    fontSize: '0.8rem',
                    color: row.Status === 'Terminated' ? theme.palette.text.disabled : 'var(--oe-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    '&:hover': { textDecoration: 'underline' },
                  }}
                >
                  {`${row.FirstName} ${row.LastName}`}
                </Typography>
                {row.Status === 'Terminated' && (
                  <Chip 
                    label="TERM" 
                    size="small" 
                    color="error" 
                    variant="filled"
                    sx={{ fontSize: '0.6rem', height: 16, fontWeight: 500, px: 0.5 }}
                  />
                )}
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }} flexWrap="wrap">
                {row.Email && (
                  <Stack direction="row" spacing={0.25} alignItems="center">
                    <EmailIcon sx={{ fontSize: '0.7rem', color: theme.palette.text.secondary }} />
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem' }}>
                      {row.Email}
                    </Typography>
                  </Stack>
                )}
                {row.PhoneNumber ? (
                  <Tooltip title={row.PhoneNumber} placement="top">
                    <PhoneIcon sx={{ fontSize: '0.7rem', color: theme.palette.text.secondary, ml: row.Email ? 0.5 : 0 }} />
                  </Tooltip>
                ) : null}
              </Stack>
            </Box>
          </Stack>
        );
      },
    },
    {
      field: 'JobPosition',
      headerName: 'Job Position',
      width: 140, // Reduced from 180
      minWidth: 120, // Reduced from 150
      sortable: true,
      filterable: true,
      hideable: true,
      valueGetter: (value, row) => row.JobPosition || '',
      renderCell: (params: GridRenderCellParams) => {
        const jobPosition = params.row.JobPosition || params.value;
        const jobPositionLabel = DEFAULT_JOB_POSITIONS.find(p => p.id === jobPosition)?.label || jobPosition;
        return (
          <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontSize: '0.8rem' }}>
            {jobPositionLabel || '-'}
          </Typography>
        );
      },
    },
    {
      field: 'EnrolledPlanNames',
      headerName: 'Plans',
      minWidth: 160,
      flex: 1,
      maxWidth: 400,
      sortable: false,
      valueGetter: (value: string[] | undefined) => (value && value.length > 0 ? value.join(', ') : ''),
      renderCell: (params: GridRenderCellParams) => {
        const plans = (params.row as Member).EnrolledPlanNames;
        if (!plans || plans.length === 0) {
          return (
            <Typography variant="body2" sx={{ color: theme.palette.text.disabled, fontSize: '0.8rem', fontStyle: 'italic' }}>
              —
            </Typography>
          );
        }
        return (
          <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontSize: '0.8rem' }}>
            {plans.join(', ')}
          </Typography>
        );
      },
    },
    {
      field: 'LocationName',
      headerName: 'Work Location',
      width: 140, // Reduced from 180
      renderCell: (params: GridRenderCellParams) => (
        params.value ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <LocationIcon sx={{ fontSize: '0.8rem', color: theme.palette.text.secondary }} />
            <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontSize: '0.8rem' }}>
              {params.value}
            </Typography>
          </Stack>
        ) : (
          <Typography variant="body2" sx={{ color: theme.palette.text.disabled, fontStyle: 'italic', fontSize: '0.8rem' }}>
            Not assigned
          </Typography>
        )
      ),
    },
    {
      field: 'EffectiveDate',
      headerName: 'Effective',
      width: 130,
      sortable: false,
      valueGetter: (_value: unknown, row: GroupMember) =>
        cohortLabel(getCohortFromDate(row.EffectiveDate)),
      renderCell: (params: GridRenderCellParams) => {
        const row = params.row as GroupMember;
        const label = cohortLabel(getCohortFromDate(row.EffectiveDate));
        return (
          <Typography
            variant="body2"
            sx={{
              color: label === '—' ? theme.palette.text.disabled : theme.palette.text.primary,
              fontSize: '0.8rem',
            }}
          >
            {label}
          </Typography>
        );
      },
    },
    {
      field: 'dependents',
      headerName: 'Dependents',
      width: 100, // Reduced from 120
      sortable: false,
      renderCell: (params: GridRenderCellParams) => {
        const depCount = params.row.DependentCount || 0;
        if (depCount === 0) {
          return (
            <Typography variant="body2" sx={{ color: theme.palette.text.disabled, fontSize: '0.8rem' }}>
              None
            </Typography>
          );
        }
        return (
          <Button
            onClick={(e) => {
              e.stopPropagation();
              handleViewDependents(params.row);
            }}
            sx={{
              textTransform: 'none',
              color: 'var(--oe-primary)',
              fontSize: '0.8rem',
              fontWeight: 500,
              minWidth: 'auto',
              px: 0.5,
              py: 0.25,
              '&:hover': {
                backgroundColor: alpha(colors.primary, 0.08),
                textDecoration: 'underline',
              },
            }}
          >
            {depCount} {depCount === 1 ? 'dep' : 'deps'}
          </Button>
        );
      },
    },
    {
      field: 'EnrollmentStatus',
      headerName: 'Status', // Shortened header
      width: 240,
      minWidth: 220,
      sortable: true,
      renderCell: (params: GridRenderCellParams) => {
        // Explicitly set yellow for "Pending Login"
        const chipColor = params.value === 'Pending Login' 
          ? 'warning' 
          : (params.row.EnrollmentStatusColor as any);

        const row = params.row as Record<string, unknown>;
        const sentAt = row.EnrollmentLinkSentAt as string | undefined;
        const sentAgo =
          params.value === 'Enrollment Link Sent' && sentAt
            ? formatRelativeTimeAgo(sentAt)
            : null;
        const label =
          sentAgo && params.value === 'Enrollment Link Sent'
            ? `${params.value} · ${sentAgo}`
            : params.value;
        const sentTitle =
          sentAt && params.value === 'Enrollment Link Sent'
            ? new Date(sentAt).toLocaleString()
            : undefined;
        
        return (
          <Tooltip title={sentTitle ?? ''} disableHoverListener={!sentTitle}>
            <span>
              <Chip
                label={label}
                color={chipColor}
                size="small"
                variant="filled"
                sx={{ 
                  fontWeight: 500,
                  minWidth: 80, // Reduced min width
                  height: 'auto',
                  py: 0.25,
                  ...(params.value === 'Pending Login' && {
                    bgcolor: '#ffc107', // Bright yellow
                    color: '#000',
                    '&:hover': {
                      bgcolor: '#ffb300',
                    }
                  }),
                  '& .MuiChip-label': {
                    fontSize: '0.65rem', // Smaller font
                    px: 1,
                    whiteSpace: 'normal',
                  }
                }}
              />
            </span>
          </Tooltip>
        );
      },
    },


    {
      field: 'MonthlyPremium',
      headerName: 'Premium', // Shortened header
      width: 100, // Reduced from 140
      sortable: true, // ✅ Now sortable via SQL function!
      renderCell: (params: GridRenderCellParams) => {
        const employerContribution = Number(params.row.EmployerContribution ?? 0) || 0;
        const employeeContribution = Number(params.row.EmployeeContribution ?? 0) || 0;
        const totalPremium = Number(params.row.MonthlyPremium ?? params.value ?? 0) || 0;
        const hasContributions = employerContribution > 0 || employeeContribution > 0;
        
        const tooltipContent = hasContributions ? (
          <Box
            sx={{
              bgcolor: 'rgba(255, 255, 255, 0.98)',
              backdropFilter: 'blur(10px)',
              p: 1.5,
              borderRadius: 1,
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
              border: '1px solid rgba(0, 0, 0, 0.1)',
              minWidth: 200,
            }}
          >
            <Typography 
              variant="body2" 
              sx={{ 
                fontWeight: 600, 
                mb: 1,
                color: '#1f2937',
                fontSize: '0.8rem'
              }}
            >
              Premium Breakdown
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block',
                  color: '#374151',
                  fontSize: '0.75rem',
                  fontWeight: 500
                }}
              >
                <span style={{ color: '#6b7280' }}>Total Premium:</span>{' '}
                <span style={{ color: '#10b981', fontWeight: 600 }}>{formatCurrency(totalPremium)}</span>
              </Typography>
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block',
                  color: '#374151',
                  fontSize: '0.75rem',
                  fontWeight: 500
                }}
              >
                <span style={{ color: '#6b7280' }}>Employer Contribution:</span>{' '}
                <span style={{ color: '#10b981', fontWeight: 600 }}>{formatCurrency(employerContribution)}</span>
              </Typography>
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block',
                  color: '#374151',
                  fontSize: '0.75rem',
                  fontWeight: 500
                }}
              >
                <span style={{ color: '#6b7280' }}>Employee Contribution:</span>{' '}
                <span style={{ color: 'var(--oe-primary)', fontWeight: 600 }}>{formatCurrency(employeeContribution)}</span>
              </Typography>
            </Box>
          </Box>
        ) : null;
        
        return (
          <Tooltip 
            title={tooltipContent || ''} 
            arrow
            componentsProps={{
              tooltip: {
                sx: {
                  bgcolor: 'transparent',
                  p: 0,
                  maxWidth: 'none',
                  boxShadow: 'none',
                }
              },
              arrow: {
                sx: {
                  color: 'rgba(255, 255, 255, 0.98)',
                }
              }
            }}
          >
            <Typography 
              variant="body2" 
              sx={{ 
                fontWeight: 600, 
                color: '#10b981', 
                fontSize: '0.8rem',
                cursor: hasContributions ? 'help' : 'default',
                '&:hover': {
                  textDecoration: hasContributions ? 'underline' : 'none',
                  opacity: hasContributions ? 0.8 : 1
                }
              }}
            >
              {formatCurrency(params.value)}
            </Typography>
          </Tooltip>
        );
      },
    },
    {
      field: 'CreatedDate',
      headerName: 'Added',
      width: 100, // Reduced from 120
      renderCell: (params: GridRenderCellParams) => (
        <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.75rem' }}>
          {format(new Date(params.value), 'MMM dd, yyyy')}
        </Typography>
      ),
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 60, // Reduced from 80
      sortable: false,
      renderCell: (params: GridRenderCellParams) => (
        <Tooltip title="More actions">
          <IconButton
            onClick={(e) => handleMenuClick(e, params.row.MemberId)}
            size="small"
            sx={{
              padding: '4px',
              '&:hover': {
                backgroundColor: alpha(colors.primary, 0.1),
              },
            }}
          >
            <MoreVertIcon sx={{ fontSize: '1.1rem' }} />
          </IconButton>
        </Tooltip>
      ),
    },
  ];

  // Effects
  // No need for useEffect to fetch members, as the hook handles that automatically
  // useEffect(() => {
  //   fetchMembers();
  // }, [groupId]);

  // Show error if API call failed
  if (isError) {
    return (
      <Box>
        <Alert severity="error" sx={{ mb: 3 }}>
          <AlertTitle>Error Loading Members</AlertTitle>
          {fetchError instanceof Error ? fetchError.message : 'Failed to load members'}
        </Alert>
        <Button
          variant="contained"
          onClick={() => refetch()}
          sx={{ 
            textTransform: 'none',
            bgcolor: 'var(--oe-primary)',
            '&:hover': {
              bgcolor: 'var(--oe-primary-dark)',
            },
          }}
        >
          Try Again
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Optional Enrollment Period Banner - only when no period is set */}
      {enrollmentPeriodStatus?.needsEnrollmentPeriod && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <AlertTitle>Optional: Enrollment Period</AlertTitle>
          <Typography variant="body2">
            You can optionally set an enrollment period for this group. When set, it extends when enrollment links expire (otherwise links expire after 7 days) and can define when benefits start. Sending enrollment links does not require an enrollment period.
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
                    <Box component="span" sx={{ mt: 1, fontStyle: 'italic', color: 'text.secondary', display: 'block' }}>
                      When the period is active, enrollment link expiration will be extended to the period end.
                    </Box>
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
                    {(() => {
                      const benefitStartDate = new Date(enrollmentPeriodStatus.currentPeriod.benefitStartDate + 'T00:00:00');
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const isFuture = benefitStartDate > today;
                      return (
                        <>
                          Benefits {isFuture ? 'start' : 'started'} on {benefitStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </>
                      );
                    })()}
                  </Typography>
                </>
              )}
            </div>
            {enrollmentPeriodStatus.currentPeriod && (
              <button
                onClick={() => setEnrollmentPeriodModalOpen(true)}
                className={`ml-4 px-3 py-1.5 text-sm rounded-lg transition-colors font-medium ${
                  enrollmentPeriodStatus.currentPeriod.isActive 
                    ? 'bg-white border border-green-300 text-green-700 hover:bg-green-50'
                    : enrollmentPeriodStatus.currentPeriod.isUpcoming
                    ? 'bg-white border border-orange-300 text-orange-700 hover:bg-orange-50'
                    : 'bg-white border border-blue-300 text-oe-primary-dark hover:bg-blue-50'
                }`}
              >
                Edit
              </button>
            )}
          </div>
        </Alert>
      )}

      {/* Header */}
      <Grid container spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <Grid size="grow">
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Group Members
          </Typography>
          {(terminatedPrimaryMembers.length > 0 || allMembers.filter(m => m.RelationshipType !== 'P').length > 0) && (
            <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Chip 
                label={`${activePrimaryMembers.length} employees`}
                size="small"
                color="primary"
                variant="outlined"
              />
              <Chip 
                label={`${allMembers.filter(m => m.RelationshipType !== 'P').length} dependents`}
                size="small"
                color="info"
                variant="outlined"
              />
              {terminatedPrimaryMembers.length > 0 && (
                <>
                  <Chip 
                    label={`${terminatedPrimaryMembers.length} terminated`} 
                    size="small" 
                    color="error" 
                    variant="outlined"
                  />
                  <Button
                    size="small"
                    onClick={() => setShowTerminated(!showTerminated)}
                    sx={{ 
                      textTransform: 'none',
                      fontSize: '0.75rem',
                      minWidth: 'auto',
                      px: 1
                    }}
                  >
                    {showTerminated ? 'Hide' : 'Show'} terminated
                  </Button>
                </>
              )}
            </Box>
          )}
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
              startIcon={<AssessmentIcon />}
              onClick={async () => {
                // Fresh dialog: explodes one row per product when enabled; reset so it stays opt-in each open.
                setReportIncludePlanDetails(false);
                setReportDialogOpen(true);
                try {
                  const response = await GroupsService.getMembersReportDefaultPeriod(groupId);
                  if (response?.success && response.data) {
                    const y = Number(response.data.reportYear);
                    const m = Number(response.data.reportMonth);
                    if (Number.isFinite(y) && y >= 2000 && y <= 2100) {
                      setReportYear(y);
                    }
                    if (Number.isFinite(m) && m >= 1 && m <= 12) {
                      setReportMonth(m);
                    }
                  }
                } catch (error) {
                  console.error('Error loading default report period:', error);
                }
              }}
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
              Create Report
            </Button>
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
              onClick={() => {
                console.log('🚀 Send Links button clicked!');
                setSendLinksDialogOpen(true);
              }}
              disabled={
                activePrimaryMembers.length === 0 || 
                !paymentValidation.hasValidPaymentMethod ||
                paymentLoading
              }
              title={
                !paymentValidation.hasValidPaymentMethod 
                  ? 'Add a payment method in the Billing tab before sending enrollment links'
                  : activePrimaryMembers.length === 0
                  ? 'No active employees to send links to'
                  : 'Send enrollment links to active employees'
              }
              sx={{ 
                textTransform: 'none',
                borderColor: '#d1d5db',
                color: '#374151',
                '&:hover': {
                  borderColor: '#9ca3af',
                  backgroundColor: '#f9fafb',
                },
                '&:disabled': {
                  borderColor: '#e5e7eb',
                  color: '#9ca3af',
                }
              }}
            >
              Send Links
            </Button>
            {canSendMessages && (
              <Button
                variant="outlined"
                startIcon={<EmailIcon />}
                onClick={() => {
                  console.log('🚀 Send Message button clicked!');
                  setSendMessageDialogOpen(true);
                }}
                disabled={activePrimaryMembers.length === 0}
                title={
                  activePrimaryMembers.length === 0
                    ? 'No active employees to send messages to'
                    : 'Send email or text messages to group members'
                }
                sx={{ 
                  textTransform: 'none',
                  borderColor: '#d1d5db',
                  color: '#374151',
                  '&:hover': {
                    borderColor: '#9ca3af',
                    backgroundColor: '#f9fafb',
                  },
                  '&:disabled': {
                    borderColor: '#e5e7eb',
                    color: '#9ca3af',
                  }
                }}
              >
                Send Message
              </Button>
            )}
            {employeeDocs.length === 0 ? (
              <Tooltip title="No employee documents are configured for this group's products.">
                <span>
                  <Button
                    variant="contained"
                    color="success"
                    startIcon={<DownloadIcon />}
                    disabled
                    sx={{ textTransform: 'none' }}
                  >
                    Download Employee Doc
                  </Button>
                </span>
              </Tooltip>
            ) : employeeDocs.length === 1 ? (
              <Button
                variant="contained"
                color="success"
                startIcon={empDocGenerating ? <CircularProgress size={16} sx={{ color: 'white' }} /> : <DownloadIcon />}
                onClick={() => handleEmpDocDownload(employeeDocs[0].proposalDocumentId)}
                disabled={empDocGenerating}
                sx={{ textTransform: 'none' }}
              >
                {empDocGenerating ? 'Generating PDF…' : 'Download Employee Doc'}
              </Button>
            ) : (
              <>
                <Button
                  variant="contained"
                  color="success"
                  startIcon={empDocGenerating ? <CircularProgress size={16} sx={{ color: 'white' }} /> : <DownloadIcon />}
                  onClick={(e) => { if (!empDocGenerating) setEmpDocMenuAnchor(e.currentTarget); }}
                  disabled={empDocGenerating}
                  sx={{ textTransform: 'none' }}
                >
                  {empDocGenerating ? 'Generating PDF…' : 'Download Employee Doc ▾'}
                </Button>
                <Menu
                  anchorEl={empDocMenuAnchor}
                  open={Boolean(empDocMenuAnchor)}
                  onClose={() => setEmpDocMenuAnchor(null)}
                >
                  {employeeDocs.map(doc => (
                    <MenuItem
                      key={doc.proposalDocumentId}
                      onClick={() => {
                        setEmpDocMenuAnchor(null);
                        handleEmpDocDownload(doc.proposalDocumentId);
                      }}
                    >
                      {doc.name}
                    </MenuItem>
                  ))}
                </Menu>
              </>
            )}
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
      
      {/* Contact Info Warning - Show on frontend for better UX */}
      <Alert severity="info" sx={{ mb: 3, display: 'none' }} id="contact-info-warning">
        <AlertTitle>Group Contact Information Required</AlertTitle>
        <Typography variant="body2">
          Please ensure the group has a <strong>Primary Contact</strong> and <strong>Contact Email</strong> set up in the group details before sending enrollment links.
          This information is required for billing setup.
        </Typography>
      </Alert>

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
            <Grid container spacing={2} sx={{ mb: 0 }}>
              {['Enrolled', 'Pending Login', 'Declined Coverage', 'Terminated', 'Enrollment Link Sent', 'Not Enrolled'].map((status) => {
                const count = statusCounts[status] || 0;
                if (count === 0) return null;
                
                // Get color from the first member with this status to match DataGrid colors
                const statusColor = members.find(m => m.EnrollmentStatus === status)?.EnrollmentStatusColor || 'default';
                
                // Use the same styling logic as the DataGrid column
                const isPendingLogin = status === 'Pending Login';
                
                return (
                  <Grid size="auto" key={status}>
                    <Chip
                      label={`${status}: ${count}`}
                      color={statusColor as any}
                      size="small"
                      variant="filled"
                      sx={{ 
                        fontWeight: 500,
                        minWidth: 110,
                        height: 22,
                        ...(isPendingLogin && {
                          bgcolor: '#ffc107', // Bright yellow background (matches DataGrid)
                          color: '#000', // Black text for contrast
                          '&:hover': {
                            bgcolor: '#ffb300', // Slightly darker yellow on hover
                          }
                        }),
                        '& .MuiChip-label': {
                          fontSize: '0.7rem',
                          px: 1.5,
                        }
                      }}
                    />
                  </Grid>
                );
              })}
            </Grid>
            {/* Total Households + Enrollment summary stats */}
            <Box sx={{ pt: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, color: theme.palette.text.primary, mb: 0.5 }}>
                Total Households: {membersData.enrollmentSummary?.totalHouseholdsCount ?? membersData.pagination?.totalCount ?? 0}
              </Typography>
              {membersData.enrollmentSummary && (
                <Grid container spacing={2} sx={{ mt: 0 }}>
                  <Grid size="auto">
                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                      <strong>Total Premium:</strong> {formatCurrency(membersData.enrollmentSummary.totalPremium)}
                    </Typography>
                  </Grid>
                  <Grid size="auto">
                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                      <strong>Enrolled Households (effective):</strong> {membersData.enrollmentSummary.enrolledHouseholdsCount}
                    </Typography>
                  </Grid>
                  <Grid size="auto">
                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                      <strong>Future Effective Households:</strong> {membersData.enrollmentSummary.futureEffectiveHouseholdsCount}
                    </Typography>
                  </Grid>
                </Grid>
              )}
            </Box>
          </Paper>
        </Box>
      )}

      {/* Search and Filters */}
      <Box sx={{ mb: 3, display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search Input */}
        <TextField
          placeholder="Search members by name, email, or phone..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          size="small"
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
          sx={{
            flex: 1,
            minWidth: 280,
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
        
        {/* Location Filter */}
        {locations.length > 1 && (
          <FormControl sx={{ minWidth: 280 }}>
            <InputLabel>Filter by Location</InputLabel>
            <Select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              label="Filter by Location"
              size="small"
              sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
              }}
            >
              <MenuItem value="all">
                All Locations ({activePrimaryMembers.length} employees)
              </MenuItem>
              {locations
                .sort((a, b) => (b.IsPrimary ? 1 : 0) - (a.IsPrimary ? 1 : 0))
                .map((location) => {
                  const locationMemberCount = [...activePrimaryMembers, ...terminatedPrimaryMembers].filter(
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

        {/* Enrollment Status Filter */}
        <FormControl sx={{ minWidth: 260 }}>
          <InputLabel>Filter by Enrollment Status</InputLabel>
          <Select
            value={enrollmentStatusFilter}
            onChange={(e) => setEnrollmentStatusFilter(e.target.value)}
            label="Filter by Enrollment Status"
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                '&.Mui-focused fieldset': {
                  borderColor: 'var(--oe-primary)',
                },
              },
            }}
          >
            <MenuItem value="all">All Statuses</MenuItem>
            <MenuItem value="__inactive_roster__">Inactive (removed from group)</MenuItem>
            <MenuItem value="Enrolled">Enrolled</MenuItem>
            <MenuItem value="Pending Login">Pending Login</MenuItem>
            <MenuItem value="Declined Coverage">Declined Coverage</MenuItem>
            <MenuItem value="Terminated">Terminated</MenuItem>
            <MenuItem value="Enrollment Link Sent">Enrollment Link Sent</MenuItem>
            <MenuItem value="Not Enrolled">Not Enrolled</MenuItem>
          </Select>
        </FormControl>

        {/* Cohort (effective date) filter — only shown when group allows mid-month effective dates */}
        {(groupDetails as Record<string, unknown> | null)?.AllowMidMonthEffective ? (
          <FormControl sx={{ minWidth: 200 }}>
            <InputLabel>Filter by Effective Date</InputLabel>
            <Select
              value={cohortFilter}
              onChange={(e) => setCohortFilter(e.target.value as typeof cohortFilter)}
              label="Filter by Effective Date"
              size="small"
              sx={{
                '& .MuiOutlinedInput-root': {
                  '&.Mui-focused fieldset': {
                    borderColor: 'var(--oe-primary)',
                  },
                },
              }}
            >
              <MenuItem value="all">All Effective Dates</MenuItem>
              <MenuItem value={COHORT_FIRST}>1st of month</MenuItem>
              <MenuItem value={COHORT_FIFTEENTH}>15th of month</MenuItem>
            </Select>
          </FormControl>
        ) : null}
      </Box>

      {/* DataGrid */}
      <Paper 
        sx={{ 
          borderRadius: 2,
          border: `1px solid ${theme.palette.divider}`,
          overflow: 'hidden',
          minHeight: 600,
          width: '100%',
          maxWidth: '100%',
        }}
      >
        <DataGrid
          rows={cohortFilteredMembers}
          columns={columns}
          loading={loading}
          getRowId={(row) => row.MemberId}
          
          // Server-side pagination
          paginationMode="server"
          paginationModel={paginationModel}
          onPaginationModelChange={setPaginationModel}
          rowCount={membersData.pagination.totalCount}
          pageSizeOptions={[10, 25, 50, 100]}
          
          // Server-side sorting
          sortingMode="server"
          sortModel={sortModel}
          onSortModelChange={handleSortModelChange}
          
          initialState={{
            columns: {
              columnVisibilityModel: {
                CreatedDate: false,
              },
            },
          }}

          disableRowSelectionOnClick
          slots={{ toolbar: GridToolbar }}
          slotProps={{
            toolbar: {
              showQuickFilter: false, // Disable client-side quick filter for now
            },
          }}
          sx={{
            border: 'none',
            '& .MuiDataGrid-columnHeader': {
              backgroundColor: '#f9fafb',
              borderBottom: 'none',
              color: theme.palette.text.primary,
              fontWeight: 600,
              fontSize: '0.75rem', // Smaller header font
              lineHeight: '1.2',
              padding: '8px 8px', // Further reduce padding for width
            },
            '& .MuiDataGrid-cell': {
              borderBottom: 'none',
              padding: '4px 8px', // Further reduce padding for width
              display: 'flex',
              alignItems: 'center',
              fontSize: '0.8rem', // Reduce font size to fit more content
            },
            '& .MuiDataGrid-row': {
              minHeight: '56px !important',
              borderBottom: `1px solid #f3f4f6`,
              '&:hover': {
                backgroundColor: '#f9fafb',
              },
              '&:last-child': {
                borderBottom: 'none', // Remove border from last row
              },
            },
            '& .MuiDataGrid-row.newest-member': {
              backgroundColor: alpha('#10b981', 0.1),
              borderLeft: `3px solid #10b981`,
              '&:hover': {
                backgroundColor: alpha('#10b981', 0.15),
              },
            },
            '& .MuiDataGrid-footerContainer': {
              borderTop: `1px solid #e5e7eb`,
              backgroundColor: '#f9fafb',
            },
          }}
          getRowClassName={(params) => {
            if (newestMemberId && params.row.MemberId === newestMemberId) {
              return 'newest-member';
            }
            return '';
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
        {(() => {
          const member = members.find(m => m.MemberId === selectedMemberId);
          // Check if member is actively enrolled
          const isActivelyEnrolled = member && (
            member.EnrollmentStatus === 'Enrolled' || 
            member.EnrollmentStatus === 'Pending Login'
          );
          
          return (
            <MenuItem 
              onClick={() => {
                console.log('🚀 Individual enrollment link clicked for member:', selectedMemberId);
                
                const member = members.find(m => m.MemberId === selectedMemberId);
                console.log('👤 Found member:', member);
                if (member) {
                  if ((member.EnrollmentStatus as string) === 'Declined Coverage') {
                    setDeclinedSendLinkConfirmMember(member);
                    setDeclinedSendLinkConfirmOpen(true);
                  } else {
                    console.log('✅ Setting selectedMemberForLink and opening dialog');
                    setSelectedMemberForLink(member);
                    setIndividualLinkDialogOpen(true);
                  }
                  handleMenuClose();
                } else {
                  console.error('❌ Member not found for ID:', selectedMemberId);
                }
              }}
              sx={{ minWidth: 150 }}
              disabled={isActivelyEnrolled}
            >
              <SendIcon sx={{ mr: 1.5, color: isActivelyEnrolled ? '#9ca3af' : 'var(--oe-primary)' }} />
              Send Enrollment Link
            </MenuItem>
          );
        })()}
        {(() => {
          const member = members.find(m => m.MemberId === selectedMemberId);
          // Only show if member is enrolled (Enrolled or Pending Login status)
          const isEnrolled = member && (
            member.EnrollmentStatus === 'Enrolled' || 
            member.EnrollmentStatus === 'Pending Login'
          );
          
          if (!isEnrolled) return null;
          
          return (
            <MenuItem 
              onClick={() => {
                if (!selectedMemberId || !member) return;
                setMemberForPasswordReset(member);
                setPasswordResetDialogOpen(true);
                handleMenuClose();
              }}
              sx={{ minWidth: 150 }}
            >
              <EmailIcon sx={{ mr: 1.5, color: 'var(--oe-primary)' }} />
              Send Password Reset
            </MenuItem>
          );
        })()}
        {(() => {
          const member = members.find(m => m.MemberId === selectedMemberId);
          if (member?.Status !== 'Terminated') return null;
          return (
            <MenuItem 
              onClick={() => {
                if (selectedMemberId) {
                  const m = members.find(x => x.MemberId === selectedMemberId);
                  if (m) {
                    openUnterminateDialog(m);
                    handleMenuClose();
                  }
                }
              }}
              sx={{ color: '#10b981' }}
            >
              <PersonIcon sx={{ mr: 1.5 }} />
              Unterminate
            </MenuItem>
          );
        })()}
      </Menu>

      {/* Add Member Dialog */}
      <Dialog 
        open={addDialogOpen} 
        onClose={() => {
          // Reset form data
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
            locationId: '',
            relationshipType: 'P',
            hireDate: new Date().toISOString().split('T')[0],
            tier: 'EE',
            jobPosition: undefined,
          });
          setAddMemberLoading(false);
          setAddDialogOpen(false);
        }} 
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
              <TextField
                label="Hire Date"
                type="date"
                value={createFormData.hireDate}
                onChange={(e) => setCreateFormData({ ...createFormData, hireDate: e.target.value })}
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
                <InputLabel>Job Position</InputLabel>
                <Select
                  value={createFormData.jobPosition || ''}
                  onChange={(e) => setCreateFormData({ ...createFormData, jobPosition: e.target.value || undefined })}
                  label="Job Position"
                >
                  <MenuItem value="">
                    <em>None</em>
                  </MenuItem>
                  {DEFAULT_JOB_POSITIONS.map((position) => (
                    <MenuItem key={position.id} value={position.id}>
                      {position.label}
                    </MenuItem>
                  ))}
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
                    <MenuItem key={state.value} value={state.value}>
                      {state.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                label="ZIP Code"
                value={createFormData.zip}
                onChange={(e) =>
                  setCreateFormData({
                    ...createFormData,
                    zip: sanitizeMemberZipInput(e.target.value),
                  })
                }
                fullWidth
                inputProps={{ inputMode: 'numeric', maxLength: 9, 'aria-label': 'ZIP Code' }}
                error={!isOptionalUsZipValid(createFormData.zip)}
                helperText={
                  !isOptionalUsZipValid(createFormData.zip)
                    ? 'US ZIP: 5 digits or 9 digits (ZIP+4), or leave blank.'
                    : undefined
                }
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
          </Grid>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          {addMemberLoading ? (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flex: 1 }}>
                <CircularProgress size={20} />
                <Typography variant="body2" color="text.secondary">Creating member...</Typography>
              </Box>
            </>
          ) : (
            <>
              <Button 
                onClick={() => {
                  // Reset form data
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
                    locationId: '',
                    relationshipType: 'P',
                    hireDate: new Date().toISOString().split('T')[0],
                    tier: 'EE',
                    jobPosition: undefined,
                  });
                  setAddDialogOpen(false);
                }}
                sx={{ textTransform: 'none' }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => addMemberFromDialog(createFormData)}
                variant="contained"
                disabled={
                  !createFormData.firstName ||
                  !createFormData.lastName ||
                  !createFormData.email ||
                  !isOptionalUsZipValid(createFormData.zip)
                }
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
              <Button
                onClick={() => addMemberFromDialog(createFormData, true)}
                variant="contained"
                disabled={
                  !createFormData.firstName ||
                  !createFormData.lastName ||
                  !createFormData.email ||
                  !isOptionalUsZipValid(createFormData.zip)
                }
                sx={{ 
                  textTransform: 'none',
                  bgcolor: 'var(--oe-primary)',
                  '&:hover': {
                    bgcolor: 'var(--oe-primary-dark)',
                  },
                }}
              >
                Add Member & Send Enrollment Link
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      {/* Member Management Modal */}
      {selectedMember && (
        <MemberManagementModal
          member={selectedMember}
          householdMembers={householdMembers}
          memberEnrollments={memberEnrollments}
          enrollmentsLoading={enrollmentsLoading}
          onClose={() => setSelectedMember(null)}
          onEdit={(member) => {
            setEditingMember(member);
            setShowEditModal(true);
            // Keep MemberManagementModal open underneath Edit Member
          }}
          onSendEnrollmentLink={async (member: Member) => {
            try {
              const response = await apiService.get<{ success: boolean; data: Member }>(`/api/members/${member.MemberId}`);
              if (response.success && response.data) {
                setSelectedMemberForLink(response.data);
                setIndividualLinkDialogOpen(true);
              }
            } catch (error) {
              console.error('Error sending enrollment link:', error);
              setMutationError('Failed to send enrollment link');
            }
          }}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={true}
          canDelete={true}
          onRefresh={() => {
            refetch();
            if (selectedMember) {
              handleEditMember(selectedMember);
            }
          }}
          onRemoveComplete={() => {
            setSelectedMember(null);
          }}
        />
      )}

      {/* Edit Member Dialog (opened from MemberManagementModal) */}
      {showEditModal && editingMember && (
        <MemberEdit
          show={showEditModal}
          member={editingMember}
          groupId={groupId}
          onClose={() => {
            setShowEditModal(false);
            setEditingMember(null);
          }}
          onSuccess={async () => {
            await refetch();
            // Refresh the selected member if it's the same one
            if (selectedMember?.MemberId === editingMember?.MemberId) {
              await handleEditMember(editingMember);
            }
          }}
          loading={addMemberLoading}
          setLoading={setAddMemberLoading}
          error={mutationError}
          setError={setMutationError}
          setSuccessMessage={setSuccessMessage}
          US_STATES={US_STATES}
        />
      )}

      {/* Import Census Dialog */}
      <Dialog 
        open={importDialogOpen} 
        onClose={() => {
          if (!aiParsingLoading) {
            setImportDialogOpen(false);
            setSelectedFile(null);
            setEmployerAuthorizationConfirmed(false);
            setIsDragOver(false);
            setImportMode('intelligent'); // Reset to default
          }
        }} 
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
            {/* Import Mode Selector */}
            <FormControl fullWidth sx={{ mb: 3 }}>
              <InputLabel>Import Method</InputLabel>
              <Select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as 'intelligent' | 'standard')}
                label="Import Method"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: 'var(--oe-primary)',
                    },
                  },
                }}
              >
                <MenuItem value="intelligent">
                  <Stack>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      Intelligent Parser
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                      Automatically interprets various CSV/Excel formats
                    </Typography>
                  </Stack>
                </MenuItem>
                <MenuItem value="standard">
                  <Stack>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      Standard Import
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                      Fixed format with specific column requirements
                    </Typography>
                  </Stack>
                </MenuItem>
              </Select>
            </FormControl>

            {/* Employer authorization (required for bulk add / TCPA compliance) */}
            <FormControlLabel
              control={
                <Checkbox
                  checked={employerAuthorizationConfirmed}
                  onChange={(e) => setEmployerAuthorizationConfirmed(e.target.checked)}
                  sx={{ color: 'var(--oe-primary)', '&.Mui-checked': { color: 'var(--oe-primary)' } }}
                />
              }
              label={
                <Typography variant="body2">
                  I confirm that I have authorization from my organization to add these employees to the group and to send them enrollment-related communications (including SMS and email).
                </Typography>
              }
              sx={{ mb: 2 }}
            />

            {importMode === 'intelligent' ? (
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>Intelligent Parser</AlertTitle>
                Upload any CSV or Excel file with member information. The parser will automatically:
                <br /><br />
                • Detect column names and map them correctly
                <br />
                • Identify household relationships
                <br />
                • Match work locations to your group locations
                <br />
                • Handle various date and data formats
                <br /><br />
                <strong>Required fields:</strong> Name, Email
                <br />
                <strong>All other fields are optional</strong> and will be mapped automatically if present.
              </Alert>
            ) : (
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>Standard Import - CSV Format Requirements</AlertTitle>
                Upload a CSV file with member information. The file must include these columns in order:
                <br /><br />
                <strong>Required:</strong> Name, Email, Tier
                <br />
                <strong>Optional:</strong> DoB (YYYY-MM-DD), Gender (Male/Female/M/F), Hire Date (YYYY-MM-DD), Address1, Address2, City, State (2-letter code), Zipcode, Phone, Tobacco Use (Y/N/U)
                <br /><br />
                <strong>Tier codes:</strong> EE = Employee, ES = Employee+Spouse, EC = Employee+Child, EF = Employee+Family
                <br /><br />
                <strong>Tobacco Use values:</strong> Y = Yes, N = No, U = Unknown (default)
                <br /><br />
                <strong>Household Structure:</strong> Members with tier 'EE' will be treated as primary members. Members with other tiers will be dependents.
                <br /><br />
                <strong>Duplicate Handling:</strong> Members with existing email addresses will be skipped gracefully, and you'll see a summary of new vs existing members.
              </Alert>
            )}
            
            {!selectedFile ? (
              <Box
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                sx={{
                  height: 120,
                  border: `2px dashed ${isDragOver ? 'var(--oe-primary)' : '#d1d5db'}`,
                  borderRadius: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDragOver ? alpha(colors.primary, 0.05) : 'transparent',
                  transition: 'all 0.2s ease-in-out',
                  mb: 2,
                  cursor: 'pointer',
                  '&:hover': {
                    borderColor: 'var(--oe-primary)',
                    backgroundColor: alpha(colors.primary, 0.02),
                  }
                }}
              >
                <Button
                  variant="outlined"
                  component="label"
                  sx={{ 
                    border: 'none',
                    textTransform: 'none',
                    color: '#374151',
                    '&:hover': {
                      backgroundColor: 'transparent',
                    }
                  }}
                >
                  <Stack alignItems="center" spacing={1}>
                    <UploadIcon sx={{ fontSize: '2rem', color: 'var(--oe-primary)' }} />
                    <Typography>
                      {isDragOver ? 'Drop file here' : 'Click to select file or drag and drop'}
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                      Supports CSV, XLS, XLSX (max {MAX_LARGE_UPLOAD_MB}MB)
                    </Typography>
                  </Stack>
                  <input
                    type="file"
                    hidden
                    accept=".csv,.xlsx,.xls"
                    onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                  />
                </Button>
              </Box>
            ) : (
              <Box sx={{ mb: 2 }}>
                <Alert 
                  severity="success" 
                  sx={{ 
                    mb: 2,
                    '& .MuiAlert-message': {
                      width: '100%'
                    }
                  }}
                  action={
                    <IconButton
                      color="inherit"
                      size="small"
                      onClick={removeSelectedFile}
                      sx={{ color: '#10b981' }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <Stack spacing={1}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      File Selected: {selectedFile.name}
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                      Size: {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </Typography>
                  </Stack>
                </Alert>
                
                <Button
                  variant="outlined"
                  fullWidth
                  component="label"
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
                  <Stack direction="row" spacing={1} alignItems="center">
                    <UploadIcon />
                    <Typography>Upload Different File</Typography>
                  </Stack>
                  <input
                    type="file"
                    hidden
                    accept=".csv,.xlsx,.xls"
                    onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                  />
                </Button>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={() => {
              setImportDialogOpen(false);
              setSelectedFile(null);
              setIsDragOver(false);
            }}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!selectedFile) return;
              
              if (importMode === 'intelligent') {
                // Use AI parsing
                handleIntelligentImport(selectedFile);
              } else {
                // Use standard import
                importMembers(selectedFile);
              }
            }}
            variant="contained"
            disabled={!selectedFile || !employerAuthorizationConfirmed || aiParsingLoading}
            startIcon={aiParsingLoading ? <CircularProgress size={16} /> : null}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            {aiParsingLoading ? 'Extracting...' : importMode === 'intelligent' ? 'Extract with Intelligence Parser' : 'Import Members'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create Report Dialog */}
      <Dialog
        open={reportDialogOpen}
        onClose={() => {
          if (!reportGenerating) {
            setReportDialogOpen(false);
          }
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Create Members Report
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ mt: 1 }}>
            <Alert severity="info">
              <AlertTitle>Report Options</AlertTitle>
              Choose what to include in your downloadable CSV report. Totals for all numeric
              columns will be included at the bottom of the file.
            </Alert>

            {/* Report period (UTC month) — backend evaluates coverage as of last instant of selected month */}
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Report month
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Premiums and &quot;active&quot; enrollments use only coverage that is already
                effective on the last day of the selected month. Future-dated enrollments are not
                included until you pick that month or later.
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="members-report-month-label">Month</InputLabel>
                    <Select
                      labelId="members-report-month-label"
                      label="Month"
                      value={reportMonth}
                      onChange={(e) => setReportMonth(Number(e.target.value))}
                    >
                      {REPORT_MONTH_LABELS.map((label, idx) => (
                        <MenuItem key={label} value={idx + 1}>
                          {label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="members-report-year-label">Year</InputLabel>
                    <Select
                      labelId="members-report-year-label"
                      label="Year"
                      value={reportYear}
                      onChange={(e) => setReportYear(Number(e.target.value))}
                    >
                      {Array.from({ length: 21 }, (_, i) => new Date().getUTCFullYear() - 10 + i).map(
                        (y) => (
                          <MenuItem key={y} value={y}>
                            {y}
                          </MenuItem>
                        )
                      )}
                    </Select>
                  </FormControl>
                </Grid>
              </Grid>
            </Box>

            {/* Scope */}
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Who should be included?
              </Typography>
              <Stack spacing={1}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportScope === 'active'}
                      onChange={() => setReportScope('active')}
                    />
                  }
                  label="Actively enrolled members only"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportScope === 'all'}
                      onChange={() => setReportScope('all')}
                    />
                  }
                  label="All members (regardless of enrollment status)"
                />
              </Stack>
            </Box>

            {/* Details */}
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                Columns to include
              </Typography>
              <Stack spacing={1}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeTotalPremium}
                      onChange={(e) => setReportIncludeTotalPremium(e.target.checked)}
                    />
                  }
                  label="Total Premium Amounts"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeContributions}
                      onChange={(e) => setReportIncludeContributions(e.target.checked)}
                    />
                  }
                  label="Employer & employee contribution (household split)"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludePlanDetails}
                      onChange={(e) => setReportIncludePlanDetails(e.target.checked)}
                    />
                  }
                  label="Products & Plans"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeFees}
                      onChange={(e) => setReportIncludeFees(e.target.checked)}
                    />
                  }
                  label="Fees"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeDependents}
                      onChange={(e) => setReportIncludeDependents(e.target.checked)}
                    />
                  }
                  label="Dependents"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeDateOfBirth}
                      onChange={(e) => setReportIncludeDateOfBirth(e.target.checked)}
                    />
                  }
                  label="DOB"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeHireDate}
                      onChange={(e) => setReportIncludeHireDate(e.target.checked)}
                    />
                  }
                  label="Hire Date"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeLocation}
                      onChange={(e) => setReportIncludeLocation(e.target.checked)}
                    />
                  }
                  label="Work Location"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeCompanyRole}
                      onChange={(e) => setReportIncludeCompanyRole(e.target.checked)}
                    />
                  }
                  label="Company Role"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeTobacco}
                      onChange={(e) => setReportIncludeTobacco(e.target.checked)}
                    />
                  }
                  label="Tobacco"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reportIncludeGender}
                      onChange={(e) => setReportIncludeGender(e.target.checked)}
                    />
                  }
                  label="Gender"
                />
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button
            onClick={() => {
              if (!reportGenerating) {
                setReportDialogOpen(false);
              }
            }}
            sx={{ textTransform: 'none' }}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                setReportGenerating(true);
                const blob = await GroupsService.downloadMembersReport(groupId, {
                  scope: reportScope,
                  includeDependents: reportIncludeDependents,
                  includeDateOfBirth: reportIncludeDateOfBirth,
                  includeHireDate: reportIncludeHireDate,
                  includeContributions: reportIncludeContributions,
                  includePlanDetails: reportIncludePlanDetails,
                  includeFees: reportIncludeFees,
                  includeLocation: reportIncludeLocation,
                  includeTotalPremium: reportIncludeTotalPremium,
                  includeCompanyRole: reportIncludeCompanyRole,
                  includeTobacco: reportIncludeTobacco,
                  includeGender: reportIncludeGender,
                  reportYear,
                  reportMonth,
                });

                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                const safeGroupName = groupName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
                const periodTag = `${String(reportYear).padStart(4, '0')}-${String(reportMonth).padStart(2, '0')}`;
                link.href = url;
                link.download = `${safeGroupName || 'group'}-members-report-${periodTag}.csv`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);

                showSnackbar('Report created and download started', 'success', 'Report Created');
                setReportDialogOpen(false);
              } catch (error) {
                console.error('Error creating members report:', error);
                showSnackbar(
                  error instanceof Error ? error.message : 'Failed to create report',
                  'error',
                  'Error'
                );
              } finally {
                setReportGenerating(false);
              }
            }}
            variant="contained"
            disabled={reportGenerating}
            startIcon={reportGenerating ? <CircularProgress size={16} /> : <AssessmentIcon />}
            sx={{
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            {reportGenerating ? 'Creating Report...' : 'Create & Download'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Send Enrollment Links Dialog */}
      <SendEnrollmentDialog
        open={sendLinksDialogOpen}
        onClose={() => setSendLinksDialogOpen(false)}
        members={activePrimaryMembers.map(m => ({
          ...m,
          HasActiveEnrollment: (m.ActiveEnrollments || 0) > 0
        }))}
        onSend={sendEnrollmentLinks}
        groupId={groupId}
        groupName={groupName}
        groupAgentId={(groupDetails as Record<string, unknown> | null)?.AgentId as string | undefined ?? undefined}
        groupTenantId={(groupDetails as Record<string, unknown> | null)?.TenantId as string | undefined ?? undefined}
        enrollmentPeriodActive={enrollmentPeriodStatus?.currentPeriod?.isActive ?? false}
        enrollmentPeriodEndDate={enrollmentPeriodStatus?.currentPeriod?.endDate ?? null}
        linkBaseUrlOptions={(() => {
          const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
          if (!isLocalhost) return [];
          const options: Array<{ label: string; value: string }> = [
            { label: `Current (${window.location.origin})`, value: window.location.origin },
            { label: 'Production (https://app.allaboard365.com)', value: 'https://app.allaboard365.com' },
          ];
          const tenantDomain = (groupDetails as any)?.TenantCustomDomain;
          if (tenantDomain && String(tenantDomain).trim().length > 0) {
            options.push({ label: `Tenant Custom Domain (https://${tenantDomain})`, value: `https://${tenantDomain}` });
          }
          return options;
        })()}
        defaultLinkBaseUrl={typeof window !== 'undefined' ? window.location.origin : ''}
      />

      {/* Send Group Message Dialog */}
      {canSendMessages && (
        <SendGroupMessageDialog
          open={sendMessageDialogOpen}
          onClose={() => {
            setSendMessageDialogOpen(false);
            refetch(); // Refresh members list after sending
          }}
          onSuccess={(message) => {
            showSnackbar(message, 'success', 'Success');
            refetch(); // Refresh members list
          }}
          groupId={groupId}
          groupName={groupName}
          initialFilters={{
            enrollmentStatus: enrollmentStatusFilter,
            locationId: locationFilter,
            showTerminated: showTerminated,
            search: searchTerm,
          }}
        />
      )}

      {/* Declined member: confirm before sending new enrollment link */}
      <Dialog
        open={declinedSendLinkConfirmOpen}
        onClose={() => {
          setDeclinedSendLinkConfirmOpen(false);
          setDeclinedSendLinkConfirmMember(null);
        }}
        maxWidth="sm"
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
            Send Enrollment Link
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Alert severity="info" sx={{ mb: 2 }}>
              <AlertTitle>This member declined coverage</AlertTitle>
              This will undo that decision and send a new enrollment link. Are you sure you want to send it?
            </Alert>
            {declinedSendLinkConfirmMember && (
              <Typography variant="body2" color="text.secondary">
                {declinedSendLinkConfirmMember.FirstName} {declinedSendLinkConfirmMember.LastName}
              </Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => {
              setDeclinedSendLinkConfirmOpen(false);
              setDeclinedSendLinkConfirmMember(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              if (declinedSendLinkConfirmMember) {
                setSelectedMemberForLink(declinedSendLinkConfirmMember);
                setIndividualLinkDialogOpen(true);
              }
              setDeclinedSendLinkConfirmOpen(false);
              setDeclinedSendLinkConfirmMember(null);
            }}
          >
            Continue
          </Button>
        </DialogActions>
      </Dialog>

      {/* Individual Enrollment Link Dialog */}
      {selectedMemberForLink && (
        <IndividualEnrollmentLinkModal
          open={individualLinkDialogOpen}
          onClose={() => {
            setIndividualLinkDialogOpen(false);
            setSelectedMemberForLink(null);
          }}
          member={selectedMemberForLink ? {
            ...selectedMemberForLink,
            GroupAgentId: (selectedMemberForLink.GroupAgentId || (groupDetails as Record<string, unknown>)?.AgentId) as string | undefined,
            GroupAgentName: (selectedMemberForLink.GroupAgentName || (groupDetails as Record<string, unknown>)?.AgentName || (groupDetails as Record<string, unknown>)?.assignedAgentName) as string | undefined
          } : selectedMemberForLink!}
          onLinkSent={() => {
            refetch(); // Refresh the members list
            showSnackbar(
              `Enrollment link sent to ${selectedMemberForLink.FirstName} ${selectedMemberForLink.LastName}`,
              'success',
              'Link Sent'
            );
          }}
          onCreateGroupTemplate={createNewEnrollmentLinkTemplate}
          linkBaseUrlOptions={(() => {
            const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            if (!isLocalhost) return [];
            const options: Array<{ label: string; value: string }> = [
              { label: `Current (${window.location.origin})`, value: window.location.origin },
              { label: 'Production (https://app.allaboard365.com)', value: 'https://app.allaboard365.com' },
            ];
            const tenantDomain = (groupDetails as any)?.TenantCustomDomain;
            if (tenantDomain && String(tenantDomain).trim().length > 0) {
              options.push({ label: `Tenant Custom Domain (https://${tenantDomain})`, value: `https://${tenantDomain}` });
            }
            return options;
          })()}
          defaultLinkBaseUrl={typeof window !== 'undefined' ? window.location.origin : ''}
        />
      )}

      {/* Termination Dialog */}
      {memberToTerminate && (
        <Dialog 
          open={terminationDialogOpen} 
          onClose={() => {
            setTerminationDialogOpen(false);
            setMemberToTerminate(null);
          }} 
          maxWidth="sm" 
          fullWidth
          PaperProps={{
            sx: {
              borderRadius: 2,
              boxShadow: theme.shadows[24],
            },
          }}
        >
          <DialogTitle>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#ef4444' }}>
              Terminate Member
            </Typography>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ py: 2 }}>
              <Alert severity="warning" sx={{ mb: 3 }}>
                <AlertTitle>Warning</AlertTitle>
                This action will terminate the member and all their active enrollments. 
                This action cannot be undone.
              </Alert>
              
              <Typography variant="body1" sx={{ mb: 2, fontWeight: 500 }}>
                Member: {memberToTerminate.FirstName} {memberToTerminate.LastName}
              </Typography>
              
              <TextField
                label="Termination Date"
                type="date"
                value={terminationDate}
                onChange={(e) => setTerminationDate(e.target.value)}
                fullWidth
                InputLabelProps={{ shrink: true }}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    '&.Mui-focused fieldset': {
                      borderColor: '#ef4444',
                    },
                  },
                  '& .MuiInputLabel-root.Mui-focused': {
                    color: '#ef4444',
                  },
                }}
              />
              
              <Typography variant="caption" sx={{ color: theme.palette.text.secondary, mt: 1, display: 'block' }}>
                The member and all their active enrollments will be terminated on this date.
              </Typography>
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 3 }}>
            <Button 
              onClick={() => {
                setTerminationDialogOpen(false);
                setMemberToTerminate(null);
              }}
              sx={{ textTransform: 'none' }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => terminateMember(memberToTerminate.MemberId, terminationDate)}
              variant="contained"
              disabled={terminationLoading}
              sx={{ 
                textTransform: 'none',
                bgcolor: '#ef4444',
                '&:hover': {
                  bgcolor: '#dc2626',
                },
                '&:disabled': {
                  bgcolor: '#fca5a5',
                }
              }}
            >
              {terminationLoading ? 'Terminating...' : 'Confirm Termination'}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Password Reset Confirmation Dialog */}
      {memberForPasswordReset && (
        <Dialog 
          open={passwordResetDialogOpen} 
          onClose={() => {
            if (!passwordResetLoading) {
              setPasswordResetDialogOpen(false);
              setMemberForPasswordReset(null);
            }
          }} 
          maxWidth="sm" 
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
              Send Password Email
            </Typography>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ py: 2 }}>
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>Confirm Password Email</AlertTitle>
                <Typography variant="body2">
                  {memberForPasswordReset.EnrollmentStatus === 'Pending Login' 
                    ? 'This member is enrolled but has not set up their password yet. A password setup email will be sent.'
                    : 'A password reset email will be sent to this member. The link will expire in 15 minutes.'}
                </Typography>
              </Alert>
              
              <Typography variant="body1" sx={{ mb: 2, fontWeight: 500 }}>
                Member: {memberForPasswordReset.FirstName} {memberForPasswordReset.LastName}
              </Typography>
              
              <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                Email: {memberForPasswordReset.Email}
              </Typography>
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 3 }}>
            <Button 
              onClick={() => {
                setPasswordResetDialogOpen(false);
                setMemberForPasswordReset(null);
              }}
              disabled={passwordResetLoading}
              sx={{ textTransform: 'none' }}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!memberForPasswordReset) return;
                
                try {
                  setPasswordResetLoading(true);
                  const response = await GroupsService.sendPasswordEmail(groupId, memberForPasswordReset.MemberId);
                  
                  if (response.success) {
                    const emailType = response.data?.emailType === 'setup' ? 'setup' : 'reset';
                    showSnackbar(
                      `Password ${emailType === 'setup' ? 'setup' : 'reset'} email sent successfully to ${memberForPasswordReset.FirstName} ${memberForPasswordReset.LastName}`,
                      'success',
                      'Email Sent'
                    );
                    setPasswordResetDialogOpen(false);
                    setMemberForPasswordReset(null);
                  } else {
                    showSnackbar(
                      response.message || 'Failed to send password email',
                      'error',
                      'Error'
                    );
                  }
                } catch (error) {
                  console.error('Error sending password email:', error);
                  showSnackbar(
                    error instanceof Error ? error.message : 'Failed to send password email',
                    'error',
                    'Error'
                  );
                } finally {
                  setPasswordResetLoading(false);
                }
              }}
              variant="contained"
              disabled={passwordResetLoading}
              sx={{ 
                textTransform: 'none',
                bgcolor: 'var(--oe-primary)',
                '&:hover': {
                  bgcolor: 'var(--oe-primary-dark)',
                },
                '&:disabled': {
                  bgcolor: '#9ca3af',
                }
              }}
            >
              {passwordResetLoading ? 'Sending...' : 'Send Email'}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Unterminate Dialog */}
      {memberToUnterminate && (
        <Dialog 
          open={unterminateDialogOpen} 
          onClose={() => {
            setUnterminateDialogOpen(false);
            setMemberToUnterminate(null);
          }} 
          maxWidth="sm" 
          fullWidth
          PaperProps={{
            sx: {
              borderRadius: 2,
              boxShadow: theme.shadows[24],
            },
          }}
        >
          <DialogTitle>
            <Typography variant="h6" sx={{ fontWeight: 600, color: '#10b981' }}>
              Unterminate Member
            </Typography>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ py: 2 }}>
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>Restore Member</AlertTitle>
                This action will restore the member to active status. The member must manually re-enroll in products.
              </Alert>
              
              <Typography variant="body1" sx={{ mb: 2, fontWeight: 500 }}>
                Member: {memberToUnterminate.FirstName} {memberToUnterminate.LastName}
              </Typography>
              
              <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                The member will be restored to active status. Their terminated enrollments will remain terminated, and they must manually re-enroll in products.
              </Typography>
            </Box>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 3 }}>
            <Button 
              onClick={() => {
                setUnterminateDialogOpen(false);
                setMemberToUnterminate(null);
              }}
              sx={{ textTransform: 'none' }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => unterminateMember(memberToUnterminate.MemberId)}
              variant="contained"
              disabled={unterminateLoading}
              sx={{ 
                textTransform: 'none',
                bgcolor: '#10b981',
                '&:hover': {
                  bgcolor: '#059669',
                },
                '&:disabled': {
                  bgcolor: '#86efac',
                }
              }}
            >
              {unterminateLoading ? 'Restoring...' : 'Confirm Restoration'}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Set Enrollment Period Modal */}
      <SetEnrollmentPeriodModal
        isOpen={enrollmentPeriodModalOpen}
        onClose={() => setEnrollmentPeriodModalOpen(false)}
        groupId={groupId}
        groupName={groupName}
        existingPeriod={enrollmentPeriodStatus?.currentPeriod}
        onPeriodSet={() => {
          fetchEnrollmentPeriodStatus();
          showSnackbar(
            `Initial enrollment period ${enrollmentPeriodStatus?.currentPeriod ? 'updated' : 'set'} successfully`, 
            'success', 
            'Success'
          );
        }}
      />

      {/* Location Match Confirmation Dialog */}
      <Dialog 
        open={locationMatchModal.open} 
        onClose={handleLocationMatchCancel} 
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
            Confirm Work Locations
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Alert severity="warning" sx={{ mb: 3 }}>
              <AlertTitle>Location Assignment Required</AlertTitle>
              The following {locationMatchModal.uncertainMembers.length} member(s) have work locations that are either empty or don't match any existing locations for this group. 
              Please select the correct location for each member below.
            </Alert>
            
            {/* Scrollable list of uncertain members */}
            <Box sx={{ 
              maxHeight: 400, 
              overflow: 'auto',
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
              p: 2
            }}>
              <Stack spacing={2}>
                {locationMatchModal.uncertainMembers.map((uncertainMember, index) => (
                  <Paper
                    key={index}
                    sx={{
                      p: 2,
                      border: `1px solid ${theme.palette.divider}`,
                      bgcolor: alpha('#fbbf24', 0.05)
                    }}
                  >
                    <Stack spacing={2}>
                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          {uncertainMember.memberData.firstName} {uncertainMember.memberData.lastName}
                        </Typography>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                          Row {uncertainMember.rowIndex} • Email: {uncertainMember.memberData.email}
                        </Typography>
                      </Box>
                      
                      <Box>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', mb: 0.5 }}>
                          CSV Work Location:
                        </Typography>
                        <Chip 
                          label={uncertainMember.csvLocationValue}
                          size="small"
                          sx={{ 
                            bgcolor: alpha('#f59e0b', 0.1),
                            color: '#f59e0b',
                            fontFamily: 'monospace',
                            fontSize: '0.75rem'
                          }}
                        />
                      </Box>
                      
                      <FormControl fullWidth size="small">
                        <InputLabel>Assign to Location *</InputLabel>
                        <Select
                          value={uncertainMember.selectedLocationId}
                          onChange={(e) => {
                            const newUncertainMembers = [...locationMatchModal.uncertainMembers];
                            newUncertainMembers[index].selectedLocationId = e.target.value;
                            setLocationMatchModal({
                              ...locationMatchModal,
                              uncertainMembers: newUncertainMembers
                            });
                          }}
                          label="Assign to Location *"
                          sx={{
                            '& .MuiOutlinedInput-root': {
                              '&.Mui-focused fieldset': {
                                borderColor: 'var(--oe-primary)',
                              },
                            },
                          }}
                        >
                          {locations.map((location) => (
                            <MenuItem key={location.LocationId} value={location.LocationId}>
                              {location.Name || 'Unnamed Location'}
                              {location.IsPrimary && ' (Primary)'}
                              {' - '}
                              {location.City}, {location.State}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Box>
            
            <Box sx={{ mt: 3, p: 2, bgcolor: alpha(colors.primary, 0.05), borderRadius: 1 }}>
              <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                <strong>Note:</strong> Members with matched locations ({locationMatchModal.allHouseholds.flat().length - locationMatchModal.uncertainMembers.length}) will be imported automatically. 
                The {locationMatchModal.uncertainMembers.length} members listed above require your attention.
              </Typography>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button 
            onClick={handleLocationMatchCancel}
            sx={{ textTransform: 'none' }}
          >
            Cancel Import
          </Button>
          <Button
            onClick={handleLocationMatchConfirm}
            variant="contained"
            disabled={locationMatchModal.uncertainMembers.some(m => !m.selectedLocationId)}
            sx={{ 
              textTransform: 'none',
              bgcolor: 'var(--oe-primary)',
              '&:hover': {
                bgcolor: 'var(--oe-primary-dark)',
              },
            }}
          >
            Confirm & Import {locationMatchModal.allHouseholds.flat().length} Members
          </Button>
        </DialogActions>
      </Dialog>

      {/* Census Import Preview Dialog */}
      <CensusImportPreview
        open={previewDialogOpen}
        onClose={() => {
          setPreviewDialogOpen(false);
          setParsedCensusData(null);
        }}
        parsedData={parsedCensusData}
        locations={locations}
        onConfirm={handlePreviewConfirm}
        loading={aiParsingLoading}
        onCancel={handleCancelAIProcessing}
      />

      {/* Import Loading Modal */}
      <Dialog
        open={importLoadingModal.open}
        onClose={() => {
          // Only allow closing if import is complete (progress === 100)
          if (importLoadingModal.progress === 100) {
            setImportLoadingModal(prev => ({ ...prev, open: false }));
          }
        }}
        maxWidth={importLoadingModal.existingUsersNotImported.length > 0 ? "md" : "sm"}
        fullWidth
        disableEscapeKeyDown={importLoadingModal.progress < 100}
        // Prevent backdrop clicks from closing during import
        BackdropProps={{
          onClick: (e) => {
            // Prevent backdrop click from closing during import
            if (importLoadingModal.progress < 100) {
              e.stopPropagation();
            }
          },
          sx: {
            pointerEvents: importLoadingModal.progress < 100 ? 'auto' : 'auto',
          }
        }}
      >
        <DialogTitle>
          {importLoadingModal.success ? 'Import Successful' : importLoadingModal.progress === 100 ? 'Import Complete' : 'Importing Members'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            {importLoadingModal.progress < 100 ? (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                  <CircularProgress size={24} sx={{ mr: 2 }} />
                  <Typography variant="body1">{importLoadingModal.current}</Typography>
                </Box>
                <Box sx={{ width: '100%', mb: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Progress
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {importLoadingModal.progress}%
                    </Typography>
                  </Box>
                  <Box
                    sx={{
                      width: '100%',
                      height: 8,
                      backgroundColor: theme.palette.grey[200],
                      borderRadius: 1,
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      sx={{
                        width: `${importLoadingModal.progress}%`,
                        height: '100%',
                        backgroundColor: theme.palette.primary.main,
                        transition: 'width 0.3s ease',
                      }}
                    />
                  </Box>
                </Box>
              </>
            ) : (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                  {importLoadingModal.success ? (
                    <CheckCircleIcon sx={{ color: 'success.main', mr: 2 }} />
                  ) : (
                    <ErrorIcon sx={{ color: 'error.main', mr: 2 }} />
                  )}
                  <Typography variant="body1">{importLoadingModal.current}</Typography>
                </Box>
                
                {/* Import Summary */}
                <Box sx={{ mt: 2, mb: 2, p: 2, bgcolor: alpha(colors.primary, 0.05), borderRadius: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                    Import Summary
                  </Typography>
                  <Typography variant="body2">
                    {importLoadingModal.totalHouseholdsImported} of {importLoadingModal.totalHouseholdsAttempted} household{importLoadingModal.totalHouseholdsAttempted !== 1 ? 's' : ''} imported successfully
                  </Typography>
                  {importLoadingModal.totalHouseholdsFailed > 0 && (
                    <Typography variant="body2" sx={{ mt: 1, color: 'error.main', fontWeight: 500 }}>
                      {importLoadingModal.totalHouseholdsFailed} household{importLoadingModal.totalHouseholdsFailed !== 1 ? 's' : ''} failed to import. Valid households were still imported successfully.
                    </Typography>
                  )}
                  {importLoadingModal.existingMembersInGroup > 0 && (
                    <Typography variant="body2" sx={{ mt: 1, color: 'success.main', fontWeight: 500 }}>
                      {importLoadingModal.existingMembersInGroup} member{importLoadingModal.existingMembersInGroup !== 1 ? 's' : ''} were already in your group (this is good - they're already set up!)
                    </Typography>
                  )}
                  {importLoadingModal.existingUsersNotImported.length > 0 && (
                    <Typography variant="body2" sx={{ mt: 1, color: 'warning.main', fontWeight: 500 }}>
                      {importLoadingModal.existingUsersNotImported.length} member{importLoadingModal.existingUsersNotImported.length !== 1 ? 's' : ''} could not be imported because they already have accounts in the system (not in this group). Please request support for these members.
                    </Typography>
                  )}
                </Box>

                {/* Existing Users Not Imported */}
                {importLoadingModal.existingUsersNotImported.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="subtitle2" color="warning.main" sx={{ fontWeight: 600 }}>
                        Members Requiring Support ({importLoadingModal.existingUsersNotImported.length}):
                      </Typography>
                      <Button
                        size="small"
                        startIcon={<ContentCopyIcon />}
                        onClick={() => {
                          const reportText = `Import Report\n\n${importLoadingModal.totalHouseholdsImported} of ${importLoadingModal.totalHouseholdsAttempted} household${importLoadingModal.totalHouseholdsAttempted !== 1 ? 's' : ''} imported successfully.\n\n${importLoadingModal.existingUsersNotImported.length} member${importLoadingModal.existingUsersNotImported.length !== 1 ? 's' : ''} could not be imported because they already have accounts in the system. Please request support for these members:\n\n${importLoadingModal.existingUsersNotImported.map((user, idx) => `${idx + 1}. ${user.firstName} ${user.lastName} - ${user.email}`).join('\n')}`;
                          navigator.clipboard.writeText(reportText).then(() => {
                            showSnackbar('Report copied to clipboard', 'success', 'Copied');
                          }).catch(() => {
                            showSnackbar('Failed to copy report', 'error', 'Error');
                          });
                        }}
                        sx={{ textTransform: 'none', fontSize: '0.75rem' }}
                      >
                        Copy Report
                      </Button>
                    </Box>
                    <Box
                      sx={{
                        maxHeight: 250,
                        overflow: 'auto',
                        backgroundColor: alpha(theme.palette.warning.main, 0.1),
                        border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
                        borderRadius: 1,
                        p: 1.5,
                      }}
                    >
                      <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', mb: 1, fontStyle: 'italic' }}>
                        Please request support for these members:
                      </Typography>
                      {importLoadingModal.existingUsersNotImported.map((user, index) => (
                        <Typography key={index} variant="body2" sx={{ mb: 0.75, pl: 1 }}>
                          {index + 1}. <strong>{user.firstName} {user.lastName}</strong> - {user.email}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                )}

                {/* Skipped Members */}
                {importLoadingModal.skippedMembers.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="subtitle2" sx={{ mb: 1, color: theme.palette.warning.main, fontWeight: 600 }}>
                      Skipped Members ({importLoadingModal.skippedMembers.length}):
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 200,
                        overflow: 'auto',
                        backgroundColor: alpha(theme.palette.warning.main, 0.1),
                        border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
                        borderRadius: 1,
                        p: 1,
                      }}
                    >
                      {importLoadingModal.skippedMembers.map((skipped, index) => (
                        <Typography key={index} variant="body2" sx={{ mb: 0.5 }}>
                          • {skipped}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                )}

                {/* Errors */}
                {importLoadingModal.errors.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="subtitle2" color="error" sx={{ mb: 1 }}>
                      Errors ({importLoadingModal.errors.length}):
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 200,
                        overflow: 'auto',
                        backgroundColor: theme.palette.error.light,
                        borderRadius: 1,
                        p: 1,
                      }}
                    >
                      {importLoadingModal.errors.map((error, index) => (
                        <Typography key={index} variant="body2" sx={{ mb: 0.5 }}>
                          • {error}
                        </Typography>
                      ))}
                    </Box>
                  </Box>
                )}
              </>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              // Check if there are failures that need attention
              const hasFailures = importLoadingModal.totalHouseholdsFailed > 0 || 
                                  importLoadingModal.existingUsersNotImported.length > 0 ||
                                  importLoadingModal.errors.length > 0;
              
              if (importLoadingModal.progress === 100 && hasFailures) {
                // Show confirmation if there are failures
                setCloseImportConfirmOpen(true);
              } else {
                // No failures or still processing - close normally
                setImportLoadingModal(prev => ({ ...prev, open: false }));
              }
            }}
            disabled={importLoadingModal.progress < 100}
            sx={{ textTransform: 'none' }}
          >
            {importLoadingModal.progress === 100 ? 'Close' : 'Cancel'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Close Import Confirmation Dialog */}
      <Dialog
        open={closeImportConfirmOpen}
        onClose={() => setCloseImportConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Confirm Close
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ py: 2 }}>
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>Save Your Report</AlertTitle>
              <Typography variant="body2">
                Did you save your report for failed households? You may lose this information if you close now.
              </Typography>
            </Alert>
            {(importLoadingModal.totalHouseholdsFailed > 0 || importLoadingModal.existingUsersNotImported.length > 0) && (
              <Box sx={{ mt: 2 }}>
                {importLoadingModal.totalHouseholdsFailed > 0 && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>
                    • {importLoadingModal.totalHouseholdsFailed} household{importLoadingModal.totalHouseholdsFailed !== 1 ? 's' : ''} failed to import
                  </Typography>
                )}
                {importLoadingModal.existingUsersNotImported.length > 0 && (
                  <Typography variant="body2">
                    • {importLoadingModal.existingUsersNotImported.length} member{importLoadingModal.existingUsersNotImported.length !== 1 ? 's' : ''} require support (already have accounts in the system)
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button
            onClick={() => setCloseImportConfirmOpen(false)}
            sx={{ textTransform: 'none' }}
          >
            Go Back
          </Button>
          <Button
            onClick={() => {
              setCloseImportConfirmOpen(false);
              setImportLoadingModal(prev => ({ ...prev, open: false }));
            }}
            variant="contained"
            sx={{ 
              textTransform: 'none',
              bgcolor: '#ef4444',
              '&:hover': {
                bgcolor: '#dc2626',
              },
            }}
          >
            Close Anyway
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dependents Modal */}
      <Dialog
        open={dependentsModalOpen}
        onClose={() => {
          setDependentsModalOpen(false);
          setSelectedMemberForDependents(null);
          setDependents([]);
        }}
        maxWidth="sm"
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
            Dependents
          </Typography>
          {selectedMemberForDependents && (
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
              {selectedMemberForDependents.FirstName} {selectedMemberForDependents.LastName}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          {dependentsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : dependents.length === 0 ? (
            <Box sx={{ py: 4, textAlign: 'center' }}>
              <PeopleIcon sx={{ fontSize: 48, color: theme.palette.text.secondary, mb: 2 }} />
              <Typography variant="body1" color="text.secondary">
                No dependents found
              </Typography>
            </Box>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {dependents.map((dependent) => {
                // Check if email is a real email (not a default generated one)
                const isRealEmail = dependent.Email && !dependent.Email.includes('@noemail.com');
                
                return (
                  <Paper
                    key={dependent.MemberId}
                    sx={{
                      p: 2,
                      border: `1px solid ${theme.palette.divider}`,
                      borderRadius: 1,
                    }}
                  >
                    <Stack spacing={1}>
                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          {dependent.FirstName} {dependent.LastName}
                        </Typography>
                        <Chip
                          label={dependent.RelationshipDescription}
                          size="small"
                          color="info"
                          variant="outlined"
                          sx={{ mt: 0.5, fontSize: '0.7rem', height: 20 }}
                        />
                      </Box>
                      
                      {isRealEmail && (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <EmailIcon sx={{ fontSize: '0.875rem', color: theme.palette.text.secondary }} />
                          <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontSize: '0.875rem' }}>
                            {dependent.Email}
                          </Typography>
                        </Stack>
                      )}
                      
                      {dependent.DateOfBirth && (
                        <Stack direction="row" spacing={1} alignItems="center">
                          <CalendarIcon sx={{ fontSize: '0.875rem', color: theme.palette.text.secondary }} />
                          <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontSize: '0.875rem' }}>
                            DOB: {format(new Date(dependent.DateOfBirth + 'T00:00:00'), 'MMM dd, yyyy')}
                          </Typography>
                        </Stack>
                      )}
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button
            onClick={() => {
              setDependentsModalOpen(false);
              setSelectedMemberForDependents(null);
              setDependents([]);
            }}
            sx={{ textTransform: 'none' }}
          >
            Close
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
