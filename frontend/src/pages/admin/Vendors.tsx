import {
    AttachMoney as AttachMoneyIcon,
    Close as CloseIcon,
    Delete as DeleteIcon,
    Edit as EditIcon,
    ExpandMore as ExpandMoreIcon,
    Inventory as InventoryIcon,
    Receipt as ReceiptIcon,
    TrendingUp as TrendingUpIcon,
    Visibility as ViewIcon,
} from '@mui/icons-material';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Alert,
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
    FormControl,
    FormControlLabel,
    Grid,
    IconButton,
    InputAdornment,
    InputLabel,
    ListSubheader,
    MenuItem,
    Paper,
    Select,
    Skeleton,
    Snackbar,
    Switch,
    Tab,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tabs,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import axios from 'axios';
import { AlertCircle, CheckCircle, Download, Eye, EyeOff, FileDown, FileText, Hash, Info, Loader2, PenTool, Play, Plus, RefreshCw, Send, Settings, Sparkles, Trash2, Upload, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { US_STATES as GEOGRAPHIC_US_STATES } from '../../components/common/geographic-data';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import NewGroupFormGenerateModal from '../../components/groups/NewGroupFormGenerateModal';
import AddProductsWizard, { ProductFormData } from '../../components/forms/AddProductWizard';
import AdminVendorUserManagementPanel from '../../components/admin/AdminVendorUserManagementPanel';
import VendorNetworksPanel from '../../components/vendor/VendorNetworksPanel';
import VendorRequestTypeSettings from '../vendor/VendorRequestTypeSettings';
import TpaForwardingTab from '../../components/vendor/settings/TpaForwardingTab';
import VendorEmailSettings from '../../components/vendor/settings/VendorEmailSettings';
import SharedHeader from '../../components/layout/SharedHeader';
import PDFSignerEditor from '../../components/pdf-signer/PDFSignerEditor';
import { MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { API_CONFIG } from '../../config/api';
import { apiService } from '../../services/api.service';
import {
    formatLocalTimeLabel,
    getBrowserIanaTimeZone,
    localInputToServerScheduleTime,
    serverScheduleTimeToLocalInput,
} from '../../utils/vendorExportScheduleTime';
import { isVendorGroupIdSystemVariable, NEW_GROUP_FORM_VENDOR_NETWORK_SYSTEM_VARIABLES } from '../../utils/vendorGroupFormVariables';
import EligibilityFormatAIAssistant from '../../components/ai/EligibilityFormatAIAssistant';
import { applyEligibilityPatchToFormData } from '../../utils/eligibilityFormatAiMerge';
import {
  clearEligibilityAiChatSession,
  eligibilityAiChatStorageKey,
} from '../../utils/eligibilityFormatAiSession';
import {
  AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE,
  getEligibilityTemplateErrors,
  SHAREWELL_24_COLUMN_TEMPLATE,
} from '../../utils/eligibilityRowTemplate';

const DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ = 'America/Chicago';

// Set up axios defaults with base URL
const axiosInstance = axios.create({
  baseURL: API_CONFIG.BASE_URL || 'http://localhost:3001', // Fallback to backend port
  headers: {
    'Content-Type': 'application/json',
  },
});

console.log('[Vendors] Initial Axios baseURL (will update from runtime config):', axiosInstance.defaults.baseURL);

/** Default payables: member contract amounts + coverage period; footer adds Payables/Paid totals (matches backend getDefaultPayablesTemplate). */
const DEFAULT_PAYABLES_TEMPLATE =
  '{MemberID:Member ID},{FirstName:First Name},{LastName:Last Name},{State:State},{GroupName:Group Name},{?Health:Health},{?Vision:Vision},{ContractAmount:Contract Amount},{CoveragePeriod:Coverage Period},{?AgentName:Agent Name}';
/** Per-product line export (one CSV row per product enrollment). */
const LINE_ITEM_PAYABLES_TEMPLATE =
  '{MemberID:Member ID},{FirstName:First Name},{LastName:Last Name},{State:State},{ProductID:Product ID},{ProductName:Product Name},{PlanTier:Plan Tier},{ContractAmount:Contract Amount},{CoveragePeriod:Coverage Period},{EffectiveDate:Effective Date},{TerminationDate:Termination Date},{?AgentName:Agent Name},{PolicyNumber:Policy Number},{GroupName:Group Name}';

// New Group Form: system variable options and MightyWell preset (for Edit Vendor → New Group Form tab)
const NEW_GROUP_FORM_SYSTEM_VARIABLES = [
  { value: '', label: '— No mapping (blank) —' },
  { value: 'group.TaxIdNumber', label: 'Group: Tax ID Number' },
  { value: 'group.Name', label: 'Group: Company / Group Name' },
  { value: 'group.LegalName', label: 'Group: Legal Name (company/group name)' },
  { value: 'group.PhysicalAddress', label: 'Group: Address' },
  { value: 'group.subsidiariesFromLocations', label: 'Group: Subsidiaries (from locations; when group has 2+ locations)' },
  { value: 'group.City', label: 'Group: City' },
  { value: 'group.State', label: 'Group: State' },
  { value: 'group.Zip', label: 'Group: Zip' },
  { value: 'group.PrimaryContact', label: 'Group: Primary Contact Name (contact person)' },
  { value: 'group.ContactEmail', label: 'Group: Contact Email' },
  { value: 'group.ContactPhone', label: 'Group: Contact Phone' },
  { value: 'group.Website', label: 'Group: Website' },
  { value: 'group.BusinessType', label: 'Group: Business Type' },
  { value: 'group.anticipatedFirstEffectiveDate', label: 'Group: Anticipated First Effective Date' },
  { value: 'group.contributionSummary', label: 'Group: Contribution rules summary' },
  { value: 'group.contributionAmountDollar', label: 'Group: Contribution amount ($)' },
  { value: 'group.contributionAmountPercent', label: 'Group: Contribution amount (%)' },
  { value: 'group.vendorProductNames', label: 'Group: Plans/products for this vendor (from group products + bundle products)' },
  ...NEW_GROUP_FORM_VENDOR_NETWORK_SYSTEM_VARIABLES,
  { value: 'agent.Name', label: 'Agent/Broker: Name' },
  { value: 'agent.Email', label: 'Agent/Broker: Email' },
  { value: 'agent.Phone', label: 'Agent/Broker: Phone' },
  { value: 'agent.LicenseState', label: 'Agent: License State' },
  { value: 'agent.LicenseNumber', label: 'Agent: License Number' },
  { value: 'group.currentDateTime', label: 'Current Date/Time' },
  { value: 'group.createdDateTime', label: 'Group Creation Date/Time' },
  { value: '__agentSignature__', label: 'Agent Signature' },
  { value: '__groupAdminSignature__', label: 'Group Admin Signature' },
  // Vendor Group ID (Master + product-specific) in optgroup below
];
// Field type: 'field' = normal label + value; 'labelHeader' = bold section header only (no input/value).
const MIGHTYWELL_NEW_GROUP_FORM_PRESET = {
  formTitle: 'MightyWell Health New Group Review / Sold Sheet',
  fields: [
    { key: 'anticipatedFirstEffectiveDate', label: 'Anticipated First Effective Date', systemVariable: 'group.anticipatedFirstEffectiveDate', fieldType: 'field' as const },
    { key: 'sectionBusinessInfo', label: 'Business Information', systemVariable: '', fieldType: 'labelHeader' as const },
    { key: 'businessTaxId', label: 'Tax ID Number', systemVariable: 'group.TaxIdNumber', fieldType: 'field' as const },
    { key: 'legalName', label: 'Legal Name', systemVariable: 'group.Name', fieldType: 'field' as const },
    { key: 'physicalAddress', label: 'Physical Address of Group', systemVariable: 'group.PhysicalAddress', fieldType: 'field' as const },
    { key: 'website', label: 'Website Address', systemVariable: 'group.Website', fieldType: 'field' as const },
    { key: 'industryType', label: 'Industry Type', systemVariable: 'group.BusinessType', fieldType: 'field' as const },
    { key: 'sic', label: 'SIC', systemVariable: '', fieldType: 'field' as const },
    { key: 'sectionBusinessOwner', label: 'Business Owner(s) Information', systemVariable: '', fieldType: 'labelHeader' as const },
    { key: 'businessOwnerName', label: 'Legal Name', systemVariable: 'group.PrimaryContact', fieldType: 'field' as const },
    { key: 'businessOwnerPhone', label: 'Phone number', systemVariable: 'group.ContactPhone', fieldType: 'field' as const },
    { key: 'businessOwnerEmail', label: 'Email', systemVariable: 'group.ContactEmail', fieldType: 'field' as const },
    { key: 'sectionPrimaryContact', label: 'Business Day-to-day Primary Contact', systemVariable: '', fieldType: 'labelHeader' as const },
    { key: 'primaryContactName', label: 'Legal Name', systemVariable: 'group.PrimaryContact', fieldType: 'field' as const },
    { key: 'primaryContactPhone', label: 'Phone number', systemVariable: 'group.ContactPhone', fieldType: 'field' as const },
    { key: 'primaryContactEmail', label: 'Email', systemVariable: 'group.ContactEmail', fieldType: 'field' as const },
    { key: 'subsidiaries', label: 'List all subsidiaries that may be covered under the Plan. (Additional space is available on page 4.)', systemVariable: 'group.subsidiariesFromLocations', fieldType: 'field' as const },
    { key: 'sectionBroker', label: 'Broker Contact', systemVariable: '', fieldType: 'labelHeader' as const },
    { key: 'brokerName', label: 'Legal Name', systemVariable: 'agent.Name', fieldType: 'field' as const },
    { key: 'brokerPhone', label: 'Phone number', systemVariable: 'agent.Phone', fieldType: 'field' as const },
    { key: 'brokerEmail', label: 'Email', systemVariable: 'agent.Email', fieldType: 'field' as const },
    { key: 'sectionLicensedAgent', label: "Licensed Agent's Information", systemVariable: '', fieldType: 'labelHeader' as const },
    { key: 'licensedAgentName', label: 'Legal Name', systemVariable: 'agent.Name', fieldType: 'field' as const },
    { key: 'licensedAgentResidentState', label: 'Resident State', systemVariable: 'agent.LicenseState', fieldType: 'field' as const },
    { key: 'licensedAgentLicenseNumber', label: 'License Number', systemVariable: 'agent.LicenseNumber', fieldType: 'field' as const },
    { key: 'overviewBackground', label: 'Overview and Background on the Business', systemVariable: '', fieldType: 'field' as const },
    { key: 'relationshipToParticipants', label: "Describe the Group's relationship to the prospective participants", systemVariable: '', fieldType: 'field' as const },
    { key: 'employerContributionLabel', label: 'Please provide the employer contribution amount (percentage or dollar) per employee.', systemVariable: 'group.contributionSummary', fieldType: 'field' as const },
    { key: 'howCensusProvided', label: 'How will the group provide an initial enrollment census and ongoing enrollment adds/updates/terms?', systemVariable: '', defaultValue: 'CSV', fieldType: 'field' as const },
    { key: 'idCardsDestination', label: 'Where are ID cards to be sent for distribution? – Digital Only', systemVariable: '', defaultValue: 'Digital', fieldType: 'field' as const },
    { key: 'plansInterested', label: 'Mark the Plans that the group is interested in offering. *Final Plans available subject to approval.', systemVariable: 'group.vendorProductNames', fieldType: 'field' as const },
    { key: 'vendorNetworkResolved', label: 'Vendor network', systemVariable: 'group.vendorNetworkTitle', fieldType: 'field' as const },
    { key: 'agentSignature', label: 'Agent Signature', systemVariable: '', fieldType: 'field' as const },
    { key: 'groupAdminSignature', label: 'Group Admin Signature', systemVariable: '', fieldType: 'field' as const },
    { key: 'question4Continued', label: 'Question 4 Continued: Use the space below for any additional subsidiaries to be covered under the Plan.', systemVariable: '', fieldType: 'field' as const },
  ],
};

// Update baseURL from runtime config before each request
axiosInstance.interceptors.request.use((config) => {
  config.baseURL = API_CONFIG.BASE_URL;
  return config;
});

// Add request interceptor for debugging
axiosInstance.interceptors.request.use(
  (config) => {
    console.log('API Request:', {
      url: config.url,
      method: config.method,
      data: config.data,
      headers: config.headers,
    });
    
    // Add auth token if available
    const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    
    return config;
  },
  (error) => {
    console.error('Request error:', error);
    return Promise.reject(error);
  }
);

// Add response interceptor for debugging
axiosInstance.interceptors.response.use(
  (response) => {
    console.log('API Response:', {
      url: response.config.url,
      status: response.status,
      data: response.data,
    });
    return response;
  },
  (error) => {
    console.error('Response error:', {
      url: error.config?.url,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    return Promise.reject(error);
  }
);

/**
 * Default manual "Effective before or on" (YYYY-MM-DD, local calendar) = today + N days.
 * N comes from vendor "Future effective days" when you open a vendor so the anchor aligns with that setting.
 */
function eligibilityEffectiveAsOfPickerDefault(futureEffectiveDays: number | string | null | undefined): string {
  const parsed = futureEffectiveDays != null ? parseInt(String(futureEffectiveDays), 10) : NaN;
  const days = !Number.isNaN(parsed) && parsed >= 0 ? parsed : 7;
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Vendor {
  Id: string;
  VendorName: string;
  AddressLine1?: string;
  AddressLine2?: string;
  City?: string;
  State?: string;
  Zip?: string;
  ContactName?: string;
  Phone?: string;
  Email?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
  achAccounts?: VendorAchAccount[];
  // Integration Settings
  ExportGroupIds?: string[]; // Array of Group IDs
  GroupIdPrefix?: string; // Prefix for Group IDs (e.g., "90")
  GroupIdSeedNumber?: number; // Starting seed number for first group (e.g., 285)
  GroupIdAffixPosition?: 'Prefix' | 'Suffix' | null; // Where the affix sits relative to the numeric part. NULL → Prefix (legacy)
  GroupIdBetweenGroupsIncrement?: number | null; // Spacing between successive employer-group numeric bases. NULL → 5 (legacy ARM)
  AutoGenerateVendorGroupIds?: boolean; // Opt in to nightly auto-assign job
  SftpHostname?: string;
  SftpPort?: number;
  SftpUsername?: string;
  SftpPassword?: string;
  SftpPath?: string;
  SftpPathNacha?: string;
  SftpPathEligibility?: string;
  ExportEmailAddress?: string;
  ExportEmailEnabled?: boolean;
  ApiBaseUrl?: string;
  ApiToken?: string;
  ApiEnabled?: boolean;
  ExportSchedule?: string; // e.g., "weekly", "daily", cron expression
  ExportMethod?: string; // 'SFTP' or 'API'
  ExportScheduleDay?: string; // Day of week for weekly schedule (Monday, Tuesday, etc.)
  ExportScheduleTime?: string; // Time for schedule (HH:mm format)
  // Additional Integration Settings
  ExportFileFormat?: string; // 'CSV', 'JSON', 'XML', etc.
  ExportFileNameTemplate?: string; // Eligibility export filename template
  PayablesExportFileNameTemplate?: string; // Payables CSV filename (optional; falls back to ExportFileNameTemplate if empty)
  ExportRetryAttempts?: number; // Number of retry attempts on failure
  ExportRetryDelayMinutes?: number; // Delay between retries in minutes
  ExportCompressionEnabled?: boolean; // Whether to compress files
  ExportEncryptionEnabled?: boolean; // Whether to encrypt files
  ExportTestConnectionStatus?: string; // Last test connection status
  // Eligibility export
  EligibilityIncludeOnlyChanges?: boolean; // Only include new/terminated since last send (default true)
  EligibilityRowTemplate?: string; // Custom CSV row template with placeholders e.g. {VendorGroupID},{LastName}
  EligibilityDateFormat?: string; // 'ARM' | 'Short' | 'Padded' | 'Compact' — Short/ARM = M/d/yyyy, Padded = MM/dd/yyyy, Compact = MMDDYYYY
  EligibilityIntegrationPartner?: string; // First column in ShareWELL-style CSV (e.g. AB365 for AllAboard365)
  EligibilityFutureEffectiveDays?: number | null; // Include future-effective enrollments up to this many days ahead (0 = none, default 7)
  EligibilityIncludeVendorIds?: string[]; // Vendor IDs whose product enrollments to include in eligibility file (current vendor always included)
  /** Primary (employee) rows: one per product (default) or one row per primary across products */
  EligibilityPrimaryExportGrain?: 'PerProduct' | 'SinglePrimaryRow';
  lastEligibilityFileSentAt?: string; // ISO date when last eligibility file was sent (from API, read-only)
  PayablesRowTemplate?: string; // Custom CSV row template for vendor payables export
  /** Minimum enrolled employees required per group (null = no minimum). Groups below this receive warnings and enrollment locks before their effective date. */
  MinimumEmployeesPerGroup?: number | null;
  /** When true, members subscribed to this vendor's products see a sharing-request status progress bar in the member portal. */
  ShowShareRequestStatusToMembers?: boolean;
  /**
   * Vendor-level default email recipients for signed ASA notifications.
   * Comma-separated. Overrides the vendor-wide Email + notification contacts
   * fallback when an `asa_signed` scheduled job is enabled but has no
   * per-job EmailRecipients of its own. Stored on oe.Vendors (column added in
   * sql-changes/2026-04-29-vendor-asa-signed-email-recipients.sql).
   */
  AsaSignedEmailRecipients?: string | null;
}

/** Per-vendor scheduled export jobs (oe.VendorScheduledJobs) */
interface VendorScheduledJobRow {
  vendorScheduledJobId: string;
  vendorId: string;
  jobType: string;
  isEnabled: boolean;
  exportSchedule: string | null;
  exportScheduleDay: string | null;
  /** 1–31 for monthly; null or omitted for non-monthly. Short months clamp on the server scheduler. */
  exportScheduleDayOfMonth?: number | null;
  /** schedule = calendar runs; nacha_generation = payables when this vendor's NACHA batch is marked Sent */
  exportTrigger?: 'schedule' | 'nacha_generation' | string | null;
  exportScheduleTime: string | null;
  emailRecipients: string | null;
  useVendorDefaultSftp: boolean;
  sftpPathOverride: string | null;
  /** When jobType is new_group_form: run VendorGroupIdService before PDF generation */
  generateVendorGroupIdsIfNeeded?: boolean;
  /** When jobType is eligibility_export: drop households whose group has no master vendor group ID for this vendor */
  excludeGroupsMissingVendorGroupId?: boolean;
  lastRunAt: string | null;
  lastExportedNachaId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row from GET /api/vendors/:id/scheduled-job-runs */
interface VendorScheduledJobRunRow {
  vendorScheduledJobRunId: string;
  vendorId: string;
  vendorScheduledJobId: string | null;
  jobType: string;
  triggerSource: string;
  ranAt: string;
  success: boolean;
  exportSkipped: boolean;
  recordCount: number | null;
  fileName: string | null;
  eligibilityExportFileId?: string | null;
  tenants: Array<{ tenantId: string; tenantName: string }>;
  errorMessage: string | null;
  hasDownloadableFile: boolean;
  nachaId?: string | null;
}

const scheduledJobTypeLabel = (jobType: string) => {
  if (jobType === 'payables_export') return 'Payables export';
  if (jobType === 'eligibility_export') return 'Eligibility export';
  if (jobType === 'new_group_form') return 'New group form';
  if (jobType === 'asa_signed') return 'ASA signed';
  return jobType;
};

/** e.g. 1 → "1st", 31 → "31st" (for schedule summary copy) */
const dayOfMonthOrdinal = (n: number): string => {
  const d = Math.floor(n);
  if (d < 1 || d > 31) return `${n}`;
  const j = d % 10;
  const k = d % 100;
  if (k >= 11 && k <= 13) return `${d}th`;
  if (j === 1) return `${d}st`;
  if (j === 2) return `${d}nd`;
  if (j === 3) return `${d}rd`;
  return `${d}th`;
};

/** SFTP folder when the job has no path override (matches backend vendorExportService). */
const getVendorDefaultSftpPathForScheduledJob = (
  vendor: Vendor | null | undefined,
  jobType: string
): string => {
  if (!vendor) return '';
  const base = (vendor.SftpPath || '').trim();
  if (jobType === 'payables_export') {
    const n = (vendor.SftpPathNacha || '').trim();
    return n || base;
  }
  const e = (vendor.SftpPathEligibility || '').trim();
  return e || base;
};

interface VendorDashboard {
  productCount: number;
  totalSales: number;
  pendingPayments: number;
  lastPaymentDate?: string;
  totalPaymentsYTD: number;
}

interface VendorProduct {
  ProductId: string;
  ProductName: string;
  ProductType: string;
  SalesType?: string;
  Price: number;
  Status: string;
  IsVendorPrice?: boolean;
  VendorCommission?: number;
}

interface VendorPayment {
  PaymentId: string;
  Amount: number;
  PaymentDate: string;
  Status: 'Pending' | 'Completed' | 'Failed';
  ReferenceNumber?: string;
}

interface VendorNavigationPage {
  vendorNavigationPageId: string;
  vendorId: string;
  tenantId?: string | null;
  tenantName?: string | null;
  routeKey: string;
  label: string;
  description?: string | null;
  iconName?: string | null;
  contentType: 'markdown' | 'static_html' | 'iframe' | 'component';
  contentRef: string;
  visibilityRule?: string | null;
  sortOrder: number;
  published: boolean;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  createdDate?: string;
  modifiedDate?: string;
}

interface VendorNavigationPageForm {
  vendorNavigationPageId?: string;
  label: string;
  routeKey: string;
  contentType: VendorNavigationPage['contentType'];
  contentRef: string;
  description: string;
  iconName: string;
  sortOrder: number;
  published: boolean;
  tenantScope: 'all' | 'specific';
  tenantId?: string;
  effectiveDate?: string;
  expirationDate?: string;
  visibilityRule: string;
}

type AchAccountType = 'Checking' | 'Savings';

interface VendorAchAccount {
  achAccountId?: string;
  accountHolderName: string;
  bankName?: string | null;
  companyIdentification?: string | null;
  accountType: AchAccountType;
  status?: 'Active' | 'Inactive' | 'Pending';
  isDefault: boolean;
  distributionPercentage: number;
  accountNumberLast4?: string | null;
  maskedRoutingNumber?: string | null;
  /** Full routing number (returned for admin view/edit) */
  routingNumber?: string | null;
  /** Full account number (returned for admin view/edit) */
  accountNumber?: string | null;
  createdDate?: string;
  modifiedDate?: string;
}

interface VendorAchAccountForm extends VendorAchAccount {
  tempId: string;
  routingNumber?: string;
  accountNumber?: string;
  updateSensitive?: boolean;
  companyIdentification?: string;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`vendor-tabpanel-${index}`}
      aria-labelledby={`vendor-tab-${index}`}
      {...other}
    >
      {value === index && <Box>{children}</Box>}
    </div>
  );
}

// Utility functions
const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
};

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString('en-US');
};

// Format state name from all caps to proper case
const formatStateName = (name: string): string => {
  return name.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const NAV_CONTENT_TYPES = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'static_html', label: 'Static HTML' },
  { value: 'iframe', label: 'iFrame' },
  { value: 'component', label: 'Component' },
];

const DEFAULT_VISIBILITY_RULE = JSON.stringify(
  {
    requiresActiveEnrollment: true,
    productIds: [],
    bundleProductIds: [],
  },
  null,
  2
);

const formatDateInputValue = (value?: string | null) => {
  if (!value) return '';
  return value.slice(0, 10);
};

const slugifyRouteKey = (value: string) => {
  return value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
};

const createEmptyNavigationPageForm = (): VendorNavigationPageForm => ({
  label: '',
  routeKey: '',
  contentType: 'markdown',
  contentRef: '',
  description: '',
  iconName: '',
  sortOrder: 0,
  published: true,
  tenantScope: 'all',
  tenantId: '',
  effectiveDate: '',
  expirationDate: '',
  visibilityRule: DEFAULT_VISIBILITY_RULE,
});

const mapNavigationPageToForm = (page: VendorNavigationPage): VendorNavigationPageForm => ({
  vendorNavigationPageId: page.vendorNavigationPageId,
  label: page.label,
  routeKey: page.routeKey,
  contentType: page.contentType,
  contentRef: page.contentRef,
  description: page.description || '',
  iconName: page.iconName || '',
  sortOrder: page.sortOrder ?? 0,
  published: page.published,
  tenantScope: page.tenantId ? 'specific' : 'all',
  tenantId: page.tenantId || '',
  effectiveDate: formatDateInputValue(page.effectiveDate),
  expirationDate: formatDateInputValue(page.expirationDate),
  visibilityRule: page.visibilityRule
    ? (() => {
        try {
          const parsed = JSON.parse(page.visibilityRule);
          return JSON.stringify(parsed, null, 2);
        } catch {
          return page.visibilityRule;
        }
      })()
    : DEFAULT_VISIBILITY_RULE,
});

export interface VendorsProps {
  mode?: 'list' | 'detail';
  routeVendorId?: string;
  /**
   * Where this page is being rendered from. 'admin' is the SysAdmin experience
   * at /admin/vendors(+/:id). 'vendor' is the vendor-portal self-settings page
   * at /vendor/settings — list mode and admin-only actions (delete vendor,
   * create vendor, "Back to Vendors") are hidden in that mode.
   */
  portal?: 'admin' | 'vendor';
}

/** Row for the Signed ASAs tab (ported from VendorSettings.tsx). */
interface SignedAsaRow {
  signedAgreementId: string;
  groupId: string;
  groupName: string;
  productId: string;
  productName: string;
  signedByName: string;
  signedByEmail: string;
  signedDate: string | null;
  hasSignedPdf: boolean;
  lastEmailedDate: string | null;
  lastEmailedTo: string | null;
  emailSendCount: number;
  lastEmailAttemptDate: string | null;
  lastEmailError: string | null;
  /**
   * True when the group has at least one currently-active enrollment.
   * Surfaced in the row badge and used by the active-enrollment filter.
   * ASAs with this set to false are skipped by the auto-trigger and any
   * bulk/manual send requests.
   */
  groupHasActiveEnrollments?: boolean;
}

const Vendors: React.FC<VendorsProps> = ({ mode = 'list', routeVendorId, portal = 'admin' }) => {
  const isVendorPortal = portal === 'vendor';
  const navigate = useNavigate();
  // State
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [detailLoading, setDetailLoading] = useState(mode === 'detail');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [currentFormTab, setCurrentFormTab] = useState(0); // Tab state for Add/Edit dialog
  const [vendorDashboard, setVendorDashboard] = useState<VendorDashboard | null>(null);
  const [vendorProducts, setVendorProducts] = useState<VendorProduct[]>([]);
  const [vendorPayments, setVendorPayments] = useState<VendorPayment[]>([]);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [editingProduct, setEditingProduct] = useState<VendorProduct | null>(null);
  const [vendorDocuments, setVendorDocuments] = useState<any[]>([]);
  const [originalVendorDocuments, setOriginalVendorDocuments] = useState<any[]>([]); // Track original documents for deletion tracking
  const [vendorNavigationPages, setVendorNavigationPages] = useState<VendorNavigationPage[]>([]);
  const [uploadingDocuments, setUploadingDocuments] = useState(false);
  const [achAccountsForm, setAchAccountsForm] = useState<VendorAchAccountForm[]>([]);
  const [achAccountsLoading, setAchAccountsLoading] = useState(false);
  const [achModalOpen, setAchModalOpen] = useState(false);
  const [achModalAccounts, setAchModalAccounts] = useState<VendorAchAccountForm[]>([]);
  const [achModalFieldErrors, setAchModalFieldErrors] = useState<Record<string, Record<string, string>>>({});
  const [achModalMode, setAchModalMode] = useState<'create' | 'edit' | null>(null);
  const [achModalTargetId, setAchModalTargetId] = useState<string | null>(null);
  const [savingAchAccounts, setSavingAchAccounts] = useState(false);
  const [navModalOpen, setNavModalOpen] = useState(false);
  const [navModalMode, setNavModalMode] = useState<'create' | 'edit'>('create');
  const [editingDocument, setEditingDocument] = useState<any | null>(null);
  // TPA Services state
  const [tenantTpaServices, setTenantTpaServices] = useState<any[]>([]);
  const [loadingTpaServices, setLoadingTpaServices] = useState(false);
  const [tenants, setTenants] = useState<any[]>([]);
  const [_loadingTenants, setLoadingTenants] = useState(false);
  const [tpaModalOpen, setTpaModalOpen] = useState(false);
  const [editingTpaTenant, setEditingTpaTenant] = useState<string | null>(null);
  const [tpaFormData, setTpaFormData] = useState<any>({
    tenantId: '',
    tpaClaimsProcessing: false,
    tpaEnrollmentManagement: false,
    tpaCustomerService: false,
    tpaMemberSupport: false,
    tpaReporting: false,
    tpaCompliance: false,
    tpaBillingCollections: false,
    tpaCobraAdministration: false,
    tpaCommissionsProcessing: false,
    tpaContactName: '',
    tpaContactEmail: '',
    tpaContactPhone: '',
    tpaPortalUrl: '',
    tpaNotes: '',
    tpaAchAccountId: ''
  });
  const [vendorAchAccounts, setVendorAchAccounts] = useState<any[]>([]);
  const [navModalForm, setNavModalForm] = useState<VendorNavigationPageForm>(createEmptyNavigationPageForm());
  const [navModalErrors, setNavModalErrors] = useState<Record<string, string>>({});
  const [navModalSubmitting, setNavModalSubmitting] = useState(false);
  // New Group Form (Edit Vendor dialog)
  const [newGroupFormTitle, setNewGroupFormTitle] = useState('');
  const [newGroupFormFields, setNewGroupFormFields] = useState<Array<{ key: string; label: string; systemVariable?: string; defaultValue?: string; fieldType?: 'field' | 'labelHeader' | 'includeAllVendorGroupIds'; attemptAutoGenerateVendorGroupIdsIfMissing?: boolean }>>([]);
  const [newGroupFormLoading, setNewGroupFormLoading] = useState(false);
  const [newGroupFormProductOptions, setNewGroupFormProductOptions] = useState<Array<{ productId: string; name: string; hasVendorGroupIdSetting: boolean }>>([]);
  const [newGroupFormProductTypes, setNewGroupFormProductTypes] = useState<Array<{ productType: string }>>([]);
  const [newGroupFormSaving, setNewGroupFormSaving] = useState(false);
  /** Admin vendor dialog: edit new group form config in a modal (replaces dedicated tab). */
  const [newGroupFormEditorModalOpen, setNewGroupFormEditorModalOpen] = useState(false);
  const [vendorGroupsListRows, setVendorGroupsListRows] = useState<
    Array<{
      groupId: string;
      groupName: string;
      hasFormHistory: boolean;
      vendorGroupIdsStatus: string;
      maxHouseholdsOnVendorProduct?: number;
      householdCount?: number;
      earliestEffectiveDate?: string | null;
      needsAttention?: boolean;
    }>
  >([]);
  const [vendorGroupsListTotal, setVendorGroupsListTotal] = useState(0);
  const [vendorGroupsListPage, setVendorGroupsListPage] = useState(1);
  const vendorGroupsListLimit = 25;
  const [vendorGroupsListLoading, setVendorGroupsListLoading] = useState(false);
  const [vendorGroupsSearchInput, setVendorGroupsSearchInput] = useState('');
  const [vendorGroupsSearch, setVendorGroupsSearch] = useState('');
  const [vendorGroupsFilterId, setVendorGroupsFilterId] = useState('');
  /** Filter the Groups tab list by active-enrollment count on vendor products. */
  // Default to 'active' so the table initially shows only groups with at least one
  // active enrollment. Operators can switch to All / No active enrollments via the
  // dropdown. Same default ships in the vendor portal listing for parity.
  const [vendorGroupsEnrollmentFilter, setVendorGroupsEnrollmentFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [vendorGroupsVendorIdsApplicable, setVendorGroupsVendorIdsApplicable] = useState(false);
  const [vendorGroupsDropdownOptions, setVendorGroupsDropdownOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [vendorGroupsDropdownLoading, setVendorGroupsDropdownLoading] = useState(false);
  const [vendorGroupsPdfLoadingId, setVendorGroupsPdfLoadingId] = useState<string | null>(null);
  const [vendorGroupsGenIdsLoadingId, setVendorGroupsGenIdsLoadingId] = useState<string | null>(null);
  const [newGroupFormModalGroup, setNewGroupFormModalGroup] = useState<{ groupId: string; groupName: string } | null>(null);

  // ============ Signed ASAs tab (ported from VendorSettings.tsx) ============
  const [signedAsasRows, setSignedAsasRows] = useState<SignedAsaRow[]>([]);
  const [signedAsasTotal, setSignedAsasTotal] = useState(0);
  const [signedAsasLoading, setSignedAsasLoading] = useState(false);
  const [signedAsasStatusFilter, setSignedAsasStatusFilter] = useState<'all' | 'unsent' | 'sent'>('all');
  /** Filter rows by whether the group has any currently-active enrollments. */
  const [signedAsasEnrollmentFilter, setSignedAsasEnrollmentFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [signedAsasSearchInput, setSignedAsasSearchInput] = useState('');
  const [signedAsasSearch, setSignedAsasSearch] = useState('');
  const [signedAsasPage, setSignedAsasPage] = useState(1);
  const signedAsasLimit = 25;
  const [signedAsasRecipientInput, setSignedAsasRecipientInput] = useState('');
  const [signedAsasRecipientEdited, setSignedAsasRecipientEdited] = useState(false);
  /** Resolved fallback recipients (vendor.Email + notification contacts) from the API. */
  const [signedAsasFallbackRecipients, setSignedAsasFallbackRecipients] = useState<string[]>([]);
  /** ASA-specific default list saved on oe.Vendors.AsaSignedEmailRecipients. */
  const [signedAsasDefaultInput, setSignedAsasDefaultInput] = useState('');
  const [signedAsasDefaultSaving, setSignedAsasDefaultSaving] = useState(false);
  /** Resolution source returned by the defaults endpoint: 'asa-specific' | 'fallback'. */
  const [signedAsasResolvedFrom, setSignedAsasResolvedFrom] = useState<'asa-specific' | 'fallback' | null>(null);
  const [signedAsaRowSending, setSignedAsaRowSending] = useState<Record<string, boolean>>({});
  const [signedAsaRowDownloading, setSignedAsaRowDownloading] = useState<Record<string, boolean>>({});
  const [signedAsasBulkLoading, setSignedAsasBulkLoading] = useState<'unsent' | 'all' | null>(null);
  const [signedAsasMessage, setSignedAsasMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [vendorScheduledJobs, setVendorScheduledJobs] = useState<VendorScheduledJobRow[]>([]);
  /** IANA zone used by the export scheduler for job wall-clock times (from API; matches VENDOR_EXPORT_SCHEDULE_TIMEZONE). */
  const [vendorScheduleTimezone, setVendorScheduleTimezone] = useState(DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ);
  const [loadingVendorScheduledJobs, setLoadingVendorScheduledJobs] = useState(false);
  const [scheduledJobModalOpen, setScheduledJobModalOpen] = useState(false);
  const [scheduledJobModalEditingId, setScheduledJobModalEditingId] = useState<string | null>(null);
  const [scheduledJobForm, setScheduledJobForm] = useState({
    jobType: 'eligibility_export',
    isEnabled: true,
    exportSchedule: 'daily' as 'daily' | 'weekly' | 'monthly',
    exportScheduleDay: 'Monday',
    exportScheduleDayOfMonth: 1,
    exportTrigger: 'schedule' as 'schedule' | 'nacha_generation' | 'asa_signed',
    exportScheduleTime: '09:00',
    emailRecipients: '',
    useVendorDefaultSftp: true,
    sftpPathOverride: '',
    generateVendorGroupIdsIfNeeded: false,
    excludeGroupsMissingVendorGroupId: false,
  });
  const [savingScheduledJob, setSavingScheduledJob] = useState(false);
  const [scheduledJobRunNowId, setScheduledJobRunNowId] = useState<string | null>(null);
  const [scheduledJobsSubTab, setScheduledJobsSubTab] = useState(0);
  const [vendorScheduledJobRuns, setVendorScheduledJobRuns] = useState<VendorScheduledJobRunRow[]>([]);
  const [loadingScheduledJobRuns, setLoadingScheduledJobRuns] = useState(false);
  const [runHistoryTenantFilter, setRunHistoryTenantFilter] = useState('');
  const [runHistoryJobFilter, setRunHistoryJobFilter] = useState('');
  /** Tenants linked to this vendor (same query as run TenantsJson) — loaded for filter even when there are no runs yet */
  const [vendorScheduledExportTenants, setVendorScheduledExportTenants] = useState<
    Array<{ tenantId: string; tenantName: string }>
  >([]);

  const runHistoryTenantDropdownOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of vendorScheduledExportTenants) {
      if (t.tenantId) {
        map.set(t.tenantId, (t.tenantName || '').trim() || t.tenantId);
      }
    }
    for (const run of vendorScheduledJobRuns) {
      for (const t of run.tenants || []) {
        if (t.tenantId) {
          const name = (t.tenantName || '').trim() || t.tenantId;
          if (!map.has(t.tenantId)) map.set(t.tenantId, name);
        }
      }
    }
    const sorted = [...map.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], undefined, { sensitivity: 'base' })
    );
    return [
      { id: 'all-tenants', label: 'All tenants', value: '' },
      ...sorted.map(([tid, name]) => ({ id: `tenant-opt-${tid}`, label: name, value: tid })),
    ];
  }, [vendorScheduledJobRuns, vendorScheduledExportTenants]);

  const runHistoryJobDropdownOptions = useMemo(() => {
    const tz = vendorScheduleTimezone || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ;
    const fromJobs = vendorScheduledJobs.map((j) => {
      const serverT = (j.exportScheduleTime || '').slice(0, 5);
      const localT = serverScheduleTimeToLocalInput(serverT, tz);
      const localPretty = formatLocalTimeLabel(localT);
      const at = localPretty || '—';
      const dom =
        j.exportSchedule === 'monthly' ? j.exportScheduleDayOfMonth ?? 1 : null;
      const trig = (j.exportTrigger || 'schedule').toLowerCase();
      const schedLabel =
        j.jobType === 'asa_signed' || trig === 'asa_signed'
          ? 'On ASA signed'
          : j.jobType === 'payables_export' && trig === 'nacha_generation'
          ? 'NACHA sent'
          : j.exportSchedule === 'monthly' && dom != null
            ? `monthly (day ${dom})`
            : j.exportSchedule || '—';
      const labelAt = j.jobType === 'asa_signed' || trig === 'asa_signed' ? '' : ` · ${at}`;
      return {
        id: j.vendorScheduledJobId,
        label: `${scheduledJobTypeLabel(j.jobType)} · ${schedLabel}${labelAt}`,
        value: j.vendorScheduledJobId,
      };
    });
    const hasLegacy = vendorScheduledJobRuns.some((r) => !r.vendorScheduledJobId);
    const opts: Array<{ id: string; label: string; value: string }> = [
      { id: 'all-jobs', label: 'All jobs', value: '' },
      ...fromJobs,
    ];
    if (hasLegacy) {
      opts.push({ id: 'legacy-run', label: 'Legacy (no scheduled job id)', value: '__legacy__' });
    }
    return opts;
  }, [vendorScheduledJobs, vendorScheduledJobRuns, vendorScheduleTimezone]);

  const filteredScheduledJobRuns = useMemo(() => {
    return vendorScheduledJobRuns.filter((run) => {
      if (runHistoryJobFilter) {
        if (runHistoryJobFilter === '__legacy__') {
          if (run.vendorScheduledJobId) return false;
        } else if (run.vendorScheduledJobId !== runHistoryJobFilter) {
          return false;
        }
      }
      if (runHistoryTenantFilter) {
        const ok = (run.tenants || []).some((t) => t.tenantId === runHistoryTenantFilter);
        if (!ok) return false;
      }
      return true;
    });
  }, [vendorScheduledJobRuns, runHistoryJobFilter, runHistoryTenantFilter]);

  const generateTempId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const sanitizeDigits = (value: string) => value.replace(/\D/g, '');

  const createEmptyAchAccount = (): VendorAchAccountForm => ({
    tempId: generateTempId(),
    accountHolderName: '',
    bankName: '',
    companyIdentification: '',
    accountType: 'Checking',
    isDefault: true,
    distributionPercentage: 100,
    routingNumber: '',
    accountNumber: '',
    accountNumberLast4: undefined,
    maskedRoutingNumber: undefined,
    updateSensitive: true,
    status: 'Active'
  });

  const mapApiAccountToForm = (account: VendorAchAccount): VendorAchAccountForm => ({
    tempId: account.achAccountId || generateTempId(),
    achAccountId: account.achAccountId,
    accountHolderName: account.accountHolderName || '',
    bankName: account.bankName || '',
    companyIdentification: account.companyIdentification || '',
    accountType: account.accountType || 'Checking',
    isDefault: !!account.isDefault,
    distributionPercentage: typeof account.distributionPercentage === 'number'
      ? account.distributionPercentage
      : Number(account.distributionPercentage) || 0,
    accountNumberLast4: account.accountNumberLast4 || undefined,
    maskedRoutingNumber: account.maskedRoutingNumber || undefined,
    routingNumber: account.routingNumber ?? '',
    accountNumber: account.accountNumber ?? '',
    updateSensitive: true,
    status: account.status || 'Active'
  });

  const calculateDistributionTotal = (accounts: VendorAchAccountForm[]) =>
    accounts.reduce((sum, account) => {
      if ((account.status || 'Active') === 'Inactive') {
        return sum;
      }
      return sum + (Number(account.distributionPercentage) || 0);
    }, 0);

  const getPaymentStatusClasses = (status: VendorPayment['Status']) => {
    switch (status) {
      case 'Completed':
        return 'bg-green-100 text-green-700';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-700';
      case 'Failed':
      default:
        return 'bg-red-100 text-red-700';
    }
  };

const displayAccountNumber = (account: VendorAchAccount | VendorAchAccountForm): string => {
  if ('accountNumber' in account && account.accountNumber) {
    return account.accountNumber;
  }
  if ('accountNumberLast4' in account && account.accountNumberLast4) {
    return `••••${account.accountNumberLast4}`;
  }
  const digits = sanitizeDigits((account as VendorAchAccountForm).accountNumber || '');
  if (digits.length >= 4) {
    return `••••${digits.slice(-4)}`;
  }
  return 'Pending';
};

const displayRoutingNumber = (account: VendorAchAccount | VendorAchAccountForm): string => {
  if ('routingNumber' in account && account.routingNumber) {
    return account.routingNumber;
  }
  if ('maskedRoutingNumber' in account && account.maskedRoutingNumber) {
    return account.maskedRoutingNumber;
  }
  const digits = sanitizeDigits((account as VendorAchAccountForm).routingNumber || '');
  if (digits.length === 9) {
    return `••••${digits.slice(-4)}`;
  }
  return 'Pending';
};

  const clearModalFieldError = (tempId: string, field: string) => {
    setAchModalFieldErrors((prev) => {
      if (!prev[tempId]) return prev;
      const next = { ...prev };
      const fieldErrors = { ...next[tempId] };
      delete fieldErrors[field];
      if (Object.keys(fieldErrors).length === 0) {
        delete next[tempId];
      } else {
        next[tempId] = fieldErrors;
      }
      return next;
    });
  };

  const handleModalAccountHolderChange = (tempId: string, value: string) => {
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, accountHolderName: value } : account
      )
    );
    clearModalFieldError(tempId, 'accountHolderName');
  };

  const handleModalBankNameChange = (tempId: string, value: string) => {
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, bankName: value } : account
      )
    );
  };

  const handleModalCompanyIdentificationChange = (tempId: string, value: string) => {
    const digits = sanitizeDigits(value).slice(0, 10);
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, companyIdentification: digits } : account
      )
    );
    clearModalFieldError(tempId, 'companyIdentification');
  };

  const handleModalAccountTypeChange = (tempId: string, value: AchAccountType) => {
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, accountType: value === 'Savings' ? 'Savings' : 'Checking' } : account
      )
    );
  };

  const handleModalDistributionChange = (tempId: string, value: string) => {
    const sanitized = value === '' ? NaN : Number(value);
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, distributionPercentage: sanitized } : account
      )
    );
    clearModalFieldError(tempId, 'distributionPercentage');
  };

  const handleModalRoutingNumberChange = (tempId: string, value: string) => {
    const digits = sanitizeDigits(value).slice(0, 9);
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, routingNumber: digits } : account
      )
    );
    clearModalFieldError(tempId, 'routingNumber');
  };

  const handleModalAccountNumberChange = (tempId: string, value: string) => {
    const digits = sanitizeDigits(value).slice(0, 17);
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, accountNumber: digits } : account
      )
    );
    clearModalFieldError(tempId, 'accountNumber');
  };

  const handleModalDefaultChange = (tempId: string, isDefault: boolean) => {
    setAchModalAccounts((prev) =>
      prev.map((account) => ({
        ...account,
        isDefault: account.tempId === tempId ? isDefault : false
      }))
    );
  };

  const handleOpenAchModal = async (options?: { addNew?: boolean; editId?: string }) => {
    const { addNew = false, editId } = options || {};

    if (addNew) {
      const currentTotal = calculateDistributionTotal(achAccountsForm);
      const newAccount = createEmptyAchAccount();
      newAccount.distributionPercentage =
        achAccountsForm.length === 0 ? 100 : Math.max(0, Number((100 - currentTotal).toFixed(2)));
      newAccount.isDefault = achAccountsForm.length === 0;

      setAchModalMode('create');
      setAchModalTargetId(null);
      setAchModalAccounts([newAccount]);
      setAchModalFieldErrors({});
      setAchModalOpen(true);
      return;
    }

    if (editId) {
      // Re-fetch ACH accounts so we have fresh routingNumber/accountNumber from API for pre-fill
      let existing = achAccountsForm.find((account) => account.tempId === editId || account.achAccountId === editId);
      if (selectedVendor?.Id) {
        try {
          const response = await axiosInstance.get(`/api/vendors/${selectedVendor.Id}/ach-accounts`);
          if (response.data?.success && Array.isArray(response.data.data)) {
            const fresh = response.data.data.find((acc: VendorAchAccount) => acc.achAccountId === editId || (acc as any).tempId === editId);
            if (fresh) existing = mapApiAccountToForm(fresh);
          }
        } catch (e) {
          console.error('Error re-fetching ACH accounts for edit:', e);
        }
      }
      if (!existing) return;

      setAchModalMode('edit');
      setAchModalTargetId(editId);
      setAchModalAccounts([{ ...existing }]);
      setAchModalFieldErrors({});
      setAchModalOpen(true);
      return;
    }
  };

  const handleRemoveAccount = async (tempId: string) => {
    if (!selectedVendor) return;

    const accountToDelete = achAccountsForm.find(acc => acc.tempId === tempId);
    if (!accountToDelete) return;

    try {
      // Remove account from list
      const remainingAccounts = achAccountsForm.filter(acc => acc.tempId !== tempId);

      // If we deleted the default, make first remaining account default
      if (accountToDelete.isDefault && remainingAccounts.length > 0) {
        remainingAccounts[0].isDefault = true;
      }

      // NOTE: Distribution percentage validation (100% total) has been disabled per user request.
      // Validation should be handled at the parent "Edit Vendor" window level if needed.
      // Removed validation that checked total > 100.01

      // Build payload - send all remaining accounts (backend will deactivate the one not in the list)
      const payload = remainingAccounts.map((acc) => {
        const accountPayload: any = {
          achAccountId: acc.achAccountId,
          accountHolderName: acc.accountHolderName.trim(),
          bankName: acc.bankName?.trim() || null,
          companyIdentification: sanitizeDigits(acc.companyIdentification || '') || null,
          accountType: acc.accountType,
          distributionPercentage: Number(acc.distributionPercentage) || 0,
          isDefault: acc.isDefault,
          status: acc.status || 'Active'
        };
        // Don't include routingNumber/accountNumber - we're not updating sensitive data
        return accountPayload;
      });

      console.log('Deleting ACH account, payload:', payload);
      const response = await axiosInstance.put(`/api/vendors/${selectedVendor.Id}/ach-accounts`, {
        accounts: payload
      });

      if (response.data.success) {
        await loadAchAccountsForForm(selectedVendor.Id);
        showSnackbar('ACH account deleted successfully', 'success');
      } else {
        alert(response.data.message || 'Failed to delete ACH account');
      }
    } catch (error: any) {
      console.error('Error deleting ACH account:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to delete ACH account';
      alert(errorMessage);
    }
  };

  const handleCloseAchModal = () => {
    setAchModalOpen(false);
    setAchModalFieldErrors({});
    setAchModalMode(null);
    setAchModalTargetId(null);
  };

  const validateAchAccounts = (accounts: VendorAchAccountForm[]) => {
    const fieldErrors: Record<string, Record<string, string>> = {};

    accounts.forEach((account) => {
      const errors: Record<string, string> = {};
      if (!account.accountHolderName.trim()) {
        errors.accountHolderName = 'Account holder name is required';
      }

      const companyIdDigits = sanitizeDigits(account.companyIdentification || '');
      if (companyIdDigits.length > 0 && companyIdDigits.length !== 10) {
        errors.companyIdentification = 'Company Identification must be exactly 10 digits';
      }

      const distribution = Number(account.distributionPercentage);
      if (Number.isNaN(distribution)) {
        errors.distributionPercentage = 'Enter a valid percentage';
      } else if (distribution < 0 || distribution > 100) {
        errors.distributionPercentage = 'Value must be between 0 and 100';
      }

      if (!account.achAccountId || account.updateSensitive) {
        const routingDigits = sanitizeDigits(account.routingNumber || '');
        if (routingDigits.length !== 9) {
          errors.routingNumber = 'Routing number must be 9 digits';
        }

        const accountDigits = sanitizeDigits(account.accountNumber || '');
        if (accountDigits.length < 4 || accountDigits.length > 17) {
          errors.accountNumber = 'Account number must be 4-17 digits';
        }
      }

      if (Object.keys(errors).length > 0) {
        fieldErrors[account.tempId] = errors;
      }
    });

    // NOTE: Distribution percentage validation (100% total) has been disabled per user request.
    // Validation should be handled at the parent "Edit Vendor" window level if needed.
    // Removed validation that checked combinedTotal > 100.01

    return {
      isValid: Object.keys(fieldErrors).length === 0,
      fieldErrors
    };
  };

  const handleSaveAchModal = async () => {
    // Prevent double-clicks
    if (savingAchAccounts) {
      return;
    }

    const { isValid, fieldErrors } = validateAchAccounts(achModalAccounts);
    setAchModalFieldErrors(fieldErrors);

    if (!isValid || achModalMode === null || !selectedVendor) {
      return;
    }

    setSavingAchAccounts(true);
    try {
      // Build all accounts array
      let allAccounts: VendorAchAccountForm[];
      
      if (achModalMode === 'create') {
        // Add new account to existing
        allAccounts = [...achAccountsForm, ...achModalAccounts.map((account) => ({ ...account }))];
      } else {
        // Update existing account
        const updatedAccount = achModalAccounts[0];
        allAccounts = achAccountsForm.map(acc => 
          acc.tempId === achModalTargetId
            ? { ...updatedAccount, tempId: achModalTargetId }
            : { ...acc, isDefault: updatedAccount.isDefault ? false : acc.isDefault }
        );
      }

      // Ensure exactly one default account
      const defaultCount = allAccounts.filter(acc => acc.isDefault).length;
      if (defaultCount === 0 && allAccounts.length > 0) {
        allAccounts[0].isDefault = true;
      } else if (defaultCount > 1) {
        // Keep only the first default, unset others
        let foundFirst = false;
        allAccounts = allAccounts.map(acc => {
          if (acc.isDefault && !foundFirst) {
            foundFirst = true;
            return acc;
          }
          return { ...acc, isDefault: false };
        });
      }

      // NOTE: Distribution percentage validation (100% total) has been disabled per user request.
      // Validation should be handled at the parent "Edit Vendor" window level if needed.
      // Removed validation that checked total > 100.01

      // Build payload
      // For existing accounts not being edited, preserve their data without sensitive fields
      // For new accounts or accounts being edited with updateSensitive=true, include sensitive fields
      const payload = allAccounts.map((account) => {
        const isNewAccount = !account.achAccountId;
        const isBeingEdited = achModalMode === 'edit' && account.tempId === achModalTargetId;
        const modalAccount = isBeingEdited || isNewAccount 
          ? achModalAccounts.find(ma => ma.tempId === account.tempId)
          : null;
        
        const requiresSensitiveUpdate = isNewAccount || (modalAccount?.updateSensitive === true);

        const routingDigits = requiresSensitiveUpdate && modalAccount
          ? sanitizeDigits(modalAccount.routingNumber || '')
          : '';
        const accountDigits = requiresSensitiveUpdate && modalAccount
          ? sanitizeDigits(modalAccount.accountNumber || '')
          : '';

        return {
          achAccountId: account.achAccountId,
          accountHolderName: account.accountHolderName.trim(),
          bankName: account.bankName?.trim() || null,
          companyIdentification: sanitizeDigits(account.companyIdentification || '') || null,
          accountType: account.accountType,
          distributionPercentage: Number(account.distributionPercentage) || 0,
          isDefault: account.isDefault,
          status: account.status || 'Active',
          routingNumber: requiresSensitiveUpdate && routingDigits ? routingDigits : undefined,
          accountNumber: requiresSensitiveUpdate && accountDigits ? accountDigits : undefined
        };
      });

      console.log('Saving ACH accounts payload:', payload);
      const response = await axiosInstance.put(`/api/vendors/${selectedVendor.Id}/ach-accounts`, {
        accounts: payload
      });

      if (response.data.success) {
        await loadAchAccountsForForm(selectedVendor.Id);
        setAchModalOpen(false);
        setAchModalMode(null);
        setAchModalTargetId(null);
        showSnackbar('ACH account saved successfully', 'success');
      } else {
        showSnackbar(response.data.message || 'Failed to save ACH accounts', 'error');
      }
    } catch (error: any) {
      console.error('Error saving ACH accounts:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to save ACH accounts';
      showSnackbar(errorMessage, 'error');
    } finally {
      setSavingAchAccounts(false);
    }
  };

  const modalDistributionTotal = useMemo(
    () => Math.round(calculateDistributionTotal(achModalAccounts) * 100) / 100,
    [achModalAccounts]
  );

  const summaryDistributionTotal = useMemo(
    () => Math.round(calculateDistributionTotal(achAccountsForm) * 100) / 100,
    [achAccountsForm]
  );

  const distributionWarning = achAccountsForm.length > 0 && Math.abs(summaryDistributionTotal - 100) > 0.01;

  
  // Search and pagination state
  const [searchTerm, setSearchTerm] = useState('');
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0
  });
  
  // Snackbar state
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'warning' | 'info';
  }>({
    open: false,
    message: '',
    severity: 'success',
  });
  
  // Form state
  const [formData, setFormData] = useState<Partial<Vendor>>({
    VendorName: '',
    AddressLine1: '',
    AddressLine2: '',
    City: '',
    State: '',
    Zip: '',
    ContactName: '',
    Phone: '',
    Email: '',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  
  // Password visibility state
  const [showSftpPassword, setShowSftpPassword] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);
  // Store actual decrypted passwords when showing
  const [actualSftpPassword, setActualSftpPassword] = useState<string | null>(null);
  const [actualApiToken, setActualApiToken] = useState<string | null>(null);
  // Sample CSV modal
  const [sampleCsvModalOpen, setSampleCsvModalOpen] = useState(false);
  const [sampleCsvMemberId, setSampleCsvMemberId] = useState<string | null>(null);
  const [sampleCsvMembers, setSampleCsvMembers] = useState<{ memberId: string; displayName: string; email: string }[]>([]);
  const [sampleCsvMembersLoading, setSampleCsvMembersLoading] = useState(false);
  const [sampleCsvGenerateLoading, setSampleCsvGenerateLoading] = useState(false);
  const [sampleCsvError, setSampleCsvError] = useState<string | null>(null);
  const [eligibilityAiChatOpen, setEligibilityAiChatOpen] = useState(false);
  // Eligibility export history modal
  const [eligibilityHistoryModalOpen, setEligibilityHistoryModalOpen] = useState(false);
  const [eligibilityFiles, setEligibilityFiles] = useState<{
    fileId: string; generatedAt: string; fileName: string; recordCount: number; sentAt: string | null;
    summary?: {
      totalFamilies: number; newCount: number; updatedCount: number; terminatedCount: number;
      groups?: {
        count: number;
        breakdown: Array<{
          groupNumber: string;
          groupName: string | null;
          masterGroupId: string;
          otherVendorGroupIds: Array<{ id: string; productType: string | null }>;
          total: number;
          enrolled: number;
          updated: number;
          terminated: number;
        }>;
      };
      individuals?: { total: number; enrolled: number; updated: number; terminated: number };
      /** Households dropped by per-run/per-job "exclude groups missing vendor group id" toggle. Zeroes when off. */
      excludedNoVendorGroupId?: { households: number; members: number; groups: number };
    };
    effectiveAsOfDate?: string | null;
  }[]>([]);
  const [eligibilityFilesLoading, setEligibilityFilesLoading] = useState(false);
  const [eligibilitySftpUploadFileId, setEligibilitySftpUploadFileId] = useState<string | null>(null);
  const [eligibilityGenerateLoading, setEligibilityGenerateLoading] = useState(false);
  const [eligibilityEffectiveAsOf, setEligibilityEffectiveAsOf] = useState<string>(() => eligibilityEffectiveAsOfPickerDefault(7));
  const [eligibilityVendorIndividualGroupId, setEligibilityVendorIndividualGroupId] = useState<string>('MVHD02');
  // Per-run override on the Generate dialog: drop households whose group has no master vendor
  // group ID assigned for this vendor (groups only — true individuals are unaffected).
  const [eligibilityExcludeGroupsMissingVgi, setEligibilityExcludeGroupsMissingVgi] = useState<boolean>(false);

  const eligibilityTemplateErrors = useMemo(
    () => getEligibilityTemplateErrors(formData.EligibilityRowTemplate),
    [formData.EligibilityRowTemplate]
  );

  const payablesTemplateErrors = useMemo(
    () => getEligibilityTemplateErrors(formData.PayablesRowTemplate),
    [formData.PayablesRowTemplate]
  );

  // Snackbar helper
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    setSnackbar({ open: true, message, severity });
  };

  const handleGenerateEligibilityFile = async (mode: 'changes' | 'full' | 'terminations' = 'changes') => {
    if (!selectedVendor) return;
    setEligibilityGenerateLoading(true);
    try {
      const templateUsesVendorIndividualGroupId = formData.EligibilityRowTemplate?.includes('VendorIndividualGroupId');
      const res = await axiosInstance.post(`/api/vendors/${selectedVendor.Id}/eligibility-export-generate`, {
        effectiveAsOf: eligibilityEffectiveAsOf || undefined,
        ...(templateUsesVendorIndividualGroupId && { eligibilityVendorIndividualGroupId: eligibilityVendorIndividualGroupId?.trim() || undefined }),
        excludeGroupsMissingVendorGroupId: eligibilityExcludeGroupsMissingVgi,
        ...(mode === 'full' && { forceFullExport: true }),
        ...(mode === 'terminations' && { forceTerminationsOnly: true }),
      });
      if (res.data.success) {
        setEligibilityFiles((prev) => [{ ...res.data.data, sentAt: res.data.data.sentAt || null, summary: res.data.data.summary, effectiveAsOfDate: res.data.data.effectiveAsOfDate }, ...prev]);
        const snackMsg = mode === 'full'
          ? 'Full eligibility file generated'
          : mode === 'terminations'
            ? 'Terminations eligibility file generated'
            : 'Eligibility file generated';
        showSnackbar(snackMsg, 'success');
      } else {
        showSnackbar(res.data.message || 'Generate failed', 'error');
      }
    } catch (e: any) {
      showSnackbar(e?.response?.data?.message || e?.message || 'Generate failed', 'error');
    } finally {
      setEligibilityGenerateLoading(false);
    }
  };

  const fetchVendorScheduledJobs = async (vendorId: string) => {
    setLoadingVendorScheduledJobs(true);
    try {
      const res = await axiosInstance.get(`/api/vendors/${vendorId}/scheduled-jobs`);
      if (res.data?.success) {
        setVendorScheduledJobs(res.data.data || []);
        const stz = (res.data as { scheduleTimezone?: string }).scheduleTimezone;
        if (stz && typeof stz === 'string') {
          setVendorScheduleTimezone(stz.trim() || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ);
        } else {
          setVendorScheduleTimezone(DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ);
        }
      } else {
        setVendorScheduledJobs([]);
        setVendorScheduleTimezone(DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ);
      }
    } catch (e: any) {
      setVendorScheduledJobs([]);
      setVendorScheduleTimezone(DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ);
      if (e?.response?.status === 503) {
        showSnackbar(
          e?.response?.data?.message || 'Scheduled jobs require the VendorScheduledJobs database table (run migration).',
          'warning'
        );
      }
    } finally {
      setLoadingVendorScheduledJobs(false);
    }
  };

  const fetchVendorScheduledExportTenants = async (vendorId: string) => {
    try {
      const res = await axiosInstance.get(`/api/vendors/${vendorId}/scheduled-export-tenants`);
      if (res.data?.success) {
        setVendorScheduledExportTenants(res.data.data || []);
      } else {
        setVendorScheduledExportTenants([]);
      }
    } catch {
      setVendorScheduledExportTenants([]);
    }
  };

  const normalizeScheduledJobRunRow = (raw: Record<string, unknown>): VendorScheduledJobRunRow => {
    const g = (a: string, b: string) => (raw[a] ?? raw[b]) as string | null | undefined;
    const gid = (a: string, b: string) => String(g(a, b) ?? '');
    return {
      vendorScheduledJobRunId: gid('vendorScheduledJobRunId', 'VendorScheduledJobRunId'),
      vendorId: gid('vendorId', 'VendorId'),
      vendorScheduledJobId: (g('vendorScheduledJobId', 'VendorScheduledJobId') as string | null) ?? null,
      jobType: String(g('jobType', 'JobType') ?? ''),
      triggerSource: String(g('triggerSource', 'TriggerSource') ?? ''),
      ranAt: String(g('ranAt', 'RanAt') ?? ''),
      success: !!(raw.success ?? raw.Success),
      exportSkipped: !!(raw.exportSkipped ?? raw.ExportSkipped),
      recordCount: (raw.recordCount ?? raw.RecordCount) as number | null,
      fileName: (g('fileName', 'FileName') as string | null) ?? null,
      eligibilityExportFileId: (g('eligibilityExportFileId', 'EligibilityExportFileId') as string | null) ?? null,
      tenants: Array.isArray(raw.tenants) ? raw.tenants : [],
      errorMessage: (g('errorMessage', 'ErrorMessage') as string | null) ?? null,
      hasDownloadableFile: !!(
        raw.hasDownloadableFile ??
        raw.EligibilityExportFileId ??
        raw.PayablesArtifactPath ??
        raw.eligibilityExportFileId ??
        raw.payablesArtifactPath
      ),
      nachaId: (g('nachaId', 'NACHAId') as string | null) ?? null
    };
  };

  const fetchVendorScheduledJobRuns = async (vendorId: string) => {
    setLoadingScheduledJobRuns(true);
    try {
      const res = await axiosInstance.get(`/api/vendors/${vendorId}/scheduled-job-runs?limit=200`);
      if (res.data?.success) {
        const rows = Array.isArray(res.data.data) ? res.data.data : [];
        setVendorScheduledJobRuns(rows.map((r: Record<string, unknown>) => normalizeScheduledJobRunRow(r)));
      } else {
        setVendorScheduledJobRuns([]);
      }
    } catch {
      setVendorScheduledJobRuns([]);
    } finally {
      setLoadingScheduledJobRuns(false);
    }
  };

  const refreshScheduledJobRunHistory = (vendorId: string) => {
    fetchVendorScheduledJobRuns(vendorId);
    fetchVendorScheduledExportTenants(vendorId);
  };

  const runScheduledJobNow = async (vendorId: string, jobId: string) => {
    setScheduledJobRunNowId(jobId);
    try {
      const res = await axiosInstance.post(`/api/vendors/${vendorId}/scheduled-jobs/${jobId}/run`);
      const data = res.data?.data as
        | {
            success?: boolean;
            message?: string;
            exportSkipped?: boolean;
            recordCount?: number;
            groupsProcessed?: number;
          }
        | undefined;
      const msg = typeof data?.message === 'string' ? data.message.trim() : '';
      const jobFailed = data && data.success === false;

      if (jobFailed) {
        showSnackbar(msg || 'Job failed', 'error');
      } else {
        const noWork =
          !!data &&
          (data.exportSkipped === true ||
            (typeof data.recordCount === 'number' && data.recordCount === 0) ||
            (typeof data.groupsProcessed === 'number' && data.groupsProcessed === 0));

        if (noWork) {
          showSnackbar(
            msg || 'Nothing needed for this job run (no file or email).',
            'info'
          );
        } else if (msg) {
          showSnackbar(msg, 'success');
        } else {
          showSnackbar(typeof res.data?.message === 'string' ? res.data.message : 'Job run completed', 'success');
        }
      }

      fetchVendorScheduledJobs(vendorId);
      refreshScheduledJobRunHistory(vendorId);
    } catch (e: any) {
      showSnackbar(e?.response?.data?.message || 'Run failed', 'error');
    } finally {
      setScheduledJobRunNowId(null);
    }
  };

  // Fetch vendors with search and pagination
  const fetchVendors = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
        sortBy: 'VendorName',
        sortOrder: 'ASC'
      });
      
      if (searchTerm.trim()) {
        params.append('search', searchTerm.trim());
      }
      
      const response = await axiosInstance.get(`/api/vendors?${params.toString()}`);
      console.log('Fetch vendors response:', response);
      if (response.data.success) {
        setVendors(response.data.data || []);
        if (response.data.pagination) {
          setPagination(response.data.pagination);
        }
      } else {
        console.error('Fetch vendors failed:', response.data);
        showSnackbar(response.data.message || 'Failed to fetch vendors', 'error');
      }
    } catch (error: any) {
      console.error('Error fetching vendors:', error);
      console.error('Error response:', error.response);
      console.error('Error message:', error.message);
      showSnackbar(
        `Failed to fetch vendors: ${error.response?.data?.message || error.message}`, 
        'error'
      );
    } finally {
      setLoading(false);
    }
  }, [searchTerm, pagination.page, pagination.limit]);

  // Fetch vendor dashboard data
  const fetchVendorDashboard = async (vendorId: string) => {
    try {
      console.log('Fetching vendor dashboard for:', vendorId);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/dashboard`);
      console.log('Dashboard response:', response);
      if (response.data.success) {
        setVendorDashboard(response.data.data);
      }
    } catch (error: any) {
      console.error('Error fetching vendor dashboard:', error);
      console.error('Error response:', error.response);
      console.error('Error details:', error.response?.data);
    }
  };

  // Fetch vendor products
  const fetchVendorProducts = async (vendorId: string) => {
    try {
      console.log('Fetching vendor products for:', vendorId);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/products`);
      console.log('Products response:', response);
      if (response.data.success) {
        setVendorProducts(response.data.data || []);
      }
    } catch (error: any) {
      console.error('Error fetching vendor products:', error);
      console.error('Error response:', error.response);
      console.error('Error details:', error.response?.data);
    }
  };

  // Fetch vendor payments
  const fetchVendorPayments = async (vendorId: string) => {
    try {
      console.log('Fetching vendor payments for:', vendorId);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/payments`);
      console.log('Payments response:', response);
      if (response.data.success) {
        setVendorPayments(response.data.data);
      }
    } catch (error: any) {
      console.error('Error fetching vendor payments:', error);
      console.error('Error response:', error.response);
      console.error('Error details:', error.response?.data);
    }
  };

  const loadAchAccountsForForm = async (vendorId: string) => {
    try {
      setAchAccountsLoading(true);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/ach-accounts`);
      if (response.data.success) {
        const accounts: VendorAchAccount[] = response.data.data || [];
        const formAccounts = accounts.length > 0 ? accounts.map(mapApiAccountToForm) : [];
        if (formAccounts.length > 0 && !formAccounts.some((account) => account.isDefault)) {
          formAccounts[0] = { ...formAccounts[0], isDefault: true };
        }
        setAchAccountsForm(formAccounts);
      } else {
        setAchAccountsForm([]);
      }
    } catch (error) {
      console.error('Error loading vendor ACH accounts:', error);
      setAchAccountsForm([]);
    } finally {
      setAchAccountsLoading(false);
    }
  };

  // Fetch tenants for TPA Services
  const fetchTenants = async () => {
    try {
      setLoadingTenants(true);
      const response = await axiosInstance.get('/api/tenants?lightweight=true');
      if (response.data.success) {
        setTenants(response.data.data || []);
      } else {
        setTenants([]);
      }
    } catch (error) {
      console.error('Error fetching tenants:', error);
      setTenants([]);
    } finally {
      setLoadingTenants(false);
    }
  };

  // Fetch tenant TPA services for a vendor
  const fetchTenantTpaServices = async (vendorId: string) => {
    try {
      setLoadingTpaServices(true);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/tpa-services`);
      if (response.data.success) {
        setTenantTpaServices(response.data.data || []);
      } else {
        setTenantTpaServices([]);
      }
    } catch (error) {
      console.error('Error fetching tenant TPA services:', error);
      setTenantTpaServices([]);
    } finally {
      setLoadingTpaServices(false);
    }
  };

  // Fetch vendor ACH accounts for TPA Commissions Processing
  const fetchVendorAchAccountsForTpa = async (vendorId: string) => {
    try {
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/ach-accounts`);
      if (response.data.success) {
        setVendorAchAccounts(response.data.data || []);
      } else {
        setVendorAchAccounts([]);
      }
    } catch (error) {
      console.error('Error fetching vendor ACH accounts for TPA:', error);
      setVendorAchAccounts([]);
    }
  };

  // Open TPA Services modal for a tenant
  const handleOpenTpaModal = async (tenantId?: string) => {
    if (!selectedVendor) return;
    
    // Fetch tenants if not already loaded
    if (tenants.length === 0) {
      await fetchTenants();
    }
    
    // Fetch ACH accounts if not already loaded
    if (vendorAchAccounts.length === 0) {
      await fetchVendorAchAccountsForTpa(selectedVendor.Id);
    }
    
    if (tenantId) {
      // Edit existing configuration
      const existing = tenantTpaServices.find(t => t.TenantId === tenantId);
      if (existing) {
        setTpaFormData({
          tenantId: existing.TenantId,
          tpaClaimsProcessing: existing.TpaClaimsProcessing || false,
          tpaEnrollmentManagement: existing.TpaEnrollmentManagement || false,
          tpaCustomerService: existing.TpaCustomerService || false,
          tpaMemberSupport: existing.TpaMemberSupport || false,
          tpaReporting: existing.TpaReporting || false,
          tpaCompliance: existing.TpaCompliance || false,
          tpaBillingCollections: existing.TpaBillingCollections || false,
          tpaCobraAdministration: existing.TpaCobraAdministration || false,
          tpaCommissionsProcessing: existing.TpaCommissionsProcessing || false,
          tpaContactName: existing.TpaContactName || '',
          tpaContactEmail: existing.TpaContactEmail || '',
          tpaContactPhone: existing.TpaContactPhone || '',
          tpaPortalUrl: existing.TpaPortalUrl || '',
          tpaNotes: existing.TpaNotes || '',
          tpaAchAccountId: existing.TpaAchAccountId || ''
        });
        setEditingTpaTenant(tenantId);
      }
    } else {
      // Create new configuration
      setTpaFormData({
        tenantId: '',
        tpaClaimsProcessing: false,
        tpaEnrollmentManagement: false,
        tpaCustomerService: false,
        tpaMemberSupport: false,
        tpaReporting: false,
        tpaCompliance: false,
        tpaBillingCollections: false,
        tpaCobraAdministration: false,
        tpaCommissionsProcessing: false,
        tpaContactName: '',
        tpaContactEmail: '',
        tpaContactPhone: '',
        tpaPortalUrl: '',
        tpaNotes: '',
        tpaAchAccountId: ''
      });
      setEditingTpaTenant(null);
    }
    setTpaModalOpen(true);
  };

  // Save TPA Services configuration
  const handleSaveTpaServices = async () => {
    if (!selectedVendor || !tpaFormData.tenantId) {
      showSnackbar('Please select a tenant', 'error');
      return;
    }

    // Validate: If Commissions Processing is enabled, ACH Account is required
    if (tpaFormData.tpaCommissionsProcessing && !tpaFormData.tpaAchAccountId) {
      showSnackbar('ACH Account is required when Commissions Processing is enabled', 'error');
      return;
    }

    try {
      const response = await axiosInstance.post(
        `/api/vendors/${selectedVendor.Id}/tpa-services`,
        tpaFormData
      );

      if (response.data.success) {
        showSnackbar(
          editingTpaTenant ? 'TPA services updated successfully' : 'TPA services created successfully',
          'success'
        );
        setTpaModalOpen(false);
        await fetchTenantTpaServices(selectedVendor.Id);
      } else {
        showSnackbar(response.data.message || 'Failed to save TPA services', 'error');
      }
    } catch (error: any) {
      console.error('Error saving TPA services:', error);
      showSnackbar(
        error.response?.data?.message || 'Failed to save TPA services',
        'error'
      );
    }
  };

  const uploadProductAsset = async (file: File, type: 'images' | 'logos' | 'documents') => {
    if (!selectedVendor) {
      throw new Error('Select a vendor before uploading assets');
    }

    const formData = new FormData();
    formData.append('files', file);
    formData.append('uploadType', 'products');
    formData.append('entityId', selectedVendor.Id);
    formData.append('fileType', type);

    const result = await apiService.post<{
      success: boolean;
      url?: string;
      data?: Array<{ url: string }>;
      message?: string;
    }>('/api/uploads', formData);

    if (!result.success) {
      const message = result?.message || 'Upload failed';
      throw new Error(message);
    }

    return result.url || (Array.isArray(result.data) ? result.data[0]?.url : null);
  };

  const fetchVendorNavigationPages = async (vendorId: string) => {
    try {
      console.log('Fetching vendor navigation pages for vendor:', vendorId);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/navigation-pages`);
      console.log('Vendor navigation response:', response);
      if (response.data.success) {
        setVendorNavigationPages(response.data.data || []);
      } else {
        setVendorNavigationPages([]);
      }
    } catch (error: any) {
      console.error('Error fetching vendor navigation pages:', error);
      console.error('Error response:', error.response);
      console.error('Error details:', error.response?.data);
      setVendorNavigationPages([]);
    }
  };

  // Search handler
  const handleSearch = (value: string) => {
    setSearchTerm(value);
    setPagination(prev => ({ ...prev, page: 1 })); // Reset to first page on search
  };

  // Pagination handlers
  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handleLimitChange = (newLimit: number) => {
    setPagination(prev => ({ ...prev, limit: newLimit, page: 1 }));
  };

  useEffect(() => {
    if (mode !== 'list') return;
    // Test API connection
    console.log('Testing API connection...');
    console.log('Current URL:', window.location.href);
    console.log('API_CONFIG.BASE_URL:', API_CONFIG.BASE_URL);
    console.log('Token in localStorage:', localStorage.getItem('token'));
    console.log('AccessToken in localStorage:', localStorage.getItem('accessToken'));
    
    fetchVendors();
  }, [fetchVendors, mode]);

  // Fetch tenants and TPA services when Advanced (TPA) tab is opened
  useEffect(() => {
    if (currentFormTab === 8 && selectedVendor) {
      fetchTenants();
      fetchTenantTpaServices(selectedVendor.Id);
      fetchVendorAchAccountsForTpa(selectedVendor.Id);
    }
  }, [currentFormTab, selectedVendor]);

  // Scheduled jobs list (Scheduled jobs tab)
  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 7) {
      fetchVendorScheduledJobs(selectedVendor.Id);
    }
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 7 && scheduledJobsSubTab === 1) {
      refreshScheduledJobRunHistory(selectedVendor.Id);
    }
  }, [currentFormTab, selectedVendor, scheduledJobsSubTab]);

  useEffect(() => {
    setRunHistoryTenantFilter('');
    setRunHistoryJobFilter('');
    setVendorScheduledExportTenants([]);
  }, [selectedVendor?.Id]);

  const loadNewGroupFormForEdit = async (vendorId: string) => {
    setNewGroupFormLoading(true);
    try {
      const [configRes, productOptionsRes] = await Promise.all([
        axiosInstance.get(`/api/vendors/${vendorId}/new-group-form`),
        axiosInstance.get(`/api/vendors/${vendorId}/new-group-form-product-options`).catch(() => ({ data: { success: false, data: { products: [] } } }))
      ]);
      const res = configRes;
      if (res.data?.success && res.data?.data) {
        const d = res.data.data;
        setNewGroupFormTitle(d.formTitle ?? '');
        setNewGroupFormFields(Array.isArray(d.fields) ? d.fields.map((f: any) => ({
          key: f.key ?? f.label ?? '',
          label: f.label ?? f.key ?? '',
          systemVariable: f.key === 'agentSignature' ? '__agentSignature__' : f.key === 'groupAdminSignature' ? '__groupAdminSignature__' : (f.systemVariable ?? ''),
          defaultValue: f.defaultValue ?? '',
          fieldType: f.fieldType || 'field',
          ...(f.attemptAutoGenerateVendorGroupIdsIfMissing === true ? { attemptAutoGenerateVendorGroupIdsIfMissing: true } : {})
        })) : []);
      } else {
        setNewGroupFormTitle('');
        setNewGroupFormFields([]);
      }
      if (productOptionsRes?.data?.success && productOptionsRes?.data?.data?.products) {
        setNewGroupFormProductOptions(productOptionsRes.data.data.products);
      } else {
        setNewGroupFormProductOptions([]);
      }
      if (productOptionsRes?.data?.success && productOptionsRes?.data?.data?.productTypes) {
        setNewGroupFormProductTypes(productOptionsRes.data.data.productTypes);
      } else {
        setNewGroupFormProductTypes([]);
      }
    } catch (e) {
      console.error('Error loading new group form config:', e);
      setNewGroupFormTitle('');
      setNewGroupFormFields([]);
      setNewGroupFormProductOptions([]);
      setNewGroupFormProductTypes([]);
    } finally {
      setNewGroupFormLoading(false);
    }
  };

  const loadVendorGroupsList = useCallback(async () => {
    if (!selectedVendor?.Id) return;
    setVendorGroupsListLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(vendorGroupsListPage),
        limit: String(vendorGroupsListLimit),
      });
      if (vendorGroupsSearch.trim()) params.set('search', vendorGroupsSearch.trim());
      if (vendorGroupsFilterId.trim()) params.set('groupId', vendorGroupsFilterId.trim());
      if (vendorGroupsEnrollmentFilter !== 'all') params.set('enrollmentFilter', vendorGroupsEnrollmentFilter);
      const res = await axiosInstance.get<{
        success: boolean;
        data?: {
          groups?: Array<{
            groupId: string;
            groupName: string;
            hasFormHistory: boolean;
            vendorGroupIdsStatus: string;
            maxHouseholdsOnVendorProduct?: number;
            householdCount?: number;
            earliestEffectiveDate?: string | null;
            needsAttention?: boolean;
          }>;
          total?: number;
          vendorIdsApplicable?: boolean;
        };
      }>(`/api/vendors/${selectedVendor.Id}/served-groups?${params.toString()}`);
      if (res.data?.success && res.data.data) {
        setVendorGroupsListRows(Array.isArray(res.data.data.groups) ? res.data.data.groups : []);
        setVendorGroupsListTotal(typeof res.data.data.total === 'number' ? res.data.data.total : 0);
        setVendorGroupsVendorIdsApplicable(!!res.data.data.vendorIdsApplicable);
      }
    } catch (e) {
      console.error('Error loading vendor groups list:', e);
      setVendorGroupsListRows([]);
      setVendorGroupsListTotal(0);
    } finally {
      setVendorGroupsListLoading(false);
    }
  }, [
    selectedVendor?.Id,
    vendorGroupsListPage,
    vendorGroupsSearch,
    vendorGroupsFilterId,
    vendorGroupsEnrollmentFilter,
    vendorGroupsListLimit,
  ]);

  const fetchVendorGroupsDropdownOptions = useCallback(
    async (query: string) => {
      if (!selectedVendor?.Id) return;
      setVendorGroupsDropdownLoading(true);
      try {
        const params = new URLSearchParams({ page: '1', limit: '50' });
        if (query.trim()) params.set('search', query.trim());
        const res = await axiosInstance.get<{
          success: boolean;
          data?: { groups?: Array<{ groupId: string; groupName: string }> };
        }>(`/api/vendors/${selectedVendor.Id}/served-groups?${params.toString()}`);
        if (res.data?.success && res.data.data?.groups) {
          setVendorGroupsDropdownOptions(
            res.data.data.groups.map((g) => ({
              id: g.groupId,
              label: g.groupName,
              value: g.groupId,
            }))
          );
        } else {
          setVendorGroupsDropdownOptions([]);
        }
      } catch {
        setVendorGroupsDropdownOptions([]);
      } finally {
        setVendorGroupsDropdownLoading(false);
      }
    },
    [selectedVendor?.Id]
  );

  const handleVendorGroupPdf = useCallback(
    async (g: { groupId: string; groupName: string }) => {
      if (!selectedVendor?.Id) return;
      setVendorGroupsPdfLoadingId(g.groupId);
      try {
        const safe = (g.groupName || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
        await apiService.downloadFile(
          `/api/vendors/${selectedVendor.Id}/served-groups/${encodeURIComponent(g.groupId)}/new-group-form-pdf`,
          `NewGroupForm-${safe}.pdf`
        );
      } catch (e: unknown) {
        const err = e as { message?: string };
        console.error(e);
        showSnackbar(err?.message || 'Failed to download PDF', 'error');
      } finally {
        setVendorGroupsPdfLoadingId(null);
      }
    },
    [selectedVendor?.Id]
  );

  const handleVendorGroupGenerateIds = useCallback(
    async (g: { groupId: string; groupName: string }) => {
      if (!selectedVendor?.Id) return;
      setVendorGroupsGenIdsLoadingId(g.groupId);
      try {
        const res = await axiosInstance.post<{ success: boolean; message?: string }>(
          `/api/vendors/${selectedVendor.Id}/served-groups/${encodeURIComponent(g.groupId)}/generate-vendor-ids`,
          {}
        );
        if (res.data?.success) {
          showSnackbar(res.data.message || 'Vendor group IDs updated', 'success');
          await loadVendorGroupsList();
        } else {
          throw new Error(res.data?.message || 'Failed');
        }
      } catch (e: unknown) {
        const err = e as { response?: { data?: { message?: string } }; message?: string };
        showSnackbar(
          err?.response?.data?.message || err?.message || 'Failed to generate vendor group IDs',
          'error'
        );
      } finally {
        setVendorGroupsGenIdsLoadingId(null);
      }
    },
    [selectedVendor?.Id, loadVendorGroupsList]
  );

  // Bulk generate vendor group IDs for all groups matching the current
  // enrollment filter (default 'active') that don't yet have a group-level
  // Master ID. Mirrors per-group generate, just batched server-side.
  const [vendorGroupsBulkGenLoading, setVendorGroupsBulkGenLoading] = useState(false);
  const handleVendorGroupBulkGenerate = useCallback(async () => {
    if (!selectedVendor?.Id) return;
    const filterLabel = vendorGroupsEnrollmentFilter === 'active'
      ? 'with active enrollments'
      : vendorGroupsEnrollmentFilter === 'inactive'
        ? 'with no active enrollments'
        : '(all)';
    if (!window.confirm(`Generate vendor group IDs for all served groups ${filterLabel} that don't already have a Master ID?`)) {
      return;
    }
    setVendorGroupsBulkGenLoading(true);
    try {
      const res = await axiosInstance.post<{
        success: boolean;
        message?: string;
        data?: { groupsConsidered: number; groupsProcessed: number; totalIdsCreated: number; errors: Array<{ groupId: string; message: string }> };
      }>(`/api/vendors/${selectedVendor.Id}/served-groups/generate-vendor-ids-bulk`, {
        enrollmentFilter: vendorGroupsEnrollmentFilter,
      });
      if (res.data?.success) {
        const d = res.data.data;
        const errCount = d?.errors?.length || 0;
        const msg = res.data.message
          || `Generated IDs for ${d?.groupsProcessed || 0} group(s), ${d?.totalIdsCreated || 0} new IDs.`;
        showSnackbar(errCount ? `${msg} (${errCount} error(s))` : msg, errCount ? 'warning' : 'success');
        await loadVendorGroupsList();
      } else {
        throw new Error(res.data?.message || 'Failed');
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      showSnackbar(
        err?.response?.data?.message || err?.message || 'Failed to bulk generate vendor group IDs',
        'error'
      );
    } finally {
      setVendorGroupsBulkGenLoading(false);
    }
  }, [selectedVendor?.Id, vendorGroupsEnrollmentFilter, loadVendorGroupsList]);

  // Lazy-load tab data (vendor detail page / dialog)
  useEffect(() => {
    if (!selectedVendor) return;
    const vid = selectedVendor.Id;
    if (currentFormTab === 0) fetchVendorDashboard(vid);
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 1) fetchVendorProducts(selectedVendor.Id);
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 2) fetchVendorDocuments(selectedVendor.Id);
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 3) {
      fetchVendorPayments(selectedVendor.Id);
      loadAchAccountsForForm(selectedVendor.Id);
    }
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    if (!selectedVendor || !newGroupFormEditorModalOpen) return;
    loadNewGroupFormForEdit(selectedVendor.Id);
  }, [newGroupFormEditorModalOpen, selectedVendor?.Id]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 6) fetchVendorNavigationPages(selectedVendor.Id);
  }, [currentFormTab, selectedVendor]);

  useEffect(() => {
    const t = setTimeout(() => setVendorGroupsSearch(vendorGroupsSearchInput), 400);
    return () => clearTimeout(t);
  }, [vendorGroupsSearchInput]);

  useEffect(() => {
    setVendorGroupsListPage(1);
  }, [vendorGroupsSearch, vendorGroupsFilterId, vendorGroupsEnrollmentFilter]);

  useEffect(() => {
    if (!selectedVendor) return;
    if (currentFormTab === 4) {
      loadVendorGroupsList();
    }
  }, [currentFormTab, selectedVendor?.Id, loadVendorGroupsList]);

  useEffect(() => {
    if (!vendorGroupsFilterId || !selectedVendor) return;
    const row = vendorGroupsListRows.find((r) => r.groupId === vendorGroupsFilterId);
    if (row) {
      setVendorGroupsDropdownOptions((prev) => {
        if (prev.some((o) => o.value === row.groupId)) return prev;
        return [{ id: row.groupId, label: row.groupName, value: row.groupId }, ...prev];
      });
    }
  }, [vendorGroupsFilterId, vendorGroupsListRows, selectedVendor]);


  // Handle form submission (vendor core + integration fields + document sync). Stays in dialog unless closeOnSuccess.
  const handleSubmit = async (options?: { closeOnSuccess?: boolean }) => {
    console.log('🔵 handleSubmit called', { selectedVendor: !!selectedVendor, currentFormTab, achModalOpen });

    // Prevent submission if ACH modal is open
    if (achModalOpen) {
      console.warn('⚠️ Cannot save vendor while ACH modal is open');
      showSnackbar('Please close the ACH Account modal before saving the vendor', 'warning');
      return;
    }
    
    // Removed validation - no specific requirements to create/update vendor
    // ACH accounts are optional
    
    try {
      // Prepare the data - filter out empty strings and ensure proper structure
      const vendorData = {
        vendorName: formData.VendorName?.trim() || '',
        addressLine1: formData.AddressLine1?.trim() || null,
        addressLine2: formData.AddressLine2?.trim() || null,
        city: formData.City?.trim() || null,
        state: formData.State || null,
        zip: formData.Zip?.trim() || null,
        contactName: formData.ContactName?.trim() || null,
        phone: formData.Phone?.trim() || null,
        email: formData.Email?.trim() || null,
        // Integration Settings
        exportGroupIds: Array.isArray(formData.ExportGroupIds) && formData.ExportGroupIds.length > 0 
          ? JSON.stringify(formData.ExportGroupIds) 
          : null,
        groupIdPrefix: formData.GroupIdPrefix?.trim() || null,
        groupIdSeedNumber: formData.GroupIdSeedNumber || null,
        groupIdAffixPosition: formData.GroupIdAffixPosition || null,
        groupIdBetweenGroupsIncrement: formData.GroupIdBetweenGroupsIncrement != null
          ? Math.max(1, Number(formData.GroupIdBetweenGroupsIncrement))
          : null,
        autoGenerateVendorGroupIds: !!formData.AutoGenerateVendorGroupIds,
        sftpHostname: formData.SftpHostname?.trim() || null,
        sftpPort: formData.SftpPort || null,
        sftpUsername: formData.SftpUsername?.trim() || null,
        sftpPath: formData.SftpPath?.trim() || null,
        sftpPathNacha: formData.SftpPathNacha?.trim() || null,
        sftpPathEligibility: formData.SftpPathEligibility?.trim() || null,
        // Always send password: use actual password if available (fetched from backend), 
        // otherwise use formData if it's not masked, otherwise null
        sftpPassword: actualSftpPassword 
          ? actualSftpPassword.trim() 
          : (formData.SftpPassword && !/^[•\*]+$/.test(formData.SftpPassword)) 
            ? formData.SftpPassword.trim() 
            : null,
        exportEmailAddress: formData.ExportEmailAddress?.trim() || null,
        exportEmailEnabled: formData.ExportEmailEnabled || false,
        apiBaseUrl: formData.ApiBaseUrl?.trim() || null,
        // Always send token: use actual token if available (fetched from backend),
        // otherwise use formData if it's not masked, otherwise null
        apiToken: actualApiToken
          ? actualApiToken.trim()
          : (formData.ApiToken && !/^[•\*]+$/.test(formData.ApiToken))
            ? formData.ApiToken.trim()
            : null,
        apiEnabled: formData.ApiEnabled || false,
        exportSchedule: formData.ExportSchedule?.trim() || null,
        exportMethod: formData.ExportMethod?.trim() || null,
        exportScheduleDay: formData.ExportScheduleDay?.trim() || null,
        exportScheduleTime: formData.ExportScheduleTime?.trim() || null,
        exportFileFormat: formData.ExportFileFormat || 'CSV',
        exportFileNameTemplate: formData.ExportFileNameTemplate?.trim() || null,
        payablesExportFileNameTemplate: formData.PayablesExportFileNameTemplate?.trim() || null,
        exportRetryAttempts: formData.ExportRetryAttempts || null,
        exportRetryDelayMinutes: formData.ExportRetryDelayMinutes || null,
        exportCompressionEnabled: formData.ExportCompressionEnabled || false,
        exportEncryptionEnabled: formData.ExportEncryptionEnabled || false,
        eligibilityIncludeOnlyChanges: formData.EligibilityIncludeOnlyChanges !== false,
        eligibilityRowTemplate: formData.EligibilityRowTemplate?.trim() || null,
        eligibilityDateFormat: formData.EligibilityDateFormat?.trim() || 'ARM',
        eligibilityIntegrationPartner: formData.EligibilityIntegrationPartner?.trim() || null,
        eligibilityFutureEffectiveDays: formData.EligibilityFutureEffectiveDays != null ? Math.max(0, parseInt(String(formData.EligibilityFutureEffectiveDays), 10) || 0) : 7,
        // Send only additional vendor IDs (current vendor is always included by backend)
        eligibilityIncludeVendorIds: (formData.EligibilityIncludeVendorIds || []).filter((id) => id !== selectedVendor?.Id),
        eligibilityPrimaryExportGrain: formData.EligibilityPrimaryExportGrain === 'SinglePrimaryRow' ? 'SinglePrimaryRow' : 'PerProduct',
        payablesRowTemplate: formData.PayablesRowTemplate?.trim() || null,
        minimumEmployeesPerGroup: formData.MinimumEmployeesPerGroup ?? null,
        showShareRequestStatusToMembers: !!formData.ShowShareRequestStatusToMembers
        // ACH accounts are now saved immediately when edited, not on vendor form submission
      };
      
      console.log('Vendor data to submit:', vendorData);
      
      let vendorId: string;
      
      if (selectedVendor) {
        // Update vendor
        console.log('Updating vendor:', selectedVendor.Id);
        const response = await axiosInstance.put(`/api/vendors/${selectedVendor.Id}`, vendorData);
        console.log('Update response:', response);
        
        if (response.data.success) {
          vendorId = selectedVendor.Id;
          clearEligibilityAiChatSession(eligibilityAiChatStorageKey(selectedVendor.Id));
          showSnackbar('Vendor updated successfully', 'success');
        } else {
          throw new Error(response.data.message || 'Update failed');
        }
      } else {
        // Create vendor
        console.log('Creating new vendor with data:', vendorData);
        const response = await axiosInstance.post('/api/vendors', vendorData);
        console.log('Create response:', response);
        
        if (response.data.success) {
          vendorId = response.data.data.Id || response.data.data.id;
          showSnackbar('Vendor created successfully', 'success');
        } else {
          throw new Error(response.data.message || 'Create failed');
        }
      }
      
      // Handle documents: delete removed ones, upload new ones
      if (vendorId && selectedVendor) {
        // CRITICAL: Re-fetch current documents from API to ensure we have the latest state
        // This prevents accidental deletion if the state is stale or out of sync
        let currentDocsFromApi: any[] = [];
        try {
          const docsResponse = await axiosInstance.get(`/api/vendors/${vendorId}/documents`);
          if (docsResponse.data.success) {
            currentDocsFromApi = docsResponse.data.data || [];
            console.log('📄 Re-fetched documents from API before comparison:', currentDocsFromApi.length);
          }
        } catch (error: any) {
          console.error('⚠️ Warning: Could not re-fetch documents before comparison:', error);
          // Continue with state-based comparison as fallback, but log warning
        }

        // Use a promise to get the latest state
        const currentDocs = await new Promise<any[]>((resolve) => {
          setVendorDocuments(prev => {
            resolve(prev);
            return prev; // Don't change state, just read it
          });
        });

        // Use API-fetched documents if available, otherwise fall back to state
        const currentDocsForComparison = currentDocsFromApi.length > 0 ? currentDocsFromApi : currentDocs;
        const originalDocs = originalVendorDocuments;
        
        // Find documents that were removed (in original but not in current)
        // Only compare documents that have DocumentId (not local files)
        const currentDocIds = new Set(
          currentDocsForComparison
            .filter(doc => doc.DocumentId && !doc.isLocal)
            .map(doc => doc.DocumentId)
        );
        const removedDocs = originalDocs.filter(
          doc => doc.DocumentId && !currentDocIds.has(doc.DocumentId)
        );
        
        // SAFETY CHECK: Only delete if we have a valid comparison
        // If currentDocsForComparison is empty but originalDocs has items, 
        // it might mean the state is stale - don't delete in that case
        if (removedDocs.length > 0) {
          // Additional safety: Only proceed if we successfully fetched from API OR
          // if the currentDocs state has at least some documents (not completely empty)
          const hasValidComparison = currentDocsFromApi.length > 0 || currentDocs.length > 0;
          
          if (!hasValidComparison && originalDocs.length > 0) {
            console.warn('⚠️ handleSubmit: Skipping document deletion - state appears stale. Original docs:', originalDocs.length, 'Current docs:', currentDocs.length);
            // Don't delete if we can't verify the current state
          } else {
            console.log('🗑️ handleSubmit: Deleting removed documents:', removedDocs.length);
            console.log('🗑️ Removed document IDs:', removedDocs.map(d => d.DocumentId));
            try {
              await Promise.all(
                removedDocs.map(doc => 
                  axiosInstance.delete(`/api/vendors/${vendorId}/documents/${doc.DocumentId}`)
                )
              );
              console.log('✅ handleSubmit: Removed documents deleted successfully');
            } catch (error: any) {
              console.error('❌ handleSubmit: Error deleting removed documents:', error);
              showSnackbar('Some documents could not be deleted. Please try again.', 'error');
              return; // Don't proceed if deletion failed
            }
          }
        }
        
        // Check if there are local files that need to be uploaded
        const localFiles = currentDocs.filter(doc => doc.isLocal && doc.file);
        console.log('📤 handleSubmit: Checking for local files to upload:', localFiles.length);
        
        if (localFiles.length > 0) {
          console.log('📤 handleSubmit: Found local files, calling uploadSelectedDocuments');
          const uploadSuccess = await uploadSelectedDocuments(vendorId, currentDocs);
          if (!uploadSuccess) {
            // Upload failed, don't close the modal so user can see the error
            console.error('❌ handleSubmit: Document upload failed');
            return;
          }
          console.log('✅ handleSubmit: Document upload succeeded');
        }
      } else if (vendorId && !selectedVendor) {
        // New vendor - just upload local files if any
        const currentDocs = await new Promise<any[]>((resolve) => {
          setVendorDocuments(prev => {
            resolve(prev);
            return prev;
          });
        });
        
        const localFiles = currentDocs.filter(doc => doc.isLocal && doc.file);
        if (localFiles.length > 0) {
          const uploadSuccess = await uploadSelectedDocuments(vendorId, currentDocs);
          if (!uploadSuccess) {
            console.error('❌ handleSubmit: Document upload failed');
            return;
          }
        }
      }
      
      fetchVendors();

      if (options?.closeOnSuccess) {
        handleCloseDialog();
      } else {
        await handleOpenDialog(
          { Id: vendorId, VendorName: vendorData.vendorName || formData.VendorName || '' },
          { skipDialog: true }
        );
        await fetchVendorDocuments(vendorId);
        if (currentFormTab === 0) {
          fetchVendorDashboard(vendorId);
        }
      }
      
    } catch (error: any) {
      console.error('Error saving vendor:', error);
      console.error('Error response:', error.response);
      console.error('Error details:', error.response?.data);
      
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error || 
                          error.message || 
                          'Failed to save vendor';
      
      showSnackbar(errorMessage, 'error');
    }
  };

  // Handle dialog open/close
  const handleOpenDialog = async (
    vendor?: Vendor,
    options?: { skipDialog?: boolean; isDetailLoad?: boolean }
  ) => {
    if (vendor) {
      setSelectedVendor(vendor);
      
      // Fetch full vendor details to get all fields (including integration settings)
      try {
        const response = await axiosInstance.get(`/api/vendors/${vendor.Id}`);
        if (response.data.success) {
          const fullVendor = response.data.data;
          
          // Parse ExportGroupIds if it's a JSON string
          const parsedVendor = { ...fullVendor };
          if (typeof fullVendor.ExportGroupIds === 'string' && fullVendor.ExportGroupIds) {
            try {
              parsedVendor.ExportGroupIds = JSON.parse(fullVendor.ExportGroupIds);
            } catch (e) {
              // If parsing fails, treat as comma-separated string
              parsedVendor.ExportGroupIds = fullVendor.ExportGroupIds.split(',').map((id: string) => id.trim()).filter((id: string) => id);
            }
          } else if (!Array.isArray(fullVendor.ExportGroupIds)) {
            parsedVendor.ExportGroupIds = [];
          }
          // Parse EligibilityIncludeVendorIds (JSON array of vendor GUIDs)
          if (typeof fullVendor.EligibilityIncludeVendorIds === 'string' && fullVendor.EligibilityIncludeVendorIds) {
            try {
              const parsed = JSON.parse(fullVendor.EligibilityIncludeVendorIds);
              parsedVendor.EligibilityIncludeVendorIds = Array.isArray(parsed) ? parsed.filter((id: unknown) => id && typeof id === 'string') : [];
            } catch (e) {
              parsedVendor.EligibilityIncludeVendorIds = [];
            }
          } else if (!Array.isArray(fullVendor.EligibilityIncludeVendorIds)) {
            parsedVendor.EligibilityIncludeVendorIds = [];
          }
          // Ensure current vendor is always in the list (cannot be unchecked)
          if (vendor?.Id && !(parsedVendor.EligibilityIncludeVendorIds || []).includes(vendor.Id)) {
            parsedVendor.EligibilityIncludeVendorIds = [vendor.Id, ...(parsedVendor.EligibilityIncludeVendorIds || [])];
          }
          const grainRaw = fullVendor.EligibilityPrimaryExportGrain;
          parsedVendor.EligibilityPrimaryExportGrain =
            grainRaw === 'SinglePrimaryRow' || String(grainRaw || '').replace(/\s+/g, '').toLowerCase() === 'singleprimaryrow'
              ? 'SinglePrimaryRow'
              : 'PerProduct';
          
          // Always fetch actual decrypted passwords/tokens when loading vendor
          // This ensures we always have the real password to save back properly
          const maskedPattern = /^[•\*]+$/;
          const hasMaskedSftpPassword = parsedVendor.SftpPassword && maskedPattern.test(parsedVendor.SftpPassword);
          const hasMaskedApiToken = parsedVendor.ApiToken && maskedPattern.test(parsedVendor.ApiToken);
          
          // Fetch actual passwords/tokens in parallel
          const fetchPromises = [];
          
          if (hasMaskedSftpPassword) {
            fetchPromises.push(
              axiosInstance.get(`/api/vendors/${vendor.Id}/export/password`)
                .then(response => {
                  if (response.data.success && response.data.password) {
                    setActualSftpPassword(response.data.password);
                    // Update formData with masked value matching the actual password length
                    parsedVendor.SftpPassword = '•'.repeat(response.data.password.length);
                  }
                })
                .catch(error => {
                  console.error('Error fetching SFTP password:', error);
                })
            );
          } else if (parsedVendor.SftpPassword && !maskedPattern.test(parsedVendor.SftpPassword)) {
            // If it's not masked, it's a new password being entered - store it
            setActualSftpPassword(parsedVendor.SftpPassword);
            parsedVendor.SftpPassword = '•'.repeat(parsedVendor.SftpPassword.length);
          }
          
          if (hasMaskedApiToken) {
            fetchPromises.push(
              axiosInstance.get(`/api/vendors/${vendor.Id}/export/token`)
                .then(response => {
                  if (response.data.success && response.data.token) {
                    setActualApiToken(response.data.token);
                    // Update formData with masked value matching the actual token length
                    parsedVendor.ApiToken = '•'.repeat(response.data.token.length);
                  }
                })
                .catch(error => {
                  console.error('Error fetching API token:', error);
                })
            );
          } else if (parsedVendor.ApiToken && !maskedPattern.test(parsedVendor.ApiToken)) {
            // If it's not masked, it's a new token being entered - store it
            setActualApiToken(parsedVendor.ApiToken);
            parsedVendor.ApiToken = '•'.repeat(parsedVendor.ApiToken.length);
          }
          
          // Wait for all password/token fetches to complete
          await Promise.all(fetchPromises);
          
          // Set form data after fetching passwords (with proper masked values)
          setFormData(parsedVendor);
          setEligibilityEffectiveAsOf(eligibilityEffectiveAsOfPickerDefault(parsedVendor.EligibilityFutureEffectiveDays));
        } else {
          // Fallback to using the vendor from the list if fetch fails
          const parsedVendor = { ...vendor };
          const exportGroupIds = (vendor as any).ExportGroupIds;
          if (typeof exportGroupIds === 'string' && exportGroupIds) {
            try {
              parsedVendor.ExportGroupIds = JSON.parse(exportGroupIds);
            } catch (e) {
              parsedVendor.ExportGroupIds = exportGroupIds.split(',').map((id: string) => id.trim()).filter((id: string) => id);
            }
          } else if (!Array.isArray(exportGroupIds)) {
            parsedVendor.ExportGroupIds = [];
          }
          setFormData(parsedVendor);
          setEligibilityEffectiveAsOf(eligibilityEffectiveAsOfPickerDefault(parsedVendor.EligibilityFutureEffectiveDays));
        }
      } catch (error) {
        console.error('Error fetching vendor details:', error);
        // Fallback to using the vendor from the list if fetch fails
        const parsedVendor = { ...vendor };
        const exportGroupIds = (vendor as any).ExportGroupIds;
        if (typeof exportGroupIds === 'string' && exportGroupIds) {
          try {
            parsedVendor.ExportGroupIds = JSON.parse(exportGroupIds);
          } catch (e) {
            parsedVendor.ExportGroupIds = exportGroupIds.split(',').map((id: string) => id.trim()).filter((id: string) => id);
          }
        } else if (!Array.isArray(exportGroupIds)) {
          parsedVendor.ExportGroupIds = [];
        }
        
        setFormData(parsedVendor);
        setEligibilityEffectiveAsOf(eligibilityEffectiveAsOfPickerDefault(parsedVendor.EligibilityFutureEffectiveDays));
        // Reset actual password states when loading new vendor
        setActualSftpPassword(null);
        setActualApiToken(null);
      }
      
      if (!options?.isDetailLoad) {
        await Promise.all([
          fetchVendorDocuments(vendor.Id),
          loadAchAccountsForForm(vendor.Id),
          fetchTenantTpaServices(vendor.Id),
          fetchVendorAchAccountsForTpa(vendor.Id),
        ]);
      }
    } else {
      setSelectedVendor(null);
      setFormData({
        VendorName: '',
        AddressLine1: '',
        AddressLine2: '',
        City: '',
        State: '',
        ExportGroupIds: [],
        GroupIdPrefix: '',
        GroupIdSeedNumber: undefined,
        GroupIdAffixPosition: null,
        GroupIdBetweenGroupsIncrement: null,
        AutoGenerateVendorGroupIds: false,
        SftpHostname: '',
        SftpPort: undefined,
        SftpUsername: '',
        SftpPassword: '',
        SftpPath: '',
        SftpPathNacha: '',
        SftpPathEligibility: '',
        ExportEmailAddress: '',
        ExportEmailEnabled: false,
        ApiBaseUrl: '',
        ApiToken: '',
        ApiEnabled: false,
        ExportSchedule: '',
        ExportMethod: '',
        ExportScheduleDay: '',
        ExportScheduleTime: '',
        ExportFileFormat: 'CSV',
        ExportFileNameTemplate: '',
        PayablesExportFileNameTemplate: '',
        EligibilityIncludeOnlyChanges: true,
        EligibilityFutureEffectiveDays: 7,
        EligibilityRowTemplate: '',
        PayablesRowTemplate: '',
        EligibilityDateFormat: 'ARM',
        EligibilityIntegrationPartner: 'AB365',
        EligibilityIncludeVendorIds: [] as string[],
        EligibilityPrimaryExportGrain: 'PerProduct' as const,
        ExportRetryAttempts: 3,
        ExportRetryDelayMinutes: 5,
        ExportCompressionEnabled: false,
        ExportEncryptionEnabled: false,
        Zip: '',
        ContactName: '',
        Phone: '',
        Email: '',
        MinimumEmployeesPerGroup: null,
      });
      setEligibilityEffectiveAsOf(eligibilityEffectiveAsOfPickerDefault(7));
      setVendorDocuments([]);
      setOriginalVendorDocuments([]);
      setAchAccountsForm([]);
      setNewGroupFormTitle('');
      setNewGroupFormFields([]);
    }
    setAchModalAccounts([]);
    setAchModalFieldErrors({});
    setFormErrors({});
    setCurrentFormTab(0); // Reset to first tab
    if (!options?.skipDialog) {
      setOpenDialog(true);
    }
  };

  const handleCloseDialog = () => {
    if (formData.Id) {
      clearEligibilityAiChatSession(eligibilityAiChatStorageKey(formData.Id));
    }
    setEligibilityAiChatOpen(false);
    setOpenDialog(false);
    if (mode === 'detail' && !isVendorPortal) {
      navigate('/admin/vendors');
    }
    setSelectedVendor(null);
    setFormData({});
    setFormErrors({});
    setShowSftpPassword(false);
    setShowApiToken(false);
    setCurrentFormTab(0); // Reset to first tab
    setAchAccountsForm([]);
    setAchModalAccounts([]);
    setAchModalFieldErrors({});
    setAchModalOpen(false);
    setVendorDocuments([]);
    setSampleCsvModalOpen(false);
    setSampleCsvMemberId(null);
    setSampleCsvError(null);
    setOriginalVendorDocuments([]);
    setNewGroupFormTitle('');
    setNewGroupFormFields([]);
    setNewGroupFormEditorModalOpen(false);
    setNewGroupFormModalGroup(null);
    setVendorGroupsListRows([]);
    setVendorGroupsListTotal(0);
    setVendorGroupsListPage(1);
    setVendorGroupsSearchInput('');
    setVendorGroupsSearch('');
    setVendorGroupsFilterId('');
    setNewGroupFormProductOptions([]);
  };

  // Bootstrap full-page vendor detail (/admin/vendors/:vendorId)
  useEffect(() => {
    if (mode !== 'detail' || !routeVendorId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setSelectedVendor(null);
    (async () => {
      try {
        const response = await axiosInstance.get(`/api/vendors/${routeVendorId}`);
        if (cancelled) return;
        if (!response.data?.success || !response.data?.data) {
          setDetailError('Vendor not found');
          setDetailLoading(false);
          return;
        }
        const row = response.data.data;
        const vendor = { ...row, Id: row.Id || routeVendorId } as Vendor;
        await handleOpenDialog(vendor, { skipDialog: true, isDetailLoad: true });
        if (!cancelled) setDetailLoading(false);
      } catch {
        if (!cancelled) {
          setDetailError('Vendor not found');
          setDetailLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per route vendor id
  }, [mode, routeVendorId]);

  const handleSaveProduct = async (productData: ProductFormData) => {
    if (!selectedVendor) {
      throw new Error('A vendor must be selected to save products.');
    }

    const uploadFailures: string[] = [];

    try {
      const vendorId = productData.vendorId || selectedVendor.Id;
      let productImageUrl: string | undefined;
      let productLogoUrl: string | undefined;
      let productDocumentUrl: string | undefined;

      if (productData.productImageFile) {
        try {
          const url = await uploadProductAsset(productData.productImageFile, 'logos');
          productImageUrl = url || undefined;
          productLogoUrl = url || undefined;
        } catch (error) {
          console.error('Product image upload failed:', error);
          uploadFailures.push(`Product Image (${productData.productImageFile.name})`);
        }
      }

      if (productData.productLogoFile) {
        try {
          const url = await uploadProductAsset(productData.productLogoFile, 'logos');
          productLogoUrl = url || undefined;
        } catch (error) {
          console.error('Product logo upload failed:', error);
          uploadFailures.push(`Product Logo (${productData.productLogoFile.name})`);
        }
      }

      if (productData.productDocumentFile) {
        try {
          const url = await uploadProductAsset(productData.productDocumentFile, 'documents');
          productDocumentUrl = url || undefined;
        } catch (error) {
          console.error('Product document upload failed:', error);
          uploadFailures.push(`Product Document (${productData.productDocumentFile.name})`);
        }
      }

      const uploadedNewDocuments: { documentUrl: string; displayName: string; sortOrder: number }[] = [];
      const pendingFiles = productData.productDocumentFiles || [];
      for (let i = 0; i < pendingFiles.length; i++) {
        const item = pendingFiles[i];
        if (!item?.file || !(item.file instanceof File)) continue;
        try {
          const url = await uploadProductAsset(item.file, 'documents');
          if (url) uploadedNewDocuments.push({ documentUrl: url, displayName: item.displayName?.trim() || item.file.name || 'Document', sortOrder: i });
        } catch (error) {
          console.error('Product document upload failed:', error);
          uploadFailures.push(`Product Document (${item.file.name})`);
        }
      }
      const existingDocs = (productData.productDocuments || []).filter((d: any) => d?.documentUrl);
      const withLegacy = productDocumentUrl ? [...existingDocs, { documentUrl: productDocumentUrl, displayName: productData.productDocumentName || 'Document', sortOrder: existingDocs.length }] : existingDocs;
      const productDocuments = withLegacy.length > 0 || uploadedNewDocuments.length > 0 ? [...withLegacy, ...uploadedNewDocuments].map((d: any, i: number) => ({ ...d, sortOrder: i })) : undefined;

      let updatedIdCardData = productData.idCardData;
      if (productData.idCardLogoFile) {
        try {
          const idCardLogoUrl = await uploadProductAsset(productData.idCardLogoFile, 'logos');
          if (idCardLogoUrl) {
            updatedIdCardData = {
              ...productData.idCardData,
              Card_Front: {
                ...productData.idCardData.Card_Front,
                Header: {
                  ...productData.idCardData.Card_Front.Header,
                  Image: idCardLogoUrl
                }
              }
            };
          }
        } catch (error) {
          console.error('ID card logo upload failed:', error);
          uploadFailures.push(`ID Card Logo (${productData.idCardLogoFile.name})`);
        }
      }

      if (productData.idCardBackImageFiles) {
        for (const [section, file] of Object.entries(productData.idCardBackImageFiles)) {
          if (!file) continue;

          try {
            const imageUrl = await uploadProductAsset(file, 'logos');
            if (!imageUrl) continue;
            type BackKey = keyof NonNullable<ProductFormData['idCardData']>['Card_Back'];
            const sec = section as BackKey;
            const back = {
              ...productData.idCardData?.Card_Back,
              ...updatedIdCardData?.Card_Back,
            } as ProductFormData['idCardData']['Card_Back'];
            const existing =
              back[sec] && typeof back[sec] === 'object' ? { ...back[sec] } : ({} as Record<string, string>);
            back[sec] = { ...existing, Image: imageUrl } as (typeof back)[BackKey];
            updatedIdCardData = {
              ...updatedIdCardData,
              Card_Back: back,
            };
          } catch (error) {
            console.error(`Card back image upload failed for ${section}:`, error);
            uploadFailures.push(`Card Back ${section} (${file.name})`);
          }
        }
      }

      // ---- Per-network ID card variation uploads ----
      const networkLogoFiles = productData.idCardLogoFileByNetwork;
      const networkBackFiles = productData.idCardBackImageFilesByNetwork;
      const allVariationKeys = new Set<string>([
        ...Object.keys(networkLogoFiles || {}),
        ...Object.keys(networkBackFiles || {}),
        ...Object.keys((updatedIdCardData?.NetworkVariations as Record<string, unknown>) || {})
      ]);
      if (allVariationKeys.size > 0) {
        const idCardDataAny = (updatedIdCardData ?? productData.idCardData) as any;
        if (!idCardDataAny.NetworkVariations) idCardDataAny.NetworkVariations = {};

        for (const networkId of allVariationKeys) {
          if (!idCardDataAny.NetworkVariations[networkId]) {
            idCardDataAny.NetworkVariations[networkId] = JSON.parse(JSON.stringify({
              DisableIDCard: idCardDataAny.DisableIDCard === true,
              Card_Front: idCardDataAny.Card_Front,
              Card_Back: idCardDataAny.Card_Back
            }));
          }
          const variation = idCardDataAny.NetworkVariations[networkId];

          const logoFile = networkLogoFiles?.[networkId];
          if (logoFile instanceof File) {
            try {
              const url = await uploadProductAsset(logoFile, 'logos');
              if (url) {
                variation.Card_Front = variation.Card_Front || { Header: {}, Footer: {} };
                variation.Card_Front.Header = { ...(variation.Card_Front.Header || {}), Image: url };
              }
            } catch (error) {
              console.error(`Variation logo upload failed for network ${networkId}:`, error);
              uploadFailures.push(`Variation Logo (${logoFile.name})`);
            }
          }

          const backFiles = networkBackFiles?.[networkId];
          if (backFiles) {
            for (const [section, file] of Object.entries(backFiles)) {
              if (!file) continue;
              try {
                const url = await uploadProductAsset(file as File, 'logos');
                if (!url) continue;
                variation.Card_Back = variation.Card_Back || {};
                variation.Card_Back[section] = {
                  ...(variation.Card_Back[section] || { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }),
                  Image: url
                };
              } catch (error) {
                console.error(`Variation back image upload failed (${section}) for network ${networkId}:`, error);
                uploadFailures.push(`Variation Card Back ${section} (${(file as File).name})`);
              }
            }
          }
        }
        updatedIdCardData = idCardDataAny as ProductFormData['idCardData'];
      }

      let updatedPlanDetailsData = productData.planDetailsData;
      if (productData.planDetailsHeaderLogoFile) {
        try {
          const planLogoUrl = await uploadProductAsset(productData.planDetailsHeaderLogoFile, 'logos');
          if (planLogoUrl && updatedPlanDetailsData?.Plan_Data?.Header) {
            updatedPlanDetailsData = {
              ...productData.planDetailsData,
              Plan_Data: {
                ...productData.planDetailsData.Plan_Data,
                Header: {
                  ...productData.planDetailsData.Plan_Data.Header,
                  Image: planLogoUrl
                }
              }
            };
          }
        } catch (error) {
          console.error('Plan details logo upload failed:', error);
          uploadFailures.push(`Plan Details Logo (${productData.planDetailsHeaderLogoFile.name})`);
        }
      }

      const payload = {
        vendorId,
        isVendorPricing: productData.isVendorPricing,
        vendorCommission: productData.vendorCommission,
        vendorGroupIdProductType: productData.vendorGroupIdProductType ?? '',
        eligibilityIndividualVendorGroupId: productData.eligibilityIndividualVendorGroupId ?? '',
        eligibilityVendorGroupFallbackProductId: productData.eligibilityVendorGroupFallbackProductId ?? '',
        planId: productData.planId ?? '',
        partNumber: productData.partNumber,
        name: productData.name,
        description: productData.description,
        productType: productData.productType,
        productOwnerId: productData.productOwnerId,
        salesType: productData.salesType,
        minAge: productData.minAge,
        maxAge: productData.maxAge,
        allowedStates: productData.allowedStates,
        requiresTobaccoInfo: productData.requiresTobaccoInfo,
        effectiveDateLogic: productData.effectiveDateLogic,
        maxEffectiveDateDays: productData.maxEffectiveDateDays,
        terminationLogic: productData.terminationLogic,
        requiredLicenses: productData.requiredLicenses,
        isPublic: productData.isPublic,
        isHidden: productData.isHidden || false,
        isSSNRequired: productData.isSSNRequired || false,
        premiumReportingCategory:
          productData.premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit',
        includeProcessingFee: productData.includeProcessingFee === true,
        roundUpProcessingFee: productData.roundUpProcessingFee !== false,
        processingFeePercentage: productData.processingFeePercentage ?? null,
        trainingConfig: productData.trainingConfig,
        medicalNeedsLinksConfig: productData.medicalNeedsLinksConfig,
        configurationFields: productData.configurationFields,
        pricingTiers: productData.pricingTiers,
        acknowledgementQuestions: productData.acknowledgementQuestions,
        productQuestionnaires: productData.productQuestionnaires || undefined,
        idCardData: updatedIdCardData,
        idCardMemberIdPrefixMask: productData.idCardMemberIdPrefixMask ?? '',
        showGroupIdOnIDCard: productData.showGroupIdOnIDCard === true,
        planDetailsData: updatedPlanDetailsData,
        aiChunks: productData.aiChunks,
        requiredASA: productData.requiredASA,
        deleteProductImage: productData.deleteProductImage,
        deleteProductLogo: productData.deleteProductLogo,
        deleteProductDocument: productData.deleteProductDocument,
        ...(productImageUrl !== undefined && { productImageUrl }),
        ...(productLogoUrl !== undefined && { productLogoUrl }),
        ...(productDocumentUrl !== undefined && { productDocumentUrl }),
        ...(productDocuments !== undefined && productDocuments.length > 0 && { productDocuments })
      };

      // Check if this is actually an existing product (has valid ProductId GUID) or AI-generated data (no ProductId)
      // CRITICAL: AI-generated products should NEVER have a valid ProductId - if editingProduct has lowercase properties (name, vendorId),
      // it's AI-generated and should be treated as a NEW product, even if it has an invalid ProductId field
      const isAIGenerated = editingProduct && ((editingProduct as any).name || (editingProduct as any).vendorId) && !(editingProduct as any).Name;
      const isValidGuid = (id: string | undefined): boolean => {
        if (!id) return false;
        // UUID v4 format: 8-4-4-4-12 hex digits
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return guidRegex.test(id);
      };
      
      // Only treat as existing product if it's NOT AI-generated AND has a valid ProductId GUID
      const isExistingProduct = !isAIGenerated && editingProduct && editingProduct.ProductId && isValidGuid(editingProduct.ProductId);
      
      const endpoint = isExistingProduct ? `/api/products/${editingProduct.ProductId}` : '/api/products';
      const response = isExistingProduct
        ? await axiosInstance.put(endpoint, payload)
        : await axiosInstance.post(endpoint, payload);

      if (!response.data?.success) {
        throw new Error(response.data?.message || 'Failed to save product');
      }

      if (uploadFailures.length > 0) {
        showSnackbar(
          `Product saved, but the following uploads failed: ${uploadFailures.join(', ')}.`,
          'warning'
        );
      }
    } catch (error: any) {
      console.error('Error saving vendor product:', error);
      const message = error?.response?.data?.message || error.message || 'Failed to save product';
      showSnackbar(message, 'error');
      throw error;
    }
  };

  const handleAddProductClick = () => {
    setEditingProduct(null);
    setShowAddProduct(true);
  };

  const handleEditVendorProduct = (product: VendorProduct) => {
    setEditingProduct(product);
    setShowAddProduct(true);
  };

  const closeProductWizard = () => {
    setShowAddProduct(false);
    setEditingProduct(null);
  };

  const handleProductWizardComplete = () => {
    const wasEditing = Boolean(editingProduct);

    if (!selectedVendor) {
      closeProductWizard();
      return;
    }

    closeProductWizard();
    fetchVendorProducts(selectedVendor.Id);
    showSnackbar(
      wasEditing ? 'Product updated successfully' : 'Products added successfully',
      'success'
    );
  };

  const closeNavigationModal = () => {
    setNavModalOpen(false);
    setNavModalSubmitting(false);
    setNavModalErrors({});
    setNavModalForm(createEmptyNavigationPageForm());
    setNavModalMode('create');
  };

  const handleOpenNavigationModal = (mode: 'create' | 'edit', page?: VendorNavigationPage) => {
    if (mode === 'edit' && page) {
      setNavModalForm(mapNavigationPageToForm(page));
      setNavModalMode('edit');
    } else {
      setNavModalForm(createEmptyNavigationPageForm());
      setNavModalMode('create');
    }
    setNavModalErrors({});
    setNavModalOpen(true);
  };

  const handleNavigationInputChange = (field: keyof VendorNavigationPageForm, value: any) => {
    setNavModalForm((prev) => {
      const updated: VendorNavigationPageForm = {
        ...prev,
        [field]: field === 'sortOrder' ? Number(value) || 0 : value,
      };

      if (
        field === 'label' &&
        (!prev.vendorNavigationPageId || prev.routeKey === slugifyRouteKey(prev.label))
      ) {
        updated.routeKey = slugifyRouteKey(value);
      }

      if (field === 'tenantScope' && value === 'all') {
        updated.tenantId = '';
      }

      if (field === 'routeKey') {
        updated.routeKey = slugifyRouteKey(value);
      }

      return updated;
    });
  };

  const handleSaveNavigationPage = async () => {
    if (!selectedVendor) return;

    setNavModalErrors({});
    const errors: Record<string, string> = {};
    if (!navModalForm.label.trim()) {
      errors.label = 'Label is required';
    }
    if (!navModalForm.routeKey.trim()) {
      errors.routeKey = 'Route key is required';
    }
    if (!navModalForm.contentRef.trim()) {
      errors.contentRef = 'Content reference is required';
    }
    if (navModalForm.tenantScope === 'specific' && !navModalForm.tenantId?.trim()) {
      errors.tenantId = 'Tenant ID is required for this scope';
    }
    if (navModalForm.visibilityRule.trim()) {
      try {
        JSON.parse(navModalForm.visibilityRule);
      } catch (error) {
        errors.visibilityRule = 'Visibility rule must be valid JSON';
      }
    }

    if (Object.keys(errors).length > 0) {
      setNavModalErrors(errors);
      return;
    }

    const toIsoDate = (value?: string) =>
      value ? new Date(`${value}T00:00:00Z`).toISOString() : null;

    const payload = {
      label: navModalForm.label.trim(),
      routeKey: navModalForm.routeKey.trim(),
      contentType: navModalForm.contentType,
      contentRef: navModalForm.contentRef.trim(),
      description: navModalForm.description.trim() || null,
      iconName: navModalForm.iconName.trim() || null,
      sortOrder: Number(navModalForm.sortOrder) || 0,
      published: navModalForm.published,
      tenantId: navModalForm.tenantScope === 'specific' ? navModalForm.tenantId?.trim() || null : null,
      effectiveDate: toIsoDate(navModalForm.effectiveDate),
      expirationDate: toIsoDate(navModalForm.expirationDate),
      visibilityRule: navModalForm.visibilityRule.trim() || null,
    };

    setNavModalSubmitting(true);

    try {
      if (navModalMode === 'edit' && navModalForm.vendorNavigationPageId) {
        await axiosInstance.put(
          `/api/vendors/${selectedVendor.Id}/navigation-pages/${navModalForm.vendorNavigationPageId}`,
          payload
        );
        showSnackbar('Navigation page updated successfully', 'success');
      } else {
        await axiosInstance.post(
          `/api/vendors/${selectedVendor.Id}/navigation-pages`,
          payload
        );
        showSnackbar('Navigation page created successfully', 'success');
      }

      closeNavigationModal();
      fetchVendorNavigationPages(selectedVendor.Id);
    } catch (error: any) {
      console.error('Error saving navigation page:', error);
      const message = error?.response?.data?.message || error.message || 'Failed to save navigation page';
      showSnackbar(message, 'error');
      setNavModalSubmitting(false);
    }
  };

  const handleDeleteNavigationPage = async (page: VendorNavigationPage) => {
    if (!selectedVendor) return;

    const confirmMessage = `Delete "${page.label}" navigation entry?`;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      await axiosInstance.delete(
        `/api/vendors/${selectedVendor.Id}/navigation-pages/${page.vendorNavigationPageId}`
      );
      showSnackbar('Navigation page deleted', 'success');
      fetchVendorNavigationPages(selectedVendor.Id);
    } catch (error: any) {
      console.error('Error deleting navigation page:', error);
      const message = error?.response?.data?.message || error.message || 'Failed to delete navigation page';
      showSnackbar(message, 'error');
    }
  };

  // Local file selection handler (for wizard)
  const handleLocalFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    console.log('📁 handleLocalFileSelection: Files selected:', Array.from(files).map(f => ({ name: f.name, size: f.size, type: f.type })));

    // Convert FileList to array and add to local documents state
    const newLocalFiles = Array.from(files).map(file => {
      const fileObj = {
        id: `local-${Date.now()}-${Math.random()}`,
        DocumentId: `local-${Date.now()}-${Math.random()}`, // Add DocumentId for consistency
        FileName: file.name,
        FileType: file.type,
        FileSize: file.size,
        UploadedDate: new Date().toISOString(),
        Url: URL.createObjectURL(file), // Create local object URL for preview
        isLocal: true,
        file: file // Store the actual File object for later upload
      };
      console.log('📁 Created file object:', { FileName: fileObj.FileName, hasFile: !!fileObj.file, isLocal: fileObj.isLocal });
      return fileObj;
    });

    setVendorDocuments(prev => {
      const updated = [...prev, ...newLocalFiles];
      console.log('📁 Updated vendorDocuments state. Total files:', updated.length, 'Local files:', updated.filter(d => d.isLocal).length);
      return updated;
    });
    
    // Reset file input
    event.target.value = '';
  };

  // Document upload handler (called when saving vendor)
  const uploadSelectedDocuments = async (vendorId: string, documentsToUpload?: any[]): Promise<boolean> => {
    console.log('📤 uploadSelectedDocuments called with vendorId:', vendorId);
    
    // Use provided documents or get latest from state
    let currentDocs: any[] = [];
    if (documentsToUpload) {
      currentDocs = documentsToUpload;
    } else {
      // Get latest state
      await new Promise<void>((resolve) => {
        setVendorDocuments(prev => {
          currentDocs = prev;
          resolve();
          return prev; // Don't change state, just read it
        });
      });
    }
    
    console.log('📤 Current vendorDocuments:', currentDocs);
    
    const localFiles = currentDocs.filter(doc => doc.isLocal && doc.file);
    console.log('📤 Filtered localFiles:', localFiles);
    console.log('📤 Local files count:', localFiles.length);
    
    if (localFiles.length === 0) {
      console.log('📤 No local files to upload, returning true');
      return true; // No files to upload, consider it successful
    }

    // Check if all local files have the file property
    const filesWithFileProperty = localFiles.filter(doc => doc.file);
    console.log('📤 Files with file property:', filesWithFileProperty.length);
    
    if (filesWithFileProperty.length === 0) {
      console.error('❌ No local files have the file property!');
      showSnackbar('Error: Files were not properly selected. Please try uploading again.', 'error');
      return false;
    }

    setUploadingDocuments(true);
    
    try {
      const formData = new FormData();
      
      // Add all local files to FormData
      localFiles.forEach((doc, index) => {
        if (doc.file) {
          console.log(`📤 Adding file ${index + 1}: ${doc.FileName} (size: ${doc.FileSize})`);
          formData.append('files', doc.file);
        } else {
          console.error(`❌ File ${index + 1} (${doc.FileName}) is missing the file property!`);
        }
      });
      
      // Add metadata
      formData.append('uploadType', 'agreements');
      formData.append('entityId', vendorId);
      formData.append('description', 'Vendor required documents');

      // Upload files to Azure Blob Storage
      const uploadResponse = await axiosInstance.post('/api/uploads', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (uploadResponse.data.success) {
        const uploadedDocs = uploadResponse.data.data;
        console.log('📄 Upload response data:', uploadResponse.data);
        console.log('📄 Uploaded docs array:', uploadedDocs);
        
        let successCount = 0;
        let errorCount = 0;
        
        // Save metadata to database for each uploaded file
        for (let i = 0; i < uploadedDocs.length; i++) {
          const doc = uploadedDocs[i];
          const originalFile = localFiles[i]; // Get the original file data
          
          try {
            console.log('📄 Uploaded doc data:', doc);
            console.log('📄 Original file data:', originalFile);
            
            const metadataResponse = await axiosInstance.post(`/api/vendors/${vendorId}/documents`, {
              fileName: originalFile.FileName,
              fileType: originalFile.FileType,
              fileSize: originalFile.FileSize,
              documentType: 'Required Document',
              description: 'Vendor required document',
              url: doc.url,
              storedFileName: doc.filename,
              containerName: 'agreements'
            });

            if (metadataResponse.data.success) {
              console.log(`✅ Document metadata saved for ${originalFile.FileName}`);
              successCount++;
            } else {
              console.error(`❌ Failed to save metadata for ${originalFile.FileName}:`, metadataResponse.data);
              errorCount++;
            }
          } catch (metadataError: any) {
            console.error(`❌ Error saving metadata for ${originalFile.FileName}:`, metadataError);
            console.error('❌ Error details:', metadataError.response?.data);
            errorCount++;
          }
        }
        
        if (errorCount === 0) {
          showSnackbar(`Successfully uploaded ${successCount} document(s)`, 'success');
          return true;
        } else if (successCount > 0) {
          showSnackbar(`Uploaded ${successCount} document(s), ${errorCount} failed`, 'warning');
          return false; // Partial success, don't close modal
        } else {
          showSnackbar('Failed to save document metadata', 'error');
          return false; // Complete failure, don't close modal
        }
      } else {
        showSnackbar('Failed to upload documents', 'error');
        return false; // Upload failed, don't close modal
      }
    } catch (error: any) {
      console.error('Error uploading documents:', error);
      showSnackbar('Error uploading documents', 'error');
      return false; // Error occurred, don't close modal
    } finally {
      setUploadingDocuments(false);
    }
  };

  // Document deletion handler
  const handleDeleteDocument = async (index: number) => {
    const doc = vendorDocuments[index];
    if (!doc) return;

    // If it's a local file (not yet uploaded), just remove from state
    if (doc.isLocal) {
      // Clean up object URL to prevent memory leaks
      if (doc.Url && doc.Url.startsWith('blob:')) {
        URL.revokeObjectURL(doc.Url);
      }
      setVendorDocuments(prev => prev.filter((_, i) => i !== index));
      return;
    }

    if (doc.DocumentId && selectedVendor) {
      // Delete from backend immediately when document exists on server
      if (!window.confirm(`Are you sure you want to delete "${doc.FileName}"?`)) {
        return;
      }

      try {
        const response = await axiosInstance.delete(`/api/vendors/${selectedVendor.Id}/documents/${doc.DocumentId}`);
        if (response.data.success) {
          // Remove from state and update original documents
          setVendorDocuments(prev => prev.filter((_, i) => i !== index));
          setOriginalVendorDocuments(prev => prev.filter(d => d.DocumentId !== doc.DocumentId));
          showSnackbar('Document deleted successfully', 'success');
        } else {
          showSnackbar(response.data.message || 'Failed to delete document', 'error');
        }
      } catch (error: any) {
        console.error('Error deleting document:', error);
        showSnackbar(error?.response?.data?.message || 'Failed to delete document', 'error');
      }
    } else {
      setVendorDocuments(prev => prev.filter((_, i) => i !== index));
    }
  };

  // Fetch vendor documents with authentication
  const fetchVendorDocuments = async (vendorId: string) => {
    try {
      console.log('Fetching vendor documents for:', vendorId);
      const response = await axiosInstance.get(`/api/vendors/${vendorId}/documents`);

      if (response.data.success) {
        console.log('✅ Vendor documents fetched:', response.data.data);
        const fetchedFiles = response.data.data || [];
        
        // Store original documents for deletion tracking
        setOriginalVendorDocuments([...fetchedFiles]);
        
        // Preserve any local files that haven't been uploaded yet
        setVendorDocuments(prev => {
          const localFiles = prev.filter(doc => doc.isLocal);
          console.log('📄 Preserving local files:', localFiles.length, 'Fetched files:', fetchedFiles.length);
          return [...fetchedFiles, ...localFiles];
        });
      } else {
        console.error('❌ Failed to fetch vendor documents:', response.data.message);
        setOriginalVendorDocuments([]);
        // Preserve local files even if fetch fails
        setVendorDocuments(prev => prev.filter(doc => doc.isLocal));
      }
    } catch (error) {
      console.error('❌ Error fetching vendor documents:', error);
      setOriginalVendorDocuments([]);
      // Preserve local files even if fetch fails
      setVendorDocuments(prev => prev.filter(doc => doc.isLocal));
      // Don't show error to user as this is not critical
    }
  };

  /** Primary vendor save for tabs 0–5. Tab 0 allows Create before a vendor exists; tabs 1–5 require an existing vendor. */
  const renderVendorTabSaveBar = (allowCreateWithoutVendor: boolean) => {
    if (!allowCreateWithoutVendor && !selectedVendor) return null;
    return (
      <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="button"
          variant="contained"
          disabled={achModalOpen}
          onClick={() => void handleSubmit()}
          sx={{ backgroundColor: 'var(--oe-primary)', '&:hover': { backgroundColor: 'var(--oe-primary-dark)' } }}
        >
          {selectedVendor ? 'Save changes' : 'Create vendor'}
        </Button>
      </Box>
    );
  };

  // ============ Signed ASAs tab loaders / handlers (ported from VendorSettings.tsx) ============
  // Uses /api/vendors/:id/asa-agreements for both SysAdmin and VendorAdmin (scoped
  // via authorizeVendorDetail middleware). The same factory powers /api/me/vendor/asa-agreements.

  /**
   * Load the resolved recipient defaults for the selected vendor so we can
   * pre-fill the per-send input and surface the comma-separated list to the
   * user. Mirrors backend asaSignedTriggerService.resolveRecipients order:
   *   1. oe.Vendors.AsaSignedEmailRecipients (ASA-specific default)
   *   2. vendor.Email + oe.VendorNotificationContacts (vendor-wide fallback)
   */
  const loadSignedAsasDefaults = useCallback(async () => {
    if (!selectedVendor?.Id) return;
    try {
      const res = await apiService.get<{
        success: boolean;
        data?: {
          vendorEmail: string | null;
          asaSignedEmailRecipients: string | null;
          resolved: string[];
          resolvedFrom: 'asa-specific' | 'fallback';
          fallback: string[];
        };
      }>(`/api/vendors/${selectedVendor.Id}/asa-recipients-defaults`);
      if (res.success && res.data) {
        setSignedAsasDefaultInput(res.data.asaSignedEmailRecipients || '');
        setSignedAsasFallbackRecipients(res.data.fallback || []);
        setSignedAsasResolvedFrom(res.data.resolvedFrom);
        // Only auto-fill the per-send input when the user has not customized it.
        if (!signedAsasRecipientEdited) {
          setSignedAsasRecipientInput((res.data.resolved || []).join(', '));
        }
      }
    } catch (err) {
      console.error('Failed to load ASA recipient defaults:', err);
    }
  }, [selectedVendor?.Id, signedAsasRecipientEdited]);

  /**
   * Persist the ASA-specific default list on oe.Vendors.AsaSignedEmailRecipients
   * via the dedicated endpoint so we don't accidentally re-send (and clobber)
   * other Vendors columns through the bulk PUT /api/vendors/:id route.
   */
  const handleSaveSignedAsasDefault = async () => {
    if (!selectedVendor?.Id) return;
    setSignedAsasDefaultSaving(true);
    setSignedAsasMessage(null);
    try {
      const trimmed = signedAsasDefaultInput.trim();
      const res = await apiService.put<{
        success: boolean;
        message?: string;
        data?: { asaSignedEmailRecipients: string | null };
      }>(`/api/vendors/${selectedVendor.Id}/asa-recipients-defaults`, {
        asaSignedEmailRecipients: trimmed,
      });
      if (res.success) {
        setSignedAsasMessage({
          type: 'success',
          text: res.message || (trimmed
            ? 'Default ASA recipients saved.'
            : 'Default ASA recipients cleared — using vendor Email + notification contacts.'),
        });
        setSelectedVendor((prev) =>
          prev ? { ...prev, AsaSignedEmailRecipients: res.data?.asaSignedEmailRecipients ?? null } : prev
        );
        // Re-resolve so the per-send input + helper text refresh immediately.
        setSignedAsasRecipientEdited(false);
        await loadSignedAsasDefaults();
      } else {
        setSignedAsasMessage({ type: 'error', text: res.message || 'Failed to save default ASA recipients' });
      }
    } catch (err: any) {
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to save default ASA recipients' });
    } finally {
      setSignedAsasDefaultSaving(false);
    }
  };

  const loadSignedAsas = useCallback(async () => {
    if (!selectedVendor?.Id) return;
    setSignedAsasLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('status', signedAsasStatusFilter);
      params.set('enrollmentFilter', signedAsasEnrollmentFilter);
      params.set('limit', String(signedAsasLimit));
      params.set('offset', String((signedAsasPage - 1) * signedAsasLimit));
      if (signedAsasSearch.trim()) params.set('search', signedAsasSearch.trim());
      const res = await apiService.get<{
        success: boolean;
        data?: { total: number; items: SignedAsaRow[] };
      }>(`/api/vendors/${selectedVendor.Id}/asa-agreements?${params.toString()}`);
      if (res.success && res.data) {
        setSignedAsasRows(res.data.items || []);
        setSignedAsasTotal(res.data.total || 0);
      } else {
        setSignedAsasRows([]);
        setSignedAsasTotal(0);
      }
    } catch (err: any) {
      console.error('Failed to load signed ASAs:', err);
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to load signed ASAs' });
      setSignedAsasRows([]);
      setSignedAsasTotal(0);
    } finally {
      setSignedAsasLoading(false);
    }
  }, [selectedVendor?.Id, signedAsasStatusFilter, signedAsasEnrollmentFilter, signedAsasSearch, signedAsasPage]);

  const handleSignedAsaDownload = async (row: SignedAsaRow) => {
    if (!selectedVendor?.Id) return;
    if (!row.hasSignedPdf) {
      setSignedAsasMessage({ type: 'error', text: 'No signed PDF attached to this agreement' });
      return;
    }
    setSignedAsaRowDownloading((m) => ({ ...m, [row.signedAgreementId]: true }));
    try {
      const res = await apiService.get<{ success: boolean; data?: { url: string; filename?: string } }>(
        `/api/vendors/${selectedVendor.Id}/asa-agreements/${encodeURIComponent(row.signedAgreementId)}/download`
      );
      if (res.success && res.data?.url) {
        const a = document.createElement('a');
        a.href = res.data.url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err: any) {
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to download signed ASA' });
    } finally {
      setSignedAsaRowDownloading((m) => ({ ...m, [row.signedAgreementId]: false }));
    }
  };

  const handleSignedAsaSend = async (row: SignedAsaRow) => {
    if (!selectedVendor?.Id) return;
    setSignedAsaRowSending((m) => ({ ...m, [row.signedAgreementId]: true }));
    setSignedAsasMessage(null);
    try {
      const trimmed = signedAsasRecipientInput.trim();
      const payload = trimmed ? { recipients: trimmed } : {};
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `/api/vendors/${selectedVendor.Id}/asa-agreements/${encodeURIComponent(row.signedAgreementId)}/send`,
        payload
      );
      if (res.success) {
        setSignedAsasMessage({ type: 'success', text: res.message || 'Sent' });
        await loadSignedAsas();
      } else {
        setSignedAsasMessage({ type: 'error', text: res.message || 'Send failed' });
      }
    } catch (err: any) {
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to send signed ASA' });
    } finally {
      setSignedAsaRowSending((m) => ({ ...m, [row.signedAgreementId]: false }));
    }
  };

  const handleSignedAsaBulkSend = async (bulkMode: 'unsent' | 'all') => {
    if (!selectedVendor?.Id) return;
    setSignedAsasBulkLoading(bulkMode);
    setSignedAsasMessage(null);
    try {
      const trimmed = signedAsasRecipientInput.trim();
      const payload: Record<string, unknown> = { mode: bulkMode };
      if (trimmed) payload.recipients = trimmed;
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `/api/vendors/${selectedVendor.Id}/asa-agreements/send-bulk`,
        payload
      );
      if (res.success) {
        setSignedAsasMessage({ type: 'success', text: res.message || 'Bulk send complete' });
        await loadSignedAsas();
      } else {
        setSignedAsasMessage({ type: 'error', text: res.message || 'Bulk send failed' });
      }
    } catch (err: any) {
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Bulk send failed' });
    } finally {
      setSignedAsasBulkLoading(null);
    }
  };

  // Debounce search input for signed ASAs tab
  useEffect(() => {
    const t = setTimeout(() => setSignedAsasSearch(signedAsasSearchInput), 400);
    return () => clearTimeout(t);
  }, [signedAsasSearchInput]);

  // Reset to first page when filters change
  useEffect(() => {
    setSignedAsasPage(1);
  }, [signedAsasStatusFilter, signedAsasEnrollmentFilter, signedAsasSearch]);

  // Load when the Signed ASAs tab (index 10) becomes active
  useEffect(() => {
    if (currentFormTab !== 10 || !selectedVendor?.Id) return;
    loadSignedAsas();
    loadSignedAsasDefaults();
  }, [currentFormTab, selectedVendor?.Id, loadSignedAsas, loadSignedAsasDefaults]);

  /**
   * Signed ASAs panel — mirrors the VendorSettings.tsx layout so SysAdmin
   * and VendorAdmin see the same UI on /admin/vendors/:id and /vendor/settings.
   */
  const renderSignedAsasPanel = () => {
    const totalPages = Math.max(1, Math.ceil(signedAsasTotal / signedAsasLimit));
    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-lg font-medium text-gray-900">Signed ASAs</h2>
              <p className="text-sm text-gray-500 mt-1">
                Vendor Agent Service Agreements signed by groups for this vendor's products. The <strong>Email status</strong>{' '}
                column shows sent (green) vs unsent (yellow) per row. Use the filter to list only unsent or only sent.
                Automatic emails group all unsigned ASAs for the same group into one message with multiple PDFs.
              </p>
            </div>
            <button
              type="button"
              onClick={() => loadSignedAsas()}
              disabled={signedAsasLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${signedAsasLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {signedAsasMessage && (
            <div
              className={`p-3 rounded-lg flex items-start gap-2 text-sm ${
                signedAsasMessage.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-800'
              }`}
            >
              {signedAsasMessage.type === 'success' ? (
                <CheckCircle className="h-4 w-4 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 mt-0.5" />
              )}
              <div className="flex-1">{signedAsasMessage.text}</div>
              <button
                type="button"
                onClick={() => setSignedAsasMessage(null)}
                className="text-current opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Default ASA email recipients — saved on the vendor and used by the
              automatic on-sign trigger. Leave empty to fall back to the vendor's
              primary Email + notification contacts. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-900">Default ASA email recipients</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Used automatically when a group signs an ASA for this vendor. Leave empty to fall back to the vendor's
                  primary Email + notification contacts.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <input
                type="text"
                value={signedAsasDefaultInput}
                onChange={(e) => setSignedAsasDefaultInput(e.target.value)}
                placeholder="ops@vendor.com, billing@vendor.com"
                className="flex-1 min-w-[260px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              <button
                type="button"
                onClick={handleSaveSignedAsasDefault}
                disabled={signedAsasDefaultSaving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
              >
                {signedAsasDefaultSaving ? 'Saving...' : 'Save default'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {signedAsasResolvedFrom === 'asa-specific' ? (
                <>
                  <span className="font-medium text-gray-700">Currently sending to (ASA-specific):</span>{' '}
                  {signedAsasRecipientInput || '—'}
                </>
              ) : (
                <>
                  <span className="font-medium text-gray-700">Currently falling back to vendor Email + contacts:</span>{' '}
                  {signedAsasFallbackRecipients.length > 0 ? signedAsasFallbackRecipients.join(', ') : '—'}
                </>
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Filter</label>
              <select
                value={signedAsasStatusFilter}
                onChange={(e) => setSignedAsasStatusFilter(e.target.value as 'all' | 'unsent' | 'sent')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="all">All signed ASAs</option>
                <option value="unsent">Unsent only</option>
                <option value="sent">Already sent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Group enrollments</label>
              <select
                value={signedAsasEnrollmentFilter}
                onChange={(e) => setSignedAsasEnrollmentFilter(e.target.value as 'all' | 'active' | 'inactive')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="all">All groups</option>
                <option value="active">With active enrollments (sendable)</option>
                <option value="inactive">No active enrollments (skipped)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Search group</label>
              <input
                type="text"
                value={signedAsasSearchInput}
                onChange={(e) => setSignedAsasSearchInput(e.target.value)}
                placeholder="Search by group name..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Recipient email(s) for sending</label>
              <input
                type="text"
                value={signedAsasRecipientInput}
                onChange={(e) => {
                  setSignedAsasRecipientInput(e.target.value);
                  setSignedAsasRecipientEdited(true);
                }}
                placeholder="ops@example.com, another@example.com"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              <p className="text-xs text-gray-500 mt-1">
                Comma-separated. Pre-filled with the vendor's currently configured recipients — edit to override for this send.
                <br />
                <span className="text-[11px] text-gray-400">ASAs are only emailed for groups with at least one currently-active enrollment.</span>
                {signedAsasRecipientEdited && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      onClick={() => {
                        setSignedAsasRecipientEdited(false);
                        void loadSignedAsasDefaults();
                      }}
                      className="text-oe-primary hover:underline font-medium"
                    >
                      Reset to defaults
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleSignedAsaBulkSend('unsent')}
              disabled={!!signedAsasBulkLoading || signedAsasLoading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
              title="Send the signed PDF for every group that hasn't received it yet"
            >
              <Send className="h-4 w-4" />
              {signedAsasBulkLoading === 'unsent' ? 'Sending unsent...' : 'Send all unsent'}
            </button>
            <button
              type="button"
              onClick={() => handleSignedAsaBulkSend('all')}
              disabled={!!signedAsasBulkLoading || signedAsasLoading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              title="Resend the signed PDF for every group — even ones already delivered"
            >
              <Send className="h-4 w-4" />
              {signedAsasBulkLoading === 'all' ? 'Sending all...' : 'Send all (resend)'}
            </button>
          </div>

          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            {signedAsasLoading ? (
              <div className="py-12 text-center text-gray-500">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto" />
                <p className="mt-2">Loading signed ASAs...</p>
              </div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Group / Product
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Signed</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Email status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {signedAsasRows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                        {signedAsasEnrollmentFilter === 'active'
                          ? 'No signed ASAs for groups with active enrollments.'
                          : signedAsasEnrollmentFilter === 'inactive'
                            ? 'No signed ASAs for groups without active enrollments.'
                            : signedAsasStatusFilter === 'unsent'
                              ? 'No unsent signed ASAs — everything has been emailed.'
                              : 'No signed ASAs for this vendor yet.'}
                      </td>
                    </tr>
                  ) : (
                    signedAsasRows.map((row) => {
                      const sending = !!signedAsaRowSending[row.signedAgreementId];
                      const downloading = !!signedAsaRowDownloading[row.signedAgreementId];
                      const signedDateStr = row.signedDate
                        ? new Date(row.signedDate).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric'
                          })
                        : '—';
                      const sentDateStr = row.lastEmailedDate ? new Date(row.lastEmailedDate).toLocaleString() : null;
                      return (
                        <tr key={row.signedAgreementId}>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{row.groupName || '—'}</span>
                              {row.groupHasActiveEnrollments === false ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full bg-gray-100 text-gray-600 border border-gray-200"
                                  title="This group has no currently-active enrollments. Bulk and auto-trigger sends will skip this row until enrollments go live."
                                >
                                  No active enrollments
                                </span>
                              ) : row.groupHasActiveEnrollments === true ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  title="Group has at least one currently-active enrollment — eligible to send."
                                >
                                  Active enrollments
                                </span>
                              ) : null}
                            </div>
                            <div className="text-xs text-gray-500">{row.productName || '—'}</div>
                            {row.signedByName && (
                              <div className="mt-1 text-xs text-gray-500">
                                Signed by {row.signedByName}
                                {row.signedByEmail ? ` <${row.signedByEmail}>` : ''}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{signedDateStr}</td>
                          <td className="px-4 py-3 text-sm">
                            {sentDateStr ? (
                              <>
                                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                  Sent
                                </span>
                                <div className="mt-1 text-xs text-gray-500">
                                  {sentDateStr}
                                  {row.emailSendCount > 1 ? ` (×${row.emailSendCount})` : ''}
                                </div>
                                {row.lastEmailedTo && (
                                  <div
                                    className="mt-0.5 text-xs text-gray-500 truncate max-w-[240px]"
                                    title={row.lastEmailedTo}
                                  >
                                    To: {row.lastEmailedTo}
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
                                  Unsent
                                </span>
                                {row.lastEmailError && (
                                  <div
                                    className="mt-1 text-xs text-red-600 truncate max-w-[240px]"
                                    title={row.lastEmailError}
                                  >
                                    Last error: {row.lastEmailError}
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-sm whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleSignedAsaDownload(row)}
                              disabled={downloading || !row.hasSignedPdf}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 mr-2 disabled:opacity-50"
                              title={row.hasSignedPdf ? 'Download signed PDF' : 'No signed PDF attached'}
                            >
                              <Download className="h-4 w-4" />
                              {downloading ? '...' : 'Download'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSignedAsaSend(row)}
                              disabled={sending || !!signedAsasBulkLoading || row.groupHasActiveEnrollments === false}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
                              title={
                                row.groupHasActiveEnrollments === false
                                  ? 'Group has no active enrollments — sending is skipped'
                                  : row.lastEmailedDate
                                    ? 'Resend signed ASA'
                                    : 'Send signed ASA'
                              }
                            >
                              <Send className="h-4 w-4" />
                              {sending ? '...' : row.lastEmailedDate ? 'Resend' : 'Send'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>

          {signedAsasTotal > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm text-gray-600">
              <span>
                Showing {(signedAsasPage - 1) * signedAsasLimit + 1}
                –{Math.min(signedAsasPage * signedAsasLimit, signedAsasTotal)} of {signedAsasTotal}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={signedAsasPage <= 1 || signedAsasLoading}
                  onClick={() => setSignedAsasPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Previous
                </button>
                <span>
                  Page {signedAsasPage} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={signedAsasPage >= totalPages || signedAsasLoading}
                  onClick={() => setSignedAsasPage((p) => p + 1)}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Render dashboard metrics
  const renderDashboard = () => {
    if (!vendorDashboard) {
      return <Skeleton variant="rectangular" height={200} />;
    }

    return (
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 3 }}>
          <Card className="bg-gradient-to-br from-blue-500 to-blue-600 text-white">
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h6" className="font-semibold">
                    Products
                  </Typography>
                  <Typography variant="h4" className="mt-2">
                    {vendorDashboard.productCount}
                  </Typography>
                </Box>
                <InventoryIcon sx={{ fontSize: 48, opacity: 0.3, color: 'var(--oe-primary)' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid size={{ xs: 12, md: 3 }}>
          <Card className="bg-gradient-to-br from-green-500 to-green-600 text-white">
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h6" className="font-semibold">
                    Total Sales
                  </Typography>
                  <Typography variant="h4" className="mt-2">
                    {formatCurrency(vendorDashboard.totalSales)}
                  </Typography>
                </Box>
                <TrendingUpIcon sx={{ fontSize: 48, opacity: 0.3, color: 'var(--oe-primary)' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid size={{ xs: 12, md: 3 }}>
          <Card className="bg-gradient-to-br from-orange-500 to-orange-600 text-white">
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h6" className="font-semibold">
                    Pending Payments
                  </Typography>
                  <Typography variant="h4" className="mt-2">
                    {formatCurrency(vendorDashboard.pendingPayments)}
                  </Typography>
                </Box>
                <AttachMoneyIcon sx={{ fontSize: 48, opacity: 0.3, color: 'var(--oe-primary)' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid size={{ xs: 12, md: 3 }}>
          <Card className="bg-gradient-to-br from-purple-500 to-purple-600 text-white">
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box>
                  <Typography variant="h6" className="font-semibold">
                    YTD Payments
                  </Typography>
                  <Typography variant="h4" className="mt-2">
                    {formatCurrency(vendorDashboard.totalPaymentsYTD)}
                  </Typography>
                </Box>
                <ReceiptIcon sx={{ fontSize: 48, opacity: 0.3, color: 'var(--oe-primary)' }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    );
  };

  // Render products tab
  const renderProducts = () => {
    return (
      <Box>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h6">Products</Typography>
          <button
            type="button"
            onClick={handleAddProductClick}
            className="btn-primary inline-flex items-center gap-2 focus-ring"
          >
            <Plus className="h-4 w-4 shrink-0 text-white" aria-hidden />
            Add Product
          </button>
        </Box>
        
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Product Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {vendorProducts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    No products found
                  </TableCell>
                </TableRow>
              ) : (
                vendorProducts.map((product) => (
                  <TableRow key={product.ProductId}>
                    <TableCell>{product.ProductName}</TableCell>
                    <TableCell>{product.ProductType}</TableCell>
                    <TableCell>
                      {(() => {
                        const status = product.Status || 'Unknown';
                        const chipColor =
                          status === 'Active'
                            ? 'success'
                            : status === 'Inactive'
                            ? 'default'
                            : 'warning';
                        return (
                          <Chip
                            label={status}
                            color={chipColor}
                            size="small"
                          />
                        );
                      })()}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="Edit product">
                        <IconButton
                          size="small"
                          color="primary"
                          onClick={() => handleEditVendorProduct(product)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  /** Payment history table (shown on Payment Info tab with ACH editor) */
  const renderVendorPaymentHistory = () => (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm mt-6">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-sm font-medium text-gray-900">Payment History</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-3">Date</th>
              <th scope="col" className="px-4 py-3">Reference #</th>
              <th scope="col" className="px-4 py-3 text-right">Amount</th>
              <th scope="col" className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {vendorPayments.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-gray-500">
                  No payment history found.
                </td>
              </tr>
            ) : (
              vendorPayments.map((payment) => (
                <tr key={payment.PaymentId}>
                  <td className="px-4 py-3 text-gray-700">{formatDate(payment.PaymentDate)}</td>
                  <td className="px-4 py-3 text-gray-700">{payment.ReferenceNumber || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-900">{formatCurrency(payment.Amount)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${getPaymentStatusClasses(
                        payment.Status
                      )}`}
                    >
                      {payment.Status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderVendorNavigation = () => {
    return (
      <Box>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Box>
            <Typography variant="h6">Member Pages</Typography>
            <Typography variant="body2" color="textSecondary">
              Extra pages and links in the member portal for enrolled members (visibility rules apply).
            </Typography>
          </Box>
          <button
            type="button"
            onClick={() => handleOpenNavigationModal('create')}
            className="btn-primary inline-flex items-center gap-2 focus-ring"
          >
            <Plus className="h-4 w-4 shrink-0 text-white" aria-hidden />
            Add page
          </button>
        </Box>

        {vendorNavigationPages.length > 0 ? (
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Label</TableCell>
                  <TableCell>Route Key</TableCell>
                  <TableCell>Content Type</TableCell>
                  <TableCell>Content</TableCell>
                  <TableCell>Scope</TableCell>
                  <TableCell>Sort Order</TableCell>
                  <TableCell>Effective</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="center">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {vendorNavigationPages.map((page) => (
                  <TableRow key={page.vendorNavigationPageId}>
                    <TableCell>{page.label}</TableCell>
                    <TableCell>{page.routeKey}</TableCell>
                    <TableCell>{page.contentType}</TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                        {page.contentRef}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {page.tenantId ? page.tenantName || 'Tenant-specific' : 'All tenants'}
                    </TableCell>
                    <TableCell>{page.sortOrder ?? 0}</TableCell>
                    <TableCell>
                      {page.effectiveDate ? new Date(page.effectiveDate).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      {page.expirationDate ? new Date(page.expirationDate).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={page.published ? 'Published' : 'Draft'}
                        color={page.published ? 'success' : 'default'}
                        size="small"
                      />
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="Edit page">
                        <IconButton size="small" sx={{ color: 'var(--oe-primary)' }} onClick={() => handleOpenNavigationModal('edit', page)}>
                          <EditIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete page">
                        <IconButton size="small" color="error" onClick={() => handleDeleteNavigationPage(page)}>
                          <DeleteIcon fontSize="inherit" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Box
            display="flex"
            alignItems="center"
            justifyContent="center"
            flexDirection="column"
            minHeight={200}
            bgcolor="background.paper"
            borderRadius={1}
            border="1px dashed"
            borderColor="divider"
          >
            <Typography variant="subtitle1" color="textSecondary">
              No vendor navigation pages configured yet.
            </Typography>
            <Typography variant="body2" color="textSecondary">
              Use the “Add Navigation Page” button to create the first entry for this vendor.
            </Typography>
          </Box>
        )}
      </Box>
    );
  };

  if (mode === 'detail' && detailError) {
    return (
      <div className="flex h-screen flex-col bg-oe-neutral-light">
        <SharedHeader title="Vendor" showSearch={false} showNotifications onSearch={() => {}} />
        <div className="flex-1 overflow-auto p-6">
          <p className="text-red-600 mb-4">{detailError}</p>
          {!isVendorPortal && (
            <Link to="/admin/vendors" className="text-oe-primary font-medium">
              ← Back to Vendors
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (mode === 'detail' && (detailLoading || !selectedVendor)) {
    return (
      <div className="flex h-screen flex-col bg-oe-neutral-light">
        <SharedHeader title="Loading vendor…" showSearch={false} showNotifications onSearch={() => {}} />
        <div className="flex-1 overflow-auto p-6">
          <Skeleton variant="rectangular" height={400} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-oe-neutral-light">
      {/* Admin Navigation */}
      {/* <AdminNavigation
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        currentUser={{
          firstName: 'Admin',
          lastName: 'User',
          email: 'admin@openenroll.com',
          role: 'SysAdmin'
        }}
      /> */}
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Shared Header */}
        <SharedHeader 
          title={mode === 'detail' && selectedVendor ? selectedVendor.VendorName : 'Vendors'}
          showSearch={mode === 'list'}
          showNotifications={true}
          onSearch={handleSearch}
          backTo={mode === 'detail' && selectedVendor && !isVendorPortal ? '/admin/vendors' : undefined}
          backLabel="Vendors"
        />
        
        {/* Page Content — detail mode fills main column only (no fullscreen portal) so AdminLayout sidebar stays visible */}
        <div
          className={
            mode === 'detail'
              ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
              : 'flex-1 overflow-auto'
          }
        >
          {mode === 'list' && (
          <Box className="p-6">
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
              <Box display="flex" gap={2}>
                <button
                  type="button"
                  onClick={() => handleOpenDialog()}
                  className="btn-primary inline-flex items-center gap-2 focus-ring"
                >
                  <Plus className="h-4 w-4 shrink-0 text-white" aria-hidden />
                  Add Vendor
                </button>
              </Box>
            </Box>

            {loading ? (
              <Box>
                <Skeleton variant="rectangular" height={400} />
              </Box>
            ) : (
              <TableContainer component={Paper} className="shadow-lg">
                <Table>
                  <TableHead>
                    <TableRow className="bg-gray-50">
                      <TableCell className="font-semibold">Vendor Name</TableCell>
                      <TableCell className="font-semibold">Contact</TableCell>
                      <TableCell className="font-semibold">Email</TableCell>
                      <TableCell className="font-semibold">Phone</TableCell>
                      <TableCell className="font-semibold">City, State</TableCell>
                      <TableCell align="center" className="font-semibold">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {vendors.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" className="py-8">
                          <Typography variant="body1" color="textSecondary">
                            No vendors found. Click "Add Vendor" to create your first vendor.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      vendors.map((vendor) => (
                        <TableRow key={vendor.Id} hover>
                          <TableCell className="font-medium">{vendor.VendorName}</TableCell>
                          <TableCell>{vendor.ContactName || '-'}</TableCell>
                          <TableCell>{vendor.Email || '-'}</TableCell>
                          <TableCell>{vendor.Phone || '-'}</TableCell>
                          <TableCell>
                            {vendor.City && vendor.State ? `${vendor.City}, ${vendor.State}` : '-'}
                          </TableCell>
                          <TableCell align="center">
                            <Tooltip title="Manage vendor">
                              <IconButton
                                size="small"
                                sx={{ color: 'var(--oe-primary)' }}
                                onClick={() => navigate(`/admin/vendors/${vendor.Id}`)}
                              >
                                <Settings className="h-5 w-5" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {/* Pagination Controls */}
            {vendors.length > 0 && (
              <Box className="mt-4 flex justify-between items-center">
                <Box className="flex items-center gap-4">
                  <Typography variant="body2" color="textSecondary">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} to {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} vendors
                  </Typography>
                  <FormControl size="small" sx={{ minWidth: 80 }}>
                    <InputLabel>Per page</InputLabel>
                    <Select
                      value={pagination.limit}
                      onChange={(e) => handleLimitChange(Number(e.target.value))}
                      label="Per page"
                    >
                      <MenuItem value={10}>10</MenuItem>
                      <MenuItem value={25}>25</MenuItem>
                      <MenuItem value={50}>50</MenuItem>
                      <MenuItem value={100}>100</MenuItem>
                    </Select>
                  </FormControl>
                </Box>
                
                <Box className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pagination.page <= 1}
                    onClick={() => handlePageChange(pagination.page - 1)}
                    className="btn-secondary focus-ring"
                  >
                    Previous
                  </button>
                  <Typography variant="body2" className="px-2">
                    Page {pagination.page} of {pagination.totalPages}
                  </Typography>
                  <button
                    type="button"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => handlePageChange(pagination.page + 1)}
                    className="btn-secondary focus-ring"
                  >
                    Next
                  </button>
                </Box>
              </Box>
            )}
          </Box>
          )}

            {/* Add/Edit Vendor Dialog - Refactored with Tabs (detail route: inline, not fullScreen portal, so admin nav remains) */}
            <Dialog
              open={(mode === 'detail' && !!selectedVendor) || openDialog}
              onClose={handleCloseDialog}
              maxWidth={mode === 'detail' ? false : 'md'}
              fullWidth
              fullScreen={false}
              disablePortal={mode === 'detail'}
              hideBackdrop={mode === 'detail'}
              sx={
                mode === 'detail'
                  ? {
                      // Modal defaults to position:fixed + inset:0 (covers sidebar); keep workspace in main column only
                      position: 'static !important',
                      top: 'auto !important',
                      right: 'auto !important',
                      bottom: 'auto !important',
                      left: 'auto !important',
                      zIndex: 0,
                      height: '100%',
                      minHeight: 0,
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      '& .MuiDialog-container': {
                        position: 'static',
                        height: '100%',
                        minHeight: 0,
                        alignItems: 'stretch',
                        justifyContent: 'flex-start',
                      },
                      '& .MuiDialog-paper': {
                        boxShadow: 'none',
                      },
                    }
                  : undefined
              }
              PaperProps={{
                sx: mode === 'detail'
                  ? {
                      borderRadius: 0,
                      overflow: 'hidden',
                      height: '100%',
                      maxHeight: 'none',
                      width: '100%',
                      maxWidth: '100%',
                      margin: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      flex: 1,
                      minHeight: 0,
                    }
                  : {
                  borderRadius: 2,
                  overflow: 'hidden',
                  height: '85vh', // Fixed height
                  minHeight: '600px', // Minimum height
                  maxHeight: '900px', // Maximum height
                  display: 'flex',
                  flexDirection: 'column'
                }
              }}
            >
              {/* Colored title bar: list/add modal only — vendor detail uses SharedHeader (vendor name + back) */}
              {!(mode === 'detail' && selectedVendor) && (
              <Box
                sx={{
                  backgroundColor: 'var(--oe-primary)',
                  color: 'white',
                  p: 3,
                  position: 'relative'
                }}
              >
                <Typography variant="h5" fontWeight="bold">
                  {selectedVendor ? 'Edit Vendor' : 'Add New Vendor'}
                </Typography>
                <IconButton
                  onClick={handleCloseDialog}
                  sx={{
                    position: 'absolute',
                    right: 8,
                    top: 8,
                    color: 'white',
                    '&:hover': {
                      backgroundColor: 'rgba(255, 255, 255, 0.1)'
                    }
                  }}
                >
                  <CloseIcon />
                </IconButton>
              </Box>
              )}

              <DialogContent sx={{ p: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {/* Tabs */}
                <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
                  <Tabs 
                    value={currentFormTab} 
                    onChange={(_, newValue) => setCurrentFormTab(newValue)}
                    variant="scrollable"
                    scrollButtons="auto"
                    sx={{
                      '& .MuiTab-root': {
                        textTransform: 'none',
                        fontWeight: 500,
                        fontSize: '14px',
                        minHeight: 48,
                        padding: '12px 16px',
                        minWidth: 'auto',
                      }
                    }}
                  >
                    <Tab label="Dashboard" />
                    <Tab label="Products" />
                    <Tab label="Documents" />
                    <Tab label="Payment Info" />
                    <Tab label="Groups" />
                    <Tab label="Eligibility" />
                    <Tab label="Member Pages" />
                    <Tab label="Scheduled jobs" />
                    <Tab label="Advanced (TPA)" />
                    <Tab label="Users" />
                    <Tab label="Signed ASAs" />
                    <Tab label="Networks" />
                    {isVendorPortal && <Tab label="Request Types" />}
                    {isVendorPortal && <Tab label="TPA Case Forwarding" />}
                    {isVendorPortal && <Tab label="Email Settings" />}
                  </Tabs>
                </Box>

                {/* Tab Panels - Scrollable */}
                <Box sx={{ flex: 1, overflow: 'auto' }}>
                {/* Tab 0: Dashboard — stats + vendor profile */}
                <TabPanel value={currentFormTab} index={0}>
                  <Box sx={{ p: 3 }}>
                    <Box sx={{ mb: 3 }}>{renderDashboard()}</Box>
                    <Grid container spacing={3}>
                      <Grid size={12}>
                        <TextField
                          fullWidth
                          label="Vendor Name"
                          value={formData.VendorName || ''}
                          onChange={(e) => setFormData({ ...formData, VendorName: e.target.value })}
                          error={!!formErrors.VendorName}
                          helperText={formErrors.VendorName}
                          required
                          sx={{ mb: 2 }}
                        />
                      </Grid>
                      
                      <Grid size={12}>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom sx={{ mt: 2, mb: 1 }}>
                          Address Information
                        </Typography>
                      </Grid>
                      
                      <Grid size={12}>
                        <TextField
                          fullWidth
                          label="Address Line 1"
                          value={formData.AddressLine1 || ''}
                          onChange={(e) => setFormData({ ...formData, AddressLine1: e.target.value })}
                          placeholder="123 Main Street"
                        />
                      </Grid>
                      
                      <Grid size={12}>
                        <TextField
                          fullWidth
                          label="Address Line 2"
                          value={formData.AddressLine2 || ''}
                          onChange={(e) => setFormData({ ...formData, AddressLine2: e.target.value })}
                          placeholder="Suite, Unit, Building, Floor, etc."
                        />
                      </Grid>
                      
                      <Grid size={{ xs: 12, md: 5 }}>
                        <TextField
                          fullWidth
                          label="City"
                          value={formData.City || ''}
                          onChange={(e) => setFormData({ ...formData, City: e.target.value })}
                        />
                      </Grid>
                      
                      <Grid size={{ xs: 12, md: 3 }}>
                        <FormControl fullWidth>
                          <InputLabel>State</InputLabel>
                          <Select
                            value={formData.State || ''}
                            onChange={(e) => setFormData({ ...formData, State: e.target.value })}
                            label="State"
                          >
                            <MenuItem value="">
                              <em>Select State</em>
                            </MenuItem>
                            {GEOGRAPHIC_US_STATES.map(state => (
                              <MenuItem key={state.code} value={state.code}>
                                {formatStateName(state.name)}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Grid>
                      
                      <Grid size={{ xs: 12, md: 4 }}>
                        <TextField
                          fullWidth
                          label="ZIP Code"
                          value={formData.Zip || ''}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 10);
                            setFormData({ ...formData, Zip: value });
                          }}
                          placeholder="12345"
                        />
                      </Grid>

                      <Grid size={12}>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom sx={{ mt: 2, mb: 1 }}>
                          Primary Contact Details
                        </Typography>
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          fullWidth
                          label="Contact Name"
                          value={formData.ContactName || ''}
                          onChange={(e) => setFormData({ ...formData, ContactName: e.target.value })}
                          placeholder="John Doe"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          fullWidth
                          label="Phone Number"
                          value={formData.Phone || ''}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '');
                            if (value.length <= 10) {
                              setFormData({ ...formData, Phone: value });
                            }
                          }}
                          error={!!formErrors.Phone}
                          helperText={formErrors.Phone || 'Format: (123) 456-7890'}
                          placeholder="1234567890"
                          InputProps={{
                            startAdornment: (
                              <InputAdornment position="start">📞</InputAdornment>
                            ),
                          }}
                        />
                      </Grid>
                      <Grid size={12}>
                        <TextField
                          fullWidth
                          label="Email Address"
                          type="email"
                          value={formData.Email || ''}
                          onChange={(e) => setFormData({ ...formData, Email: e.target.value })}
                          error={!!formErrors.Email}
                          helperText={formErrors.Email || 'We\'ll use this for vendor communications'}
                          placeholder="vendor@example.com"
                          InputProps={{
                            startAdornment: (
                              <InputAdornment position="start">✉️</InputAdornment>
                            ),
                          }}
                        />
                      </Grid>
                    </Grid>
                    {renderVendorTabSaveBar(true)}
                  </Box>
                </TabPanel>

                <TabPanel value={currentFormTab} index={1}>
                  <Box sx={{ p: 3 }}>
                    {renderProducts()}
                    {renderVendorTabSaveBar(false)}
                  </Box>
                </TabPanel>

                {/* Tab 3: Payment Information */}
                <TabPanel value={currentFormTab} index={3}>
                  <div className="space-y-6 p-6">
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-800">
                      <div className="flex items-start gap-3">
                        <Info className="mt-0.5 h-5 w-5 text-oe-primary" />
                        <div>
                          <p className="text-sm font-medium">
                            All vendor payments are processed via ACH (Automated Clearing House). Please ensure the banking information is accurate before saving.
                          </p>
                          <p className="mt-1 text-xs text-oe-primary-dark">
                            Sensitive account numbers are encrypted using our secure payment service.
                          </p>
                        </div>
                      </div>
                    </div>

                    {distributionWarning && (
                      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                        Distribution percentages must total 100%.
                      </div>
                    )}

                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-800">ACH Distribution</p>
                        <p className="text-xs text-gray-500">
                          Current allocation totals{' '}
                          <span className={summaryDistributionTotal <= 100.01 ? 'font-semibold text-green-600' : 'font-semibold text-red-600'}>
                            {summaryDistributionTotal.toFixed(2)}%
                          </span>{' '}
                          (cannot exceed 100%).
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpenAchModal({ addNew: true })}
                          className="btn-primary inline-flex items-center gap-2"
                        >
                          <Plus className="h-4 w-4 shrink-0 text-white" aria-hidden />
                          Add New ACH Account
                        </button>
                      </div>
                    </div>

                    {achAccountsLoading ? (
                      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
                        Loading ACH accounts...
                      </div>
                    ) : achAccountsForm.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600">
                        No ACH accounts configured yet. Click <span className="font-semibold text-oe-primary">Add New ACH Account</span> to get started.
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2">
                        {achAccountsForm.map((account) => (
                          <div key={account.tempId} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-gray-900">{account.accountHolderName || 'Account holder not provided'}</p>
                                <p className="text-xs text-gray-500">{account.bankName || 'Bank name not provided'}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <Tooltip title="Edit account">
                                  <IconButton size="small" sx={{ color: 'var(--oe-primary)' }} onClick={() => handleOpenAchModal({ editId: account.tempId })}>
                                    <EditIcon fontSize="inherit" />
                                  </IconButton>
                                </Tooltip>
                                <Tooltip title="Delete account">
                                  <IconButton size="small" color="error" onClick={() => handleRemoveAccount(account.tempId)}>
                                    <DeleteIcon fontSize="inherit" />
                                  </IconButton>
                                </Tooltip>
                              </div>
                            </div>
                            <div className="mt-3 grid gap-3 text-xs text-gray-600 md:grid-cols-2">
                              <div>
                                <p className="font-medium text-gray-500">Account Type</p>
                                <p className="text-gray-900">{account.accountType}</p>
                              </div>
                              <div>
                                <p className="font-medium text-gray-500">Distribution</p>
                                <p className="text-gray-900">{(Number(account.distributionPercentage) || 0).toFixed(2)}%</p>
                              </div>
                              <div>
                                <p className="font-medium text-gray-500">Routing Number</p>
                                <p className="font-mono text-gray-900">{displayRoutingNumber(account)}</p>
                              </div>
                              <div>
                                <p className="font-medium text-gray-500">Account Number</p>
                                <p className="font-mono text-gray-900">{displayAccountNumber(account)}</p>
                              </div>
                              <div>
                                <p className="font-medium text-gray-500">Status</p>
                                <p className="text-gray-900">{account.status || 'Active'}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                      Banking information is encrypted using AES-256 and stored securely. Only authorized personnel can update routing and account numbers.
                    </div>
                    {renderVendorPaymentHistory()}
                    {renderVendorTabSaveBar(false)}
                  </div>

                  <Dialog
                    open={achModalOpen}
                    onClose={handleCloseAchModal}
                    fullWidth
                    maxWidth="md"
                    PaperProps={{
                      sx: {
                        borderRadius: 2,
                        overflow: 'hidden',
                        width: '95%',
                        maxWidth: '912px'
                      }
                    }}
                  >
                    <Box
                      sx={{
                        backgroundColor: 'var(--oe-primary)',
                        color: 'white',
                        p: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <Typography variant="h6" fontWeight="bold">
                        Manage ACH Account
                      </Typography>
                      <IconButton onClick={handleCloseAchModal} sx={{ color: 'var(--oe-primary)' }}>
                        <CloseIcon />
                      </IconButton>
                    </Box>
                    <DialogContent sx={{ p: 0 }}>
                      <div className="space-y-6 p-6">
                        {achModalAccounts.map((account, index) => (
                          <div key={account.tempId} className="rounded-lg border border-gray-200 bg-white shadow-sm">
                            <div className="border-b border-gray-100 px-4 py-3">
                              <p className="text-sm font-semibold text-gray-900">ACH Account {index + 1}</p>
                            </div>

                            <div className="grid gap-4 px-4 py-5 md:grid-cols-2">
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">
                                  Account Holder Name<span className="text-red-500">*</span>
                                </label>
                                <input
                                  type="text"
                                  value={account.accountHolderName}
                                  onChange={(e) => handleModalAccountHolderChange(account.tempId, e.target.value)}
                                  className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                    achModalFieldErrors[account.tempId]?.accountHolderName ? 'border-red-300' : 'border-gray-300'
                                  }`}
                                />
                                {achModalFieldErrors[account.tempId]?.accountHolderName && (
                                  <p className="mt-1 text-sm text-red-600">
                                    {achModalFieldErrors[account.tempId]?.accountHolderName}
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">Bank Name</label>
                                <input
                                  type="text"
                                  value={account.bankName || ''}
                                  onChange={(e) => handleModalBankNameChange(account.tempId, e.target.value)}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">
                                  Company Identification (10 digits)
                                </label>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={account.companyIdentification || ''}
                                  onChange={(e) => handleModalCompanyIdentificationChange(account.tempId, e.target.value)}
                                  className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                    achModalFieldErrors[account.tempId]?.companyIdentification ? 'border-red-300' : 'border-gray-300'
                                  }`}
                                  placeholder="1234567890"
                                />
                                <p className="mt-1 text-xs text-gray-500">Optional. Used for NACHA file header.</p>
                                {achModalFieldErrors[account.tempId]?.companyIdentification && (
                                  <p className="mt-1 text-sm text-red-600">
                                    {achModalFieldErrors[account.tempId]?.companyIdentification}
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">Account Type</label>
                                <select
                                  value={account.accountType}
                                  onChange={(e) => handleModalAccountTypeChange(account.tempId, e.target.value as AchAccountType)}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                >
                                  <option value="Checking">Checking</option>
                                  <option value="Savings">Savings</option>
                                </select>
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">
                                  Distribution Percentage
                                </label>
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="0.01"
                                  value={Number.isNaN(account.distributionPercentage) ? '' : account.distributionPercentage}
                                  onChange={(e) => handleModalDistributionChange(account.tempId, e.target.value)}
                                  className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                    achModalFieldErrors[account.tempId]?.distributionPercentage ? 'border-red-300' : 'border-gray-300'
                                  }`}
                                />
                                {achModalFieldErrors[account.tempId]?.distributionPercentage && (
                                  <p className="mt-1 text-sm text-red-600">
                                    {achModalFieldErrors[account.tempId]?.distributionPercentage}
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">
                                  Routing Number<span className="text-red-500">*</span>
                                </label>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={account.routingNumber || ''}
                                  onChange={(e) => handleModalRoutingNumberChange(account.tempId, e.target.value)}
                                  className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                    achModalFieldErrors[account.tempId]?.routingNumber ? 'border-red-300' : 'border-gray-300'
                                  }`}
                                  placeholder="123456789"
                                />
                                <p className="mt-1 text-xs text-gray-500">9-digit routing number</p>
                                {achModalFieldErrors[account.tempId]?.routingNumber && (
                                  <p className="mt-1 text-sm text-red-600">
                                    {achModalFieldErrors[account.tempId]?.routingNumber}
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="mb-1 block text-sm font-medium text-gray-700">
                                  Account Number<span className="text-red-500">*</span>
                                </label>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={account.accountNumber || ''}
                                  onChange={(e) => handleModalAccountNumberChange(account.tempId, e.target.value)}
                                  className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                    achModalFieldErrors[account.tempId]?.accountNumber ? 'border-red-300' : 'border-gray-300'
                                  }`}
                                  placeholder="Enter full account number"
                                />
                                <p className="mt-1 text-xs text-gray-500">4-17 digits</p>
                                {achModalFieldErrors[account.tempId]?.accountNumber && (
                                  <p className="mt-1 text-sm text-red-600">
                                    {achModalFieldErrors[account.tempId]?.accountNumber}
                                  </p>
                                )}
                              </div>

                              <div className="md:col-span-2">
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={account.isDefault}
                                    onChange={(e) => handleModalDefaultChange(account.tempId, e.target.checked)}
                                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                                  />
                                  <span className="text-sm text-gray-700">Set as default account</span>
                                </label>
                              </div>
                            </div>
                          </div>
                        ))}

                        {(() => {
                          const existingTotal = calculateDistributionTotal(
                            achAccountsForm
                              .filter(acc => {
                                if (achModalMode === 'edit' && achModalTargetId) {
                                  return acc.tempId !== achModalTargetId;
                                }
                                return true;
                              })
                          );
                          const combinedTotal = existingTotal + modalDistributionTotal;
                          return (
                            <div className="text-sm text-gray-600 border-t border-gray-200 pt-4">
                              Combined total (all accounts):{' '}
                              <span className={combinedTotal <= 100.01 ? 'font-semibold text-green-600' : 'font-semibold text-red-600'}>
                                {combinedTotal.toFixed(2)}%
                              </span>
                              {combinedTotal > 100.01 && (
                                <span className="block text-red-600 mt-1">
                                  Total cannot exceed 100%
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </DialogContent>
                    <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-3">
                      <button
                        type="button"
                        onClick={handleCloseAchModal}
                        disabled={savingAchAccounts}
                        className="btn-secondary focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveAchModal}
                        disabled={savingAchAccounts}
                        className="btn-primary focus-ring disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {savingAchAccounts ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          'Save Accounts'
                        )}
                      </button>
                    </div>
                  </Dialog>
                </TabPanel>

                {/* Tab 2: Documents */}
                <TabPanel value={currentFormTab} index={2}>
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={3}>
                      <Grid size={12}>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                          Required Documents
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                          Upload required documents for this vendor. These documents will be available for selection when creating products.
                        </Typography>
                      </Grid>

                      <Grid size={12}>
                        <Card variant="outlined">
                          <CardContent>
                            <Typography variant="h6" gutterBottom>
                              Upload Documents
                            </Typography>
                            
                            {/* File Upload Area with Drag and Drop */}
                            <Box
                              sx={{
                                border: '2px dashed #ccc',
                                borderRadius: 2,
                                p: 4,
                                textAlign: 'center',
                                mb: 3,
                                backgroundColor: '#fafafa',
                                position: 'relative',
                                '&:hover': {
                                  backgroundColor: '#f0f0f0',
                                  borderColor: 'var(--oe-primary)'
                                },
                                '&.drag-over': {
                                  backgroundColor: '#e3f2fd',
                                  borderColor: 'var(--oe-primary)',
                                  borderStyle: 'solid'
                                }
                              }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.currentTarget.classList.add('drag-over');
                              }}
                              onDragLeave={(e) => {
                                e.preventDefault();
                                e.currentTarget.classList.remove('drag-over');
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.currentTarget.classList.remove('drag-over');
                                
                                const files = Array.from(e.dataTransfer.files);
                                console.log('📁 Drag and drop: Files dropped:', files.map(f => ({ name: f.name, size: f.size, type: f.type })));
                                
                                if (files.length > 0) {
                                  // Create a FileList-like object to reuse existing upload handler
                                  const fileList = {
                                    length: files.length,
                                    item: (index: number) => files[index] || null,
                                    [Symbol.iterator]: function* () {
                                      for (const file of files) {
                                        yield file;
                                      }
                                    }
                                  } as FileList;
                                  
                                  // Create a fake event object to reuse existing upload handler
                                  const fakeEvent = {
                                    target: {
                                      files: fileList,
                                      value: ''
                                    }
                                  } as unknown as React.ChangeEvent<HTMLInputElement>;
                                  
                                  console.log('📁 Drag and drop: Calling handleLocalFileSelection with fake event');
                                  handleLocalFileSelection(fakeEvent);
                                }
                              }}
                            >
                              <input
                                type="file"
                                id="document-upload"
                                multiple
                                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                                style={{ display: 'none' }}
                                onChange={handleLocalFileSelection}
                              />
                              <label htmlFor="document-upload">
                                <Box sx={{ cursor: 'pointer' }}>
                                  <Typography variant="h6" gutterBottom>
                                    📁 Click to Upload or Drag & Drop Documents
                                  </Typography>
                                  <Typography variant="body2" color="text.secondary">
                                    Supported formats: PDF, DOC, DOCX, XLS, XLSX, JPG, PNG
                                  </Typography>
                                  <Typography variant="caption" display="block" sx={{ mt: 1 }}>
                                    Maximum file size: {MAX_DOCUMENT_UPLOAD_MB}MB per file
                                  </Typography>
                                </Box>
                              </label>
                            </Box>

                            {/* Upload Progress */}
                            {uploadingDocuments && (
                              <Box sx={{ mb: 3, p: 2, backgroundColor: '#e3f2fd', borderRadius: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Box sx={{ 
                                  width: 20, 
                                  height: 20, 
                                  border: '2px solid #1976d2', 
                                  borderTop: '2px solid transparent', 
                                  borderRadius: '50%', 
                                  animation: 'spin 1s linear infinite',
                                  '@keyframes spin': {
                                    '0%': { transform: 'rotate(0deg)' },
                                    '100%': { transform: 'rotate(360deg)' }
                                  }
                                }} />
                                <Typography variant="body2" color="primary">
                                  Uploading documents...
                                </Typography>
                              </Box>
                            )}

                            {/* Document List */}
                            {vendorDocuments.length > 0 && (
                              <Box>
                                <Typography variant="h6" gutterBottom>
                                  Uploaded Documents
                                </Typography>
                                <TableContainer component={Paper} variant="outlined">
                                  <Table size="small">
                                    <TableHead>
                                      <TableRow>
                                        <TableCell>Document Name</TableCell>
                                        <TableCell>Type</TableCell>
                                        <TableCell>Size</TableCell>
                                        <TableCell>Status</TableCell>
                                        <TableCell>Actions</TableCell>
                                      </TableRow>
                                    </TableHead>
                                    <TableBody>
                                      {vendorDocuments.map((doc, index) => (
                                        <TableRow key={doc.DocumentId || index}>
                                          <TableCell>
                                            <Typography variant="body2" fontWeight="medium">
                                              {doc.FileName}
                                            </Typography>
                                          </TableCell>
                                          <TableCell>
                                            <Chip 
                                              label={doc.FileType?.split('/')[1]?.toUpperCase() || 'Unknown'} 
                                              size="small" 
                                              variant="outlined"
                                            />
                                          </TableCell>
                                          <TableCell>
                                            <Typography variant="body2">
                                              {(doc.FileSize / 1024 / 1024).toFixed(2)} MB
                                            </Typography>
                                          </TableCell>
                                          <TableCell>
                                            <Chip
                                              label={doc.isLocal ? 'Pending Upload' : 'Uploaded'}
                                              color={doc.isLocal ? 'warning' : 'success'}
                                              size="small"
                                              variant="outlined"
                                            />
                                          </TableCell>
                                          <TableCell>
                                            <Box sx={{ display: 'flex', gap: 1 }}>
                                              {doc.FileType?.toLowerCase().includes('pdf') && !doc.isLocal && (
                                                <Tooltip title="Edit Signature Fields">
                                                  <IconButton size="small" onClick={() => setEditingDocument(doc)}>
                                                    <PenTool className="h-5 w-5 text-oe-primary" />
                                                  </IconButton>
                                                </Tooltip>
                                              )}
                                              <Tooltip title="View Document">
                                                <IconButton 
                                                  size="small"
                                                  onClick={() => {
                                                    if (doc.Url) {
                                                      // For local files, use object URL directly
                                                      // For uploaded files, use the authenticated URL
                                                      window.open(doc.Url, '_blank');
                                                    } else {
                                                      showSnackbar('Document URL not available', 'error');
                                                    }
                                                  }}
                                                >
                                                  <ViewIcon />
                                                </IconButton>
                                              </Tooltip>
                                              <Tooltip title="Delete Document">
                                                <IconButton 
                                                  size="small"
                                                  color="error"
                                                  onClick={() => handleDeleteDocument(index)}
                                                >
                                                  <DeleteIcon />
                                                </IconButton>
                                              </Tooltip>
                                            </Box>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </TableContainer>
                              </Box>
                            )}

                            {vendorDocuments.length === 0 && !uploadingDocuments && (
                              <Box sx={{ textAlign: 'center', py: 4 }}>
                                <Typography variant="body2" color="text.secondary">
                                  No documents uploaded yet. Click above to upload required documents.
                                </Typography>
                              </Box>
                            )}
                          </CardContent>
                        </Card>
                      </Grid>
                    </Grid>
                    {renderVendorTabSaveBar(false)}
                  </Box>
                </TabPanel>

                {/* Tab 4: Groups — ID config + served groups + new group form actions */}
                <TabPanel value={currentFormTab} index={4}>
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={3}>
                      <Grid size={12}>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                          Group ID Configuration
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                          Configure Group ID prefix and seed number for automatic Group ID generation. Group IDs are product-specific for each group and only needed for groups that have products for this vendor.
                        </Typography>
                      </Grid>

                      <Grid size={6}>
                        <TextField
                          fullWidth
                          label="Group ID Prefix"
                          value={formData.GroupIdPrefix || ''}
                          onChange={(e) => setFormData({ ...formData, GroupIdPrefix: e.target.value })}
                          placeholder="90"
                          helperText="Prefix for all Group IDs (e.g., '90' for Group IDs starting with 90)"
                        />
                      </Grid>

                      <Grid size={6}>
                        <TextField
                          fullWidth
                          label="Seed Number"
                          type="number"
                          value={formData.GroupIdSeedNumber || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            setFormData({ ...formData, GroupIdSeedNumber: value ? parseInt(value, 10) : undefined });
                          }}
                          placeholder="285"
                          helperText="Starting number for the first group's Master Group ID (e.g., 285 for 90285)"
                        />
                      </Grid>

                      <Grid size={6}>
                        <TextField
                          select
                          fullWidth
                          label="Affix position"
                          value={formData.GroupIdAffixPosition || 'Prefix'}
                          onChange={(e) => {
                            const v = e.target.value === 'Suffix' ? 'Suffix' : 'Prefix';
                            setFormData({ ...formData, GroupIdAffixPosition: v });
                          }}
                          helperText="Where the prefix string sits relative to the number. Prefix → MW1001. Suffix → 1001MW. Existing IDs keep their current shape; only new IDs adopt the new affix."
                        >
                          <MenuItem value="Prefix">Before number (e.g. MW1001)</MenuItem>
                          <MenuItem value="Suffix">After number (e.g. 1001MW)</MenuItem>
                        </TextField>
                      </Grid>

                      <Grid size={6}>
                        <TextField
                          fullWidth
                          label="Increment between groups"
                          type="number"
                          value={formData.GroupIdBetweenGroupsIncrement ?? 5}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') {
                              setFormData({ ...formData, GroupIdBetweenGroupsIncrement: null });
                              return;
                            }
                            const n = parseInt(raw, 10);
                            setFormData({ ...formData, GroupIdBetweenGroupsIncrement: Number.isFinite(n) && n >= 1 ? n : null });
                          }}
                          inputProps={{ min: 1 }}
                          helperText="Numeric spacing between successive groups' Master IDs. Default 5 (ARM-style: 90500, 90505…). Set to 1 for consecutive IDs."
                        />
                      </Grid>

                      <Grid size={12}>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={!!formData.AutoGenerateVendorGroupIds}
                              onChange={(e) => setFormData({ ...formData, AutoGenerateVendorGroupIds: e.target.checked })}
                            />
                          }
                          label={
                            <Box>
                              <Typography variant="body2" fontWeight={500}>
                                Automatically assign vendor group IDs nightly
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                When enabled, a nightly job assigns vendor group IDs for groups that have at least one active enrollment on this vendor's products and don't already have a Master ID. Requires Group ID prefix/seed configuration above.
                              </Typography>
                            </Box>
                          }
                        />
                      </Grid>

                      <Grid size={12}>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 2, p: 2, bgcolor: 'info.light', borderRadius: 1 }}>
                          <strong>Note:</strong> Group ID generation patterns are vendor-specific. Configure the prefix, seed number, affix position, and increment according to each vendor's requirements. For individual (no-group) enrollments, set the product&apos;s default vendor group ID in the Add Product wizard.
                        </Typography>
                      </Grid>
                    </Grid>

                    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 3, mt: 2 }}>
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <h2 className="text-lg font-medium text-gray-900">Groups using this vendor&apos;s products</h2>
                            <p className="mt-1 text-sm text-gray-500">
                              Active groups with at least one product from this vendor. Each row shows active enrollment count and earliest effective date for enrollments on this vendor&apos;s products. Search by name or vendor group ID. Use Generate Group Form for the full prepare/review flow; PDF downloads the form. Configure the PDF field template below.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setNewGroupFormEditorModalOpen(true)}
                            className="inline-flex shrink-0 items-center gap-2 rounded-lg border-2 border-oe-primary px-4 py-2 text-sm font-medium text-oe-primary hover:bg-gray-50"
                          >
                            <FileText className="h-4 w-4" />
                            Edit new group form template
                          </button>
                        </div>

                        <div className="flex flex-col gap-4 md:flex-row md:items-end md:flex-wrap">
                          <div className="max-w-md flex-1">
                            <label className="mb-1 block text-sm font-medium text-gray-700">Filter by group</label>
                            <SearchableDropdown
                              options={vendorGroupsDropdownOptions}
                              value={vendorGroupsFilterId}
                              onChange={(value) => setVendorGroupsFilterId(value)}
                              placeholder="All groups"
                              searchPlaceholder="Search groups..."
                              useBackendSearch
                              onSearch={fetchVendorGroupsDropdownOptions}
                              loading={vendorGroupsDropdownLoading}
                              className="w-full"
                            />
                          </div>
                          <div className="max-w-xs flex-1">
                            <label className="mb-1 block text-sm font-medium text-gray-700">Active enrollments</label>
                            <select
                              value={vendorGroupsEnrollmentFilter}
                              onChange={(e) =>
                                setVendorGroupsEnrollmentFilter(e.target.value as 'all' | 'active' | 'inactive')
                              }
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-oe-primary focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            >
                              <option value="all">All groups</option>
                              <option value="active">With active enrollments</option>
                              <option value="inactive">No active enrollments</option>
                            </select>
                          </div>
                          <div className="max-w-md flex-1">
                            <label className="mb-1 block text-sm font-medium text-gray-700">Search table</label>
                            <input
                              type="text"
                              value={vendorGroupsSearchInput}
                              onChange={(e) => setVendorGroupsSearchInput(e.target.value)}
                              placeholder="Search by group name or vendor group ID..."
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-oe-primary focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            />
                          </div>
                        </div>

                        {vendorGroupsVendorIdsApplicable && (
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-xs text-gray-500">
                              Vendor group IDs are configured for this vendor. Use Generate IDs when status is Pending.
                            </p>
                            <button
                              type="button"
                              onClick={handleVendorGroupBulkGenerate}
                              disabled={vendorGroupsBulkGenLoading}
                              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-oe-primary bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {vendorGroupsBulkGenLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Hash className="h-4 w-4" />
                              )}
                              Generate IDs for filtered groups
                            </button>
                          </div>
                        )}

                        <div className="overflow-x-auto rounded-lg border border-gray-200">
                          {vendorGroupsListLoading ? (
                            <div className="py-12 text-center text-gray-500">
                              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-oe-primary" />
                              <p className="mt-2">Loading groups...</p>
                            </div>
                          ) : (
                            <table className="min-w-full divide-y divide-gray-200">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Group</th>
                                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Form generated</th>
                                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Vendor group IDs</th>
                                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-200 bg-white">
                                {vendorGroupsListRows.length === 0 ? (
                                  <tr>
                                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                                      No groups match your filters.
                                    </td>
                                  </tr>
                                ) : (
                                  vendorGroupsListRows.map((row) => {
                                    const hasActiveEnrollments = (row.householdCount ?? 0) > 0;
                                    return (
                                    <tr key={row.groupId}>
                                      <td className="px-4 py-3 text-sm text-gray-900">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span>{row.groupName}</span>
                                          {hasActiveEnrollments ? (
                                            <span
                                              className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200"
                                              title="Group has at least one currently-active enrolled household on this vendor's products."
                                            >
                                              Active enrollments
                                            </span>
                                          ) : (
                                            <span
                                              className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 border border-gray-200"
                                              title="Group has no currently-active enrolled households on this vendor's products. Auto-trigger and bulk ASA sends are skipped for this group."
                                            >
                                              No active enrollments
                                            </span>
                                          )}
                                          {row.needsAttention && (
                                            <span
                                              className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
                                              title="More than one household is enrolled on a single vendor product, so this group needs unique vendor group IDs."
                                            >
                                              Needs IDs · 2+ households
                                            </span>
                                          )}
                                        </div>
                                        <div className="mt-1 space-y-0.5 text-xs text-gray-500">
                                          <p>
                                            {row.householdCount ?? 0} enrolled household
                                            {(row.householdCount ?? 0) === 1 ? '' : 's'} on vendor products
                                          </p>
                                          <p>
                                            Earliest effective:{' '}
                                            {row.earliestEffectiveDate
                                              ? new Date(`${row.earliestEffectiveDate}T12:00:00`).toLocaleDateString()
                                              : '—'}
                                          </p>
                                        </div>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span
                                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                            row.hasFormHistory ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                                          }`}
                                        >
                                          {row.hasFormHistory ? 'Yes' : 'Not yet'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span
                                          className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                            row.vendorGroupIdsStatus === 'generated'
                                              ? 'bg-green-100 text-green-800'
                                              : row.vendorGroupIdsStatus === 'pending'
                                                ? 'bg-yellow-100 text-yellow-800'
                                                : 'bg-gray-100 text-gray-600'
                                          }`}
                                        >
                                          {row.vendorGroupIdsStatus === 'generated'
                                            ? 'Generated'
                                            : row.vendorGroupIdsStatus === 'pending'
                                              ? 'Pending'
                                              : row.vendorGroupIdsStatus === 'not_required'
                                                ? 'Not required'
                                                : row.vendorGroupIdsStatus}
                                        </span>
                                      </td>
                                      <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setNewGroupFormModalGroup({ groupId: row.groupId, groupName: row.groupName })
                                          }
                                          className="mr-2 inline-flex items-center gap-1 rounded-lg border-2 px-3 py-1.5 hover:bg-gray-50"
                                          style={{ borderColor: 'var(--oe-primary)', color: 'var(--oe-primary)' }}
                                        >
                                          <FileDown className="h-4 w-4" />
                                          Generate Group Form
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleVendorGroupPdf(row)}
                                          disabled={!!vendorGroupsPdfLoadingId}
                                          className="mr-2 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                        >
                                          <Download className="h-4 w-4" />
                                          {vendorGroupsPdfLoadingId === row.groupId
                                            ? '...'
                                            : row.hasFormHistory
                                              ? 'Download PDF'
                                              : 'Generate PDF'}
                                        </button>
                                        {vendorGroupsVendorIdsApplicable && row.vendorGroupIdsStatus === 'pending' && (
                                          <button
                                            type="button"
                                            onClick={() => handleVendorGroupGenerateIds(row)}
                                            disabled={!!vendorGroupsGenIdsLoadingId}
                                            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
                                          >
                                            <Hash className="h-4 w-4" />
                                            {vendorGroupsGenIdsLoadingId === row.groupId ? '...' : 'Generate IDs'}
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                    );
                                  })
                                )}
                              </tbody>
                            </table>
                          )}
                        </div>

                        {vendorGroupsListTotal > 0 && (
                          <div className="flex flex-col gap-2 text-sm text-gray-600 sm:flex-row sm:items-center sm:justify-between">
                            <span>
                              Showing {(vendorGroupsListPage - 1) * vendorGroupsListLimit + 1}–
                              {Math.min(vendorGroupsListPage * vendorGroupsListLimit, vendorGroupsListTotal)} of{' '}
                              {vendorGroupsListTotal}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={vendorGroupsListPage <= 1 || vendorGroupsListLoading}
                                onClick={() => setVendorGroupsListPage((p) => Math.max(1, p - 1))}
                                className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Previous
                              </button>
                              <span>
                                Page {vendorGroupsListPage} of{' '}
                                {Math.max(1, Math.ceil(vendorGroupsListTotal / vendorGroupsListLimit))}
                              </span>
                              <button
                                type="button"
                                disabled={
                                  vendorGroupsListPage >= Math.ceil(vendorGroupsListTotal / vendorGroupsListLimit) ||
                                  vendorGroupsListLoading
                                }
                                onClick={() => setVendorGroupsListPage((p) => p + 1)}
                                className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </Box>

                    {renderVendorTabSaveBar(false)}
                  </Box>
                </TabPanel>

                {/* Tab 5: Eligibility */}
                <TabPanel value={currentFormTab} index={5}>
                  <Box sx={{ p: 3 }}>
                    <Grid container spacing={3}>
                      <Grid size={12}>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                          Export Configuration
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                          Configure how data is exported to this vendor (SFTP or API). Email notifications can be sent when SFTP files are uploaded.
                        </Typography>
                      </Grid>

                      {/* Export Method Selection */}
                      <Grid size={12}>
                        <FormControl fullWidth>
                          <InputLabel>Export Method</InputLabel>
                          <Select
                            value={formData.ExportMethod || ''}
                            onChange={(e) => setFormData({ ...formData, ExportMethod: e.target.value })}
                            label="Export Method"
                          >
                            <MenuItem value="">None</MenuItem>
                            <MenuItem value="SFTP">SFTP</MenuItem>
                            <MenuItem value="API">API</MenuItem>
                          </Select>
                        </FormControl>
                      </Grid>

                      <Grid size={12}>
                        <Alert severity="info" sx={{ py: 1 }}>
                          <Typography variant="body2">
                            Automated export schedules (daily / weekly / monthly) are configured on the{' '}
                            <strong>Scheduled jobs</strong> tab.
                          </Typography>
                        </Alert>
                      </Grid>

                      {/* Only include enrollment changes (default on) */}
                      <Grid size={12}>
                        <FormControlLabel
                          control={
                            <Switch
                              checked={formData.EligibilityIncludeOnlyChanges !== false}
                              onChange={(e) => setFormData({ ...formData, EligibilityIncludeOnlyChanges: e.target.checked })}
                            />
                          }
                          label="Only include enrollment changes"
                        />
                        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                          When on, each file contains only new enrollments and terminations since the last file sent. When off, send full snapshot every time.
                        </Typography>
                      </Grid>

                      {/* Future effective days: include enrollments with effective date up to N days ahead (0 = none, default 7) */}
                      <Grid size={12}>
                        <TextField
                          size="small"
                          type="number"
                          inputProps={{ min: 0, max: 365, step: 1 }}
                          label="Future effective days"
                          value={formData.EligibilityFutureEffectiveDays ?? 7}
                          onChange={(e) => {
                            const v = e.target.value === '' ? undefined : parseInt(e.target.value, 10);
                            setFormData({ ...formData, EligibilityFutureEffectiveDays: v != null && !Number.isNaN(v) ? Math.max(0, v) : 7 });
                          }}
                          sx={{ minWidth: 120 }}
                          helperText="After the export anchor date, include enrollments effective within this many additional days (0 = none). When you open this vendor, the manual &quot;Effective before or on&quot; picker defaults to today + this number (you can edit it)."
                        />
                      </Grid>

                      {/* Minimum employees per group */}
                      <Grid size={12}>
                        <TextField
                          size="small"
                          type="number"
                          inputProps={{ min: 0, step: 1 }}
                          label="Minimum employees per group"
                          value={formData.MinimumEmployeesPerGroup ?? ''}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              MinimumEmployeesPerGroup: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          sx={{ minWidth: 200 }}
                          helperText="Leave blank for no minimum. Example: Tall Tree = 5. Groups below this number receive automated warnings and enrollment locks before their effective date."
                        />
                      </Grid>

                      {/* Show sharing-request status to members */}
                      <Grid size={12}>
                        <FormControlLabel
                          control={
                            <Switch
                              checked={!!formData.ShowShareRequestStatusToMembers}
                              onChange={(e) => setFormData({ ...formData, ShowShareRequestStatusToMembers: e.target.checked })}
                            />
                          }
                          label="Show sharing-request status to members"
                        />
                        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                          When on, members subscribed to this vendor's products see a status progress bar for their sharing requests in the member portal.
                        </Typography>
                      </Grid>

                      {/* Primary member rows: one per product (default) vs one row per primary */}
                      <Grid size={12}>
                        <FormControl size="small" sx={{ minWidth: 360 }}>
                          <InputLabel id="eligibility-primary-grain-label">Primary member rows in eligibility file</InputLabel>
                          <Select
                            labelId="eligibility-primary-grain-label"
                            label="Primary member rows in eligibility file"
                            value={formData.EligibilityPrimaryExportGrain === 'SinglePrimaryRow' ? 'SinglePrimaryRow' : 'PerProduct'}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                EligibilityPrimaryExportGrain: e.target.value === 'SinglePrimaryRow' ? 'SinglePrimaryRow' : 'PerProduct'
                              })
                            }
                          >
                            <MenuItem value="PerProduct">One row per product (default)</MenuItem>
                            <MenuItem value="SinglePrimaryRow">One row per primary only</MenuItem>
                          </Select>
                        </FormControl>
                        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                          Dependents still appear once per dependent. When &quot;one row per primary only&quot; is selected, multiple product enrollments collapse to a single row using the same tie-break rules as duplicate enrollments (latest enrollment date, then active, then modified date).
                        </Typography>
                      </Grid>

                      {/* Eligibility date format: Short (M/d/yyyy) vs Padded (MM/dd/yyyy) vs Compact (MMDDYYYY) */}
                      <Grid size={12}>
                        <FormControl size="small" sx={{ minWidth: 280 }}>
                          <InputLabel id="eligibility-date-format-label">Eligibility date format</InputLabel>
                          <Select
                            labelId="eligibility-date-format-label"
                            label="Eligibility date format"
                            value={formData.EligibilityDateFormat || 'ARM'}
                            onChange={(e) => setFormData({ ...formData, EligibilityDateFormat: e.target.value as string })}
                          >
                            <MenuItem value="ARM">Short — M/d/yyyy (e.g. 2/1/2025)</MenuItem>
                            <MenuItem value="Padded">Zero-padded — MM/dd/yyyy (e.g. 02/01/2025)</MenuItem>
                            <MenuItem value="TwoDigitYear">Short year — M/d/yy (e.g. 11/8/75)</MenuItem>
                            <MenuItem value="Compact">Compact — MMDDYYYY (e.g. 02012025)</MenuItem>
                          </Select>
                        </FormControl>
                        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                          Applies to all date columns (Enrollment Date, Termination Date, DoB, Date Of Hire, etc.). Short (no leading zeros) is the default; use Padded for vendors like Sharewell that expect 02/01/2025.
                        </Typography>
                      </Grid>

                      {/* Include vendors: which vendors' product enrollments to include in this eligibility file */}
                      {selectedVendor && (
                        <Grid size={12}>
                          <Typography variant="subtitle2" fontWeight="bold" sx={{ mb: 0.5 }}>
                            Include vendors
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                            Include product enrollments from these vendors in the eligibility file (same format; households are those with at least one enrollment with the current vendor). The current vendor is always included.
                          </Typography>
                          <Box sx={{ display: 'flex', flexDirection: 'column', flexWrap: 'wrap', gap: 0.5, maxHeight: 200 }}>
                            {vendors.map((v) => {
                              const isCurrent = v.Id === selectedVendor.Id;
                              const selected = (formData.EligibilityIncludeVendorIds || []).includes(v.Id);
                              return (
                                <FormControlLabel
                                  key={v.Id}
                                  control={
                                    <Checkbox
                                      checked={isCurrent || selected}
                                      disabled={isCurrent}
                                      onChange={(e) => {
                                        if (isCurrent) return;
                                        const list = formData.EligibilityIncludeVendorIds || [];
                                        const others = list.filter((id) => id !== selectedVendor.Id);
                                        if (e.target.checked) {
                                          setFormData({ ...formData, EligibilityIncludeVendorIds: [selectedVendor.Id, ...others, v.Id].filter((id, i, a) => a.indexOf(id) === i) });
                                        } else {
                                          setFormData({ ...formData, EligibilityIncludeVendorIds: [selectedVendor.Id, ...others.filter((id) => id !== v.Id)] });
                                        }
                                      }}
                                    />
                                  }
                                  label={v.VendorName || v.Id}
                                />
                              );
                            })}
                          </Box>
                        </Grid>
                      )}

                      {/* Last eligibility file sent */}
                      {formData.lastEligibilityFileSentAt && (
                        <Grid size={12}>
                          <Typography variant="body2" color="text.secondary">
                            Last eligibility file sent: {new Date(formData.lastEligibilityFileSentAt).toLocaleString()}
                          </Typography>
                        </Grid>
                      )}

                      {/* Eligibility row template (custom CSV format) */}
                      <Grid size={12}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, borderTop: 1, borderColor: 'divider', pt: 2, flexWrap: 'wrap' }}>
                          <Typography variant="subtitle2" fontWeight="bold">
                            Eligibility Row Template
                          </Typography>
                          {formData.Id && (
                            <Button
                              size="small"
                              variant="outlined"
                              color="secondary"
                              startIcon={<Sparkles className="w-4 h-4" />}
                              onClick={() => setEligibilityAiChatOpen(true)}
                              sx={{ ml: 'auto' }}
                            >
                              Edit with AI
                            </Button>
                          )}
                          {formData.EligibilityRowTemplate?.trim() && (
                            <Tooltip
                              title={eligibilityTemplateErrors.length > 0
                                ? `Invalid placeholders: ${eligibilityTemplateErrors.join(', ')}`
                                : 'All placeholders are valid'}
                            >
                              <Chip
                                size="small"
                                label={eligibilityTemplateErrors.length === 0 ? '0 errors' : `${eligibilityTemplateErrors.length} error${eligibilityTemplateErrors.length !== 1 ? 's' : ''}`}
                                color={eligibilityTemplateErrors.length === 0 ? 'default' : 'error'}
                                variant="outlined"
                                sx={{ cursor: 'help' }}
                              />
                            </Tooltip>
                          )}
                        </Box>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 1 }}>
                          Optional. Define CSV row format with placeholders. Leave empty to use default column format. Column order = order you type. Use {'{PlaceholderName:Header Label}'} to customize column headers (e.g. {'{LastName:Last Name}'}). Example: {'{VendorGroupID},{HouseholdMemberID},{ProductName},{LastName},{FirstName}'}. Modifiers on the name segment (before the colon): {'(replace=from,to)'}, {'(nocomma)'}, and {'(dateOffset=M/D/Y)'} — use _ in a segment to keep that part from the source date (e.g. {'_/1/_'} = first of month; {'5/1/_'} = May 1, same year). Respects Eligibility date format (ARM/Padded/Compact).
                        </Typography>
                        <TextField
                          fullWidth
                          multiline
                          minRows={2}
                          label="Row template"
                          value={formData.EligibilityRowTemplate || ''}
                          onChange={(e) => setFormData({ ...formData, EligibilityRowTemplate: e.target.value })}
                          placeholder="{VendorGroupID},{HouseholdMemberID},{LastName:Last Name},{FirstName:First Name},{EnrollmentDate},{TerminationDate}"
                          helperText="Insert placeholders below; comma-separated for CSV columns"
                          error={eligibilityTemplateErrors.length > 0}
                        />
                        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            onClick={() => setFormData({
                              ...formData,
                              EligibilityRowTemplate: '{RecordType:Record Type},{VendorGroupID:Group Number},{LocationNumber:Location Number},{EmployeeOrDependent:Employee Or Dependent},{EmployeeSSN:Employee SSN},{DependentSSN:Dependent SSN},{RestrictSSN:Restrict SSN},{AlternateID:Alternate ID},{RestrictedEmployee:Restricted Employee},{LastName:Last Name},{FirstName:First Name},{MiddleInitial:Middle Initial},{NameSuffix:Name Suffix},{Gender:Gender},{EmployeeDateOfBirth:Employee Date Of Birth},{DependentDateOfBirth:Dependent Date of Birth},{AgeIndependent:Age Independent},{DateOfHire:Date of Hire},{EnrollmentDate:Enrollment Date},{TerminationDate:Termination Date},{EligibilityChangeEffectiveDate:Eligibility Change Effective Date},{AddressLine1:1st Address Line},{AddressLine2:2nd Address Line},{InternationalAddressFlag:International Address Flag},{City:City},{State:State},{ZipCode:Zip Code},{Country:Country},{CountryCode:Country Code},{Language:Language},{HomePhone:Home Phone},{WorkPhone:Work Phone},{CellPhone:Cell Phone},{FaxNumber:Fax Number},{Email:Email},{Retiree:Retiree},{DisabilityEmployee:Disability Employee},{COBRAEmployee:COBRA Employee},{DependentLifeCoverage:Dependent Life Coverage},{MarriageStatus:Marriage Status},{MarriageDate:Marriage Date},{RelationshipCode:Relationship Code},{DomesticPartner:Domestic Partner},{MedicalEligibility:Medical Eligibility},{MedicalCOB:Medical COB},{DentalEligibility:Dental Eligibility},{DentalCOB:Dental COB},{VisionEligibility:Vision Eligibility},{VisionCOB:Vision COB},{DrugEligibility:Drug Eligibility},{DrugCOB:Drug COB},{MiscellaneousEligibility:Miscellaneous Eligibility},{MiscellaneousCOB:Miscellaneous COB},{LifeEligibility:Life Eligibility},{LifeCOB:Life COB},{LTDEligibility:LTD Eligibility},{STDEligibility:STD Eligibility}'
                            })}
                            sx={{ mb: 1.5 }}
                          >
                            Default format (Record Type first)
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            onClick={() => setFormData({
                              ...formData,
                              EligibilityRowTemplate: '{VendorGroupID:Group Number},{LocationNumber:Location Number},{EmployeeOrDependent:Employee Or Dependent},{EmployeeSSN:Employee SSN},{DependentSSN:Dependent SSN},{RestrictSSN:Restrict SSN},{AlternateID:Alternate ID},{RestrictedEmployee:Restricted Employee},{LastName:Last Name},{FirstName:First Name},{MiddleInitial:Middle Initial},{NameSuffix:Name Suffix},{Gender:Gender},{EmployeeDateOfBirth:Employee Date Of Birth},{DependentDateOfBirth:Dependent Date of Birth},{AgeIndependent:Age Independent},{DateOfHire:Date of Hire},{EnrollmentDate:Enrollment Date},{TerminationDate:Termination Date},{EligibilityChangeEffectiveDate:Eligibility Change Effective Date},{AddressLine1:1st Address Line},{AddressLine2:2nd Address Line},{InternationalAddressFlag:International Address Flag},{City:City},{State:State},{ZipCode:Zip Code},{Country:Country},{CountryCode:Country Code},{Language:Language},{HomePhone:Home Phone},{WorkPhone:Work Phone},{CellPhone:Cell Phone},{FaxNumber:Fax Number},{Email:Email},{Retiree:Retiree},{DisabilityEmployee:Disability Employee},{COBRAEmployee:COBRA Employee},{DependentLifeCoverage:Dependent Life Coverage},{MarriageStatus:Marriage Status},{MarriageDate:Marriage Date},{RelationshipCodeARM:Relationship Code},{DomesticPartner:Domestic Partner},{MedicalEligibility:Medical Eligibility},{MedicalCOB:Medical COB},{DentalEligibility:Dental Eligibility},{DentalCOB:Dental COB},{VisionEligibility:Vision Eligibility},{VisionCOB:Vision COB},{DrugEligibility:Drug Eligibility},{DrugCOB:Drug COB},{MiscellaneousEligibility:Miscellaneous Eligibility},{MiscellaneousCOB:Miscellaneous COB},{LifeEligibility:Life Eligibility},{LifeCOB:Life COB},{LTDEligibility:LTD Eligibility},{STDEligibility:STD Eligibility}'
                            })}
                            sx={{ mb: 1.5 }}
                          >
                            Default format (source of truth: Group # first, Relationship S/P/C)
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            onClick={() => setFormData({
                              ...formData,
                              EligibilityRowTemplate: SHAREWELL_24_COLUMN_TEMPLATE,
                              EligibilityDateFormat: 'Padded',
                              EligibilityIntegrationPartner: formData.EligibilityIntegrationPartner?.trim() || 'AB365'
                            })}
                            sx={{ mb: 1.5 }}
                          >
                            ShareWELL format (24 columns)
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            onClick={() => setFormData({
                              ...formData,
                              EligibilityRowTemplate: AB365_OPTIONAL_MULTI_PRODUCT_TEMPLATE,
                              EligibilityDateFormat: 'Padded',
                              EligibilityIntegrationPartner: formData.EligibilityIntegrationPartner?.trim() || 'AB365'
                            })}
                            sx={{ mb: 1.5 }}
                          >
                            AB365 Multi-Product (optional columns)
                          </Button>
                          {formData.Id && (
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => {
                                setSampleCsvMemberId(null);
                                setSampleCsvError(null);
                                setSampleCsvMembers([]);
                                setSampleCsvModalOpen(true);
                              }}
                            >
                              Create sample CSV
                            </Button>
                          )}
                          {selectedVendor && (
                            <Button
                              variant="contained"
                              size="small"
                              sx={{
                                backgroundColor: 'var(--oe-primary)',
                                '&:hover': { backgroundColor: '#125e82' },
                                '& .MuiButton-startIcon': { color: 'white' },
                              }}
                              startIcon={<Send className="h-4 w-4" style={{ color: 'white' }} />}
                              onClick={async () => {
                                setEligibilityHistoryModalOpen(true);
                                setEligibilityFilesLoading(true);
                                try {
                                  const res = await axiosInstance.get(`/api/vendors/${selectedVendor.Id}/eligibility-export-files`);
                                  if (res.data.success) setEligibilityFiles(res.data.data || []);
                                } catch (e) {
                                  showSnackbar('Failed to load eligibility file history', 'error');
                                } finally {
                                  setEligibilityFilesLoading(false);
                                }
                              }}
                            >
                              Generate Eligibility CSV
                            </Button>
                          )}
                          {[
                            {
                              label: 'Vendor, group & product',
                              subtitle: 'Which system each value comes from',
                              placeholders: [
                                { ph: 'VendorGroupID', pertainsTo: 'Vendor: Group ID we send (from Group Product Vendor Group Ids for this group+product)' },
                                { ph: 'NetworkTitle', pertainsTo: 'Vendor: Network title chosen for this group (or household for individuals); blank when no override. Including this in the template re-flags members on next export when the network changes.' },
                                { ph: 'LocationNumber', pertainsTo: 'Vendor / group: Location number (we typically send blank)' },
                                { ph: 'BillType', pertainsTo: 'Member: LB if member has GroupId, SB if not' },
                                { ph: 'RecordType', pertainsTo: 'Export: New or Terminated (set by change-only run)' },
                                { ph: 'ProductName', pertainsTo: 'Product: Plan name from the member’s enrollment' }
                              ]
                            },
                            { label: 'AB365 optional multi-product', placeholders: ['ABProductID', 'ABBenefitIdOverride', 'RelationshipFullText', 'ABPolicyNumber', 'ABDependentID'] },
                            { label: 'Member identifiers', placeholders: ['EmployeeOrDependent', 'EmployeeSSN', 'DependentSSN', 'RestrictSSN', 'AlternateID', 'AlternateIDBase', 'HouseholdMemberID', 'HouseholdMemberIDBase', 'MemberID', 'MemberIDBase', 'RestrictedEmployee'] },
                            { label: 'Member demographics & dates', placeholders: ['LastName', 'FirstName', 'MiddleInitial', 'NameSuffix', 'Gender', 'RelationshipCode', 'EmployeeDateOfBirth', 'DependentDateOfBirth', 'DateOfBirth', 'DOB', 'AgeIndependent', 'DateOfHire', 'EnrollmentDate', 'TerminationDate', 'EligibilityChangeEffectiveDate'] },
                            { label: 'Member address', placeholders: ['AddressLine1', 'AddressLine2', 'InternationalAddressFlag', 'City', 'State', 'ZipCode', 'Country', 'CountryCode', 'Language'] },
                            { label: 'Member contact', placeholders: ['HomePhone', 'WorkPhone', 'CellPhone', 'FaxNumber', 'Email'] },
                            { label: 'Eligibility flags', placeholders: ['MedicalEligibility', 'DentalEligibility', 'VisionEligibility', 'DrugEligibility', 'LifeEligibility', 'LTDEligibility', 'STDEligibility'] }
                          ].map((cat) => (
                            <Accordion key={cat.label} defaultExpanded={false} disableGutters sx={{ boxShadow: 'none', '&:before': { display: 'none' }, borderBottom: '1px solid', borderColor: 'divider' }}>
                              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                                <Typography variant="body2" fontWeight="600" color="text.secondary">
                                  {cat.label}
                                </Typography>
                              </AccordionSummary>
                              <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
                                {cat.subtitle && (
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                    {cat.subtitle}
                                  </Typography>
                                )}
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: cat.placeholders[0] && typeof cat.placeholders[0] === 'object' ? 2 : 0.5, alignItems: 'flex-start' }}>
                                  {cat.placeholders[0] && typeof cat.placeholders[0] === 'object'
                                    ? (cat.placeholders as { ph: string; pertainsTo: string }[]).map(({ ph, pertainsTo }) => (
                                        <Box key={ph} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}>
                                          <Button
                                            size="small"
                                            variant="outlined"
                                            onClick={() => setFormData({ ...formData, EligibilityRowTemplate: ((formData.EligibilityRowTemplate || '') + (formData.EligibilityRowTemplate && !formData.EligibilityRowTemplate.endsWith(',') ? ',' : '') + `{${ph}}`).replace(/^,/, '') })}
                                          >
                                            {'{' + ph + '}'}
                                          </Button>
                                          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 220 }}>
                                            {pertainsTo}
                                          </Typography>
                                        </Box>
                                      ))
                                    : (cat.placeholders as string[]).map((ph) => (
                                        <Button
                                          key={ph}
                                          size="small"
                                          variant="outlined"
                                          onClick={() => setFormData({ ...formData, EligibilityRowTemplate: ((formData.EligibilityRowTemplate || '') + (formData.EligibilityRowTemplate && !formData.EligibilityRowTemplate.endsWith(',') ? ',' : '') + `{${ph}}`).replace(/^,/, '') })}
                                        >
                                          {'{' + ph + '}'}
                                        </Button>
                                      ))
                                  }
                                </Box>
                              </AccordionDetails>
                            </Accordion>
                          ))}
                        </Box>

                        {/* Payables Row Template (for vendor payables export from NACHA) */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 3, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                          <Typography variant="subtitle2" fontWeight="bold">
                            Payables Row Template
                          </Typography>
                          {formData.PayablesRowTemplate?.trim() && (
                            <Tooltip
                              title={payablesTemplateErrors.length > 0
                                ? `Invalid placeholders: ${payablesTemplateErrors.join(', ')}`
                                : 'All placeholders are valid'}
                            >
                              <Chip
                                size="small"
                                label={payablesTemplateErrors.length === 0 ? '0 errors' : `${payablesTemplateErrors.length} error${payablesTemplateErrors.length !== 1 ? 's' : ''}`}
                                color={payablesTemplateErrors.length === 0 ? 'default' : 'error'}
                                variant="outlined"
                                sx={{ cursor: 'help' }}
                              />
                            </Tooltip>
                          )}
                        </Box>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, mt: 1 }}>
                          Optional. Custom CSV row format for vendor payables export (from NACHA Vendor Payout details). Leave empty to use the server default (contract amount, Coverage Period start–end, footer totals). Prefix ? on a placeholder to omit that column when every row is blank or zero. Placeholders include ContractAmount, CoveragePeriod, PaidThroughStart/End, GroupName, AgentName, or per-product fields (ProductID, ProductName, PlanTier, Premium, etc.).
                        </Typography>
                        <TextField
                          fullWidth
                          multiline
                          minRows={2}
                          label="Payables row template"
                          value={formData.PayablesRowTemplate || ''}
                          onChange={(e) => setFormData({ ...formData, PayablesRowTemplate: e.target.value })}
                          placeholder={DEFAULT_PAYABLES_TEMPLATE}
                          helperText="Insert placeholders below; comma-separated for CSV columns"
                          error={payablesTemplateErrors.length > 0}
                        />
                        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mb: 1 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            color="secondary"
                            onClick={() => setFormData({ ...formData, PayablesRowTemplate: DEFAULT_PAYABLES_TEMPLATE })}
                          >
                            Default payables
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => setFormData({ ...formData, PayablesRowTemplate: LINE_ITEM_PAYABLES_TEMPLATE })}
                          >
                            Line item (per product)
                          </Button>
                          <Button
                            size="small"
                            variant="text"
                            onClick={() => setFormData({ ...formData, PayablesRowTemplate: '' })}
                          >
                            Clear (use server default)
                          </Button>
                        </Box>
                        {[
                          { label: 'Member identifiers', placeholders: ['MemberID', 'PolicyNumber'] },
                          { label: 'Member demographics', placeholders: ['FirstName', 'LastName', 'State'] },
                          { label: 'Product info', placeholders: ['ProductID', 'ProductName', 'PlanTier'] },
                          { label: 'Premium & dates', placeholders: ['Premium', 'EffectiveDate', 'TerminationDate', 'PaidThroughStart', 'PaidThroughEnd', 'RespectiveBillingDate', 'NACHASentDate', 'NACHASentDateMDY', 'NACHASentMonthFirstMDY'] },
                          { label: 'Agent & group', placeholders: ['AgentName', 'GroupName'] }
                        ].map((cat) => (
                          <Accordion key={cat.label} defaultExpanded={false} disableGutters sx={{ boxShadow: 'none', '&:before': { display: 'none' }, borderBottom: '1px solid', borderColor: 'divider' }}>
                            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                              <Typography variant="body2" fontWeight="600" color="text.secondary">
                                {cat.label}
                              </Typography>
                            </AccordionSummary>
                            <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'flex-start' }}>
                                {cat.placeholders.map((ph) => (
                                  <Button
                                    key={ph}
                                    size="small"
                                    variant="outlined"
                                    onClick={() => setFormData({ ...formData, PayablesRowTemplate: ((formData.PayablesRowTemplate || '') + (formData.PayablesRowTemplate && !formData.PayablesRowTemplate.endsWith(',') ? ',' : '') + `{${ph}}`).replace(/^,/, '') })}
                                  >
                                    {'{' + ph + '}'}
                                  </Button>
                                ))}
                              </Box>
                            </AccordionDetails>
                          </Accordion>
                        ))}

                        {/* Sample CSV modal */}
                        <Dialog open={sampleCsvModalOpen} onClose={() => setSampleCsvModalOpen(false)} maxWidth="sm" fullWidth>
                          <DialogTitle>Create sample CSV</DialogTitle>
                          <DialogContent>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                              Generate a sample file using the current format and template. Leave primary member empty for sample data, or search and select a primary member to include them and their dependents.
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                              Primary member (optional)
                            </Typography>
                            <SearchableDropdown
                              options={sampleCsvMembers.map((m) => ({
                                id: m.memberId,
                                label: m.displayName,
                                value: m.memberId,
                                email: m.email
                              }))}
                              value={sampleCsvMemberId ?? ''}
                              onChange={(value) => setSampleCsvMemberId(value || null)}
                              placeholder="Use sample data (no real member)"
                              searchPlaceholder="Search by name or email..."
                              loading={sampleCsvMembersLoading}
                              showEmail
                              useBackendSearch
                              onSearch={(query) => {
                                if (!formData.Id) return;
                                setSampleCsvMembersLoading(true);
                                const params = new URLSearchParams({ limit: '50' });
                                if (query.trim()) params.set('q', query.trim());
                                axiosInstance.get(`/api/vendors/${formData.Id}/eligibility-export-members?${params}`)
                                  .then((res) => { setSampleCsvMembers(res.data.data || []); })
                                  .catch(() => { setSampleCsvMembers([]); })
                                  .finally(() => { setSampleCsvMembersLoading(false); });
                              }}
                              className="mt-0"
                            />
                            {sampleCsvError && (
                              <Typography variant="body2" color="error" sx={{ mt: 1 }}>{sampleCsvError}</Typography>
                            )}
                          </DialogContent>
                          <DialogActions>
                            <Button onClick={() => setSampleCsvModalOpen(false)}>Cancel</Button>
                            <Button
                              variant="contained"
                              disabled={sampleCsvGenerateLoading}
                              onClick={async () => {
                                if (!formData.Id) return;
                                setSampleCsvError(null);
                                setSampleCsvGenerateLoading(true);
                                try {
                                  const params = sampleCsvMemberId ? `?memberId=${sampleCsvMemberId}` : '';
                                  const res = await axiosInstance.get(`/api/vendors/${formData.Id}/eligibility-export-sample${params}`);
                                  if (!res.data.success || !res.data.csv) throw new Error(res.data.message || 'No data');
                                  const blob = new Blob([res.data.csv], { type: 'text/csv' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = res.data.fileName || 'eligibility-sample.csv';
                                  a.click();
                                  URL.revokeObjectURL(url);
                                  setSampleCsvModalOpen(false);
                                } catch (err: any) {
                                  setSampleCsvError(err.response?.data?.message || err.message || 'Failed to generate sample');
                                } finally {
                                  setSampleCsvGenerateLoading(false);
                                }
                              }}
                            >
                              {sampleCsvGenerateLoading ? 'Generating…' : 'Generate & download'}
                            </Button>
                          </DialogActions>
                        </Dialog>
                      </Grid>

                      {/* SFTP Settings */}
                      {(formData.ExportMethod?.includes('SFTP') || !formData.ExportMethod) && (
                        <>
                          <Grid size={12}>
                            <Typography variant="subtitle2" fontWeight="bold" gutterBottom sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                              SFTP Settings
                            </Typography>
                          </Grid>
                          <Grid size={{ xs: 12, md: 8 }}>
                            <TextField
                              fullWidth
                              label="SFTP Hostname"
                              value={formData.SftpHostname || ''}
                              onChange={(e) => setFormData({ ...formData, SftpHostname: e.target.value })}
                              placeholder="sftp.example.com"
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 4 }}>
                            <TextField
                              fullWidth
                              label="SFTP Port"
                              type="number"
                              value={formData.SftpPort || ''}
                              onChange={(e) => setFormData({ ...formData, SftpPort: e.target.value ? parseInt(e.target.value) : undefined })}
                              placeholder="22"
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="SFTP Username"
                              value={formData.SftpUsername || ''}
                              onChange={(e) => setFormData({ ...formData, SftpUsername: e.target.value })}
                              placeholder="username"
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="SFTP Password"
                              type={showSftpPassword ? 'text' : 'password'}
                              value={showSftpPassword && actualSftpPassword 
                                ? actualSftpPassword 
                                : (formData.SftpPassword || '')}
                              onChange={(e) => {
                                const value = e.target.value;
                                // Always store the actual password
                                setActualSftpPassword(value);
                                // Update formData with masked value matching the length
                                setFormData({ ...formData, SftpPassword: '•'.repeat(value.length) });
                              }}
                              placeholder="Enter SFTP password"
                              InputProps={{
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <IconButton
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        // Password is already loaded, just toggle visibility
                                        setShowSftpPassword(prev => !prev);
                                      }}
                                      onMouseDown={(e) => {
                                        e.preventDefault(); // Prevent input from losing focus
                                      }}
                                      edge="end"
                                      aria-label={showSftpPassword ? 'Hide password' : 'Show password'}
                                      tabIndex={-1}
                                    >
                                      {showSftpPassword ? <EyeOff className="h-4 w-4 text-oe-primary" /> : <Eye className="h-4 w-4 text-oe-primary" />}
                                    </IconButton>
                                  </InputAdornment>
                                ),
                              }}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="SFTP path (NACHA)"
                              value={formData.SftpPathNacha ?? formData.SftpPath ?? ''}
                              onChange={(e) => setFormData({ ...formData, SftpPathNacha: e.target.value })}
                              placeholder="/NACHA or leave empty for root"
                              helperText="Destination folder for NACHA/payment files. Leave empty to use default path below."
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="SFTP path (Eligibility)"
                              value={formData.SftpPathEligibility ?? formData.SftpPath ?? ''}
                              onChange={(e) => setFormData({ ...formData, SftpPathEligibility: e.target.value })}
                              placeholder="/eligibility or leave empty for root"
                              helperText="Destination folder for eligibility CSV files. Leave empty to use default path below."
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="SFTP default path (fallback)"
                              value={formData.SftpPath || ''}
                              onChange={(e) => setFormData({ ...formData, SftpPath: e.target.value })}
                              placeholder="/exports or root"
                              helperText="Used when NACHA or Eligibility path is empty. Leave empty for root."
                            />
                          </Grid>
                          <Grid size={12}>
                            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!selectedVendor) {
                                    showSnackbar('Please save vendor first', 'error');
                                    return;
                                  }
                                  if (formData.ExportMethod !== 'SFTP') {
                                    showSnackbar('Please select SFTP as export method first', 'error');
                                    return;
                                  }
                                  if (!formData.SftpHostname || !formData.SftpUsername || !formData.SftpPassword) {
                                    showSnackbar('Please fill in SFTP Hostname, Username, and Password', 'error');
                                    return;
                                  }
                                  try {
                                    setFormData({ ...formData, ExportTestConnectionStatus: 'testing' });
                                    const response = await axiosInstance.post(
                                      `/api/vendors/${selectedVendor.Id}/export/test-connection`,
                                      {
                                        sftpHostname: formData.SftpHostname,
                                        sftpPort: formData.SftpPort || 22,
                                        sftpUsername: formData.SftpUsername,
                                        sftpPassword: formData.SftpPassword
                                      }
                                    );
                                    if (response.data.success) {
                                      setFormData({ ...formData, ExportTestConnectionStatus: 'success' });
                                      showSnackbar('SFTP connection test successful', 'success');
                                    } else {
                                      setFormData({ ...formData, ExportTestConnectionStatus: 'error' });
                                      showSnackbar(response.data.message || 'Connection test failed', 'error');
                                    }
                                  } catch (error: any) {
                                    console.error('Error testing SFTP connection:', error);
                                    setFormData({ ...formData, ExportTestConnectionStatus: 'error' });
                                    let errorMessage = 'Connection test failed';
                                    if (error?.response?.data) {
                                      const { message, error: errorDetail } = error.response.data;
                                      errorMessage = errorDetail ? `${message || ''}: ${errorDetail}` : (message || errorMessage);
                                    } else if (error?.message) errorMessage = error.message;
                                    showSnackbar(errorMessage, 'error');
                                  }
                                }}
                                className="btn-secondary focus-ring"
                                disabled={!selectedVendor || formData.ExportMethod !== 'SFTP' || !formData.SftpHostname || !formData.SftpUsername || !formData.SftpPassword}
                              >
                                Test Connection
                              </button>
                              {formData.ExportTestConnectionStatus === 'testing' && (
                                <Typography variant="body2" color="text.secondary">Testing connection...</Typography>
                              )}
                              {formData.ExportTestConnectionStatus === 'success' && (
                                <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 'medium' }}>✓ Connection successful</Typography>
                              )}
                              {formData.ExportTestConnectionStatus === 'error' && (
                                <Typography variant="body2" sx={{ color: 'error.main', fontWeight: 'medium' }}>✗ Connection failed</Typography>
                              )}
                            </Box>
                          </Grid>
                        </>
                      )}

                      {/* Email Notification Settings - Show when SFTP is selected */}
                      {formData.ExportMethod?.includes('SFTP') && (
                        <>
                          <Grid size={12}>
                            <Typography variant="subtitle2" fontWeight="bold" gutterBottom sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                              Email Notification Settings
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                              Send an email notification when an SFTP file is uploaded and ready for pickup.
                            </Typography>
                          </Grid>
                          <Grid size={12}>
                            <TextField
                              fullWidth
                              label="Notification Email Address"
                              type="email"
                              value={formData.ExportEmailAddress || ''}
                              onChange={(e) => setFormData({ ...formData, ExportEmailAddress: e.target.value })}
                              placeholder="notifications@vendor.com"
                              helperText="Email address to notify when SFTP files are ready"
                            />
                          </Grid>
                          <Grid size={12}>
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={formData.ExportEmailEnabled || false}
                                  onChange={(e) => setFormData({ ...formData, ExportEmailEnabled: e.target.checked })}
                                />
                              }
                              label="Send Email Notification on SFTP Upload"
                            />
                          </Grid>
                        </>
                      )}

                      {/* API Settings */}
                      {(formData.ExportMethod?.includes('API') || !formData.ExportMethod) && (
                        <>
                          <Grid size={12}>
                            <Typography variant="subtitle2" fontWeight="bold" gutterBottom sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                              API Settings
                            </Typography>
                          </Grid>
                          <Grid size={12}>
                            <TextField
                              fullWidth
                              label="API Base URL"
                              value={formData.ApiBaseUrl || ''}
                              onChange={(e) => setFormData({ ...formData, ApiBaseUrl: e.target.value })}
                              placeholder="https://api.vendor.com"
                            />
                          </Grid>
                          <Grid size={12}>
                            <TextField
                              fullWidth
                              label="API Token"
                              type={showApiToken ? 'text' : 'password'}
                              value={showApiToken && actualApiToken 
                                ? actualApiToken 
                                : (formData.ApiToken || '')}
                              onChange={(e) => {
                                const value = e.target.value;
                                // Always store the actual token
                                setActualApiToken(value);
                                // Update formData with masked value matching the length
                                setFormData({ ...formData, ApiToken: '•'.repeat(value.length) });
                              }}
                              placeholder="Enter API token"
                              InputProps={{
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <IconButton
                                      type="button"
                                      onClick={async (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        
                                        if (!showApiToken) {
                                          // Showing token - fetch actual token if masked
                                          const maskedPattern = /^[•\*]+$/;
                                          if (formData.ApiToken && maskedPattern.test(formData.ApiToken) && selectedVendor) {
                                            try {
                                              // Fetch decrypted token from backend
                                              const response = await axiosInstance.get(`/api/vendors/${selectedVendor.Id}/export/token`);
                                              if (response.data.success && response.data.token) {
                                                setActualApiToken(response.data.token);
                                              }
                                            } catch (error) {
                                              console.error('Error fetching token:', error);
                                              showSnackbar('Could not retrieve token', 'error');
                                            }
                                          }
                                        }
                                        
                                        setShowApiToken(prev => !prev);
                                      }}
                                      onMouseDown={(e) => {
                                        e.preventDefault(); // Prevent input from losing focus
                                      }}
                                      edge="end"
                                      aria-label={showApiToken ? 'Hide token' : 'Show token'}
                                      tabIndex={-1}
                                    >
                                      {showApiToken ? <EyeOff className="h-4 w-4 text-oe-primary" /> : <Eye className="h-4 w-4 text-oe-primary" />}
                                    </IconButton>
                                  </InputAdornment>
                                ),
                              }}
                            />
                          </Grid>
                          <Grid size={12}>
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={formData.ApiEnabled || false}
                                  onChange={(e) => setFormData({ ...formData, ApiEnabled: e.target.checked })}
                                />
                              }
                              label="Enable API Export"
                            />
                          </Grid>
                        </>
                      )}

                      {/* File Format & Naming Settings */}
                      {(formData.ExportMethod === 'SFTP' || formData.ExportMethod === 'API') && (
                        <>
                          <Grid size={12}>
                            <Typography variant="subtitle2" fontWeight="bold" gutterBottom sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                              File Format & Naming
                            </Typography>
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <FormControl fullWidth>
                              <InputLabel>File Format</InputLabel>
                              <Select
                                value={formData.ExportFileFormat || 'CSV'}
                                onChange={(e) => setFormData({ ...formData, ExportFileFormat: e.target.value })}
                                label="File Format"
                              >
                                <MenuItem value="CSV">CSV</MenuItem>
                                <MenuItem value="JSON">JSON</MenuItem>
                                <MenuItem value="XML">XML</MenuItem>
                                <MenuItem value="TXT">TXT</MenuItem>
                              </Select>
                            </FormControl>
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="Eligibility file name template"
                              value={formData.ExportFileNameTemplate || ''}
                              onChange={(e) => setFormData({ ...formData, ExportFileNameTemplate: e.target.value })}
                              placeholder="{vendor}-eligibility-{dateMDY}.csv"
                              helperText="Eligibility CSV: {date}, {dateMDY}, {timestamp}, {vendor}, {format}. {date}/{dateMDY} = when the file is generated (not effective-as-of). Leave blank for default name."
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="Payables file name template (optional)"
                              value={formData.PayablesExportFileNameTemplate || ''}
                              onChange={(e) => setFormData({ ...formData, PayablesExportFileNameTemplate: e.target.value })}
                              placeholder="payables-{vendor}-{nachaShort}-{paidThroughMonth}.csv"
                              helperText="Payables CSV: {date} is YYYYMMDD from NACHA SentDate, else GeneratedDate (same calendar as {nachaFileDate}). {nachaPeriodRange} is that single YYYY-MM-DD date (not paid-through). Use {paidThroughRange} for start_end coverage span. Also: {paidThroughStart}, {paidThroughEnd}, {paidThroughMonth}, {nachaSentDate}, {nachaGeneratedDate}, {nacha}, {nachaShort}. Default file name is one NACHA date, not the coverage range."
                            />
                          </Grid>
                        </>
                      )}

                      {/* Advanced Settings */}
                      {(formData.ExportMethod === 'SFTP' || formData.ExportMethod === 'API') && (
                        <>
                          <Grid size={12}>
                            <Typography variant="subtitle2" fontWeight="bold" gutterBottom sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
                              Advanced Settings
                            </Typography>
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="Retry Attempts"
                              type="number"
                              value={formData.ExportRetryAttempts || ''}
                              onChange={(e) => setFormData({ ...formData, ExportRetryAttempts: e.target.value ? parseInt(e.target.value) : undefined })}
                              placeholder="3"
                              helperText="Number of retry attempts on failure"
                              inputProps={{ min: 0, max: 10 }}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 6 }}>
                            <TextField
                              fullWidth
                              label="Retry Delay (minutes)"
                              type="number"
                              value={formData.ExportRetryDelayMinutes || ''}
                              onChange={(e) => setFormData({ ...formData, ExportRetryDelayMinutes: e.target.value ? parseInt(e.target.value) : undefined })}
                              placeholder="5"
                              helperText="Minutes between retry attempts"
                              inputProps={{ min: 1, max: 60 }}
                            />
                          </Grid>
                          <Grid size={12}>
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={formData.ExportCompressionEnabled || false}
                                  onChange={(e) => setFormData({ ...formData, ExportCompressionEnabled: e.target.checked })}
                                />
                              }
                              label="Compress Files (ZIP)"
                            />
                          </Grid>
                          <Grid size={12}>
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={formData.ExportEncryptionEnabled || false}
                                  onChange={(e) => setFormData({ ...formData, ExportEncryptionEnabled: e.target.checked })}
                                />
                              }
                              label="Encrypt Files"
                            />
                          </Grid>
                        </>
                      )}

                      {/* Eligibility export history modal */}
                      <Dialog open={eligibilityHistoryModalOpen} onClose={() => setEligibilityHistoryModalOpen(false)} maxWidth="md" fullWidth>
                        <DialogTitle>Eligibility export history</DialogTitle>
                        <DialogContent>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                            Generated files for this vendor. Download, mark as sent, or upload to SFTP.
                            {formData.EligibilityIncludeOnlyChanges !== false && (
                              <> When &quot;Only include enrollment changes&quot; is on, <strong>Generate new file</strong> exports changes since the last sent file; use <strong>Generate full eligibility file</strong> for a complete snapshot.</>
                            )}
                          </Typography>
                          {eligibilityFiles.length > 0 && eligibilityFiles[0]?.summary && (
                            <Box sx={{ mb: 2, p: 2, bgcolor: 'grey.100', borderRadius: 1 }}>
                              <Typography variant="subtitle2" color="text.secondary" gutterBottom>Export overview (latest)</Typography>
                              <Typography variant="body2">
                                Total families: <strong>{eligibilityFiles[0].summary.totalFamilies}</strong>
                                {' · '}New: <strong>{eligibilityFiles[0].summary.newCount}</strong>
                                {' · '}Updated: <strong>{eligibilityFiles[0].summary.updatedCount}</strong>
                                {' · '}Terminated: <strong>{eligibilityFiles[0].summary.terminatedCount}</strong>
                              </Typography>
                              {eligibilityFiles[0].summary.excludedNoVendorGroupId
                                && (eligibilityFiles[0].summary.excludedNoVendorGroupId.households || 0) > 0 && (
                                <Typography variant="body2" color="warning.main" sx={{ mt: 1 }}>
                                  Excluded households (group missing vendor group ID):{' '}
                                  <strong>{eligibilityFiles[0].summary.excludedNoVendorGroupId.households}</strong>
                                  {' · across '}
                                  <strong>{eligibilityFiles[0].summary.excludedNoVendorGroupId.groups}</strong>
                                  {' '}group{eligibilityFiles[0].summary.excludedNoVendorGroupId.groups === 1 ? '' : 's'}.
                                  Individuals (no group) are unaffected.
                                </Typography>
                              )}
                              {eligibilityFiles[0].summary.groups != null && (
                                <>
                                  <Typography variant="body2" sx={{ mt: 1.5 }}>
                                    Groups included: <strong>{eligibilityFiles[0].summary.groups.count}</strong>
                                    {eligibilityFiles[0].summary.individuals != null && (
                                      <> · Individuals (non-group): Total <strong>{eligibilityFiles[0].summary.individuals.total}</strong> (Enrolled: <strong>{eligibilityFiles[0].summary.individuals.enrolled}</strong>, Updated: <strong>{eligibilityFiles[0].summary.individuals.updated}</strong>, Terminated: <strong>{eligibilityFiles[0].summary.individuals.terminated}</strong>)</>
                                    )}
                                  </Typography>
                                  {Array.isArray(eligibilityFiles[0].summary.groups.breakdown) && eligibilityFiles[0].summary.groups.breakdown.length > 0 && (
                                    <Accordion defaultExpanded={true} disableGutters sx={{ mt: 1.5, boxShadow: 'none', '&:before': { display: 'none' }, bgcolor: 'transparent' }}>
                                      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                                        <Typography variant="body2" fontWeight={500}>Group-by-group breakdown</Typography>
                                      </AccordionSummary>
                                      <AccordionDetails sx={{ pt: 0, pb: 0 }}>
                                        <TableContainer component={Paper} variant="outlined" sx={{ mt: 0 }}>
                                          <Table size="small">
                                            <TableHead>
                                              <TableRow>
                                                <TableCell>Group ID (Master)</TableCell>
                                                <TableCell>Group name</TableCell>
                                                <TableCell align="right">Total</TableCell>
                                                <TableCell align="right">Enrolled</TableCell>
                                                <TableCell align="right">Updated</TableCell>
                                                <TableCell align="right">Terminated</TableCell>
                                              </TableRow>
                                            </TableHead>
                                            <TableBody>
                                              {eligibilityFiles[0].summary.groups.breakdown.map((g: {
                                                groupNumber: string;
                                                groupName: string | null;
                                                masterGroupId?: string;
                                                otherVendorGroupIds?: Array<{ id: string; productType: string | null }>;
                                                total: number;
                                                enrolled: number;
                                                updated: number;
                                                terminated: number;
                                                isIndividuals?: boolean;
                                                isNoVendorGroupId?: boolean;
                                              }) => {
                                                const masterId = g.masterGroupId ?? g.groupNumber;
                                                const others = g.otherVendorGroupIds ?? [];
                                                const tooltip = g.isNoVendorGroupId
                                                  ? 'Vendor group ID not assigned for this group'
                                                  : others.length > 0
                                                    ? `Product-specific IDs: ${others.map((o: { id: string; productType: string | null }) => `${o.id}${o.productType ? ` (${o.productType})` : ''}`).join(', ')}`
                                                    : '';
                                                const rowKey = g.isIndividuals ? 'individuals' : (g.isNoVendorGroupId ? `no-vgi-${g.groupName ?? ''}` : g.groupNumber);
                                                return (
                                                  <TableRow key={rowKey}>
                                                    <TableCell>
                                                      {tooltip ? (
                                                        <Tooltip title={tooltip}>
                                                          <span style={{ cursor: 'help', textDecoration: g.isNoVendorGroupId ? 'none' : 'underline dotted' }}>{masterId}</span>
                                                        </Tooltip>
                                                      ) : (
                                                        masterId
                                                      )}
                                                    </TableCell>
                                                    <TableCell>{g.groupName ?? '—'}</TableCell>
                                                    <TableCell align="right">{g.total}</TableCell>
                                                    <TableCell align="right">{g.enrolled}</TableCell>
                                                    <TableCell align="right">{g.updated}</TableCell>
                                                    <TableCell align="right">{g.terminated}</TableCell>
                                                  </TableRow>
                                                );
                                              })}
                                            </TableBody>
                                          </Table>
                                        </TableContainer>
                                      </AccordionDetails>
                                    </Accordion>
                                  )}
                                </>
                              )}
                            </Box>
                          )}
                          <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
                            <TextField
                              label="Effective before or on"
                              type="date"
                              value={eligibilityEffectiveAsOf}
                              onChange={(e) => setEligibilityEffectiveAsOf(e.target.value)}
                              InputLabelProps={{ shrink: true }}
                              size="small"
                              sx={{ width: 200 }}
                            />
                            {formData.EligibilityRowTemplate?.includes('VendorIndividualGroupId') && (
                              <TextField
                                label="Vendor individual group ID (no group)"
                                placeholder="MVHD02"
                                value={eligibilityVendorIndividualGroupId}
                                onChange={(e) => setEligibilityVendorIndividualGroupId(e.target.value)}
                                size="small"
                                sx={{ width: 240 }}
                                helperText="Fallback when template uses {...,VendorIndividualGroupId:...}"
                              />
                            )}
                            <FormControlLabel
                              control={
                                <Checkbox
                                  size="small"
                                  checked={eligibilityExcludeGroupsMissingVgi}
                                  onChange={(e) => setEligibilityExcludeGroupsMissingVgi(e.target.checked)}
                                />
                              }
                              label={
                                <Typography variant="body2">
                                  Exclude groups missing a vendor group ID
                                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                                    (individuals unaffected)
                                  </Typography>
                                </Typography>
                              }
                              sx={{ mr: 0 }}
                            />
                            <Button
                              variant="outlined"
                              size="small"
                              disabled={!selectedVendor || eligibilityGenerateLoading}
                              startIcon={eligibilityGenerateLoading ? <CircularProgress size={16} /> : <Plus className="h-4 w-4" />}
                              onClick={() => handleGenerateEligibilityFile('changes')}
                            >
                              Generate new file
                            </Button>
                            {formData.EligibilityIncludeOnlyChanges !== false && (
                              <>
                                <Button
                                  variant="outlined"
                                  size="small"
                                  color="secondary"
                                  disabled={!selectedVendor || eligibilityGenerateLoading}
                                  startIcon={eligibilityGenerateLoading ? <CircularProgress size={16} /> : <FileDown className="h-4 w-4" />}
                                  onClick={() => handleGenerateEligibilityFile('full')}
                                >
                                  Generate full eligibility file
                                </Button>
                                <Button
                                  variant="outlined"
                                  size="small"
                                  color="warning"
                                  disabled={!selectedVendor || eligibilityGenerateLoading}
                                  startIcon={eligibilityGenerateLoading ? <CircularProgress size={16} /> : <FileDown className="h-4 w-4" />}
                                  onClick={() => handleGenerateEligibilityFile('terminations')}
                                >
                                  Generate terminations file
                                </Button>
                              </>
                            )}
                          </Box>
                          {eligibilityFilesLoading ? (
                            <Box sx={{ py: 2 }}><CircularProgress size={24} /></Box>
                          ) : eligibilityFiles.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">No generated files yet. Click &quot;Generate new file&quot; to create one.</Typography>
                          ) : (
                            <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                              <Table size="small">
                                <TableHead>
                                  <TableRow>
                                    <TableCell>Generated</TableCell>
                                    <TableCell>Effective as of</TableCell>
                                    <TableCell>File name</TableCell>
                                    <TableCell align="right">Records</TableCell>
                                    <TableCell align="right">Households</TableCell>
                                    <TableCell align="right">New</TableCell>
                                    <TableCell align="right">Updated</TableCell>
                                    <TableCell align="right">Terminated</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell align="right">Actions</TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {eligibilityFiles.map((row) => (
                                    <TableRow key={row.fileId}>
                                      <TableCell>{new Date(row.generatedAt).toLocaleString()}</TableCell>
                                      <TableCell>{row.effectiveAsOfDate ?? '—'}</TableCell>
                                      <TableCell>{row.fileName}</TableCell>
                                      <TableCell align="right">{row.recordCount}</TableCell>
                                      <TableCell align="right">{row.summary?.totalFamilies ?? '—'}</TableCell>
                                      <TableCell align="right">{row.summary?.newCount ?? '—'}</TableCell>
                                      <TableCell align="right">{row.summary?.updatedCount ?? '—'}</TableCell>
                                      <TableCell align="right">{row.summary?.terminatedCount ?? '—'}</TableCell>
                                      <TableCell>
                                        {row.sentAt ? (
                                          <Chip label="Sent" color="success" size="small" />
                                        ) : (
                                          <Chip label="Pending" color="default" size="small" />
                                        )}
                                      </TableCell>
                                      <TableCell align="right">
                                        <Tooltip title="Download">
                                          <IconButton
                                            size="small"
                                            onClick={async () => {
                                              try {
                                                const res = await axiosInstance.get(
                                                  `/api/vendors/${selectedVendor?.Id}/eligibility-export-files/${row.fileId}/download`,
                                                  { responseType: 'blob' }
                                                );
                                                const url = window.URL.createObjectURL(new Blob([res.data]));
                                                const a = document.createElement('a');
                                                a.href = url;
                                                a.download = row.fileName;
                                                a.click();
                                                window.URL.revokeObjectURL(url);
                                              } catch (e: any) {
                                                showSnackbar(e?.response?.data?.message || 'Download failed', 'error');
                                              }
                                            }}
                                          >
                                            <Download className="h-4 w-4" />
                                          </IconButton>
                                        </Tooltip>
                                        {row.sentAt ? (
                                          <Tooltip title="Unmark as sent">
                                            <IconButton
                                              size="small"
                                              onClick={async () => {
                                                try {
                                                  await axiosInstance.post(`/api/vendors/${selectedVendor?.Id}/eligibility-export-files/${row.fileId}/unmark-sent`);
                                                  setEligibilityFiles((prev) => prev.map((f) => f.fileId === row.fileId ? { ...f, sentAt: null } : f));
                                                  showSnackbar('Unmarked as sent', 'success');
                                                } catch (e: any) {
                                                  showSnackbar(e?.response?.data?.message || 'Failed', 'error');
                                                }
                                              }}
                                            >
                                              <EditIcon fontSize="small" />
                                            </IconButton>
                                          </Tooltip>
                                        ) : (
                                          <>
                                            <Tooltip title="Mark as sent">
                                              <IconButton
                                                size="small"
                                                onClick={async () => {
                                                  try {
                                                    await axiosInstance.post(`/api/vendors/${selectedVendor?.Id}/eligibility-export-files/${row.fileId}/mark-sent`);
                                                    setEligibilityFiles((prev) => prev.map((f) => f.fileId === row.fileId ? { ...f, sentAt: new Date().toISOString() } : f));
                                                    showSnackbar('Marked as sent', 'success');
                                                  } catch (e: any) {
                                                    showSnackbar(e?.response?.data?.message || 'Failed', 'error');
                                                  }
                                                }}
                                              >
                                                <Send className="h-4 w-4" />
                                              </IconButton>
                                            </Tooltip>
                                            {formData.ExportMethod === 'SFTP' && (
                                              <Tooltip title={`Upload to SFTP: ${(formData.SftpPathEligibility || formData.SftpPath || '').trim() || 'root'}`}>
                                                <span>
                                                  <IconButton
                                                    size="small"
                                                    disabled={eligibilitySftpUploadFileId === row.fileId}
                                                    onClick={async () => {
                                                      setEligibilitySftpUploadFileId(row.fileId);
                                                      try {
                                                        const res = await axiosInstance.post(
                                                          `/api/vendors/${selectedVendor?.Id}/eligibility-export-files/${row.fileId}/upload-sftp`,
                                                          {},
                                                          { timeout: 120000 }
                                                        );
                                                        const remotePath = res?.data?.data?.remotePath;
                                                        setEligibilityFiles((prev) => prev.map((f) => f.fileId === row.fileId ? { ...f, sentAt: new Date().toISOString() } : f));
                                                        showSnackbar(
                                                          remotePath
                                                            ? `Uploaded to SFTP (${remotePath}) and marked as sent`
                                                            : 'Uploaded to SFTP and marked as sent',
                                                          'success'
                                                        );
                                                      } catch (e: any) {
                                                        const msg = e?.response?.data?.message || e?.message || 'Upload failed';
                                                        console.error('Eligibility SFTP upload failed:', e?.response?.data || e);
                                                        showSnackbar(msg, 'error');
                                                      } finally {
                                                        setEligibilitySftpUploadFileId(null);
                                                      }
                                                    }}
                                                  >
                                                    {eligibilitySftpUploadFileId === row.fileId ? (
                                                      <CircularProgress size={18} />
                                                    ) : (
                                                      <Upload className="h-4 w-4" />
                                                    )}
                                                  </IconButton>
                                                </span>
                                              </Tooltip>
                                            )}
                                          </>
                                        )}
                                        <Tooltip title="Delete">
                                          <IconButton
                                            size="small"
                                            color="error"
                                            onClick={async () => {
                                              if (!confirm(`Delete "${row.fileName}"? This cannot be undone.`)) return;
                                              try {
                                                await axiosInstance.delete(`/api/vendors/${selectedVendor?.Id}/eligibility-export-files/${row.fileId}`);
                                                setEligibilityFiles((prev) => prev.filter((f) => f.fileId !== row.fileId));
                                                showSnackbar('File deleted', 'success');
                                              } catch (e: any) {
                                                showSnackbar(e?.response?.data?.message || 'Delete failed', 'error');
                                              }
                                            }}
                                          >
                                            <DeleteIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </TableContainer>
                          )}
                        </DialogContent>
                        <DialogActions>
                          <Button onClick={() => setEligibilityHistoryModalOpen(false)}>Close</Button>
                        </DialogActions>
                      </Dialog>
                    </Grid>
                    {renderVendorTabSaveBar(false)}
                  </Box>
                </TabPanel>

                {/* Tab 7: Scheduled jobs */}
                <TabPanel value={currentFormTab} index={7}>
                  <Box sx={{ p: 3 }}>
                    <Tabs
                      value={scheduledJobsSubTab}
                      onChange={(_, v) => setScheduledJobsSubTab(v)}
                      sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
                    >
                      <Tab label="Job schedules" />
                      <Tab label="Run history" />
                    </Tabs>

                    {scheduledJobsSubTab === 0 && (
                      <>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={2} flexWrap="wrap" gap={2}>
                      <Box>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                          Scheduled export jobs
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Eligibility jobs export member data; payables jobs export the vendor payables CSV for the <strong>latest NACHA batch</strong> that includes this vendor (same file as Accounting → NACHA payables export). <strong>New group form</strong> emails PDF download links for groups that need a form (configure the template on the <strong>Groups</strong> tab). SFTP comes from the Eligibility tab for eligibility and payables; optional path override and emails apply per job. Automation still requires an external scheduler to call the vendor-exports endpoint.
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          Use <strong>Run</strong> on a row to test immediately — same pipeline as the automated scheduler (that job’s SFTP path, emails, and export logic).
                          Payables jobs can use <strong>NACHA sent</strong> to run automatically when a NACHA batch that includes this vendor is <strong>marked Sent</strong> (async on the API; usually within seconds).
                        </Typography>
                      </Box>
                      {selectedVendor && (
                        <Box display="flex" flexWrap="wrap" gap={1} alignItems="center" justifyContent="flex-end">
                          <button
                            type="button"
                            onClick={() => {
                              setScheduledJobModalEditingId(null);
                              const tz = vendorScheduleTimezone || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ;
                              setScheduledJobForm({
                                jobType: 'eligibility_export',
                                isEnabled: true,
                                exportSchedule: 'daily',
                                exportScheduleDay: 'Monday',
                                exportScheduleDayOfMonth: 1,
                                exportTrigger: 'schedule',
                                exportScheduleTime: serverScheduleTimeToLocalInput('09:00', tz),
                                emailRecipients: '',
                                useVendorDefaultSftp: true,
                                sftpPathOverride: '',
                                generateVendorGroupIdsIfNeeded: false,
                                excludeGroupsMissingVendorGroupId: false,
                              });
                              setScheduledJobModalOpen(true);
                            }}
                            className="px-4 py-2 text-white rounded-lg transition-colors bg-oe-primary hover:bg-oe-primary-dark"
                          >
                            <Plus className="h-4 w-4 inline mr-2" />
                            Add job
                          </button>
                        </Box>
                      )}
                    </Box>

                    {loadingVendorScheduledJobs ? (
                      <Box display="flex" justifyContent="center" p={4}>
                        <CircularProgress />
                      </Box>
                    ) : vendorScheduledJobs.length === 0 ? (
                      <Box
                        sx={{
                          p: 4,
                          textAlign: 'center',
                          border: '1px dashed',
                          borderColor: 'divider',
                          borderRadius: 2,
                        }}
                      >
                        <Typography variant="body1" color="text.secondary" gutterBottom>
                          No scheduled jobs yet.
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Add a job to define SFTP paths and emails, then use <strong>Run</strong> on that row to test — same pipeline as at the scheduled time.
                        </Typography>
                      </Box>
                    ) : (
                      <TableContainer component={Paper} variant="outlined">
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell><strong>Type</strong></TableCell>
                              <TableCell><strong>Schedule</strong></TableCell>
                              <TableCell><strong>Gen vendor IDs</strong></TableCell>
                              <TableCell><strong>SFTP upload</strong></TableCell>
                              <TableCell><strong>SFTP path override</strong></TableCell>
                              <TableCell><strong>Emails</strong></TableCell>
                              <TableCell><strong>Enabled</strong></TableCell>
                              <TableCell><strong>Last run</strong></TableCell>
                              <TableCell><strong>Last NACHA (payables)</strong></TableCell>
                              <TableCell align="right"><strong>Actions</strong></TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {vendorScheduledJobs.map((row) => {
                              const tz = vendorScheduleTimezone || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ;
                              const timeStr = (row.exportScheduleTime || '').slice(0, 5);
                              const localT = serverScheduleTimeToLocalInput(timeStr, tz);
                              const localPretty = formatLocalTimeLabel(localT);
                              const timePart = localPretty || '—';
                              const trig = (row.exportTrigger || 'schedule').toLowerCase();
                              let schedSummary = row.exportSchedule || '—';
                              if (
                                row.jobType === 'payables_export' &&
                                trig === 'nacha_generation'
                              ) {
                                schedSummary = `NACHA sent → payables`;
                              } else if (row.jobType === 'asa_signed' || trig === 'asa_signed') {
                                schedSummary = 'On ASA signed';
                              } else if (row.exportSchedule === 'weekly' && row.exportScheduleDay) {
                                schedSummary = `Weekly ${row.exportScheduleDay} at ${timePart}`;
                              } else if (row.exportSchedule === 'daily') {
                                schedSummary = `Daily at ${timePart}`;
                              } else if (row.exportSchedule === 'monthly') {
                                const dom = row.exportScheduleDayOfMonth ?? 1;
                                schedSummary = `Monthly (${dayOfMonthOrdinal(dom)}) at ${timePart}`;
                              }
                              return (
                                <TableRow key={row.vendorScheduledJobId}>
                                  <TableCell>{scheduledJobTypeLabel(row.jobType)}</TableCell>
                                  <TableCell>{schedSummary}</TableCell>
                                  <TableCell>
                                    {row.jobType === 'new_group_form'
                                      ? row.generateVendorGroupIdsIfNeeded
                                        ? 'Yes'
                                        : 'No'
                                      : '—'}
                                  </TableCell>
                                  <TableCell>
                                    {row.jobType === 'new_group_form' || row.jobType === 'asa_signed'
                                      ? '—'
                                      : row.useVendorDefaultSftp !== false
                                        ? 'Yes'
                                        : 'No'}
                                  </TableCell>
                                  <TableCell sx={{ maxWidth: 260 }}>
                                    {row.jobType === 'new_group_form' || row.jobType === 'asa_signed' ? (
                                      <Typography variant="body2" color="text.secondary" component="span">
                                        —
                                      </Typography>
                                    ) : row.sftpPathOverride?.trim() ? (
                                      row.sftpPathOverride
                                    ) : (
                                      <Typography variant="body2" color="text.secondary" component="span">
                                        Default:{' '}
                                        <strong style={{ fontWeight: 500, color: 'inherit' }}>
                                          {getVendorDefaultSftpPathForScheduledJob(selectedVendor, row.jobType) ||
                                            '(not set)'}
                                        </strong>
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell sx={{ maxWidth: 220 }}>
                                    <Typography variant="body2" noWrap title={row.emailRecipients || ''}>
                                      {row.emailRecipients || '—'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>{row.isEnabled ? 'Yes' : 'No'}</TableCell>
                                  <TableCell>
                                    {row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : '—'}
                                  </TableCell>
                                  <TableCell sx={{ maxWidth: 120 }}>
                                    <Typography variant="body2" noWrap title={row.lastExportedNachaId || ''}>
                                      {row.jobType === 'payables_export' && row.lastExportedNachaId
                                        ? `${String(row.lastExportedNachaId).slice(0, 8)}…`
                                        : '—'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">
                                    <Tooltip title="Run this job now — same pipeline as the scheduled run (this row’s SFTP path and emails)">
                                      <span>
                                        <Button
                                          size="small"
                                          variant="outlined"
                                          disabled={!selectedVendor || scheduledJobRunNowId !== null}
                                          onClick={() => {
                                            if (!selectedVendor) return;
                                            void runScheduledJobNow(
                                              selectedVendor.Id,
                                              row.vendorScheduledJobId
                                            );
                                          }}
                                          sx={{ minWidth: 72, mr: 0.5 }}
                                          aria-label="Run scheduled job now"
                                          startIcon={
                                            scheduledJobRunNowId === row.vendorScheduledJobId ? (
                                              <CircularProgress size={16} />
                                            ) : (
                                              <Play className="h-4 w-4" />
                                            )
                                          }
                                        >
                                          Run
                                        </Button>
                                      </span>
                                    </Tooltip>
                                    <IconButton
                                      size="small"
                                      onClick={() => {
                                        setScheduledJobModalEditingId(row.vendorScheduledJobId);
                                        const tz = vendorScheduleTimezone || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ;
                                        setScheduledJobForm({
                                          jobType: row.jobType,
                                          isEnabled: row.isEnabled,
                                          exportSchedule: (row.exportSchedule as 'daily' | 'weekly' | 'monthly') || 'daily',
                                          exportScheduleDay: row.exportScheduleDay || 'Monday',
                                          exportScheduleDayOfMonth: row.exportScheduleDayOfMonth ?? 1,
                                          exportTrigger:
                                            (row.exportTrigger || 'schedule').toLowerCase() === 'nacha_generation'
                                              ? 'nacha_generation'
                                              : 'schedule',
                                          exportScheduleTime: serverScheduleTimeToLocalInput(
                                            (row.exportScheduleTime || '09:00').slice(0, 5),
                                            tz
                                          ),
                                          emailRecipients: row.emailRecipients || '',
                                          useVendorDefaultSftp: row.useVendorDefaultSftp !== false,
                                          sftpPathOverride: row.sftpPathOverride || '',
                                          generateVendorGroupIdsIfNeeded: row.generateVendorGroupIdsIfNeeded === true,
                                          excludeGroupsMissingVendorGroupId: row.excludeGroupsMissingVendorGroupId === true,
                                        });
                                        setScheduledJobModalOpen(true);
                                      }}
                                      sx={{ color: 'var(--oe-primary)' }}
                                    >
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                    <IconButton
                                      size="small"
                                      color="error"
                                      onClick={async () => {
                                        if (!selectedVendor) return;
                                        if (!window.confirm('Delete this scheduled job?')) return;
                                        try {
                                          await axiosInstance.delete(
                                            `/api/vendors/${selectedVendor.Id}/scheduled-jobs/${row.vendorScheduledJobId}`
                                          );
                                          showSnackbar('Scheduled job deleted', 'success');
                                          fetchVendorScheduledJobs(selectedVendor.Id);
                                        } catch (e: any) {
                                          showSnackbar(e?.response?.data?.message || 'Delete failed', 'error');
                                        }
                                      }}
                                    >
                                      <DeleteIcon fontSize="small" />
                                    </IconButton>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                      </>
                    )}

                    {scheduledJobsSubTab === 1 && (
                      <Box>
                        <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2} flexWrap="wrap" gap={2}>
                          <Box>
                            <Typography variant="body2" color="text.secondary" paragraph sx={{ mb: 0 }}>
                              Each row is recorded when the <strong>vendor-exports</strong> scheduler runs and picks up a due job for this vendor.
                              Tenants are derived from products and groups tied to this vendor. Download uses the file snapshot stored for that run (when a file was produced).
                            </Typography>
                          </Box>
                          {selectedVendor && (
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() => fetchVendorScheduledJobRuns(selectedVendor.Id)}
                              disabled={loadingScheduledJobRuns}
                            >
                              Refresh
                            </Button>
                          )}
                        </Box>
                        {/* Tenant list from GET .../scheduled-export-tenants (vendor products/groups); runs add any extra names */}
                        {!loadingScheduledJobRuns && (
                          <Box
                            display="flex"
                            flexWrap="wrap"
                            alignItems="flex-end"
                            gap={2}
                            mb={2}
                            sx={{ maxWidth: 900 }}
                          >
                            <Box sx={{ minWidth: 220, flex: '1 1 200px' }}>
                              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                                Tenant
                              </Typography>
                              <SearchableDropdown
                                options={runHistoryTenantDropdownOptions}
                                value={runHistoryTenantFilter}
                                onChange={(v) => setRunHistoryTenantFilter(v)}
                                placeholder="All tenants"
                                searchPlaceholder="Search tenants..."
                                className="w-full"
                              />
                            </Box>
                            <Box sx={{ minWidth: 260, flex: '1 1 240px' }}>
                              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                                Scheduled job
                              </Typography>
                              <SearchableDropdown
                                options={runHistoryJobDropdownOptions}
                                value={runHistoryJobFilter}
                                onChange={(v) => setRunHistoryJobFilter(v)}
                                placeholder="All jobs"
                                searchPlaceholder="Search jobs..."
                                className="w-full"
                              />
                            </Box>
                            {(runHistoryTenantFilter || runHistoryJobFilter) && (
                              <button
                                type="button"
                                className="px-3 py-2 text-sm text-oe-primary border border-gray-300 rounded-lg hover:bg-gray-50"
                                onClick={() => {
                                  setRunHistoryTenantFilter('');
                                  setRunHistoryJobFilter('');
                                }}
                              >
                                Clear filters
                              </button>
                            )}
                          </Box>
                        )}
                        {loadingScheduledJobRuns ? (
                          <Box display="flex" justifyContent="center" p={4}>
                            <CircularProgress />
                          </Box>
                        ) : vendorScheduledJobRuns.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            No run history yet. Scheduler runs will appear here after exports execute.
                          </Typography>
                        ) : filteredScheduledJobRuns.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            No runs match the selected filters. Clear the filters above to see all runs.
                          </Typography>
                        ) : (
                          <TableContainer component={Paper} variant="outlined">
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell><strong>Ran at (local)</strong></TableCell>
                                  <TableCell><strong>Type</strong></TableCell>
                                  <TableCell><strong>Status</strong></TableCell>
                                  <TableCell align="right"><strong>Records</strong></TableCell>
                                  <TableCell><strong>Tenants</strong></TableCell>
                                  <TableCell><strong>NACHA</strong></TableCell>
                                  <TableCell><strong>File</strong></TableCell>
                                  <TableCell align="right"><strong>Download</strong></TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {filteredScheduledJobRuns.map((run) => (
                                  <TableRow key={run.vendorScheduledJobRunId}>
                                    <TableCell>{run.ranAt ? new Date(run.ranAt).toLocaleString() : '—'}</TableCell>
                                    <TableCell>{scheduledJobTypeLabel(run.jobType)}</TableCell>
                                    <TableCell>
                                      {!run.success ? (
                                        <Chip label="Failed" color="error" size="small" />
                                      ) : run.exportSkipped ? (
                                        <Chip label="Skipped" color="warning" size="small" />
                                      ) : (
                                        <Chip label="OK" color="success" size="small" />
                                      )}
                                      {run.errorMessage ? (
                                        <Typography variant="caption" display="block" color="error" sx={{ mt: 0.5 }}>
                                          {run.errorMessage}
                                        </Typography>
                                      ) : null}
                                    </TableCell>
                                    <TableCell align="right">{run.recordCount != null ? run.recordCount : '—'}</TableCell>
                                    <TableCell sx={{ maxWidth: 280 }}>
                                      {run.tenants && run.tenants.length > 0 ? (
                                        <Typography variant="body2" noWrap title={run.tenants.map((t) => t.tenantName || t.tenantId).join(', ')}>
                                          {run.tenants.map((t) => t.tenantName || t.tenantId).join(', ')}
                                        </Typography>
                                      ) : (
                                        '—'
                                      )}
                                    </TableCell>
                                    <TableCell sx={{ maxWidth: 120 }}>
                                      {run.jobType === 'payables_export' && run.nachaId
                                        ? `${String(run.nachaId).slice(0, 8)}…`
                                        : '—'}
                                    </TableCell>
                                    <TableCell sx={{ maxWidth: 200 }}>
                                      <Typography variant="body2" noWrap title={run.fileName || ''}>
                                        {run.fileName || '—'}
                                      </Typography>
                                    </TableCell>
                                    <TableCell align="right">
                                      {run.hasDownloadableFile && selectedVendor ? (
                                        <Tooltip title="Download file">
                                          <IconButton
                                            size="small"
                                            onClick={async () => {
                                              const vendorIdForRun = run.vendorId || selectedVendor.Id;
                                              const runId = run.vendorScheduledJobRunId;
                                              if (!vendorIdForRun || !runId) {
                                                showSnackbar('Missing vendor or run id for download', 'error');
                                                return;
                                              }
                                              try {
                                                const res = await axiosInstance.get(
                                                  `/api/vendors/${vendorIdForRun}/scheduled-job-runs/${runId}/download`,
                                                  { responseType: 'blob' }
                                                );
                                                if (res.data?.type === 'application/json') {
                                                  const text = await (res.data as Blob).text();
                                                  try {
                                                    const j = JSON.parse(text) as { message?: string };
                                                    showSnackbar(j?.message || 'Download failed', 'error');
                                                  } catch {
                                                    showSnackbar('Download failed', 'error');
                                                  }
                                                  return;
                                                }
                                                const url = window.URL.createObjectURL(new Blob([res.data]));
                                                const a = document.createElement('a');
                                                a.href = url;
                                                a.download = run.fileName || 'export.csv';
                                                a.click();
                                                window.URL.revokeObjectURL(url);
                                              } catch (e: any) {
                                                let msg = 'Download failed';
                                                const errData = e?.response?.data;
                                                if (errData instanceof Blob) {
                                                  try {
                                                    const text = await errData.text();
                                                    const j = JSON.parse(text) as { message?: string };
                                                    if (j?.message) msg = j.message;
                                                  } catch {
                                                    /* keep default */
                                                  }
                                                } else if (typeof e?.response?.data?.message === 'string') {
                                                  msg = e.response.data.message;
                                                }
                                                showSnackbar(msg, 'error');
                                              }
                                            }}
                                          >
                                            <Download className="h-4 w-4" />
                                          </IconButton>
                                        </Tooltip>
                                      ) : (
                                        <Typography variant="caption" color="text.secondary">—</Typography>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </TableContainer>
                        )}
                      </Box>
                    )}
                  </Box>
                </TabPanel>

                {/* Tab 8: Advanced (TPA) */}
                <TabPanel value={currentFormTab} index={8}>
                  <Box sx={{ p: 3 }}>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
                      <Box>
                        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                          Advanced — TPA (Third Party Administrator)
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Tenant-specific TPA records. Commissions processing uses the linked ACH in NACHA when enabled.
                        </Typography>
                      </Box>
                      {selectedVendor && (
                        <button
                          type="button"
                          onClick={() => handleOpenTpaModal()}
                          className="px-4 py-2 text-white rounded-lg transition-colors bg-oe-primary hover:bg-oe-primary-dark"
                        >
                          <Plus className="h-4 w-4 inline mr-2" />
                          Add Tenant TPA Services
                        </button>
                      )}
                    </Box>

                    {loadingTpaServices ? (
                      <Box display="flex" justifyContent="center" p={4}>
                        <CircularProgress />
                      </Box>
                    ) : tenantTpaServices.length === 0 ? (
                      <Box 
                        sx={{ 
                          p: 4, 
                          textAlign: 'center',
                          border: '1px dashed',
                          borderColor: 'divider',
                          borderRadius: 2
                        }}
                      >
                        <Typography variant="body1" color="text.secondary" gutterBottom>
                          No tenant TPA services configured yet.
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Click "Add Tenant TPA Services" to configure TPA services for a tenant.
                        </Typography>
                      </Box>
                    ) : (
                      <TableContainer component={Paper} variant="outlined">
                        <Table>
                          <TableHead>
                            <TableRow>
                              <TableCell><strong>Tenant</strong></TableCell>
                              <TableCell><strong>Services</strong></TableCell>
                              <TableCell><strong>Contact</strong></TableCell>
                              <TableCell><strong>ACH Account</strong></TableCell>
                              <TableCell align="right"><strong>Actions</strong></TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {tenantTpaServices.map((tpa: any) => {
                              const services = [];
                              if (tpa.TpaClaimsProcessing) services.push('Claims');
                              if (tpa.TpaEnrollmentManagement) services.push('Enrollment');
                              if (tpa.TpaCustomerService) services.push('Customer Service');
                              if (tpa.TpaMemberSupport) services.push('Member Support');
                              if (tpa.TpaReporting) services.push('Reporting');
                              if (tpa.TpaCompliance) services.push('Compliance');
                              if (tpa.TpaBillingCollections) services.push('Billing');
                              if (tpa.TpaCobraAdministration) services.push('COBRA');
                              if (tpa.TpaCommissionsProcessing) services.push('Commissions');
                              
                              return (
                                <TableRow key={tpa.VendorTenantTpaServiceId}>
                                  <TableCell>
                                    <Typography variant="body2" fontWeight="medium">
                                      {tpa.TenantName}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>
                                    {services.length > 0 ? (
                                      <Box display="flex" flexWrap="wrap" gap={0.5}>
                                        {services.map((service, idx) => (
                                          <Chip
                                            key={idx}
                                            label={service}
                                            size="small"
                                            sx={{ 
                                              fontSize: '0.7rem',
                                              height: '20px',
                                              backgroundColor: '#e3f2fd',
                                              color: '#1976d2'
                                            }}
                                          />
                                        ))}
                                      </Box>
                                    ) : (
                                      <Typography variant="body2" color="text.secondary">
                                        No services enabled
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {tpa.TpaContactName ? (
                                      <Box>
                                        <Typography variant="body2">{tpa.TpaContactName}</Typography>
                                        {tpa.TpaContactEmail && (
                                          <Typography variant="caption" color="text.secondary">
                                            {tpa.TpaContactEmail}
                                          </Typography>
                                        )}
                                      </Box>
                                    ) : (
                                      <Typography variant="body2" color="text.secondary">
                                        Not set
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {tpa.TpaAchAccountId ? (
                                      <Box>
                                        <Typography variant="body2">
                                          {tpa.AchAccountHolderName || 'N/A'}
                                        </Typography>
                                        {tpa.AchAccountNumberLast4 && (
                                          <Typography variant="caption" color="text.secondary">
                                            ••••{tpa.AchAccountNumberLast4}
                                          </Typography>
                                        )}
                                      </Box>
                                    ) : (
                                      <Typography variant="body2" color="text.secondary">
                                        None
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell align="right">
                                    <IconButton
                                      size="small"
                                      onClick={() => handleOpenTpaModal(tpa.TenantId)}
                                      sx={{ color: 'var(--oe-primary)' }}
                                    >
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                  </Box>
                </TabPanel>

                {/* Tab 9: Vendor portal users (SysAdmin) */}
                <TabPanel value={currentFormTab} index={9}>
                  <Box sx={{ p: 0 }}>
                    {selectedVendor?.Id ? (
                      <AdminVendorUserManagementPanel
                        vendorId={selectedVendor.Id}
                        vendorName={selectedVendor.VendorName || formData.VendorName || undefined}
                      />
                    ) : (
                      <Box sx={{ p: 3 }}>
                        <Typography variant="body2" color="text.secondary">
                          Save the vendor first, then open this tab to add or manage logins for the vendor portal (share
                          requests and related tools).
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </TabPanel>

                {/* Tab 10: Signed ASAs (shared with vendor portal via /vendor/settings) */}
                <TabPanel value={currentFormTab} index={10}>
                  <Box sx={{ p: 3 }}>
                    {selectedVendor?.Id ? (
                      renderSignedAsasPanel()
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Save the vendor first, then open this tab to review signed ASAs.
                      </Typography>
                    )}
                  </Box>
                </TabPanel>

                {/* Tab 6: Member Pages */}
                <TabPanel value={currentFormTab} index={6}>
                  <Box sx={{ p: 3 }}>{renderVendorNavigation()}</Box>
                </TabPanel>

                {/* Tab 11: Networks (shared component, also used in vendor portal /vendor/settings) */}
                <TabPanel value={currentFormTab} index={11}>
                  <Box sx={{ p: 3 }}>
                    {selectedVendor?.Id ? (
                      <VendorNetworksPanel mode="admin" vendorId={selectedVendor.Id} />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Save the vendor first, then open this tab to manage its networks.
                      </Typography>
                    )}
                  </Box>
                </TabPanel>

                {/* Tab 12: Request Types (vendor portal only) */}
                {isVendorPortal && (
                  <TabPanel value={currentFormTab} index={12}>
                    <VendorRequestTypeSettings />
                  </TabPanel>
                )}
                {/* Tab 13: TPA Case Forwarding (vendor portal only) */}
                {isVendorPortal && (
                  <TabPanel value={currentFormTab} index={13}>
                    <TpaForwardingTab />
                  </TabPanel>
                )}
                {/* Tab 14: Email Settings — Office 365 mailbox for the Back Office inbox (vendor portal only) */}
                {isVendorPortal && (
                  <TabPanel value={currentFormTab} index={14}>
                    <Box sx={{ p: 3 }}>
                      <VendorEmailSettings />
                    </Box>
                  </TabPanel>
                )}
                </Box>
              </DialogContent>
            </Dialog>

            {/* New group form template editor (opened from Groups tab) */}
            <Dialog
              open={newGroupFormEditorModalOpen && !!selectedVendor}
              onClose={() => {
                if (!newGroupFormSaving) setNewGroupFormEditorModalOpen(false);
              }}
              maxWidth="md"
              fullWidth
              PaperProps={{ sx: { maxHeight: '90vh' } }}
            >
              <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pr: 1 }}>
                <span>Edit new group form template</span>
                <IconButton onClick={() => !newGroupFormSaving && setNewGroupFormEditorModalOpen(false)} disabled={newGroupFormSaving} aria-label="Close">
                  <CloseIcon />
                </IconButton>
              </DialogTitle>
              <DialogContent dividers sx={{ pt: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Configure the form fields and mappings used when generating the &quot;New Group Form&quot; PDF for groups that have this vendor&apos;s products.
                </Typography>
                {newGroupFormLoading ? (
                  <Box display="flex" justifyContent="center" p={4}>
                    <CircularProgress />
                  </Box>
                ) : (
                  <>
                    <TextField
                      fullWidth
                      label="Form title"
                      value={newGroupFormTitle}
                      onChange={(e) => setNewGroupFormTitle(e.target.value)}
                      placeholder="e.g. MightyWell Health New Group Review / Sold Sheet"
                      sx={{ mb: 3 }}
                    />
                    <Typography variant="subtitle2" fontWeight="medium" gutterBottom>
                      Form rows
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
                      Each row uses <strong>Row kind</strong>. Use <strong>Field</strong> plus <strong>Map to</strong> for normal inputs — choose <strong>Master group id</strong> for one Master ID line only. Use <strong>Vendor Group ID(s)</strong> to insert Master plus every product ID block at once.
                    </Typography>
                    {newGroupFormFields.map((field, idx) => {
                      const ft = field.fieldType ?? 'field';
                      return (
                      <Box key={idx} sx={{ mb: 2 }}>
                        <Box display="flex" gap={1} alignItems="center" flexWrap="wrap">
                        <FormControl size="small" sx={{ minWidth: 200 }}>
                          <InputLabel>Row kind</InputLabel>
                          <Select
                            value={ft}
                            label="Row kind"
                            title="Vendor Group ID(s): expands to Master + product IDs at this position"
                            onChange={(e) => {
                              const next = [...newGroupFormFields];
                              const v = e.target.value as 'field' | 'labelHeader' | 'includeAllVendorGroupIds';
                              if (v === 'includeAllVendorGroupIds') {
                                next[idx] = {
                                  ...next[idx],
                                  fieldType: v,
                                  systemVariable: '',
                                };
                              } else if (v === 'labelHeader') {
                                next[idx] = {
                                  ...next[idx],
                                  fieldType: v,
                                  systemVariable: '',
                                  attemptAutoGenerateVendorGroupIdsIfMissing: undefined,
                                };
                              } else {
                                next[idx] = { ...next[idx], fieldType: 'field' };
                              }
                              setNewGroupFormFields(next);
                            }}
                          >
                            <MenuItem value="field">Field</MenuItem>
                            <MenuItem value="labelHeader">Label Header</MenuItem>
                            <MenuItem value="includeAllVendorGroupIds">Vendor Group ID(s)</MenuItem>
                          </Select>
                        </FormControl>
                        <TextField
                          size="small"
                          label={
                            ft === 'labelHeader'
                              ? 'Section header'
                              : ft === 'includeAllVendorGroupIds'
                                ? 'Optional section title'
                                : 'Label'
                          }
                          value={field.label}
                          onChange={(e) => {
                            const next = [...newGroupFormFields];
                            next[idx] = { ...next[idx], label: e.target.value, key: next[idx].key || e.target.value };
                            setNewGroupFormFields(next);
                          }}
                          sx={{ flex: 1, minWidth: 180 }}
                        />
                        {ft === 'field' && (
                          <>
                            <FormControl size="small" sx={{ minWidth: 220 }}>
                              <InputLabel>Map to</InputLabel>
                              <Select
                                value={field.key === 'agentSignature' ? '__agentSignature__' : field.key === 'groupAdminSignature' ? '__groupAdminSignature__' : (field.systemVariable ?? '')}
                                label="Map to"
                                onChange={(e) => {
                                  const next = [...newGroupFormFields];
                                  const v = e.target.value as string;
                                  if (v === '__agentSignature__') {
                                    next[idx] = {
                                      ...next[idx],
                                      systemVariable: '__agentSignature__',
                                      key: 'agentSignature',
                                      defaultValue: '',
                                      attemptAutoGenerateVendorGroupIdsIfMissing: undefined,
                                    };
                                  } else if (v === '__groupAdminSignature__') {
                                    next[idx] = {
                                      ...next[idx],
                                      systemVariable: '__groupAdminSignature__',
                                      key: 'groupAdminSignature',
                                      defaultValue: '',
                                      attemptAutoGenerateVendorGroupIdsIfMissing: undefined,
                                    };
                                  } else {
                                    const row = {
                                      ...next[idx],
                                      systemVariable: v,
                                      key: (field.key === 'agentSignature' || field.key === 'groupAdminSignature') ? `field_${Date.now()}` : field.key,
                                    };
                                    if (!isVendorGroupIdSystemVariable(v)) delete row.attemptAutoGenerateVendorGroupIdsIfMissing;
                                    next[idx] = row;
                                  }
                                  setNewGroupFormFields(next);
                                }}
                              >
                                {NEW_GROUP_FORM_SYSTEM_VARIABLES.map((opt) => (
                                  <MenuItem key={opt.value || 'blank'} value={opt.value}>{opt.label}</MenuItem>
                                ))}
                                <ListSubheader sx={{ lineHeight: 2 }}>Vendor Group ID</ListSubheader>
                                <MenuItem value="group.vendorMasterGroupId">Master group id</MenuItem>
                                {newGroupFormProductTypes.map((t) => (
                                  <MenuItem key={`vgid-type-${t.productType}`} value={`group.vendorProductGroupId_${t.productType}`}>
                                    {t.productType} (group id by type)
                                  </MenuItem>
                                ))}
                                {newGroupFormProductOptions.length === 0 && newGroupFormProductTypes.length === 0 ? (
                                  <MenuItem disabled value="__no_products__">
                                    — No products for this vendor —
                                  </MenuItem>
                                ) : (
                                  newGroupFormProductOptions.map((p) => (
                                    <MenuItem
                                      key={`vgid-${p.productId}`}
                                      value={`group.vendorProductGroupId_${p.productId}`}
                                      disabled={!p.hasVendorGroupIdSetting}
                                    >
                                      {p.name} (product group id){!p.hasVendorGroupIdSetting ? ' — group ID not configured' : ''}
                                    </MenuItem>
                                  ))
                                )}
                              </Select>
                            </FormControl>
                            {field.systemVariable !== '__agentSignature__' && field.systemVariable !== '__groupAdminSignature__' && field.key !== 'agentSignature' && field.key !== 'groupAdminSignature' && (
                              <TextField
                                size="small"
                                label="Default value"
                                value={field.defaultValue ?? ''}
                                onChange={(e) => {
                                  const next = [...newGroupFormFields];
                                  next[idx] = { ...next[idx], defaultValue: e.target.value };
                                  setNewGroupFormFields(next);
                                }}
                                placeholder="e.g. Digital"
                                sx={{ minWidth: 140 }}
                                title="Default value when no system variable is mapped or value is empty"
                              />
                            )}
                          </>
                        )}
                        <IconButton
                          size="small"
                          onClick={() => setNewGroupFormFields(newGroupFormFields.filter((_, i) => i !== idx))}
                          color="error"
                          title="Remove field"
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </Box>
                        {ft === 'includeAllVendorGroupIds' && (
                          <>
                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1, ml: 1 }}>
                              Inserts Master and each configured product vendor group ID line here (deduped with separate Field rows mapped to IDs).
                            </Typography>
                            <FormControlLabel
                              sx={{ mt: 1, ml: 1, alignItems: 'flex-start', display: 'flex' }}
                              control={
                                <Checkbox
                                  checked={!!field.attemptAutoGenerateVendorGroupIdsIfMissing}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setNewGroupFormFields((prev) => {
                                      const copy = [...prev];
                                      const row = { ...copy[idx] };
                                      if (checked) row.attemptAutoGenerateVendorGroupIdsIfMissing = true;
                                      else delete row.attemptAutoGenerateVendorGroupIdsIfMissing;
                                      copy[idx] = row;
                                      return copy;
                                    });
                                  }}
                                />
                              }
                              label={
                                <Box>
                                  <Typography variant="body2" fontWeight={500}>
                                    Generate vendor group IDs if missing
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary" display="block">
                                    Runs ID generation for this group before filling the form (same logic as Generate IDs on Field rows).
                                  </Typography>
                                </Box>
                              }
                            />
                          </>
                        )}
                        {ft === 'field' && isVendorGroupIdSystemVariable(field.systemVariable ?? '') && (
                          <FormControlLabel
                            sx={{ mt: 1, ml: 1, alignItems: 'flex-start', display: 'flex' }}
                            control={
                              <Checkbox
                                checked={!!field.attemptAutoGenerateVendorGroupIdsIfMissing}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setNewGroupFormFields((prev) => {
                                    const copy = [...prev];
                                    const row = { ...copy[idx] };
                                    if (checked) row.attemptAutoGenerateVendorGroupIdsIfMissing = true;
                                    else delete row.attemptAutoGenerateVendorGroupIdsIfMissing;
                                    copy[idx] = row;
                                    return copy;
                                  });
                                }}
                              />
                            }
                            label={
                              <Box>
                                <Typography variant="body2" fontWeight={500}>
                                  Attempt to auto-generate vendor group IDs if missing
                                </Typography>
                                <Typography variant="caption" color="text.secondary" display="block">
                                  Runs ID generation for this group before filling the form (same logic as Generate IDs).
                                </Typography>
                              </Box>
                            }
                          />
                        )}
                      </Box>
                      );
                    })}
                    <Box display="flex" flexWrap="wrap" gap={1} sx={{ mt: 2, mb: 3 }}>
                      <Button
                        variant="outlined"
                        startIcon={<Plus className="h-4 w-4" />}
                        onClick={() => setNewGroupFormFields([...newGroupFormFields, { key: '', label: '', systemVariable: '', defaultValue: '', fieldType: 'field' }])}
                      >
                        Add field
                      </Button>
                      <Button
                        variant="outlined"
                        startIcon={<FileText className="h-4 w-4" />}
                        onClick={() => {
                          setNewGroupFormTitle(MIGHTYWELL_NEW_GROUP_FORM_PRESET.formTitle);
                          setNewGroupFormFields(MIGHTYWELL_NEW_GROUP_FORM_PRESET.fields.map((f) => ({ ...f })));
                        }}
                      >
                        Load Default Template
                      </Button>
                    </Box>
                    {selectedVendor && (
                      <Button
                        variant="contained"
                        disabled={newGroupFormSaving}
                        startIcon={newGroupFormSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        onClick={async () => {
                          setNewGroupFormSaving(true);
                          try {
                            const fieldsForApi = newGroupFormFields.map((f) => {
                              if (f.systemVariable === '__agentSignature__') return { ...f, key: 'agentSignature', systemVariable: undefined };
                              if (f.systemVariable === '__groupAdminSignature__') return { ...f, key: 'groupAdminSignature', systemVariable: undefined };
                              return f;
                            }).map((f) => {
                              const ft = f.fieldType || 'field';
                              const injectAllRow = ft === 'includeAllVendorGroupIds';
                              const mappedVendorGid = isVendorGroupIdSystemVariable(f.systemVariable ?? '');
                              const autoGen =
                                f.attemptAutoGenerateVendorGroupIdsIfMissing === true && (injectAllRow || mappedVendorGid)
                                  ? { attemptAutoGenerateVendorGroupIdsIfMissing: true as const }
                                  : {};
                              return {
                                key: f.key || f.label,
                                label: f.label,
                                systemVariable: f.systemVariable || undefined,
                                defaultValue: f.defaultValue && String(f.defaultValue).trim() ? String(f.defaultValue).trim() : undefined,
                                fieldType: ft,
                                ...autoGen,
                              };
                            });
                            await axiosInstance.put(`/api/vendors/${selectedVendor.Id}/new-group-form`, {
                              formTitle: newGroupFormTitle,
                              fields: fieldsForApi,
                            });
                            showSnackbar('New group form configuration saved.', 'success');
                          } catch (e: any) {
                            showSnackbar(e?.response?.data?.message || 'Failed to save.', 'error');
                          } finally {
                            setNewGroupFormSaving(false);
                          }
                        }}
                        sx={{ backgroundColor: 'var(--oe-primary)', '&:hover': { backgroundColor: 'var(--oe-primary-dark)' } }}
                      >
                        {newGroupFormSaving ? 'Saving…' : 'Save New Group Form'}
                      </Button>
                    )}
                  </>
                )}
              </DialogContent>
            </Dialog>

            <NewGroupFormGenerateModal
              open={!!newGroupFormModalGroup}
              onClose={() => setNewGroupFormModalGroup(null)}
              groupId={newGroupFormModalGroup?.groupId ?? ''}
              groupName={newGroupFormModalGroup?.groupName ?? ''}
              onNotify={(msg, sev) => {
                if (sev === 'success') showSnackbar(msg, 'success');
                else if (sev === 'error') showSnackbar(msg, 'error');
                else showSnackbar(msg, 'info');
              }}
            />

            {/* Scheduled job add/edit */}
            <Dialog
              open={scheduledJobModalOpen}
              onClose={() => {
                if (!savingScheduledJob) setScheduledJobModalOpen(false);
              }}
              maxWidth="sm"
              fullWidth
            >
              <DialogTitle>
                {scheduledJobModalEditingId ? 'Edit scheduled job' : 'Add scheduled job'}
              </DialogTitle>
              <DialogContent>
                <Grid container spacing={2} sx={{ mt: 0.5 }}>
                  <Grid size={12}>
                    <FormControl fullWidth size="small">
                      <InputLabel id="sj-job-type-label">Job type</InputLabel>
                      <Select
                        labelId="sj-job-type-label"
                        label="Job type"
                        value={scheduledJobForm.jobType}
                        onChange={(e) => {
                          const v = e.target.value as string;
                          setScheduledJobForm((prev) => ({
                            ...prev,
                            jobType: v,
                            exportTrigger:
                              v === 'asa_signed'
                                ? 'asa_signed'
                                : v !== 'payables_export' && prev.exportTrigger === 'nacha_generation'
                                  ? 'schedule'
                                  : prev.exportTrigger === 'asa_signed' && v !== 'asa_signed'
                                    ? 'schedule'
                                    : prev.exportTrigger,
                            ...(v === 'new_group_form' || v === 'asa_signed'
                              ? { useVendorDefaultSftp: false, sftpPathOverride: '' }
                              : {}),
                          }));
                        }}
                      >
                        <MenuItem value="eligibility_export">Eligibility export</MenuItem>
                        <MenuItem value="payables_export">Payables export (latest NACHA)</MenuItem>
                        <MenuItem value="new_group_form">New group form (PDF links by email)</MenuItem>
                        <MenuItem value="asa_signed">ASA signed (email signed PDF when a group signs)</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid size={12}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={scheduledJobForm.isEnabled}
                          onChange={(e) =>
                            setScheduledJobForm({ ...scheduledJobForm, isEnabled: e.target.checked })
                          }
                        />
                      }
                      label="Enabled"
                    />
                  </Grid>
                  {scheduledJobForm.jobType === 'payables_export' && (
                    <Grid size={12}>
                      <FormControl fullWidth size="small">
                        <InputLabel id="sj-trigger-label">When to run payables</InputLabel>
                        <Select
                          labelId="sj-trigger-label"
                          label="When to run payables"
                          value={scheduledJobForm.exportTrigger}
                          onChange={(e) =>
                            setScheduledJobForm({
                              ...scheduledJobForm,
                              exportTrigger: e.target.value as 'schedule' | 'nacha_generation',
                            })
                          }
                        >
                          <MenuItem value="schedule">On a calendar schedule (below)</MenuItem>
                          <MenuItem value="nacha_generation">When NACHA is marked Sent (this vendor in batch)</MenuItem>
                        </Select>
                      </FormControl>
                      {scheduledJobForm.exportTrigger === 'nacha_generation' && (
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                          Runs automatically when the NACHA batch is marked Sent in Accounting (async; typically within
                          seconds). Calendar time below is stored but not used for this trigger.
                        </Typography>
                      )}
                    </Grid>
                  )}
                  {scheduledJobForm.jobType === 'asa_signed' && (
                    <Grid size={12}>
                      <Typography variant="body2" color="text.secondary">
                        Fires automatically each time a group signs a Vendor ASA Agreement for any of
                        this vendor's products (from the group portal or onboarding wizard). The
                        signed PDF is emailed as an attachment to the recipients below.
                      </Typography>
                    </Grid>
                  )}
                  {scheduledJobForm.jobType !== 'asa_signed' && (
                  <Grid size={12}>
                    <FormControl fullWidth size="small">
                      <InputLabel>Schedule</InputLabel>
                      <Select
                        value={scheduledJobForm.exportSchedule}
                        label="Schedule"
                        disabled={
                          scheduledJobForm.jobType === 'payables_export' &&
                          scheduledJobForm.exportTrigger === 'nacha_generation'
                        }
                        onChange={(e) =>
                          setScheduledJobForm({
                            ...scheduledJobForm,
                            exportSchedule: e.target.value as 'daily' | 'weekly' | 'monthly',
                          })
                        }
                      >
                        <MenuItem value="daily">Daily</MenuItem>
                        <MenuItem value="weekly">Weekly</MenuItem>
                        <MenuItem value="monthly">Monthly (choose day)</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  )}
                  {scheduledJobForm.jobType !== 'asa_signed' && scheduledJobForm.exportSchedule === 'weekly' && (
                    <Grid size={12}>
                      <FormControl fullWidth size="small">
                        <InputLabel>Day of week</InputLabel>
                        <Select
                          value={scheduledJobForm.exportScheduleDay}
                          label="Day of week"
                          onChange={(e) =>
                            setScheduledJobForm({ ...scheduledJobForm, exportScheduleDay: e.target.value })
                          }
                        >
                          <MenuItem value="Monday">Monday</MenuItem>
                          <MenuItem value="Tuesday">Tuesday</MenuItem>
                          <MenuItem value="Wednesday">Wednesday</MenuItem>
                          <MenuItem value="Thursday">Thursday</MenuItem>
                          <MenuItem value="Friday">Friday</MenuItem>
                          <MenuItem value="Saturday">Saturday</MenuItem>
                          <MenuItem value="Sunday">Sunday</MenuItem>
                        </Select>
                      </FormControl>
                    </Grid>
                  )}
                  {scheduledJobForm.jobType !== 'asa_signed' && scheduledJobForm.exportSchedule === 'monthly' && (
                    <Grid size={12}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Day of month (1–31)"
                        type="number"
                        inputProps={{ min: 1, max: 31 }}
                        value={scheduledJobForm.exportScheduleDayOfMonth}
                        disabled={
                          scheduledJobForm.jobType === 'payables_export' &&
                          scheduledJobForm.exportTrigger === 'nacha_generation'
                        }
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setScheduledJobForm({
                            ...scheduledJobForm,
                            exportScheduleDayOfMonth:
                              Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : 1,
                          });
                        }}
                        helperText="Short months use the last valid day (e.g. day 31 → Feb 28/29)."
                      />
                    </Grid>
                  )}
                  {scheduledJobForm.jobType !== 'asa_signed' && (
                  <Grid size={12}>
                    <TextField
                      fullWidth
                      size="small"
                      label="Run time"
                      type="time"
                      value={scheduledJobForm.exportScheduleTime}
                      onChange={(e) =>
                        setScheduledJobForm({ ...scheduledJobForm, exportScheduleTime: e.target.value })
                      }
                      InputLabelProps={{ shrink: true }}
                      disabled={
                        scheduledJobForm.jobType === 'payables_export' &&
                        scheduledJobForm.exportTrigger === 'nacha_generation'
                      }
                      helperText={`Local · ${getBrowserIanaTimeZone()}${
                        scheduledJobForm.jobType === 'payables_export' &&
                        scheduledJobForm.exportTrigger === 'nacha_generation'
                          ? ' (unused for NACHA sent trigger)'
                          : ''
                      }`}
                    />
                  </Grid>
                  )}
                  <Grid size={12}>
                    <TextField
                      fullWidth
                      size="small"
                      label={
                        scheduledJobForm.jobType === 'new_group_form'
                          ? 'Email recipients (required)'
                          : 'Email recipients (optional)'
                      }
                      value={scheduledJobForm.emailRecipients}
                      onChange={(e) =>
                        setScheduledJobForm({ ...scheduledJobForm, emailRecipients: e.target.value })
                      }
                      multiline
                      minRows={2}
                      placeholder="a@x.com, b@y.com"
                      helperText={
                        scheduledJobForm.jobType === 'new_group_form'
                          ? 'One email lists all groups with 7-day PDF download links. Comma-separated.'
                          : scheduledJobForm.jobType === 'asa_signed'
                            ? 'Each signed ASA emails the PDF attachment to these addresses. If empty, falls back to the vendor Email + notification contacts.'
                            : 'Replaces vendor default list when set.'
                      }
                      required={scheduledJobForm.jobType === 'new_group_form'}
                    />
                  </Grid>
                  {scheduledJobForm.jobType === 'new_group_form' && (
                    <Grid size={12}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={scheduledJobForm.generateVendorGroupIdsIfNeeded}
                            onChange={(e) =>
                              setScheduledJobForm({
                                ...scheduledJobForm,
                                generateVendorGroupIdsIfNeeded: e.target.checked,
                              })
                            }
                          />
                        }
                        label="Generate vendor-group IDs if needed (before PDF)"
                      />
                    </Grid>
                  )}
                  {scheduledJobForm.jobType === 'eligibility_export' && (
                    <Grid size={12}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={scheduledJobForm.excludeGroupsMissingVendorGroupId}
                            onChange={(e) =>
                              setScheduledJobForm({
                                ...scheduledJobForm,
                                excludeGroupsMissingVendorGroupId: e.target.checked,
                              })
                            }
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2">
                              Exclude groups missing a vendor group ID
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Drops households whose group has no master vendor group ID for this vendor. Individuals
                              (no group) are unaffected — included as before.
                            </Typography>
                          </Box>
                        }
                      />
                    </Grid>
                  )}
                  {scheduledJobForm.jobType !== 'asa_signed' && (
                  <Grid size={12}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={scheduledJobForm.useVendorDefaultSftp}
                          disabled={scheduledJobForm.jobType === 'new_group_form'}
                          onChange={(e) =>
                            setScheduledJobForm({
                              ...scheduledJobForm,
                              useVendorDefaultSftp: e.target.checked,
                            })
                          }
                        />
                      }
                      label="Upload via vendor SFTP (Eligibility tab)"
                    />
                  </Grid>
                  )}
                  {scheduledJobForm.useVendorDefaultSftp &&
                    scheduledJobForm.jobType !== 'new_group_form' &&
                    scheduledJobForm.jobType !== 'asa_signed' && (
                    <Grid size={12}>
                      <Typography variant="body2" color="text.primary" sx={{ mb: 1 }}>
                        Default folder:{' '}
                        <Box
                          component="span"
                          sx={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                            fontWeight: 600,
                            wordBreak: 'break-all',
                          }}
                        >
                          {getVendorDefaultSftpPathForScheduledJob(
                            selectedVendor,
                            scheduledJobForm.jobType
                          ) || '—'}
                        </Box>
                      </Typography>
                      <TextField
                        fullWidth
                        size="small"
                        label="Path override"
                        placeholder="Uses default folder above if empty"
                        value={scheduledJobForm.sftpPathOverride}
                        onChange={(e) =>
                          setScheduledJobForm({ ...scheduledJobForm, sftpPathOverride: e.target.value })
                        }
                      />
                    </Grid>
                  )}
                  {!scheduledJobForm.useVendorDefaultSftp &&
                    scheduledJobForm.jobType !== 'new_group_form' &&
                    scheduledJobForm.jobType !== 'asa_signed' && (
                    <Grid size={12}>
                      <Typography variant="body2" color="text.secondary">
                        SFTP upload off — file is generated and emailed only.
                      </Typography>
                    </Grid>
                  )}
                  {scheduledJobForm.jobType === 'new_group_form' && (
                    <Grid size={12}>
                      <Typography variant="body2" color="text.secondary">
                        New group form jobs email PDF links only (no SFTP). Groups are included when the earliest
                        qualifying enrollment effective date is within 14 days; farther-out future effective dates are
                        skipped until closer.
                      </Typography>
                    </Grid>
                  )}
                </Grid>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setScheduledJobModalOpen(false)} disabled={savingScheduledJob}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  disabled={savingScheduledJob || !selectedVendor}
                  onClick={async () => {
                    if (!selectedVendor) return;
                    const tz = vendorScheduleTimezone || DEFAULT_VENDOR_EXPORT_SCHEDULE_TZ;
                    const isAsaSigned = scheduledJobForm.jobType === 'asa_signed';
                    const payload = {
                      jobType: scheduledJobForm.jobType,
                      isEnabled: scheduledJobForm.isEnabled,
                      // asa_signed has no calendar schedule — the backend defaults these when absent
                      exportSchedule: isAsaSigned ? 'daily' : scheduledJobForm.exportSchedule,
                      exportScheduleDay:
                        !isAsaSigned && scheduledJobForm.exportSchedule === 'weekly'
                          ? scheduledJobForm.exportScheduleDay
                          : null,
                      exportScheduleDayOfMonth:
                        !isAsaSigned && scheduledJobForm.exportSchedule === 'monthly'
                          ? scheduledJobForm.exportScheduleDayOfMonth ?? 1
                          : null,
                      exportTrigger: isAsaSigned
                        ? 'asa_signed'
                        : scheduledJobForm.jobType === 'payables_export'
                          ? scheduledJobForm.exportTrigger
                          : 'schedule',
                      exportScheduleTime: isAsaSigned
                        ? '09:00'
                        : localInputToServerScheduleTime(
                            scheduledJobForm.exportScheduleTime,
                            tz
                          ),
                      emailRecipients: scheduledJobForm.emailRecipients.trim() || null,
                      useVendorDefaultSftp:
                        scheduledJobForm.jobType === 'new_group_form' || isAsaSigned
                          ? false
                          : scheduledJobForm.useVendorDefaultSftp,
                      sftpPathOverride:
                        scheduledJobForm.jobType === 'new_group_form' || isAsaSigned
                          ? null
                          : scheduledJobForm.sftpPathOverride.trim() || null,
                      generateVendorGroupIdsIfNeeded:
                        scheduledJobForm.jobType === 'new_group_form' &&
                        scheduledJobForm.generateVendorGroupIdsIfNeeded,
                      excludeGroupsMissingVendorGroupId:
                        scheduledJobForm.jobType === 'eligibility_export' &&
                        scheduledJobForm.excludeGroupsMissingVendorGroupId,
                    };
                    setSavingScheduledJob(true);
                    try {
                      if (scheduledJobModalEditingId) {
                        await axiosInstance.put(
                          `/api/vendors/${selectedVendor.Id}/scheduled-jobs/${scheduledJobModalEditingId}`,
                          payload
                        );
                        showSnackbar('Scheduled job updated', 'success');
                      } else {
                        await axiosInstance.post(`/api/vendors/${selectedVendor.Id}/scheduled-jobs`, payload);
                        showSnackbar('Scheduled job created', 'success');
                      }
                      setScheduledJobModalOpen(false);
                      fetchVendorScheduledJobs(selectedVendor.Id);
                      refreshScheduledJobRunHistory(selectedVendor.Id);
                    } catch (e: any) {
                      showSnackbar(e?.response?.data?.message || 'Save failed', 'error');
                    } finally {
                      setSavingScheduledJob(false);
                    }
                  }}
                  sx={{ backgroundColor: 'var(--oe-primary)', '&:hover': { backgroundColor: 'var(--oe-primary-dark)' } }}
                >
                  {savingScheduledJob ? 'Saving…' : 'Save'}
                </Button>
              </DialogActions>
            </Dialog>

            {/* Add Product Dialog - Using AddProductsWizard */}
            {showAddProduct && selectedVendor && (
              <Dialog
                open={showAddProduct}
                onClose={closeProductWizard}
                maxWidth="lg"
                fullWidth
                PaperProps={{
                  sx: { 
                    height: '90vh',
                    display: 'flex',
                    flexDirection: 'column'
                  }
                }}
              >
                <DialogTitle>
                  <Box display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="h5">
                      {editingProduct ? 'Edit Product' : 'Add Products'}
                    </Typography>
                    <IconButton onClick={closeProductWizard}>
                      <CloseIcon />
                    </IconButton>
                  </Box>
                </DialogTitle>
                <DialogContent sx={{ flex: 1, overflow: 'auto', p: 0 }}>
                  <AddProductsWizard 
                    editingProduct={editingProduct || undefined}
                    prefilledVendorId={selectedVendor.Id}
                    onSave={handleSaveProduct}
                    onComplete={handleProductWizardComplete}
                    onCancel={closeProductWizard}
                  />
                </DialogContent>
              </Dialog>
            )}

            {navModalOpen && selectedVendor && (
              <Dialog
                open={navModalOpen}
                onClose={() => {
                  if (!navModalSubmitting) closeNavigationModal();
                }}
                maxWidth="md"
                fullWidth
              >
                <DialogTitle>
                  {navModalMode === 'edit' ? 'Edit page' : 'Add page'}
                </DialogTitle>
                <DialogContent dividers>
                  <Box component="div" sx={{ mt: 1 }}>
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Label"
                          fullWidth
                          value={navModalForm.label}
                          onChange={(e) => handleNavigationInputChange('label', e.target.value)}
                          error={Boolean(navModalErrors.label)}
                          helperText={navModalErrors.label}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Route Key"
                          fullWidth
                          value={navModalForm.routeKey}
                          onChange={(e) => handleNavigationInputChange('routeKey', e.target.value)}
                          error={Boolean(navModalErrors.routeKey)}
                          helperText={navModalErrors.routeKey || 'Lowercase letters, numbers, and hyphens only'}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <FormControl fullWidth>
                          <InputLabel>Content Type</InputLabel>
                          <Select
                            label="Content Type"
                            value={navModalForm.contentType}
                            onChange={(e) => handleNavigationInputChange('contentType', e.target.value)}
                          >
                            {NAV_CONTENT_TYPES.map((option) => (
                              <MenuItem key={option.value} value={option.value}>
                                {option.label}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Content Reference"
                          fullWidth
                          value={navModalForm.contentRef}
                          onChange={(e) => handleNavigationInputChange('contentRef', e.target.value)}
                          error={Boolean(navModalErrors.contentRef)}
                          helperText={navModalErrors.contentRef || 'Path or URL used by the member experience'}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Icon Name (optional)"
                          fullWidth
                          value={navModalForm.iconName}
                          onChange={(e) => handleNavigationInputChange('iconName', e.target.value)}
                          helperText="Lucide icon name, e.g., 'file-text'"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Sort Order"
                          fullWidth
                          type="number"
                          value={navModalForm.sortOrder}
                          onChange={(e) => handleNavigationInputChange('sortOrder', e.target.value)}
                        />
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <TextField
                          label="Description"
                          fullWidth
                          multiline
                          minRows={2}
                          value={navModalForm.description}
                          onChange={(e) => handleNavigationInputChange('description', e.target.value)}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <FormControl fullWidth>
                          <InputLabel>Scope</InputLabel>
                          <Select
                            label="Scope"
                            value={navModalForm.tenantScope}
                            onChange={(e) => handleNavigationInputChange('tenantScope', e.target.value)}
                          >
                            <MenuItem value="all">All tenants</MenuItem>
                            <MenuItem value="specific">Specific tenant</MenuItem>
                          </Select>
                        </FormControl>
                      </Grid>
                      {navModalForm.tenantScope === 'specific' && (
                        <Grid size={{ xs: 12, md: 6 }}>
                          <TextField
                            label="Tenant ID"
                            fullWidth
                            value={navModalForm.tenantId}
                            onChange={(e) => handleNavigationInputChange('tenantId', e.target.value)}
                            error={Boolean(navModalErrors.tenantId)}
                            helperText={navModalErrors.tenantId || 'Provide the Tenant GUID for this link'}
                          />
                        </Grid>
                      )}
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Effective Date"
                          type="date"
                          fullWidth
                          InputLabelProps={{ shrink: true }}
                          value={navModalForm.effectiveDate}
                          onChange={(e) => handleNavigationInputChange('effectiveDate', e.target.value)}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <TextField
                          label="Expiration Date"
                          type="date"
                          fullWidth
                          InputLabelProps={{ shrink: true }}
                          value={navModalForm.expirationDate}
                          onChange={(e) => handleNavigationInputChange('expirationDate', e.target.value)}
                        />
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <FormControlLabel
                          control={
                            <Switch
                              checked={navModalForm.published}
                              onChange={(e) => handleNavigationInputChange('published', e.target.checked)}
                            />
                          }
                          label="Published"
                        />
                      </Grid>
                      <Grid size={{ xs: 12 }}>
                        <TextField
                          label="Visibility Rule JSON"
                          fullWidth
                          multiline
                          minRows={4}
                          value={navModalForm.visibilityRule}
                          onChange={(e) => handleNavigationInputChange('visibilityRule', e.target.value)}
                          error={Boolean(navModalErrors.visibilityRule)}
                          helperText={
                            navModalErrors.visibilityRule ||
                            'Example: {"requiresActiveEnrollment": true, "productIds": ["PRODUCT-ID"], "bundleProductIds": []}'
                          }
                        />
                      </Grid>
                    </Grid>
                  </Box>
                </DialogContent>
                <DialogActions>
                  <button
                    type="button"
                    className="btn-secondary focus-ring"
                    onClick={closeNavigationModal}
                    disabled={navModalSubmitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary focus-ring"
                    onClick={handleSaveNavigationPage}
                    disabled={navModalSubmitting}
                  >
                    {navModalSubmitting
                      ? navModalMode === 'edit'
                        ? 'Saving...'
                        : 'Creating...'
                      : navModalMode === 'edit'
                      ? 'Save Changes'
                      : 'Create Page'}
                  </button>
                </DialogActions>
              </Dialog>
            )}

            {/* PDF Signer Editor Modal */}
            {editingDocument && (
              <PDFSignerEditor
                documentId={editingDocument.DocumentId}
                documentUrl={editingDocument.Url}
                onClose={() => {
                  setEditingDocument(null);
                  if (selectedVendor) {
                    fetchVendorDocuments(selectedVendor.Id);
                  }
                }}
                onSave={() => {
                  setEditingDocument(null);
                  showSnackbar('Signature template saved successfully', 'success');
                  if (selectedVendor) {
                    fetchVendorDocuments(selectedVendor.Id);
                  }
                }}
              />
            )}

            {/* TPA Services Modal */}
            <Dialog
              open={tpaModalOpen}
              onClose={() => setTpaModalOpen(false)}
              maxWidth="md"
              fullWidth
            >
              <DialogTitle>
                <Box display="flex" justifyContent="space-between" alignItems="center">
                  <Typography variant="h6" fontWeight="bold">
                    {editingTpaTenant ? 'Edit Tenant TPA Services' : 'Add Tenant TPA Services'}
                  </Typography>
                  <IconButton
                    onClick={() => setTpaModalOpen(false)}
                    size="small"
                  >
                    <CloseIcon />
                  </IconButton>
                </Box>
              </DialogTitle>
              <DialogContent>
                <Box sx={{ pt: 2 }}>
                  <Grid container spacing={3}>
                    {/* Tenant Selection */}
                    <Grid size={12}>
                      <FormControl fullWidth>
                        <InputLabel>Tenant *</InputLabel>
                        <Select
                          value={tpaFormData.tenantId}
                          onChange={(e) => setTpaFormData({ ...tpaFormData, tenantId: e.target.value })}
                          label="Tenant *"
                          disabled={!!editingTpaTenant}
                        >
                          <MenuItem value="">
                            <em>Select Tenant</em>
                          </MenuItem>
                          {tenants
                            .filter(t => !editingTpaTenant || t.TenantId === editingTpaTenant)
                            .map((tenant) => (
                              <MenuItem key={tenant.TenantId} value={tenant.TenantId}>
                                {tenant.Name}
                              </MenuItem>
                            ))}
                        </Select>
                      </FormControl>
                    </Grid>

                    {/* TPA Services — automation today: commissions + ACH only; other toggles/contact fields are display-only until workflows consume them */}
                    <Grid size={12}>
                      <Typography variant="subtitle2" fontWeight="medium" gutterBottom sx={{ mt: 2, mb: 1 }}>
                        Available Services
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                        Only Commissions processing (and the linked ACH account) is used by payout automation. Other toggles below are not used by automation yet; values are shown from the database and stay unchanged while disabled.
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaClaimsProcessing || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaClaimsProcessing: e.target.checked })}
                          />
                        }
                        label="Claims Processing"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Process and manage insurance claims
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaEnrollmentManagement || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaEnrollmentManagement: e.target.checked })}
                          />
                        }
                        label="Enrollment Management"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Manage member enrollments and eligibility
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaCustomerService || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaCustomerService: e.target.checked })}
                          />
                        }
                        label="Customer Service"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Provide customer support and assistance
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaMemberSupport || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaMemberSupport: e.target.checked })}
                          />
                        }
                        label="Member Support"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Direct member support and assistance
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaReporting || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaReporting: e.target.checked })}
                          />
                        }
                        label="Reporting & Analytics"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Generate reports and analytics
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaCompliance || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaCompliance: e.target.checked })}
                          />
                        }
                        label="Compliance Services"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Ensure regulatory compliance
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaBillingCollections || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaBillingCollections: e.target.checked })}
                          />
                        }
                        label="Billing & Collections"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Handle billing and payment collections
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <FormControlLabel
                        disabled
                        control={
                          <Switch
                            checked={tpaFormData.tpaCobraAdministration || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaCobraAdministration: e.target.checked })}
                          />
                        }
                        label="COBRA Administration"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Manage COBRA continuation coverage
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={tpaFormData.tpaCommissionsProcessing || false}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaCommissionsProcessing: e.target.checked })}
                          />
                        }
                        label="Commissions Processing"
                      />
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4.5 }}>
                        Process commission payments (requires ACH Account)
                      </Typography>
                    </Grid>

                    {/* ACH Account Selection (when Commissions Processing is enabled) */}
                    {tpaFormData.tpaCommissionsProcessing && (
                      <Grid size={12}>
                        <FormControl fullWidth required>
                          <InputLabel>ACH Account for Commissions *</InputLabel>
                          <Select
                            value={tpaFormData.tpaAchAccountId || ''}
                            onChange={(e) => setTpaFormData({ ...tpaFormData, tpaAchAccountId: e.target.value })}
                            label="ACH Account for Commissions *"
                          >
                            <MenuItem value="">
                              <em>Select ACH Account</em>
                            </MenuItem>
                            {vendorAchAccounts.map((account) => (
                              <MenuItem key={account.achAccountId} value={account.achAccountId}>
                                {account.accountHolderName} - {account.bankName} 
                                {account.accountNumberLast4 ? ` (••••${account.accountNumberLast4})` : ''}
                              </MenuItem>
                            ))}
                          </Select>
                          {vendorAchAccounts.length === 0 && (
                            <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
                              No ACH accounts available. Please add an ACH account in the Payment Info tab first.
                            </Typography>
                          )}
                        </FormControl>
                      </Grid>
                    )}

                    {/* TPA Contact Information — not used by automation yet; display stored values */}
                    <Grid size={12} sx={{ opacity: 0.55 }}>
                      <Typography variant="subtitle2" fontWeight="medium" gutterBottom sx={{ mt: 3, mb: 2 }}>
                        TPA Contact Information
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                        Contact, portal URL, and notes are not used by automation yet. Shown for reference; editing is disabled for now.
                      </Typography>
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <TextField
                        fullWidth
                        disabled
                        label="TPA Contact Name"
                        value={tpaFormData.tpaContactName || ''}
                        onChange={(e) => setTpaFormData({ ...tpaFormData, tpaContactName: e.target.value })}
                        placeholder="John Doe"
                      />
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <TextField
                        fullWidth
                        disabled
                        label="TPA Contact Email"
                        type="email"
                        value={tpaFormData.tpaContactEmail || ''}
                        onChange={(e) => setTpaFormData({ ...tpaFormData, tpaContactEmail: e.target.value })}
                        placeholder="tpa@vendor.com"
                      />
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <TextField
                        fullWidth
                        disabled
                        label="TPA Contact Phone"
                        value={tpaFormData.tpaContactPhone || ''}
                        onChange={(e) => {
                          const value = e.target.value.replace(/\D/g, '').slice(0, 15);
                          setTpaFormData({ ...tpaFormData, tpaContactPhone: value });
                        }}
                        placeholder="(555) 123-4567"
                      />
                    </Grid>

                    <Grid size={{ xs: 12, md: 6 }} sx={{ opacity: 0.55 }}>
                      <TextField
                        fullWidth
                        disabled
                        label="TPA Portal URL"
                        value={tpaFormData.tpaPortalUrl || ''}
                        onChange={(e) => setTpaFormData({ ...tpaFormData, tpaPortalUrl: e.target.value })}
                        placeholder="https://portal.vendor.com"
                        helperText="URL to vendor's member portal (if available)"
                      />
                    </Grid>

                    <Grid size={12} sx={{ opacity: 0.55 }}>
                      <TextField
                        fullWidth
                        disabled
                        label="TPA Notes"
                        value={tpaFormData.tpaNotes || ''}
                        onChange={(e) => setTpaFormData({ ...tpaFormData, tpaNotes: e.target.value })}
                        placeholder="Additional notes about TPA services..."
                        multiline
                        rows={4}
                        helperText="Any additional information about TPA services provided by this vendor"
                      />
                    </Grid>
                  </Grid>
                </Box>
              </DialogContent>
              <DialogActions sx={{ p: 2 }}>
                <button
                  type="button"
                  onClick={() => setTpaModalOpen(false)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveTpaServices}
                  className="px-4 py-2 text-white rounded-lg transition-colors"
                  style={{ 
                    backgroundColor: 'var(--oe-primary)',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--oe-primary-dark)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--oe-primary)'}
                >
                  {editingTpaTenant ? 'Update' : 'Create'} TPA Services
                </button>
              </DialogActions>
            </Dialog>

            {formData.Id && (
              <EligibilityFormatAIAssistant
                open={eligibilityAiChatOpen}
                onClose={() => setEligibilityAiChatOpen(false)}
                formData={formData}
                storageKey={eligibilityAiChatStorageKey(formData.Id)}
                onApplyPatch={(patch) => {
                  setFormData((prev) => {
                    const next = applyEligibilityPatchToFormData(prev, patch);
                    return {
                      ...prev,
                      ...(next.EligibilityRowTemplate !== undefined && {
                        EligibilityRowTemplate: next.EligibilityRowTemplate,
                      }),
                      ...(next.EligibilityDateFormat !== undefined && {
                        EligibilityDateFormat: next.EligibilityDateFormat as Vendor['EligibilityDateFormat'],
                      }),
                      ...(next.EligibilityIntegrationPartner !== undefined && {
                        EligibilityIntegrationPartner: next.EligibilityIntegrationPartner,
                      }),
                    };
                  });
                  showSnackbar('Eligibility template updated on Eligibility tab', 'success');
                }}
              />
            )}

            {/* Snackbar for notifications */}
            <Snackbar
              open={snackbar.open}
              autoHideDuration={snackbar.severity === 'error' ? null : 6000}
              onClose={(_, reason) => {
                if (reason === 'clickaway') return;
                setSnackbar((prev) => ({ ...prev, open: false }));
              }}
              anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
              sx={{ top: { xs: 72, sm: 80 } }}
            >
              <Alert
                onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
                severity={snackbar.severity}
                sx={{ width: '100%' }}
              >
                {snackbar.message}
              </Alert>
            </Snackbar>
        </div>
      </div>
    </div>
  );
};

export default Vendors;