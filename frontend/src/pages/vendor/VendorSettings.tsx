// frontend/src/pages/vendor/VendorSettings.tsx
import { AlertCircle, Building2, CheckCircle, Copy, CreditCard, Download, Edit, FileDown, FileText, Hash, Link2, Mail, MessageSquare, Network, Phone, PhoneCall, Plus, RefreshCw, Save, Send, Settings, Trash2, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import NewGroupFormGenerateModal from '../../components/groups/NewGroupFormGenerateModal';
import VendorNetworksPanel from '../../components/vendor/VendorNetworksPanel';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { isVendorGroupIdSystemVariable, NEW_GROUP_FORM_VENDOR_NETWORK_SYSTEM_VARIABLES } from '../../utils/vendorGroupFormVariables';

type TabType = 'details' | 'ach-accounts' | 'networks' | 'users' | 'email' | 'phone' | 'sms' | 'new-group-form' | 'signed-asas';

/** Row representing a single signed Vendor ASA for this vendor (Signed ASAs tab). */
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
}

/** Sample payables row for payroll deduction (MightyWell); paste into Admin → Vendors → Payables Row Template. */
const MW_PAYROLL_DEDUCTION_PAYABLES_ROW_TEMPLATE =
  '{DeductionPeriod:Deduction Period},{DeductionAmount:Deduction Amount},{MemberID:Member ID},{FirstName:First Name},{LastName:Last Name},{State:State},{ProductID:Product ID},{ProductName:Product Name},{PlanTier:Plan Tier},{Premium:Premium},{EffectiveDate:Effective Date},{TerminationDate:Termination Date},{PaidThroughStart:Paid Through Start},{PaidThroughEnd:Paid Through End},{AgentName:Agent Name},{PolicyNumber:Policy Number},{GroupName:Group Name}';

interface ServedGroupRow {
  groupId: string;
  groupName: string;
  hasFormHistory: boolean;
  vendorGroupIdsStatus: string;
  /** Max enrolled households on a single vendor product for this group (for sorting / context). */
  maxHouseholdsOnVendorProduct?: number;
  /** Distinct enrolled households across this vendor's products on the group. */
  householdCount?: number;
  /** Minimum EffectiveDate among those enrollments (YYYY-MM-DD). */
  earliestEffectiveDate?: string | null;
  /** True when vendor IDs apply, master ID pending, and >1 household is enrolled on a single vendor product. */
  needsAttention?: boolean;
}

// ============ Vendor Profile Types ============
interface VendorAdditionalContact {
  name: string;
  email: string;
}
interface VendorProfileData {
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
  additionalContacts?: VendorAdditionalContact[];
  /** oe.Vendors.ShareRequestEnabled — share requests, providers, NPI, call center, etc. */
  ShareRequestEnabled?: boolean;
}

// ============ ACH Account Types ============
interface VendorAchAccount {
  achAccountId?: string;
  accountHolderName: string;
  bankName?: string | null;
  companyIdentification?: string | null;
  accountType: 'Checking' | 'Savings';
  status?: 'Active' | 'Inactive' | 'Pending';
  isDefault: boolean;
  distributionPercentage: number;
  accountNumberLast4?: string | null;
  maskedRoutingNumber?: string | null;
  /** Full routing number (returned in vendor settings for view/edit) */
  routingNumber?: string | null;
  /** Full account number (returned in vendor settings for view/edit) */
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

// ============ User Types ============
interface VendorUser {
  UserId: string;
  Email: string;
  FirstName?: string;
  LastName?: string;
  Role: string;
  Status: string;
  CreatedDate?: string;
}

// ============ Email Config Types ============
interface EmailConfigData {
  emailProvider: string;
  emailFromAddress: string;
  emailFromName: string;
  emailReplyTo: string;
  office365TenantId: string;
  office365ClientId: string;
  hasClientSecret: boolean;
  office365SharedMailbox: string;
}

// ============ Phone System Config Types ============
interface PhoneConfigData {
  phoneProvider: string;
  phoneProviderEnabled: boolean;
  // Zoom Phone settings
  zoomAccountId: string;
  zoomClientId: string;
  hasZoomClientSecret: boolean;
  zoomWebhookSecretToken: string;
  zoomWebhookUrl: string;
  // Twilio SMS settings
  twilioAccountSid: string;
  hasTwilioAuthToken: boolean;
  twilioPhoneNumber: string;
  smsProvider: string;
  // General settings
  phoneAutoMatchEnabled: boolean;
  phonePopupEnabled: boolean;
  phoneRecordingsEnabled: boolean;
  smsFromNumber: string;
  smsZoomUserId: string;
}

const PHONE_PROVIDERS = [
  { id: '', label: 'Select a provider...' },
  { id: 'ZoomPhone', label: 'Zoom Phone' },
  { id: 'Twilio', label: 'Twilio' },
  { id: 'RingCentral', label: 'RingCentral (Coming Soon)', disabled: true }
];

// New Group Form: system variables available when generating the PDF (group + agent + contribution rules).
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
  // Signature options (filled by certification; sentinel values for UI only)
  { value: '__agentSignature__', label: 'Agent Signature' },
  { value: '__groupAdminSignature__', label: 'Group Admin Signature' },
  // Vendor Group ID options (Master + product-specific) are added below via optgroup + newGroupFormProductOptions
];

// Field type: 'field' = normal label + value; 'labelHeader' = bold section header only (no input/value).
// MightyWell template: exact order and all fields. Section headers use fieldType: 'labelHeader'.
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
  ]
};

const VendorSettings: React.FC = () => {
  const { user } = useAuth();
  const isVendorAdmin = Boolean(user?.roles?.includes('VendorAdmin'));

  const [activeTab, setActiveTab] = useState<TabType>('details');
  
  // Profile state
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileData, setProfileData] = useState<VendorProfileData>({
    Id: '',
    VendorName: '',
    AddressLine1: '',
    AddressLine2: '',
    City: '',
    State: '',
    Zip: '',
    ContactName: '',
    Phone: '',
    Email: '',
    additionalContacts: [],
    ShareRequestEnabled: false
  });
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ACH state
  const [achAccounts, setAchAccounts] = useState<VendorAchAccount[]>([]);
  const [achLoading, setAchLoading] = useState(false);
  const [achSaving, setAchSaving] = useState(false);
  const [achModalOpen, setAchModalOpen] = useState(false);
  const [achModalAccounts, setAchModalAccounts] = useState<VendorAchAccountForm[]>([]);
  const [achModalFieldErrors, setAchModalFieldErrors] = useState<Record<string, Record<string, string>>>({});
  const [achModalMode, setAchModalMode] = useState<'create' | 'edit' | null>(null);
  const [achModalTargetId, setAchModalTargetId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<VendorAchAccount | null>(null);

  // Users state
  const [users, setUsers] = useState<VendorUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // Email config state
  const [emailConfig, setEmailConfig] = useState<EmailConfigData>({
    emailProvider: 'Office365',
    emailFromAddress: '',
    emailFromName: '',
    emailReplyTo: '',
    office365TenantId: '',
    office365ClientId: '',
    hasClientSecret: false,
    office365SharedMailbox: ''
  });
  const [emailConfigLoading, setEmailConfigLoading] = useState(false);
  const [emailConfigSaving, setEmailConfigSaving] = useState(false);
  const [emailMessage, setEmailMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newClientSecret, setNewClientSecret] = useState('');
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [testingEmail, setTestingEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{ success: boolean; message: string } | null>(null);

  // Phone config state
  const [phoneConfig, setPhoneConfig] = useState<PhoneConfigData>({
    phoneProvider: '',
    phoneProviderEnabled: false,
    zoomAccountId: '',
    zoomClientId: '',
    hasZoomClientSecret: false,
    zoomWebhookSecretToken: '',
    zoomWebhookUrl: '',
    twilioAccountSid: '',
    hasTwilioAuthToken: false,
    twilioPhoneNumber: '',
    smsProvider: 'Twilio',
    phoneAutoMatchEnabled: true,
    phonePopupEnabled: true,
    phoneRecordingsEnabled: false,
    smsFromNumber: '',
    smsZoomUserId: ''
  });
  const [phoneConfigLoading, setPhoneConfigLoading] = useState(false);
  const [phoneConfigSaving, setPhoneConfigSaving] = useState(false);
  const [phoneMessage, setPhoneMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newZoomClientSecret, setNewZoomClientSecret] = useState('');
  const [newTwilioAuthToken, setNewTwilioAuthToken] = useState('');
  const [testingZoomConnection, setTestingZoomConnection] = useState(false);
  const [zoomConnectionResult, setZoomConnectionResult] = useState<{ success: boolean; message: string } | null>(null);

  // New Group Form state
  const [newGroupFormTitle, setNewGroupFormTitle] = useState('');
  const [newGroupFormFields, setNewGroupFormFields] = useState<Array<{ key: string; label: string; systemVariable?: string; defaultValue?: string; fieldType?: 'field' | 'labelHeader' | 'includeAllVendorGroupIds'; attemptAutoGenerateVendorGroupIdsIfMissing?: boolean }>>([]);
  const [newGroupFormLoading, setNewGroupFormLoading] = useState(false);
  const [newGroupFormSaving, setNewGroupFormSaving] = useState(false);
  const [newGroupFormMessage, setNewGroupFormMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newGroupFormProductOptions, setNewGroupFormProductOptions] = useState<Array<{ productId: string; name: string; hasVendorGroupIdSetting: boolean }>>([]);
  const [newGroupFormProductTypes, setNewGroupFormProductTypes] = useState<Array<{ productType: string }>>([]);

  /** Served groups (enrollments on vendor products) — New Group Form tab */
  const [servedGroupsRows, setServedGroupsRows] = useState<ServedGroupRow[]>([]);
  const [servedGroupsTotal, setServedGroupsTotal] = useState(0);
  const [servedGroupsPage, setServedGroupsPage] = useState(1);
  const servedGroupsLimit = 25;
  // active-only by default so the table shows actionable groups first; users can flip to All / No active.
  const [servedGroupsEnrollmentFilter, setServedGroupsEnrollmentFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [servedGroupsBulkGenLoading, setServedGroupsBulkGenLoading] = useState(false);
  const [servedGroupsLoading, setServedGroupsLoading] = useState(false);
  const [servedGroupTableSearchInput, setServedGroupTableSearchInput] = useState('');
  const [servedGroupTableSearch, setServedGroupTableSearch] = useState('');
  const [servedGroupFilterId, setServedGroupFilterId] = useState('');
  const [vendorIdsApplicable, setVendorIdsApplicable] = useState(false);

  /** Signed ASAs tab state */
  const [signedAsasRows, setSignedAsasRows] = useState<SignedAsaRow[]>([]);
  const [signedAsasTotal, setSignedAsasTotal] = useState(0);
  const [signedAsasLoading, setSignedAsasLoading] = useState(false);
  const [signedAsasStatusFilter, setSignedAsasStatusFilter] = useState<'all' | 'unsent' | 'sent'>('all');
  const [signedAsasSearchInput, setSignedAsasSearchInput] = useState('');
  const [signedAsasSearch, setSignedAsasSearch] = useState('');
  const [signedAsasPage, setSignedAsasPage] = useState(1);
  const signedAsasLimit = 25;
  const [signedAsasRecipientInput, setSignedAsasRecipientInput] = useState('');
  /** Per-row sending state — map of signedAgreementId → boolean. */
  const [signedAsaRowSending, setSignedAsaRowSending] = useState<Record<string, boolean>>({});
  const [signedAsaRowDownloading, setSignedAsaRowDownloading] = useState<Record<string, boolean>>({});
  const [signedAsasBulkLoading, setSignedAsasBulkLoading] = useState<'unsent' | 'all' | null>(null);
  const [signedAsasMessage, setSignedAsasMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [servedGroupDropdownOptions, setServedGroupDropdownOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [servedGroupDropdownLoading, setServedGroupDropdownLoading] = useState(false);
  const [servedGroupPdfLoadingId, setServedGroupPdfLoadingId] = useState<string | null>(null);
  const [servedGroupGenIdsLoadingId, setServedGroupGenIdsLoadingId] = useState<string | null>(null);
  const [newGroupFormModalGroup, setNewGroupFormModalGroup] = useState<{ groupId: string; groupName: string } | null>(
    null
  );
  const [payablesTemplateCopied, setPayablesTemplateCopied] = useState(false);
  const copyMwPayablesTemplate = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(MW_PAYROLL_DEDUCTION_PAYABLES_ROW_TEMPLATE);
      setPayablesTemplateCopied(true);
      window.setTimeout(() => setPayablesTemplateCopied(false), 2000);
    } catch {
      setPayablesTemplateCopied(false);
    }
  }, []);

  // Load data on mount
  useEffect(() => {
    loadProfile();
    loadAchAccounts();
    loadUsers();
    loadEmailConfig();
    loadPhoneConfig();
    loadNewGroupForm();
  }, []);

  useEffect(() => {
    if (!newGroupFormMessage || newGroupFormMessage.type !== 'success') return;
    const t = window.setTimeout(() => setNewGroupFormMessage(null), 6000);
    return () => window.clearTimeout(t);
  }, [newGroupFormMessage]);

  // ============ Profile Functions ============
  const loadProfile = async () => {
    try {
      setProfileLoading(true);
      const response = await apiService.get<{ success: boolean; data?: any }>('/api/me/vendor/profile');
      if (response?.success && response.data) {
        const data = {
          ...response.data,
          additionalContacts: response.data.additionalContacts ?? [],
          ShareRequestEnabled: response.data.ShareRequestEnabled === true
        };
        setProfileData(data);
      }
    } catch (error) {
      console.error('Error loading vendor profile:', error);
      setProfileMessage({ type: 'error', text: 'Failed to load vendor profile' });
    } finally {
      setProfileLoading(false);
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setProfileSaving(true);
      setProfileMessage(null);
      const response = await apiService.put<{
        success: boolean;
        message?: string;
        data?: VendorProfileData & { additionalContacts?: VendorAdditionalContact[]; ShareRequestEnabled?: boolean };
      }>('/api/me/vendor/profile', {
        ...profileData,
        shareRequestEnabled: profileData.ShareRequestEnabled === true
      });
      if (response?.success) {
        setProfileMessage({ type: 'success', text: 'Vendor profile updated successfully' });
        if (response.data) {
          const d = response.data;
          setProfileData((prev) => ({
            ...prev,
            ...d,
            additionalContacts: d.additionalContacts ?? prev.additionalContacts,
            ShareRequestEnabled: d.ShareRequestEnabled === true
          }));
        }
        window.dispatchEvent(new Event('oe-vendor-profile-updated'));
      } else {
        setProfileMessage({ type: 'error', text: response?.message || 'Failed to update profile' });
      }
    } catch (error: any) {
      console.error('Error updating vendor profile:', error);
      setProfileMessage({ type: 'error', text: error?.response?.data?.message || 'Failed to update profile' });
    } finally {
      setProfileSaving(false);
    }
  };

  const handleProfileChange = (field: keyof VendorProfileData, value: string | boolean) => {
    setProfileData(prev => ({ ...prev, [field]: value } as VendorProfileData));
  };

  const additionalContacts = profileData.additionalContacts || [];
  const setAdditionalContacts = (list: VendorAdditionalContact[]) => {
    setProfileData(prev => ({ ...prev, additionalContacts: list }));
  };
  const addAdditionalContact = () => {
    setAdditionalContacts([...additionalContacts, { name: '', email: '' }]);
  };
  const updateAdditionalContact = (index: number, field: 'name' | 'email', value: string) => {
    const next = [...additionalContacts];
    next[index] = { ...next[index], [field]: value };
    setAdditionalContacts(next);
  };
  const removeAdditionalContact = (index: number) => {
    setAdditionalContacts(additionalContacts.filter((_, i) => i !== index));
  };

  // ============ ACH Functions ============
  const loadAchAccounts = async (): Promise<VendorAchAccount[]> => {
    try {
      setAchLoading(true);
      const response = await apiService.get<{ success: boolean; data?: VendorAchAccount[] }>('/api/me/vendor/profile/ach-accounts');
      const accounts = response?.success && Array.isArray(response.data) ? response.data : [];
      setAchAccounts(accounts);
      return accounts;
    } catch (error) {
      console.error('Error loading ACH accounts:', error);
      return [];
    } finally {
      setAchLoading(false);
    }
  };

  const generateTempId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const sanitizeDigits = (value: string) => value.replace(/\D/g, '');

  const mapToForm = (account: VendorAchAccount): VendorAchAccountForm => ({
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

  const calculateDistributionTotal = (accounts: VendorAchAccount[]) => {
    return accounts
      .filter(acc => (acc.status || 'Active') !== 'Inactive')
      .reduce((sum, account) => sum + (Number(account.distributionPercentage) || 0), 0);
  };

  const handleOpenAchModal = async (options?: { addNew?: boolean; editId?: string }) => {
    const { addNew = false, editId } = options || {};

    if (addNew) {
      const newAccount: VendorAchAccountForm = {
        tempId: generateTempId(),
        accountHolderName: '',
        bankName: '',
        companyIdentification: '',
        accountType: 'Checking',
        isDefault: achAccounts.length === 0,
        distributionPercentage: 0,
        routingNumber: '',
        accountNumber: '',
        accountNumberLast4: undefined,
        maskedRoutingNumber: undefined,
        updateSensitive: true,
        status: 'Active'
      };
      setAchModalMode('create');
      setAchModalTargetId(null);
      setAchModalAccounts([newAccount]);
      setAchModalFieldErrors({});
      setAchModalOpen(true);
      return;
    }

    if (editId) {
      // Re-fetch so we have fresh routingNumber/accountNumber from API for pre-fill
      const accounts = await loadAchAccounts();
      const existing = accounts.find((account) => account.achAccountId === editId);
      if (!existing) return;

      setAchModalMode('edit');
      setAchModalTargetId(editId);
      setAchModalAccounts([mapToForm(existing)]);
      setAchModalFieldErrors({});
      setAchModalOpen(true);
      return;
    }
  };

  const handleCloseAchModal = () => {
    setAchModalOpen(false);
    setAchModalFieldErrors({});
    setAchModalMode(null);
    setAchModalTargetId(null);
    setAchModalAccounts([]);
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

  const handleModalAccountTypeChange = (tempId: string, value: 'Checking' | 'Savings') => {
    setAchModalAccounts((prev) =>
      prev.map((account) =>
        account.tempId === tempId ? { ...account, accountType: value } : account
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

  const validateAchModalAccounts = (accounts: VendorAchAccountForm[]) => {
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

    return {
      isValid: Object.keys(fieldErrors).length === 0,
      fieldErrors
    };
  };

  const handleSaveAchModal = async () => {
    const { isValid, fieldErrors } = validateAchModalAccounts(achModalAccounts);
    setAchModalFieldErrors(fieldErrors);

    if (!isValid || achModalMode === null) {
      return;
    }

    try {
      setAchSaving(true);

      let allAccounts: VendorAchAccount[];
      
      if (achModalMode === 'create') {
        const newAccount = achModalAccounts[0];
        allAccounts = [...achAccounts, {
          achAccountId: undefined,
          accountHolderName: newAccount.accountHolderName,
          bankName: newAccount.bankName || null,
          accountType: newAccount.accountType,
          isDefault: newAccount.isDefault,
          distributionPercentage: newAccount.distributionPercentage,
          status: newAccount.status || 'Active',
          accountNumberLast4: undefined,
          maskedRoutingNumber: undefined
        }];
      } else {
        const updatedAccount = achModalAccounts[0];
        allAccounts = achAccounts.map(acc => 
          acc.achAccountId === achModalTargetId
            ? {
                ...acc,
                accountHolderName: updatedAccount.accountHolderName,
                bankName: updatedAccount.bankName || null,
                accountType: updatedAccount.accountType,
                isDefault: updatedAccount.isDefault,
                distributionPercentage: updatedAccount.distributionPercentage,
                status: updatedAccount.status || 'Active'
              }
            : { ...acc, isDefault: updatedAccount.isDefault ? false : acc.isDefault }
        );
      }

      const defaultCount = allAccounts.filter(acc => acc.isDefault).length;
      if (defaultCount === 0 && allAccounts.length > 0) {
        allAccounts[0].isDefault = true;
      } else if (defaultCount > 1) {
        let foundFirst = false;
        allAccounts = allAccounts.map(acc => {
          if (acc.isDefault && !foundFirst) {
            foundFirst = true;
            return acc;
          }
          return { ...acc, isDefault: false };
        });
      }

      const total = calculateDistributionTotal(allAccounts);
      if (total > 100.01) {
        alert(`Total distribution cannot exceed 100%. Current total: ${total.toFixed(2)}%`);
        setAchSaving(false);
        return;
      }

      const payload = allAccounts.map((account) => {
        const modalAccount = achModalAccounts.find(ma => 
          (achModalMode === 'create' && !account.achAccountId) ||
          (achModalMode === 'edit' && account.achAccountId === achModalTargetId)
        );

        const routingDigits = modalAccount && (modalAccount.updateSensitive || !account.achAccountId)
          ? sanitizeDigits(modalAccount.routingNumber || '')
          : '';
        const accountDigits = modalAccount && (modalAccount.updateSensitive || !account.achAccountId)
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
          routingNumber: routingDigits ? routingDigits : undefined,
          accountNumber: accountDigits ? accountDigits : undefined
        };
      });

      const response = await apiService.put<{ success: boolean; message?: string }>('/api/me/vendor/profile/ach-accounts', {
        achAccounts: payload
      });

      if (response?.success) {
        await loadAchAccounts();
        handleCloseAchModal();
      } else {
        alert(response?.message || 'Failed to save ACH accounts');
      }
    } catch (error: any) {
      console.error('Error saving ACH accounts:', error);
      alert(error?.message || 'Failed to save ACH accounts');
    } finally {
      setAchSaving(false);
    }
  };

  const handleDeleteAccount = async (account: VendorAchAccount) => {
    try {
      setAchSaving(true);

      const remainingAccounts = achAccounts.filter(acc => acc.achAccountId !== account.achAccountId);

      if (account.isDefault && remainingAccounts.length > 0) {
        remainingAccounts[0].isDefault = true;
      }

      const total = calculateDistributionTotal(remainingAccounts);
      if (total > 100.01) {
        alert(`Total distribution cannot exceed 100%. Current total: ${total.toFixed(2)}%`);
        setAchSaving(false);
        return;
      }

      const payload = remainingAccounts.map((acc) => ({
        achAccountId: acc.achAccountId,
        accountHolderName: acc.accountHolderName.trim(),
        bankName: acc.bankName?.trim() || null,
        companyIdentification: sanitizeDigits((acc as any).companyIdentification || '') || null,
        accountType: acc.accountType,
        distributionPercentage: Number(acc.distributionPercentage) || 0,
        isDefault: acc.isDefault,
        status: acc.status || 'Active'
      }));

      const response = await apiService.put<{ success: boolean; message?: string; data?: { message?: string } }>('/api/me/vendor/profile/ach-accounts', {
        achAccounts: payload
      });

      if (response?.success) {
        await loadAchAccounts();
        setShowDeleteConfirm(false);
        setAccountToDelete(null);
      } else {
        const errorMsg = response?.message || response?.data?.message || 'Failed to delete ACH account';
        alert(errorMsg);
      }
    } catch (error: any) {
      console.error('Error deleting ACH account:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to delete ACH account';
      alert(errorMessage);
    } finally {
      setAchSaving(false);
    }
  };

  const getAchStatusClasses = (status: string) => {
    const statusLower = (status || '').toLowerCase();
    if (statusLower === 'active' || statusLower === 'verified') {
      return 'bg-green-100 text-green-800';
    }
    if (statusLower === 'pending' || statusLower === 'verifying') {
      return 'bg-yellow-100 text-yellow-800';
    }
    if (statusLower === 'inactive' || statusLower === 'failed') {
      return 'bg-gray-100 text-gray-800';
    }
    return 'bg-blue-100 text-blue-800';
  };

  const displayAccountNumber = (account: VendorAchAccount) => {
    if (account.accountNumber) return account.accountNumber;
    if (account.accountNumberLast4) return `****${account.accountNumberLast4}`;
    return '****';
  };

  const displayRoutingNumber = (account: VendorAchAccount) => {
    if (account.routingNumber) return account.routingNumber;
    if (account.maskedRoutingNumber) return account.maskedRoutingNumber;
    return '****';
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '—';
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateString;
    }
  };

  const distributionTotal = calculateDistributionTotal(achAccounts);

  // ============ Users Functions ============
  const loadUsers = async () => {
    try {
      setUsersLoading(true);
      const response = await apiService.get<{ success: boolean; data?: any[] }>('/api/me/vendor/users');
      if (response?.success) {
        setUsers(response.data || []);
      }
    } catch (error) {
      console.error('Error loading users:', error);
    } finally {
      setUsersLoading(false);
    }
  };

  // ============ Email Config Functions ============
  const loadEmailConfig = async () => {
    try {
      setEmailConfigLoading(true);
      const response = await apiService.get('/api/me/vendor/profile/email-config') as { success: boolean; data?: EmailConfigData };
      if (response?.success && response.data) {
        setEmailConfig(response.data);
      }
    } catch (error) {
      console.error('Error loading email config:', error);
    } finally {
      setEmailConfigLoading(false);
    }
  };

  const saveEmailConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setEmailConfigSaving(true);
      setEmailMessage(null);

      const payload: Record<string, string> = {
        emailProvider: emailConfig.emailProvider,
        emailFromAddress: emailConfig.emailFromAddress,
        emailFromName: emailConfig.emailFromName,
        emailReplyTo: emailConfig.emailReplyTo,
        office365TenantId: emailConfig.office365TenantId,
        office365ClientId: emailConfig.office365ClientId,
        office365SharedMailbox: emailConfig.office365SharedMailbox
      };

      // Only include secret if a new one was provided
      if (newClientSecret.trim()) {
        payload.office365ClientSecret = newClientSecret;
      }

      const response = await apiService.put('/api/me/vendor/profile/email-config', payload) as { success: boolean; message?: string };
      
      if (response.success) {
        setEmailMessage({ type: 'success', text: 'Email configuration saved successfully!' });
        setNewClientSecret('');
        loadEmailConfig(); // Refresh to get updated hasClientSecret flag
      } else {
        throw new Error(response.message || 'Failed to save');
      }
    } catch (error: any) {
      console.error('Error saving email config:', error);
      setEmailMessage({ type: 'error', text: error.message || 'Failed to save email configuration' });
    } finally {
      setEmailConfigSaving(false);
    }
  };

  const testEmail = async () => {
    if (!testEmailAddress.trim()) {
      setTestEmailResult({ success: false, message: 'Please enter a test email address' });
      return;
    }

    try {
      setTestingEmail(true);
      setTestEmailResult(null);

      const response = await apiService.post('/api/me/vendor/profile/email-config/test', {
        testEmailAddress: testEmailAddress
      }) as { success: boolean; message?: string };

      setTestEmailResult({
        success: response.success,
        message: response.message || (response.success ? 'Test email sent successfully!' : 'Failed to send test email')
      });
    } catch (error: any) {
      console.error('Error testing email:', error);
      setTestEmailResult({
        success: false,
        message: error.message || 'Failed to send test email'
      });
    } finally {
      setTestingEmail(false);
    }
  };

  // ============ Phone Config Functions ============
  const loadPhoneConfig = async () => {
    try {
      setPhoneConfigLoading(true);
      const response = await apiService.get<{ success: boolean; data?: PhoneConfigData }>('/api/me/vendor/profile/phone-config');
      console.log('Phone config response:', response);
      if (response?.success && response.data) {
        console.log('Setting phone config:', response.data);
        setPhoneConfig(response.data);
      } else {
        console.warn('Phone config response missing data:', response);
      }
    } catch (error) {
      console.error('Error loading phone config:', error);
      setPhoneMessage({ type: 'error', text: 'Failed to load phone configuration' });
    } finally {
      setPhoneConfigLoading(false);
    }
  };

  const savePhoneConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setPhoneConfigSaving(true);
      setPhoneMessage(null);

      const payload: Record<string, any> = {
        phoneProvider: phoneConfig.phoneProvider,
        phoneProviderEnabled: phoneConfig.phoneProviderEnabled,
        zoomAccountId: phoneConfig.zoomAccountId,
        zoomClientId: phoneConfig.zoomClientId,
        zoomWebhookSecretToken: phoneConfig.zoomWebhookSecretToken,
        twilioAccountSid: phoneConfig.twilioAccountSid,
        twilioPhoneNumber: phoneConfig.twilioPhoneNumber,
        smsProvider: phoneConfig.smsProvider || 'Twilio',
        phoneAutoMatchEnabled: phoneConfig.phoneAutoMatchEnabled,
        phonePopupEnabled: phoneConfig.phonePopupEnabled,
        phoneRecordingsEnabled: phoneConfig.phoneRecordingsEnabled,
        smsFromNumber: phoneConfig.smsFromNumber,
        smsZoomUserId: phoneConfig.smsZoomUserId
      };

      // Only include secrets if new ones were provided
      if (newZoomClientSecret.trim()) {
        payload.zoomClientSecret = newZoomClientSecret;
      }
      if (newTwilioAuthToken.trim()) {
        payload.twilioAuthToken = newTwilioAuthToken;
      }

      const response = await apiService.put('/api/me/vendor/profile/phone-config', payload) as { success: boolean; message?: string; data?: PhoneConfigData };
      
      if (response.success) {
        setPhoneMessage({ type: 'success', text: 'Phone system configuration saved successfully' });
        setNewZoomClientSecret('');
        setNewTwilioAuthToken('');
        if (response.data) {
          setPhoneConfig(response.data);
        }
      } else {
        throw new Error(response.message || 'Failed to save');
      }
    } catch (error: any) {
      console.error('Error saving phone config:', error);
      setPhoneMessage({ type: 'error', text: error.message || 'Failed to save phone system configuration' });
    } finally {
      setPhoneConfigSaving(false);
    }
  };

  const testZoomConnection = async () => {
    if (!phoneConfig.zoomAccountId || !phoneConfig.zoomClientId) {
      setZoomConnectionResult({ success: false, message: 'Please enter Account ID and Client ID first' });
      return;
    }

    try {
      setTestingZoomConnection(true);
      setZoomConnectionResult(null);

      const response = await apiService.post('/api/me/vendor/profile/phone-config/test', {}) as { success: boolean; message?: string };

      setZoomConnectionResult({
        success: response.success,
        message: response.message || (response.success ? 'Successfully connected to Zoom Phone!' : 'Failed to connect')
      });
    } catch (error: any) {
      console.error('Error testing Zoom connection:', error);
      setZoomConnectionResult({
        success: false,
        message: error.message || 'Failed to connect to Zoom Phone'
      });
    } finally {
      setTestingZoomConnection(false);
    }
  };

  // ============ SMS Config Functions ============
  const saveSmsConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setPhoneConfigSaving(true);
      setPhoneMessage(null);

      const payload: Record<string, any> = {
        phoneProvider: phoneConfig.phoneProvider,
        phoneProviderEnabled: phoneConfig.phoneProviderEnabled,
        zoomAccountId: phoneConfig.zoomAccountId,
        zoomClientId: phoneConfig.zoomClientId,
        zoomWebhookSecretToken: phoneConfig.zoomWebhookSecretToken,
        twilioAccountSid: phoneConfig.twilioAccountSid,
        twilioPhoneNumber: phoneConfig.twilioPhoneNumber,
        smsProvider: phoneConfig.smsProvider || 'Twilio',
        phoneAutoMatchEnabled: phoneConfig.phoneAutoMatchEnabled,
        phonePopupEnabled: phoneConfig.phonePopupEnabled,
        phoneRecordingsEnabled: phoneConfig.phoneRecordingsEnabled,
        smsFromNumber: phoneConfig.smsFromNumber,
        smsZoomUserId: phoneConfig.smsZoomUserId
      };

      // Only include secrets if new ones were provided
      if (newZoomClientSecret.trim()) {
        payload.zoomClientSecret = newZoomClientSecret;
      }
      if (newTwilioAuthToken.trim()) {
        payload.twilioAuthToken = newTwilioAuthToken;
      }

      const response = await apiService.put('/api/me/vendor/profile/phone-config', payload) as { success: boolean; message?: string; data?: PhoneConfigData };
      
      if (response.success) {
        setPhoneMessage({ type: 'success', text: 'SMS configuration saved successfully' });
        setNewTwilioAuthToken('');
        if (response.data) {
          setPhoneConfig(response.data);
        }
      } else {
        throw new Error(response.message || 'Failed to save');
      }
    } catch (error: any) {
      console.error('Error saving SMS config:', error);
      setPhoneMessage({ type: 'error', text: error.message || 'Failed to save SMS configuration' });
    } finally {
      setPhoneConfigSaving(false);
    }
  };

  const copyWebhookUrl = () => {
    if (phoneConfig.zoomWebhookUrl) {
      navigator.clipboard.writeText(phoneConfig.zoomWebhookUrl);
      setPhoneMessage({ type: 'success', text: 'Webhook URL copied to clipboard' });
      setTimeout(() => setPhoneMessage(null), 3000);
    }
  };

  const getUserStatusClasses = (status: string) => {
    const statusLower = (status || '').toLowerCase();
    if (statusLower === 'active') {
      return 'bg-green-100 text-green-800';
    }
    if (statusLower === 'pending' || statusLower === 'invited') {
      return 'bg-yellow-100 text-yellow-800';
    }
    if (statusLower === 'inactive' || statusLower === 'disabled') {
      return 'bg-gray-100 text-gray-800';
    }
    return 'bg-blue-100 text-blue-800';
  };

  // ============ New Group Form Functions ============
  const loadNewGroupForm = async () => {
    try {
      setNewGroupFormLoading(true);
      const [configRes, productOptionsRes] = await Promise.all([
        apiService.get<{ success: boolean; data?: { formTitle?: string; fields?: Array<{ key: string; label: string; systemVariable?: string; defaultValue?: string; fieldType?: 'field' | 'labelHeader' | 'includeAllVendorGroupIds'; attemptAutoGenerateVendorGroupIdsIfMissing?: boolean }> } }>('/api/me/vendor/profile/new-group-form'),
        apiService.get<{ success: boolean; data?: { products?: Array<{ productId: string; name: string; hasVendorGroupIdSetting: boolean }>; productTypes?: Array<{ productType: string }> } }>('/api/me/vendor/profile/new-group-form-product-options').catch(() => ({ success: false, data: { products: [], productTypes: [] } }))
      ]);
      if (configRes?.success && configRes.data) {
        setNewGroupFormTitle(configRes.data.formTitle ?? '');
        setNewGroupFormFields(Array.isArray(configRes.data.fields) ? configRes.data.fields.map((f: { key?: string; label?: string; systemVariable?: string; defaultValue?: string; fieldType?: 'field' | 'labelHeader' | 'includeAllVendorGroupIds'; attemptAutoGenerateVendorGroupIdsIfMissing?: boolean }) => ({
          key: f.key ?? '',
          label: f.label ?? '',
          ...f,
          fieldType: f.fieldType || 'field',
          systemVariable: f.key === 'agentSignature' ? '__agentSignature__' : f.key === 'groupAdminSignature' ? '__groupAdminSignature__' : (f.systemVariable ?? ''),
          ...(f.attemptAutoGenerateVendorGroupIdsIfMissing === true ? { attemptAutoGenerateVendorGroupIdsIfMissing: true } : {})
        })) : []);
      }
      if (productOptionsRes?.success && productOptionsRes.data?.products) {
        setNewGroupFormProductOptions(productOptionsRes.data.products);
      } else {
        setNewGroupFormProductOptions([]);
      }
      if (productOptionsRes?.success && productOptionsRes.data?.productTypes) {
        setNewGroupFormProductTypes(productOptionsRes.data.productTypes);
      } else {
        setNewGroupFormProductTypes([]);
      }
    } catch (error) {
      console.error('Error loading new group form config:', error);
      setNewGroupFormMessage({ type: 'error', text: 'Failed to load new group form configuration' });
    } finally {
      setNewGroupFormLoading(false);
    }
  };

  const saveNewGroupForm = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setNewGroupFormSaving(true);
      setNewGroupFormMessage(null);
      const fieldsForApi = newGroupFormFields.map((f) => {
        if (f.systemVariable === '__agentSignature__') return { ...f, key: 'agentSignature', systemVariable: '', attemptAutoGenerateVendorGroupIdsIfMissing: undefined };
        if (f.systemVariable === '__groupAdminSignature__') return { ...f, key: 'groupAdminSignature', systemVariable: '', attemptAutoGenerateVendorGroupIdsIfMissing: undefined };
        const base = { ...f };
        const ft = base.fieldType ?? 'field';
        const injectAllRow = ft === 'includeAllVendorGroupIds';
        const mappedVendorGid = isVendorGroupIdSystemVariable(f.systemVariable ?? '');
        if (!injectAllRow && !mappedVendorGid) {
          delete base.attemptAutoGenerateVendorGroupIdsIfMissing;
          return base;
        }
        if (base.attemptAutoGenerateVendorGroupIdsIfMissing === true) return base;
        const { attemptAutoGenerateVendorGroupIdsIfMissing: _omit, ...rest } = base;
        return rest;
      });
      const response = await apiService.put<{ success: boolean; message?: string }>('/api/me/vendor/profile/new-group-form', {
        formTitle: newGroupFormTitle,
        fields: fieldsForApi,
      });
      if (response?.success) {
        setNewGroupFormMessage({ type: 'success', text: 'New group form configuration saved successfully' });
      } else {
        throw new Error(response?.message || 'Failed to save');
      }
    } catch (error: any) {
      console.error('Error saving new group form config:', error);
      setNewGroupFormMessage({ type: 'error', text: error?.message || 'Failed to save new group form configuration' });
    } finally {
      setNewGroupFormSaving(false);
    }
  };

  const loadMightyWellPreset = () => {
    setNewGroupFormTitle(MIGHTYWELL_NEW_GROUP_FORM_PRESET.formTitle);
    setNewGroupFormFields(MIGHTYWELL_NEW_GROUP_FORM_PRESET.fields.map((f) => ({ ...f })));
    setNewGroupFormMessage({ type: 'success', text: 'MightyWell template loaded. Save to keep changes.' });
  };

  const addNewGroupFormField = () => {
    setNewGroupFormFields((prev) => [...prev, { key: `field_${Date.now()}`, label: '', systemVariable: '', defaultValue: '', fieldType: 'field' }]);
  };

  const updateNewGroupFormField = (index: number, updates: Partial<{ key: string; label: string; systemVariable: string; defaultValue: string; fieldType: 'field' | 'labelHeader' | 'includeAllVendorGroupIds'; attemptAutoGenerateVendorGroupIdsIfMissing?: boolean }>) => {
    setNewGroupFormFields((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      return next;
    });
  };

  const setNewGroupFormFieldSystemVariable = (index: number, v: string) => {
    setNewGroupFormFields((prev) => {
      const next = [...prev];
      const cur = next[index];
      if (v === '__agentSignature__') {
        next[index] = { ...cur, systemVariable: '__agentSignature__', key: 'agentSignature', defaultValue: '', attemptAutoGenerateVendorGroupIdsIfMissing: undefined };
      } else if (v === '__groupAdminSignature__') {
        next[index] = { ...cur, systemVariable: '__groupAdminSignature__', key: 'groupAdminSignature', defaultValue: '', attemptAutoGenerateVendorGroupIdsIfMissing: undefined };
      } else {
        const row = {
          ...cur,
          systemVariable: v,
          key: (cur.key === 'agentSignature' || cur.key === 'groupAdminSignature') ? `field_${Date.now()}` : cur.key,
          ...(isVendorGroupIdSystemVariable(v) ? {} : { attemptAutoGenerateVendorGroupIdsIfMissing: undefined }),
        };
        next[index] = row;
      }
      return next;
    });
  };

  const removeNewGroupFormField = (index: number) => {
    setNewGroupFormFields((prev) => prev.filter((_, i) => i !== index));
  };

  const loadServedGroups = useCallback(async () => {
    setServedGroupsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(servedGroupsPage),
        limit: String(servedGroupsLimit),
      });
      if (servedGroupTableSearch.trim()) params.set('search', servedGroupTableSearch.trim());
      if (servedGroupFilterId.trim()) params.set('groupId', servedGroupFilterId.trim());
      if (servedGroupsEnrollmentFilter !== 'all') params.set('enrollmentFilter', servedGroupsEnrollmentFilter);
      const res = await apiService.get<{
        success: boolean;
        data?: {
          groups?: ServedGroupRow[];
          total?: number;
          vendorIdsApplicable?: boolean;
        };
      }>(`/api/me/vendor/profile/served-groups?${params.toString()}`);
      if (res?.success && res.data) {
        const rows = Array.isArray(res.data.groups) ? res.data.groups : [];
        setServedGroupsRows(
          rows.map((r) => ({
            ...r,
            maxHouseholdsOnVendorProduct:
              typeof r.maxHouseholdsOnVendorProduct === 'number' ? r.maxHouseholdsOnVendorProduct : undefined,
            householdCount: typeof r.householdCount === 'number' ? r.householdCount : undefined,
            earliestEffectiveDate: r.earliestEffectiveDate ?? null,
            needsAttention: !!r.needsAttention,
          }))
        );
        setServedGroupsTotal(typeof res.data.total === 'number' ? res.data.total : 0);
        setVendorIdsApplicable(!!res.data.vendorIdsApplicable);
      }
    } catch (e) {
      console.error('Error loading served groups:', e);
      setServedGroupsRows([]);
      setServedGroupsTotal(0);
    } finally {
      setServedGroupsLoading(false);
    }
  }, [servedGroupsPage, servedGroupTableSearch, servedGroupFilterId, servedGroupsEnrollmentFilter]);

  const fetchServedGroupDropdownOptions = useCallback(async (query: string) => {
    setServedGroupDropdownLoading(true);
    try {
      const params = new URLSearchParams({ page: '1', limit: '50' });
      if (query.trim()) params.set('search', query.trim());
      // Match the table's enrollment filter so the dropdown options stay consistent with what's listed.
      if (servedGroupsEnrollmentFilter !== 'all') params.set('enrollmentFilter', servedGroupsEnrollmentFilter);
      const res = await apiService.get<{
        success: boolean;
        data?: { groups?: Array<{ groupId: string; groupName: string }> };
      }>(`/api/me/vendor/profile/served-groups?${params.toString()}`);
      if (res?.success && res.data?.groups) {
        setServedGroupDropdownOptions(
          res.data.groups.map((g) => ({
            id: g.groupId,
            label: g.groupName,
            value: g.groupId,
          }))
        );
      } else {
        setServedGroupDropdownOptions([]);
      }
    } catch {
      setServedGroupDropdownOptions([]);
    } finally {
      setServedGroupDropdownLoading(false);
    }
  }, [servedGroupsEnrollmentFilter]);

  const handleServedGroupPdf = async (g: ServedGroupRow) => {
    setServedGroupPdfLoadingId(g.groupId);
    try {
      const safe = (g.groupName || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
      await apiService.downloadFile(
        `/api/me/vendor/profile/served-groups/${encodeURIComponent(g.groupId)}/new-group-form-pdf`,
        `NewGroupForm-${safe}.pdf`
      );
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error(e);
      setNewGroupFormMessage({ type: 'error', text: err?.message || 'Failed to download PDF' });
    } finally {
      setServedGroupPdfLoadingId(null);
    }
  };

  const handleServedGroupGenerateIds = async (g: ServedGroupRow) => {
    setServedGroupGenIdsLoadingId(g.groupId);
    try {
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/profile/served-groups/${encodeURIComponent(g.groupId)}/generate-vendor-ids`,
        {}
      );
      if (res?.success) {
        setNewGroupFormMessage({ type: 'success', text: res.message || 'Vendor group IDs updated' });
        await loadServedGroups();
      } else {
        throw new Error(res?.message || 'Failed');
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setNewGroupFormMessage({ type: 'error', text: err?.message || 'Failed to generate vendor group IDs' });
    } finally {
      setServedGroupGenIdsLoadingId(null);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setServedGroupTableSearch(servedGroupTableSearchInput), 400);
    return () => clearTimeout(t);
  }, [servedGroupTableSearchInput]);

  // ============ Signed ASAs tab ============
  const loadSignedAsas = useCallback(async () => {
    setSignedAsasLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('status', signedAsasStatusFilter);
      params.set('limit', String(signedAsasLimit));
      params.set('offset', String((signedAsasPage - 1) * signedAsasLimit));
      if (signedAsasSearch.trim()) params.set('search', signedAsasSearch.trim());
      const res = await apiService.get<{
        success: boolean;
        data?: { total: number; items: SignedAsaRow[] };
      }>(`/api/me/vendor/asa-agreements?${params.toString()}`);
      if (res?.success && res.data) {
        setSignedAsasRows(res.data.items || []);
        setSignedAsasTotal(res.data.total || 0);
      } else {
        setSignedAsasRows([]);
        setSignedAsasTotal(0);
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to load signed ASAs' });
      setSignedAsasRows([]);
      setSignedAsasTotal(0);
    } finally {
      setSignedAsasLoading(false);
    }
  }, [signedAsasStatusFilter, signedAsasSearch, signedAsasPage]);

  const handleSignedAsaDownload = async (row: SignedAsaRow) => {
    if (!row.hasSignedPdf) {
      setSignedAsasMessage({ type: 'error', text: 'No signed PDF attached to this agreement' });
      return;
    }
    setSignedAsaRowDownloading((m) => ({ ...m, [row.signedAgreementId]: true }));
    try {
      const res = await apiService.get<{ success: boolean; data?: { url: string; filename?: string }; message?: string }>(
        `/api/me/vendor/asa-agreements/${encodeURIComponent(row.signedAgreementId)}/download`
      );
      if (res?.success && res.data?.url) {
        // Open in a new tab so the authenticated blob URL triggers browser download.
        window.open(res.data.url, '_blank', 'noopener');
      } else {
        throw new Error(res?.message || 'Failed to get download URL');
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to download signed ASA' });
    } finally {
      setSignedAsaRowDownloading((m) => ({ ...m, [row.signedAgreementId]: false }));
    }
  };

  const handleSignedAsaSend = async (row: SignedAsaRow) => {
    setSignedAsaRowSending((m) => ({ ...m, [row.signedAgreementId]: true }));
    try {
      const payload: { recipients?: string } = {};
      const trimmed = signedAsasRecipientInput.trim();
      if (trimmed) payload.recipients = trimmed;
      const res = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/asa-agreements/${encodeURIComponent(row.signedAgreementId)}/send`,
        payload
      );
      if (res?.success) {
        setSignedAsasMessage({ type: 'success', text: res.message || 'Sent' });
        await loadSignedAsas();
      } else {
        throw new Error(res?.message || 'Failed to send');
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Failed to send signed ASA' });
    } finally {
      setSignedAsaRowSending((m) => ({ ...m, [row.signedAgreementId]: false }));
    }
  };

  const handleSignedAsaBulkSend = async (mode: 'unsent' | 'all') => {
    setSignedAsasBulkLoading(mode);
    setSignedAsasMessage(null);
    try {
      const payload: { mode: 'unsent' | 'all'; recipients?: string } = { mode };
      const trimmed = signedAsasRecipientInput.trim();
      if (trimmed) payload.recipients = trimmed;
      const res = await apiService.post<{
        success: boolean;
        message?: string;
        data?: { agreementCount: number; groupCount: number; emailsSent: number; emailsFailed: number };
      }>(`/api/me/vendor/asa-agreements/send-bulk`, payload);
      if (res?.success) {
        setSignedAsasMessage({
          type: res.data && (res.data.emailsFailed ?? 0) > 0 ? 'error' : 'success',
          text: res.message || 'Bulk send complete'
        });
        await loadSignedAsas();
      } else {
        throw new Error(res?.message || 'Bulk send failed');
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setSignedAsasMessage({ type: 'error', text: err?.message || 'Bulk send failed' });
    } finally {
      setSignedAsasBulkLoading(null);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setSignedAsasSearch(signedAsasSearchInput), 400);
    return () => clearTimeout(t);
  }, [signedAsasSearchInput]);

  useEffect(() => {
    setSignedAsasPage(1);
  }, [signedAsasStatusFilter, signedAsasSearch]);

  useEffect(() => {
    if (activeTab !== 'signed-asas') return;
    loadSignedAsas();
  }, [activeTab, loadSignedAsas]);

  useEffect(() => {
    setServedGroupsPage(1);
  }, [servedGroupTableSearch, servedGroupFilterId, servedGroupsEnrollmentFilter]);

  useEffect(() => {
    if (activeTab !== 'new-group-form') return;
    loadServedGroups();
  }, [activeTab, loadServedGroups]);

  useEffect(() => {
    if (!servedGroupFilterId) return;
    const row = servedGroupsRows.find((r) => r.groupId === servedGroupFilterId);
    if (row) {
      setServedGroupDropdownOptions((prev) => {
        if (prev.some((o) => o.value === row.groupId)) return prev;
        return [{ id: row.groupId, label: row.groupName, value: row.groupId }, ...prev];
      });
    }
  }, [servedGroupFilterId, servedGroupsRows]);

  // ============ Tab Definitions ============
  const tabs = [
    { id: 'details' as TabType, label: 'Vendor Details', icon: <Building2 className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'new-group-form' as TabType, label: 'New Group Form', icon: <FileText className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'signed-asas' as TabType, label: 'Signed ASAs', icon: <FileText className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'ach-accounts' as TabType, label: 'ACH Accounts', icon: <CreditCard className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'networks' as TabType, label: 'Networks', icon: <Network className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'users' as TabType, label: 'Users', icon: <Users className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'email' as TabType, label: 'Email Settings', icon: <Mail className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'phone' as TabType, label: 'Phone System', icon: <Phone className="h-4 w-4" style={{ color: 'inherit' }} /> },
    { id: 'sms' as TabType, label: 'SMS Settings', icon: <MessageSquare className="h-4 w-4" style={{ color: 'inherit' }} /> }
  ];

  // ============ Render Functions ============
  const renderDetailsTab = () => (
    <div>
      {profileMessage && (
        <div className={`mb-4 p-4 rounded-lg ${
          profileMessage.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-800' 
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {profileMessage.text}
        </div>
      )}

      <form onSubmit={handleProfileSubmit} className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vendor Name *
            </label>
            <input
              type="text"
              required
              value={profileData.VendorName}
              onChange={(e) => handleProfileChange('VendorName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 1
            </label>
            <input
              type="text"
              value={profileData.AddressLine1 || ''}
              onChange={(e) => handleProfileChange('AddressLine1', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address Line 2
            </label>
            <input
              type="text"
              value={profileData.AddressLine2 || ''}
              onChange={(e) => handleProfileChange('AddressLine2', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              City
            </label>
            <input
              type="text"
              value={profileData.City || ''}
              onChange={(e) => handleProfileChange('City', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              State
            </label>
            <input
              type="text"
              value={profileData.State || ''}
              onChange={(e) => handleProfileChange('State', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ZIP Code
            </label>
            <input
              type="text"
              value={profileData.Zip || ''}
              onChange={(e) => handleProfileChange('Zip', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contact Name
            </label>
            <input
              type="text"
              value={profileData.ContactName || ''}
              onChange={(e) => handleProfileChange('ContactName', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={profileData.Phone || ''}
              onChange={(e) => handleProfileChange('Phone', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={profileData.Email || ''}
              onChange={(e) => handleProfileChange('Email', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <h3 className="text-base font-medium text-gray-900 mb-1 flex items-center gap-2">
            <Link2 className="h-4 w-4 text-gray-600 shrink-0" />
            Share request management
          </h3>
          <p className="text-sm text-gray-500 mb-3">
            When enabled, your team can use share requests, provider directory, NPI, call center, and related features. The Members list is available either way and includes enrollments across all tenants.
          </p>
          <label className="flex items-start gap-3 cursor-pointer max-w-2xl">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary disabled:opacity-50"
              checked={!!profileData.ShareRequestEnabled}
              disabled={!isVendorAdmin}
              onChange={(e) => handleProfileChange('ShareRequestEnabled', e.target.checked)}
            />
            <span className="text-sm text-gray-700">
              <span className="font-medium">Enable share request features</span>
              {!isVendorAdmin && (
                <span className="block text-gray-500 mt-1">Only vendor administrators can change this.</span>
              )}
            </span>
          </label>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <h3 className="text-base font-medium text-gray-900 mb-1">Payables file (payroll deduction layout)</h3>
          <p className="text-sm text-gray-500 mb-2">
            Copy into <span className="text-gray-700">Admin → Vendors</span> → your vendor → <span className="text-gray-700">Payables Row Template</span>.
            DeductionPeriod is the first day of the NACHA paid-through month (M/D/YYYY), not the member&apos;s plan effective date. DeductionAmount is net rate (vendor pay).
          </p>
          <div className="flex flex-wrap items-start gap-2 mb-1">
            <pre className="flex-1 min-w-0 text-xs text-gray-800 bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {MW_PAYROLL_DEDUCTION_PAYABLES_ROW_TEMPLATE}
            </pre>
            <button
              type="button"
              onClick={() => {
                void copyMwPayablesTemplate();
              }}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shrink-0"
            >
              <Copy className="h-4 w-4" />
              {payablesTemplateCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <h3 className="text-base font-medium text-gray-900 mb-1">Additional contacts</h3>
          <p className="text-sm text-gray-500 mb-4">
            These contacts will also receive notifications for NACHA files, eligibility files, and new group forms.
          </p>
          <div className="space-y-3">
            {additionalContacts.map((contact, index) => (
              <div key={index} className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <input
                  type="text"
                  placeholder="Name"
                  value={contact.name}
                  onChange={(e) => updateAdditionalContact(index, 'name', e.target.value)}
                  className="flex-1 min-w-[120px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={contact.email}
                  onChange={(e) => updateAdditionalContact(index, 'email', e.target.value)}
                  className="flex-1 min-w-[160px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <button
                  type="button"
                  onClick={() => removeAdditionalContact(index)}
                  className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Remove contact"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addAdditionalContact}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" />
              Add contact
            </button>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            disabled={profileSaving}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Save className="h-4 w-4" />
            {profileSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );

  const renderAchAccountsTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">ACH Accounts</h2>
            <p className="text-sm text-gray-500 mt-1">
              Total allocation: <span className={distributionTotal <= 100.01 ? 'font-semibold text-green-600' : 'font-semibold text-red-600'}>
                {distributionTotal.toFixed(2)}%
              </span> (cannot exceed 100%)
            </p>
          </div>
          <button
            onClick={() => handleOpenAchModal({ addNew: true })}
            className="btn-primary inline-flex items-center gap-2"
            disabled={achSaving}
          >
            <Plus className="h-4 w-4" />
            Add ACH Account
          </button>
        </div>
      </div>

      {achAccounts.length === 0 ? (
        <div className="px-6 py-6 text-sm text-gray-600">
          No ACH accounts have been configured yet.
        </div>
      ) : (
        <div className="p-6 space-y-4">
          {achAccounts.map((account) => (
            <div
              key={account.achAccountId}
              className="rounded-lg border border-gray-200 bg-gray-50"
            >
              <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-base font-semibold text-gray-900">{account.accountHolderName}</p>
                  <p className="text-sm text-gray-500">{account.bankName || '—'}</p>
                </div>
                <div className="flex items-center gap-2">
                  {account.isDefault && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-oe-primary-dark">
                      Default
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${getAchStatusClasses(
                      account.status || 'Active'
                    )}`}
                  >
                    {account.status || 'Active'}
                  </span>
                  <button
                    onClick={() => handleOpenAchModal({ editId: account.achAccountId })}
                    className="p-1 transition-colors"
                    style={{ color: 'var(--oe-primary, #1f8dbf)' }}
                    onMouseEnter={(e) => e.currentTarget.style.color = 'var(--oe-primary-dark, #125e82)'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--oe-primary, #1f8dbf)'}
                    title="Edit account"
                    disabled={achSaving}
                  >
                    <Edit className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => {
                      setAccountToDelete(account);
                      setShowDeleteConfirm(true);
                    }}
                    className="p-1 transition-colors"
                    style={{ color: 'var(--oe-error, #e53935)' }}
                    onMouseEnter={(e) => e.currentTarget.style.color = '#c62828'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--oe-error, #e53935)'}
                    title="Delete account"
                    disabled={achSaving}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="grid gap-4 px-4 py-5 md:grid-cols-2">
                <div>
                  <p className="text-xs uppercase text-gray-500">Account Type</p>
                  <p className="text-sm text-gray-900">{account.accountType}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-gray-500">Distribution</p>
                  <p className="text-sm text-gray-900">
                    {(Number(account.distributionPercentage) || 0).toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase text-gray-500">Account Number</p>
                  <p className="text-sm font-mono text-gray-900">
                    {displayAccountNumber(account)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase text-gray-500">Routing Number</p>
                  <p className="text-sm font-mono text-gray-900">
                    {displayRoutingNumber(account)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase text-gray-500">Created</p>
                  <p className="text-sm text-gray-900">
                    {account.createdDate ? formatDate(account.createdDate) : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase text-gray-500">Last Updated</p>
                  <p className="text-sm text-gray-900">
                    {account.modifiedDate ? formatDate(account.modifiedDate) : '—'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderUsersTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-gray-900">Vendor Users</h2>
          <p className="text-sm text-gray-500">User management coming soon</p>
        </div>
      </div>

      {users.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 mb-2">No users found</p>
          <p className="text-sm text-gray-500">User management functionality is coming soon.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {users.map((user) => (
                <tr key={user.UserId} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">
                      {user.FirstName} {user.LastName}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-600">{user.Email}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">{user.Role}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${getUserStatusClasses(user.Status)}`}>
                      {user.Status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderEmailTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Email Configuration</h2>
            <p className="text-sm text-gray-500 mt-1">Configure Office 365 email settings for Share Request communications</p>
          </div>
        </div>
      </div>

      <form onSubmit={saveEmailConfig} className="p-6 space-y-6">
        {emailMessage && (
          <div className={`p-4 rounded-lg flex items-center gap-2 ${
            emailMessage.type === 'success' 
              ? 'bg-green-50 border border-green-200 text-green-800' 
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {emailMessage.type === 'success' ? (
              <CheckCircle className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
            {emailMessage.text}
          </div>
        )}

        {emailConfigLoading ? (
          <div className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
            <p className="mt-2 text-gray-500">Loading email configuration...</p>
          </div>
        ) : (
          <>
            {/* Office 365 Configuration */}
            <div className="space-y-4">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <Mail className="h-5 w-5" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
                Office 365 Configuration
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tenant ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={emailConfig.office365TenantId}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365TenantId: e.target.value })}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={emailConfig.office365ClientId}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365ClientId: e.target.value })}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client Secret {emailConfig.hasClientSecret && <span className="text-green-600 text-xs">(configured)</span>}
                  </label>
                  <input
                    type="password"
                    value={newClientSecret}
                    onChange={(e) => setNewClientSecret(e.target.value)}
                    placeholder={emailConfig.hasClientSecret ? "Enter new secret to change" : "Enter client secret"}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {emailConfig.hasClientSecret 
                      ? "Leave blank to keep current secret, or enter a new value to update" 
                      : "Required for authentication"}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Shared Mailbox <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={emailConfig.office365SharedMailbox}
                    onChange={(e) => setEmailConfig({ ...emailConfig, office365SharedMailbox: e.target.value })}
                    placeholder="sharingrequest@yourdomain.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
              </div>
            </div>

            {/* Display Settings */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="font-medium text-gray-900">Display Settings</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    From Name
                  </label>
                  <input
                    type="text"
                    value={emailConfig.emailFromName}
                    onChange={(e) => setEmailConfig({ ...emailConfig, emailFromName: e.target.value })}
                    placeholder="e.g., Sharewell Member Success"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reply-To Address
                  </label>
                  <input
                    type="email"
                    value={emailConfig.emailReplyTo}
                    onChange={(e) => setEmailConfig({ ...emailConfig, emailReplyTo: e.target.value })}
                    placeholder="Optional - defaults to shared mailbox"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
              </div>
            </div>

            {/* Test Email */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="font-medium text-gray-900">Test Configuration</h3>
              
              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Test Email Address
                  </label>
                  <input
                    type="email"
                    value={testEmailAddress}
                    onChange={(e) => setTestEmailAddress(e.target.value)}
                    placeholder="your@email.com"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>
                <button
                  type="button"
                  onClick={testEmail}
                  disabled={testingEmail || !testEmailAddress.trim()}
                  className="btn-secondary inline-flex items-center gap-2"
                >
                  <Send className="h-4 w-4" />
                  {testingEmail ? 'Sending...' : 'Send Test'}
                </button>
              </div>
              
              {testEmailResult && (
                <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                  testEmailResult.success 
                    ? 'bg-green-50 text-green-800 border border-green-200' 
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  {testEmailResult.success ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {testEmailResult.message}
                </div>
              )}
            </div>

            {/* Save Button */}
            <div className="pt-4 border-t border-gray-200 flex justify-end">
              <button
                type="submit"
                disabled={emailConfigSaving}
                className="btn-primary inline-flex items-center gap-2"
              >
                <Save className="h-4 w-4" />
                {emailConfigSaving ? 'Saving...' : 'Save Email Settings'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );

  const renderPhoneTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Phone System Integration</h2>
            <p className="text-sm text-gray-500 mt-1">Connect your phone system to track calls and link them to Share Requests</p>
          </div>
        </div>
      </div>

      <form onSubmit={savePhoneConfig} className="p-6 space-y-6">
        {phoneMessage && (
          <div className={`p-4 rounded-lg flex items-center gap-2 ${
            phoneMessage.type === 'success' 
              ? 'bg-green-50 border border-green-200 text-green-800' 
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {phoneMessage.type === 'success' ? (
              <CheckCircle className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
            {phoneMessage.text}
          </div>
        )}

        {phoneConfigLoading ? (
          <div className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
            <p className="mt-2 text-gray-500">Loading phone configuration...</p>
          </div>
        ) : (
          <>
            {/* Phone Provider Selection */}
            <div className="space-y-4">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <Phone className="h-5 w-5" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
                Phone Provider
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select Provider
                  </label>
                  <select
                    value={phoneConfig.phoneProvider}
                    onChange={(e) => setPhoneConfig({ ...phoneConfig, phoneProvider: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  >
                    {PHONE_PROVIDERS.map(provider => (
                      <option key={provider.id} value={provider.id} disabled={provider.disabled}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={phoneConfig.phoneProviderEnabled}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, phoneProviderEnabled: e.target.checked })}
                      disabled={!phoneConfig.phoneProvider}
                      className="w-5 h-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    />
                    <span className="text-sm font-medium text-gray-700">Enable Phone Integration</span>
                  </label>
                </div>
              </div>
            </div>

            {/* Zoom Phone Configuration */}
            {phoneConfig.phoneProvider === 'ZoomPhone' && (
              <div className="space-y-4 pt-4 border-t border-gray-200">
                <h3 className="font-medium text-gray-900 flex items-center gap-2">
                  <PhoneCall className="h-5 w-5" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
                  Zoom Phone Server-to-Server OAuth
                </h3>
                <p className="text-sm text-gray-500">
                  Create a Server-to-Server OAuth app in the <a href="https://marketplace.zoom.us/" target="_blank" rel="noopener noreferrer" className="text-oe-primary hover:underline">Zoom App Marketplace</a> with Phone API scopes.
                </p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Account ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={phoneConfig.zoomAccountId}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, zoomAccountId: e.target.value })}
                      placeholder="Your Zoom Account ID"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Client ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={phoneConfig.zoomClientId}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, zoomClientId: e.target.value })}
                      placeholder="OAuth Client ID"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Client Secret {phoneConfig.hasZoomClientSecret && <span className="text-green-600 text-xs">(configured)</span>}
                    </label>
                    <input
                      type="password"
                      value={newZoomClientSecret}
                      onChange={(e) => setNewZoomClientSecret(e.target.value)}
                      placeholder={phoneConfig.hasZoomClientSecret ? "Enter new secret to change" : "Enter client secret"}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Webhook Secret Token
                    </label>
                    <input
                      type="text"
                      value={phoneConfig.zoomWebhookSecretToken}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, zoomWebhookSecretToken: e.target.value })}
                      placeholder="For webhook signature verification"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                    />
                  </div>
                </div>

                {/* Webhook URL */}
                {phoneConfig.zoomWebhookUrl && (
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Webhook URL (use this in Zoom App settings)
                    </label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-white px-3 py-2 rounded border border-gray-300 text-sm text-gray-800 overflow-x-auto">
                        {phoneConfig.zoomWebhookUrl}
                      </code>
                      <button
                        type="button"
                        onClick={copyWebhookUrl}
                        className="btn-secondary inline-flex items-center gap-1 text-sm"
                      >
                        <Link2 className="h-4 w-4" />
                        Copy
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Configure this URL in your Zoom App's webhook settings to receive real-time call events.
                    </p>
                  </div>
                )}

                {/* Test Connection */}
                <div className="flex items-end gap-4">
                  <button
                    type="button"
                    onClick={testZoomConnection}
                    disabled={testingZoomConnection || !phoneConfig.zoomAccountId || !phoneConfig.zoomClientId}
                    className="btn-secondary inline-flex items-center gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${testingZoomConnection ? 'animate-spin' : ''}`} />
                    {testingZoomConnection ? 'Testing...' : 'Test Connection'}
                  </button>
                  
                  {zoomConnectionResult && (
                    <div className={`flex items-center gap-2 text-sm ${
                      zoomConnectionResult.success ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {zoomConnectionResult.success ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <AlertCircle className="h-4 w-4" />
                      )}
                      {zoomConnectionResult.message}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Feature Settings */}
            {phoneConfig.phoneProvider && (
              <>
              <div className="space-y-4 pt-4 border-t border-gray-200">
                <h3 className="font-medium text-gray-900">Feature Settings</h3>
                
                <div className="space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={phoneConfig.phoneAutoMatchEnabled}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, phoneAutoMatchEnabled: e.target.checked })}
                      className="w-5 h-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Auto-Match Calls</span>
                      <p className="text-xs text-gray-500">Automatically link calls to members based on phone number</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={phoneConfig.phonePopupEnabled}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, phonePopupEnabled: e.target.checked })}
                      className="w-5 h-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Call Popup Notifications</span>
                      <p className="text-xs text-gray-500">Show popup when incoming calls are detected with member info</p>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={phoneConfig.phoneRecordingsEnabled}
                      onChange={(e) => setPhoneConfig({ ...phoneConfig, phoneRecordingsEnabled: e.target.checked })}
                      className="w-5 h-5 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Call Recordings</span>
                      <p className="text-xs text-gray-500">Store links to call recordings (requires Zoom recording feature)</p>
                    </div>
                  </label>
                </div>
              </div>

              </>
            )}

            {/* Save Button */}
            <div className="pt-4 border-t border-gray-200 flex justify-end">
              <button
                type="submit"
                disabled={phoneConfigSaving}
                className="btn-primary inline-flex items-center gap-2"
              >
                <Save className="h-4 w-4" />
                {phoneConfigSaving ? 'Saving...' : 'Save Phone Settings'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );

  const renderNewGroupFormTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">New Group Form</h2>
            <p className="text-sm text-gray-500 mt-1">Configure which fields appear when agents generate a new group form for this vendor. Unmapped fields render blank.</p>
          </div>
          <button
            type="button"
            onClick={loadMightyWellPreset}
            className="btn-secondary inline-flex items-center gap-2"
          >
            Load Default Template
          </button>
        </div>
      </div>

      <form onSubmit={saveNewGroupForm} className="p-6 space-y-6">
        {newGroupFormLoading ? (
          <div className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto" />
            <p className="mt-2 text-gray-500">Loading new group form configuration...</p>
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Form title</label>
              <input
                type="text"
                value={newGroupFormTitle}
                onChange={(e) => setNewGroupFormTitle(e.target.value)}
                placeholder="e.g. MightyWell Health New Group Review / Sold Sheet"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">Form fields</label>
                <button type="button" onClick={addNewGroupFormField} className="btn-secondary inline-flex items-center gap-1 text-sm">
                  <Plus className="h-4 w-4" /> Add field
                </button>
              </div>
              <p className="text-xs text-gray-600 mb-3">
                Each row sets <span className="font-medium">Row kind</span> (what the row is). For normal inputs, use <span className="font-medium">Field</span> and choose <span className="font-medium">Map to</span> — pick <span className="font-medium">Master group id</span> only when you want a single Master ID line; use <span className="font-medium">Vendor Group ID(s)</span> when you want Master plus every product ID block inserted at once.
              </p>
              <div className="space-y-3">
                {newGroupFormFields.map((field, index) => {
                  const ft = field.fieldType ?? 'field';
                  return (
                  <div key={field.key || index} className="flex flex-wrap items-start gap-2 p-3 rounded-lg border border-gray-200 bg-gray-50">
                    <div className="w-[200px] shrink-0">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Row kind</label>
                      <select
                        value={ft}
                        onChange={(e) => {
                          const v = e.target.value as 'field' | 'labelHeader' | 'includeAllVendorGroupIds';
                          if (v === 'includeAllVendorGroupIds') {
                            updateNewGroupFormField(index, { fieldType: v, systemVariable: '' });
                            return;
                          }
                          if (v === 'labelHeader') {
                            updateNewGroupFormField(index, {
                              fieldType: v,
                              systemVariable: '',
                              attemptAutoGenerateVendorGroupIdsIfMissing: undefined,
                            });
                            return;
                          }
                          updateNewGroupFormField(index, { fieldType: 'field' });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                        title="Vendor Group ID(s): expands to Master + product IDs at this position"
                      >
                        <option value="field">Field</option>
                        <option value="labelHeader">Label Header</option>
                        <option value="includeAllVendorGroupIds">Vendor Group ID(s)</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      value={field.label}
                      onChange={(e) => updateNewGroupFormField(index, { label: e.target.value })}
                      placeholder={
                        ft === 'labelHeader'
                          ? 'Section header text'
                          : ft === 'includeAllVendorGroupIds'
                            ? 'Optional section title above ID lines'
                            : 'Field label'
                      }
                      className="flex-1 min-w-[180px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    />
                    {ft === 'includeAllVendorGroupIds' && (
                      <>
                        <p className="text-xs text-gray-600 basis-full w-full">
                          Inserts Master and each configured product vendor group ID line here (deduped with separate Field rows mapped to IDs below).
                        </p>
                        <label className="flex items-start gap-2 cursor-pointer basis-full mt-1 ml-1">
                          <input
                            type="checkbox"
                            checked={!!field.attemptAutoGenerateVendorGroupIdsIfMissing}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setNewGroupFormFields((prev) => {
                                const next = [...prev];
                                const row = { ...next[index] };
                                if (checked) row.attemptAutoGenerateVendorGroupIdsIfMissing = true;
                                else delete row.attemptAutoGenerateVendorGroupIdsIfMissing;
                                next[index] = row;
                                return next;
                              });
                            }}
                            className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                          />
                          <span className="text-xs text-gray-700">
                            <span className="font-medium block">Generate vendor group IDs if missing</span>
                            <span className="text-gray-500 mt-0.5 block">
                              Runs ID generation for this group before filling the form (same as per-ID Field rows).
                            </span>
                          </span>
                        </label>
                      </>
                    )}
                    {ft === 'field' && (
                      <>
                        <select
                          value={field.key === 'agentSignature' ? '__agentSignature__' : field.key === 'groupAdminSignature' ? '__groupAdminSignature__' : (field.systemVariable ?? '')}
                          onChange={(e) => {
                            const v = e.target.value;
                            setNewGroupFormFieldSystemVariable(index, v);
                          }}
                          className="min-w-[220px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                        >
                          {NEW_GROUP_FORM_SYSTEM_VARIABLES.map((opt) => (
                            <option key={opt.value || 'blank'} value={opt.value}>{opt.label}</option>
                          ))}
                          <optgroup label="Vendor Group ID">
                            <option value="group.vendorMasterGroupId">Master group id</option>
                            {newGroupFormProductTypes.map((t) => (
                              <option key={`vgid-type-${t.productType}`} value={`group.vendorProductGroupId_${t.productType}`}>
                                {t.productType} (group id by type)
                              </option>
                            ))}
                            {newGroupFormProductOptions.length === 0 && newGroupFormProductTypes.length === 0 ? (
                              <option disabled value="__no_products__">— No products for this vendor —</option>
                            ) : (
                              newGroupFormProductOptions.map((p) => (
                                <option
                                  key={`vgid-${p.productId}`}
                                  value={`group.vendorProductGroupId_${p.productId}`}
                                  disabled={!p.hasVendorGroupIdSetting}
                                >
                                  {p.name} (product group id){!p.hasVendorGroupIdSetting ? ' — group ID not configured' : ''}
                                </option>
                              ))
                            )}
                          </optgroup>
                        </select>
                        {(field.systemVariable !== '__agentSignature__' && field.systemVariable !== '__groupAdminSignature__' && field.key !== 'agentSignature' && field.key !== 'groupAdminSignature') && (
                          <input
                            type="text"
                            value={field.defaultValue ?? ''}
                            onChange={(e) => updateNewGroupFormField(index, { defaultValue: e.target.value })}
                            placeholder="Default value"
                            className="min-w-[120px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                            title="Default value when no system variable is mapped or value is empty"
                          />
                        )}
                        {(field.fieldType ?? 'field') === 'field' && isVendorGroupIdSystemVariable(field.systemVariable) && (
                          <label className="flex items-start gap-2 cursor-pointer basis-full mt-1 ml-1">
                            <input
                              type="checkbox"
                              checked={!!field.attemptAutoGenerateVendorGroupIdsIfMissing}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setNewGroupFormFields((prev) => {
                                  const next = [...prev];
                                  const row = { ...next[index] };
                                  if (checked) row.attemptAutoGenerateVendorGroupIdsIfMissing = true;
                                  else delete row.attemptAutoGenerateVendorGroupIdsIfMissing;
                                  next[index] = row;
                                  return next;
                                });
                              }}
                              className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                            />
                            <span className="text-xs text-gray-700">
                              <span className="font-medium block">Attempt to auto-generate vendor group IDs if missing</span>
                              <span className="text-gray-500 mt-0.5 block">
                                Runs ID generation for this group before filling the form (same logic as Generate IDs). Use when paperwork should only go out after IDs exist.
                              </span>
                            </span>
                          </label>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => removeNewGroupFormField(index)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded"
                      title="Remove field"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
                })}
                {newGroupFormFields.length === 0 && (
                  <p className="text-sm text-gray-500">No fields yet. Add fields or load the MightyWell template.</p>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-gray-200 flex justify-end">
              <button type="submit" disabled={newGroupFormSaving} className="btn-primary inline-flex items-center gap-2">
                <Save className="h-4 w-4" />
                {newGroupFormSaving ? 'Saving...' : 'Save New Group Form'}
              </button>
            </div>
          </>
        )}
      </form>

      <div className="border-t border-gray-200 px-6 py-6 space-y-4">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Groups using your products</h3>
          <p className="text-sm text-gray-500 mt-1">
            Lists active groups that have any of your vendor products on the group. Search by group name or vendor group ID. Each row shows the number of enrolled households on your products and the earliest effective date. Rows that still need vendor group IDs (when configured) and have more than one enrolled household on a vendor product appear first. Download generates the PDF; Generate Group Form opens the full prepare/review flow (same as on the group&apos;s Vendors tab).
          </p>
        </div>

        {/* Auto-assign vendor group IDs nightly. Saves via PUT /api/vendors/:id
            (VendorAdmin self-scoped allowed by authorizeVendorDetail). Existing
            IDs keep their stored value when configuration changes; only new IDs
            adopt new affix shape (see Part E4 affix-flip migration policy). */}
        {(profileData as any)?.Id && vendorIdsApplicable && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={!!(profileData as any).AutoGenerateVendorGroupIds}
                onChange={async (e) => {
                  const checked = e.target.checked;
                  const prev = (profileData as any).AutoGenerateVendorGroupIds;
                  setProfileData((p: any) => ({ ...p, AutoGenerateVendorGroupIds: checked }));
                  try {
                    const res = await apiService.put<{ success: boolean; message?: string }>(
                      `/api/vendors/${encodeURIComponent((profileData as any).Id)}`,
                      {
                        // Backend PUT requires vendorName; profileData carries it.
                        vendorName: (profileData as any).VendorName || (profileData as any).vendorName,
                        autoGenerateVendorGroupIds: checked,
                      }
                    );
                    if (res?.success) {
                      setNewGroupFormMessage({ type: 'success', text: 'Auto-generate vendor group IDs preference saved.' });
                    } else {
                      throw new Error(res?.message || 'Failed');
                    }
                  } catch (err: unknown) {
                    setProfileData((p: any) => ({ ...p, AutoGenerateVendorGroupIds: prev }));
                    const m = (err as { message?: string })?.message;
                    setNewGroupFormMessage({ type: 'error', text: m || 'Failed to update auto-generate setting' });
                  }
                }}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  Automatically assign vendor group IDs nightly
                </span>
                <span className="block text-xs text-gray-500 mt-1">
                  When enabled, a nightly job assigns vendor group IDs for groups that have at least one active enrollment on your products and don&apos;t already have a Master ID. Requires vendor group ID configuration (prefix / seed) to be set up.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="flex flex-col md:flex-row md:flex-wrap md:items-end gap-4">
          <div className="flex-1 max-w-md min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">Filter by group</label>
            <SearchableDropdown
              options={servedGroupDropdownOptions}
              value={servedGroupFilterId}
              onChange={(value) => setServedGroupFilterId(value)}
              placeholder="All groups"
              searchPlaceholder="Search groups..."
              useBackendSearch
              onSearch={fetchServedGroupDropdownOptions}
              loading={servedGroupDropdownLoading}
            />
          </div>
          <div className="flex-1 max-w-xs min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">Active enrollments</label>
            <select
              value={servedGroupsEnrollmentFilter}
              onChange={(e) => setServedGroupsEnrollmentFilter(e.target.value as 'all' | 'active' | 'inactive')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="all">All groups</option>
              <option value="active">With active enrollments</option>
              <option value="inactive">No active enrollments</option>
            </select>
          </div>
          <div className="flex-1 max-w-md min-w-0">
            <label className="block text-sm font-medium text-gray-700 mb-1">Search table</label>
            <input
              type="text"
              value={servedGroupTableSearchInput}
              onChange={(e) => setServedGroupTableSearchInput(e.target.value)}
              placeholder="Search by group name or vendor group ID..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
        </div>

        {vendorIdsApplicable && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-gray-500">Vendor group IDs are configured for your vendor. Use Generate IDs when status is Pending.</p>
            <button
              type="button"
              onClick={async () => {
                const filterLabel = servedGroupsEnrollmentFilter === 'active'
                  ? 'with active enrollments'
                  : servedGroupsEnrollmentFilter === 'inactive'
                    ? 'with no active enrollments'
                    : '(all)';
                if (!window.confirm(`Generate vendor group IDs for all served groups ${filterLabel} that don't already have a Master ID?`)) {
                  return;
                }
                setServedGroupsBulkGenLoading(true);
                try {
                  const res = await apiService.post<{
                    success: boolean;
                    message?: string;
                    data?: { groupsConsidered: number; groupsProcessed: number; totalIdsCreated: number; errors: Array<{ groupId: string; message: string }> };
                  }>(`/api/me/vendor/profile/served-groups/generate-vendor-ids-bulk`, {
                    enrollmentFilter: servedGroupsEnrollmentFilter,
                  });
                  if (res?.success) {
                    const d = res.data;
                    const errCount = d?.errors?.length || 0;
                    const msg = res.message
                      || `Generated IDs for ${d?.groupsProcessed || 0} group(s), ${d?.totalIdsCreated || 0} new IDs.`;
                    setNewGroupFormMessage({ type: errCount ? 'error' : 'success', text: errCount ? `${msg} (${errCount} error(s))` : msg });
                    await loadServedGroups();
                  } else {
                    throw new Error(res?.message || 'Failed');
                  }
                } catch (e: unknown) {
                  const err = e as { message?: string };
                  setNewGroupFormMessage({ type: 'error', text: err?.message || 'Failed to bulk generate vendor group IDs' });
                } finally {
                  setServedGroupsBulkGenLoading(false);
                }
              }}
              disabled={servedGroupsBulkGenLoading}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-oe-primary bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {servedGroupsBulkGenLoading ? 'Generating…' : 'Generate IDs for filtered groups'}
            </button>
          </div>
        )}

        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          {servedGroupsLoading ? (
            <div className="py-12 text-center text-gray-500">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto" />
              <p className="mt-2">Loading groups...</p>
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Form generated</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor group IDs</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {servedGroupsRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                      No groups match your filters.
                    </td>
                  </tr>
                ) : (
                  servedGroupsRows.map((row) => (
                    <tr key={row.groupId}>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{row.groupName}</span>
                          {row.needsAttention && (
                            <span
                              className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-900"
                              title="More than one household is enrolled on a single vendor product, so this group needs unique vendor group IDs."
                            >
                              Needs IDs · 2+ households
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                          <p>
                            {(row.householdCount ?? 0)} enrolled household
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
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${row.hasFormHistory ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                          {row.hasFormHistory ? 'Yes' : 'Not yet'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
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
                      <td className="px-4 py-3 text-right text-sm whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setNewGroupFormModalGroup({ groupId: row.groupId, groupName: row.groupName })
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border-2 mr-2 hover:bg-gray-50"
                          style={{ borderColor: 'var(--oe-primary)', color: 'var(--oe-primary)' }}
                        >
                          <FileDown className="h-4 w-4" />
                          Generate Group Form
                        </button>
                        <button
                          type="button"
                          onClick={() => handleServedGroupPdf(row)}
                          disabled={!!servedGroupPdfLoadingId}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 mr-2 disabled:opacity-50"
                        >
                          <Download className="h-4 w-4" />
                          {servedGroupPdfLoadingId === row.groupId ? '...' : row.hasFormHistory ? 'Download PDF' : 'Generate PDF'}
                        </button>
                        {vendorIdsApplicable && row.vendorGroupIdsStatus === 'pending' && (
                          <button
                            type="button"
                            onClick={() => handleServedGroupGenerateIds(row)}
                            disabled={!!servedGroupGenIdsLoadingId}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            <Hash className="h-4 w-4" />
                            {servedGroupGenIdsLoadingId === row.groupId ? '...' : 'Generate IDs'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {servedGroupsTotal > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm text-gray-600">
            <span>
              Showing {(servedGroupsPage - 1) * servedGroupsLimit + 1}–{Math.min(servedGroupsPage * servedGroupsLimit, servedGroupsTotal)} of {servedGroupsTotal}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={servedGroupsPage <= 1 || servedGroupsLoading}
                onClick={() => setServedGroupsPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Previous
              </button>
              <span>
                Page {servedGroupsPage} of {Math.max(1, Math.ceil(servedGroupsTotal / servedGroupsLimit))}
              </span>
              <button
                type="button"
                disabled={servedGroupsPage >= Math.ceil(servedGroupsTotal / servedGroupsLimit) || servedGroupsLoading}
                onClick={() => setServedGroupsPage((p) => p + 1)}
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <NewGroupFormGenerateModal
        open={!!newGroupFormModalGroup}
        onClose={() => setNewGroupFormModalGroup(null)}
        groupId={newGroupFormModalGroup?.groupId ?? ''}
        groupName={newGroupFormModalGroup?.groupName ?? ''}
        onNotify={(msg, sev) => {
          if (sev === 'success') setNewGroupFormMessage({ type: 'success', text: msg });
          else if (sev === 'error') setNewGroupFormMessage({ type: 'error', text: msg });
        }}
      />
    </div>
  );

  const renderSignedAsasTab = () => {
    const totalPages = Math.max(1, Math.ceil(signedAsasTotal / signedAsasLimit));
    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-lg font-medium text-gray-900">Signed ASAs</h2>
              <p className="text-sm text-gray-500 mt-1">
                Vendor Agent Service Agreements signed by groups for your products. The <strong>Email status</strong> column
                shows sent (green) vs unsent (yellow) per row. Use the filter to list only unsent or only sent.
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
            <div className={`p-3 rounded-lg flex items-start gap-2 text-sm ${
              signedAsasMessage.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}>
              {signedAsasMessage.type === 'success' ? <CheckCircle className="h-4 w-4 mt-0.5" /> : <AlertCircle className="h-4 w-4 mt-0.5" />}
              <div className="flex-1">{signedAsasMessage.text}</div>
              <button type="button" onClick={() => setSignedAsasMessage(null)} className="text-current opacity-70 hover:opacity-100">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Recipient email(s) for sending
              </label>
              <input
                type="text"
                value={signedAsasRecipientInput}
                onChange={(e) => setSignedAsasRecipientInput(e.target.value)}
                placeholder="ops@example.com, another@example.com"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              <p className="text-xs text-gray-500 mt-1">
                Comma-separated. Leave empty to fall back to vendor Email + notification contacts.
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
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group / Product</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Signed</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {signedAsasRows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                        {signedAsasStatusFilter === 'unsent'
                          ? 'No unsent signed ASAs — everything has been emailed.'
                          : 'No signed ASAs for your products yet.'}
                      </td>
                    </tr>
                  ) : (
                    signedAsasRows.map((row) => {
                      const sending = !!signedAsaRowSending[row.signedAgreementId];
                      const downloading = !!signedAsaRowDownloading[row.signedAgreementId];
                      const signedDateStr = row.signedDate
                        ? new Date(row.signedDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                        : '—';
                      const sentDateStr = row.lastEmailedDate
                        ? new Date(row.lastEmailedDate).toLocaleString()
                        : null;
                      return (
                        <tr key={row.signedAgreementId}>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            <div className="font-medium">{row.groupName || '—'}</div>
                            <div className="text-xs text-gray-500">{row.productName || '—'}</div>
                            {row.signedByName && (
                              <div className="mt-1 text-xs text-gray-500">
                                Signed by {row.signedByName}{row.signedByEmail ? ` <${row.signedByEmail}>` : ''}
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
                                  <div className="mt-0.5 text-xs text-gray-500 truncate max-w-[240px]" title={row.lastEmailedTo}>
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
                                  <div className="mt-1 text-xs text-red-600 truncate max-w-[240px]" title={row.lastEmailError}>
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
                              disabled={sending || !!signedAsasBulkLoading}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
                              title={row.lastEmailedDate ? 'Resend signed ASA' : 'Send signed ASA'}
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
                <span>Page {signedAsasPage} of {totalPages}</span>
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

  const renderSmsTab = () => (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">SMS Messaging Configuration</h2>
            <p className="text-sm text-gray-500 mt-1">Configure SMS messaging for Share Request communications</p>
          </div>
        </div>
      </div>

      <form onSubmit={saveSmsConfig} className="p-6 space-y-6">
        {phoneMessage && (
          <div className={`p-4 rounded-lg flex items-center gap-2 ${
            phoneMessage.type === 'success' 
              ? 'bg-green-50 border border-green-200 text-green-800' 
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {phoneMessage.type === 'success' ? (
              <CheckCircle className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )}
            {phoneMessage.text}
          </div>
        )}

        {phoneConfigLoading ? (
          <div className="py-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
            <p className="mt-2 text-gray-500">Loading SMS configuration...</p>
          </div>
        ) : (
          <>
            {/* Twilio SMS Configuration */}
            <div className="space-y-4">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <MessageSquare className="h-5 w-5" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
                Twilio SMS Configuration
              </h3>
              <p className="text-sm text-gray-500">
                Configure Twilio for SMS messaging. Get your credentials from the <a href="https://console.twilio.com/" target="_blank" rel="noopener noreferrer" className="text-oe-primary hover:underline">Twilio Console</a>.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Account SID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={phoneConfig.twilioAccountSid}
                    onChange={(e) => setPhoneConfig({ ...phoneConfig, twilioAccountSid: e.target.value })}
                    placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Auth Token {phoneConfig.hasTwilioAuthToken && <span className="text-green-600 text-xs">(configured)</span>}
                  </label>
                  <input
                    type="password"
                    value={newTwilioAuthToken}
                    onChange={(e) => setNewTwilioAuthToken(e.target.value)}
                    placeholder={phoneConfig.hasTwilioAuthToken ? "Enter new token to change" : "Enter auth token"}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={phoneConfig.twilioPhoneNumber}
                    onChange={(e) => setPhoneConfig({ ...phoneConfig, twilioPhoneNumber: e.target.value })}
                    placeholder="+19043736872"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Your Twilio phone number in E.164 format (e.g., +1XXXXXXXXXX)
                  </p>
                </div>
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-4 border-t border-gray-200 flex justify-end">
              <button
                type="submit"
                disabled={phoneConfigSaving}
                className="btn-primary inline-flex items-center gap-2"
              >
                <Save className="h-4 w-4" />
                {phoneConfigSaving ? 'Saving...' : 'Save SMS Settings'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="h-6 w-6" style={{ color: 'var(--oe-primary, #1f8dbf)' }} />
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6 overflow-x-auto">
        <nav className="-mb-px flex space-x-8 min-w-max flex-nowrap">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 py-4 px-1 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'details' && renderDetailsTab()}
      {activeTab === 'ach-accounts' && renderAchAccountsTab()}
      {activeTab === 'networks' && (
        <VendorNetworksPanel mode="self" />
      )}
      {activeTab === 'users' && renderUsersTab()}
      {activeTab === 'email' && renderEmailTab()}
      {activeTab === 'phone' && renderPhoneTab()}
      {activeTab === 'sms' && renderSmsTab()}
      {activeTab === 'new-group-form' && renderNewGroupFormTab()}
      {activeTab === 'signed-asas' && renderSignedAsasTab()}

      {/* ACH Account Modal */}
      {achModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* Modal Header */}
            <div className="px-6 py-4 flex items-center justify-between rounded-t-lg" style={{ backgroundColor: 'var(--oe-primary, #1f8dbf)', color: 'white' }}>
              <h3 className="text-lg font-semibold">
                {achModalMode === 'create' ? 'Add ACH Account' : 'Edit ACH Account'}
              </h3>
              <button
                onClick={handleCloseAchModal}
                className="text-white hover:bg-white hover:bg-opacity-20 p-1 rounded transition-colors"
                disabled={achSaving}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-6">
              {achModalAccounts.map((account, index) => (
                <div key={account.tempId} className="rounded-lg border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-200 px-4 py-3">
                    <p className="text-sm font-semibold text-gray-900">ACH Account {index + 1}</p>
                  </div>

                  <div className="grid gap-4 px-4 py-5 md:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Holder Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={account.accountHolderName}
                        onChange={(e) => handleModalAccountHolderChange(account.tempId, e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          achModalFieldErrors[account.tempId]?.accountHolderName ? 'border-red-300' : 'border-gray-300'
                        }`}
                        disabled={achSaving}
                      />
                      {achModalFieldErrors[account.tempId]?.accountHolderName && (
                        <p className="mt-1 text-sm text-red-600">
                          {achModalFieldErrors[account.tempId]?.accountHolderName}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                      <input
                        type="text"
                        value={account.bankName || ''}
                        onChange={(e) => handleModalBankNameChange(account.tempId, e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                        disabled={achSaving}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Company Identification (10 digits)
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={account.companyIdentification || ''}
                        onChange={(e) => handleModalCompanyIdentificationChange(account.tempId, e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          achModalFieldErrors[account.tempId]?.companyIdentification ? 'border-red-300' : 'border-gray-300'
                        }`}
                        placeholder="1234567890"
                        disabled={achSaving}
                      />
                      <p className="mt-1 text-xs text-gray-500">Optional. Used for NACHA file header.</p>
                      {achModalFieldErrors[account.tempId]?.companyIdentification && (
                        <p className="mt-1 text-sm text-red-600">
                          {achModalFieldErrors[account.tempId]?.companyIdentification}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Account Type</label>
                      <select
                        value={account.accountType}
                        onChange={(e) => handleModalAccountTypeChange(account.tempId, e.target.value as 'Checking' | 'Savings')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                        disabled={achSaving}
                      >
                        <option value="Checking">Checking</option>
                        <option value="Savings">Savings</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Distribution Percentage
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={Number.isNaN(account.distributionPercentage) ? '' : account.distributionPercentage}
                        onChange={(e) => handleModalDistributionChange(account.tempId, e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          achModalFieldErrors[account.tempId]?.distributionPercentage ? 'border-red-300' : 'border-gray-300'
                        }`}
                        disabled={achSaving}
                      />
                      {achModalFieldErrors[account.tempId]?.distributionPercentage && (
                        <p className="mt-1 text-sm text-red-600">
                          {achModalFieldErrors[account.tempId]?.distributionPercentage}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Routing Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={account.routingNumber || ''}
                        onChange={(e) => handleModalRoutingNumberChange(account.tempId, e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          achModalFieldErrors[account.tempId]?.routingNumber ? 'border-red-300' : 'border-gray-300'
                        }`}
                        placeholder="123456789"
                        disabled={achSaving}
                      />
                      <p className="mt-1 text-xs text-gray-500">9-digit routing number</p>
                      {achModalFieldErrors[account.tempId]?.routingNumber && (
                        <p className="mt-1 text-sm text-red-600">
                          {achModalFieldErrors[account.tempId]?.routingNumber}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Number <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={account.accountNumber || ''}
                        onChange={(e) => handleModalAccountNumberChange(account.tempId, e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                          achModalFieldErrors[account.tempId]?.accountNumber ? 'border-red-300' : 'border-gray-300'
                        }`}
                        placeholder="Enter full account number"
                        disabled={achSaving}
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
                          disabled={achSaving}
                        />
                        <span className="text-sm text-gray-700">Set as default account</span>
                      </label>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4 rounded-b-lg">
              <button
                type="button"
                onClick={handleCloseAchModal}
                className="btn-secondary"
                disabled={achSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAchModal}
                className="btn-primary"
                disabled={achSaving}
              >
                {achSaving ? 'Saving...' : 'Save Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && accountToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Delete ACH Account</h3>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete the ACH account for "{accountToDelete.accountHolderName}"? 
              This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setAccountToDelete(null);
                }}
                className="btn-secondary"
                disabled={achSaving}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteAccount(accountToDelete)}
                className="btn-danger"
                disabled={achSaving}
              >
                {achSaving ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {newGroupFormMessage && (
        <div
          className="fixed top-4 left-1/2 z-[200] w-[min(90vw,28rem)] -translate-x-1/2 px-4 pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border p-4 shadow-lg ${
              newGroupFormMessage.type === 'success'
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {newGroupFormMessage.type === 'success' ? (
              <CheckCircle className="h-5 w-5 shrink-0" aria-hidden />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" aria-hidden />
            )}
            <span className="flex-1 text-sm leading-snug">{newGroupFormMessage.text}</span>
            <button
              type="button"
              onClick={() => setNewGroupFormMessage(null)}
              className="pointer-events-auto shrink-0 rounded p-1 opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-oe-primary"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorSettings;
