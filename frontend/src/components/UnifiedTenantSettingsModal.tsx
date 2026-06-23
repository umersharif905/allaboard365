// File: src/components/UnifiedTenantSettingsModal.tsx
// Unified tenant settings modal for both SysAdmin and TenantAdmin roles

/** DIME webhook endpoint (Azure Function). Use this URL in the DIME dashboard as the webhook URL. */
const PAYMENT_WEBHOOK_URL = 'https://allaboard-payment-manager-aebfesgwffcnafb3.centralus-01.azurewebsites.net/api/webhooks/dime';

import {
    AlertCircle,
    Banknote,
    Brain,
    CheckCircle,
    Copy,
    CreditCard,
    DollarSign,
    Eye,
    EyeOff,
    Globe,
    HelpCircle,
    Image,
    Info,
    KeyRound,
    Link,
    Loader2,
    Mail,
    Monitor,
    Palette,
    Plus,
    Save,
    Settings,
    Smartphone,
    Trash2,
    Upload,
    UserPlus,
    X
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';
import { type DnsRecord } from '../services/email-settings.service';
import { OverrideACHAccount, ProductOverridesService } from '../services/product-overrides.service';
import { TenantPayoutACHAccount, TenantPayoutACHService } from '../services/tenant-payout-ach.service';
import { AgentAgreementDocument, AgentOnboardingService } from '../services/tenant-admin/agent-onboarding.service';
import { TenantAdminService } from '../services/tenant-admin/tenant-admin.service';
import { TenantApiKeysService } from '../services/tenant-admin/tenant-api-keys.service';
import type { CreatedTenantApiKey, TenantApiKey } from '../types/tenant-admin/tenant-api-keys.types';
import TenantService from '../services/TenantService';
import type { ApiResponse } from '../types/index';
import { MAX_DOCUMENT_UPLOAD_BYTES, MAX_DOCUMENT_UPLOAD_MB } from '../constants/uploads';
import SearchableDropdown from './common/SearchableDropdown';
import EmailSettingsSection from './EmailSettingsSection';
import AIKnowledgeSection from './tenant-settings/AIKnowledgeSection';
import UrlPathManager from './UrlPathManager';

interface ApiKey {
  id: string;
  name: string;
  key: string;
  partialKey: string;
  createdDate: string;
  lastUsed?: string;
  expiresAt?: string;
  status: 'active' | 'expired' | 'revoked';
}

/** Endpoint the tenant's website POSTs each form submission to. */
const WEBSITE_SUBMISSIONS_URL = 'https://api.allaboard365.com/api/website-form-submissions';

/** Sample JSON payload the website sends to /api/website-form-submissions. */
const WEBSITE_SAMPLE_PAYLOAD = `{
  "advisorName": "Jane Smith",
  "submitterName": "John Doe",
  "email": "john@example.com",
  "phone": "2015551234",
  "company": "Acme Co",
  "state": "TX",
  "formType": "quote",
  "subject": "Requesting a quote"
}`;

/**
 * Website Integration section — mint/list/revoke the single tenant-level website API key,
 * plus the endpoint + sample payload the website sends. Reuses the LeadIngestModal UI patterns
 * (generate, copy-once, list, revoke), but calls the tenant key endpoints. Self-contained so the
 * large settings modal stays unchanged structurally.
 */
const WebsiteIntegrationSection: React.FC = () => {
  const [keys, setKeys] = useState<TenantApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedTenantApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<TenantApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await TenantApiKeysService.list();
      setKeys(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load website keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const name = keyName.trim() || 'Website key';
    try {
      setCreating(true);
      setError(null);
      const res = await TenantApiKeysService.create(name);
      setCreated(res);
      setKeyName('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to generate website key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      setRevoking(true);
      setError(null);
      await TenantApiKeysService.revoke(revokeTarget.apiKeyId);
      setRevokeTarget(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke key');
    } finally {
      setRevoking(false);
    }
  };

  const copy = (text: string) => {
    window.navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const activeKeys = keys.filter((k) => k.status === 'active');

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Generate an API key for your public website to send quote/contact form submissions to
        AllAboard365. Submissions are routed to the right agent automatically by the advisor name in
        the payload — a single key serves your whole site.
      </p>

      {error && (
        <div role="alert" className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <X size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* Freshly created key (shown once) */}
      {created && (
        <div className="p-4 rounded-lg bg-oe-light border border-oe-primary/30 space-y-2">
          <p className="text-sm font-medium text-gray-900">
            New key — copy it now, it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-gray-200 rounded px-2 py-1.5 break-all">
              {created.key}
            </code>
            <button
              type="button"
              onClick={() => copy(created.key)}
              className="flex items-center gap-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Create */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-700 mb-1">Key name</label>
          <input
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="e.g. MightyWELL Website"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
        >
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Generate website key
        </button>
      </div>

      {/* Existing keys */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 mb-2">Website keys</h3>
        {loading ? (
          <div className="flex items-center justify-center py-6 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : activeKeys.length === 0 ? (
          <p className="text-sm text-gray-500">No active keys.</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {activeKeys.map((k) => (
              <li key={k.apiKeyId} className="px-3 py-2 flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-gray-800">{k.keyName}</span>
                <code className="text-gray-600">sk_live_…{k.partialKey}</code>
                <span className="text-xs text-gray-400 flex-1 min-w-[8rem]">
                  {k.lastUsedDate
                    ? `Last used ${new Date(k.lastUsedDate).toLocaleDateString()}`
                    : 'Never used'}
                  {k.createdDate ? ` · Created ${new Date(k.createdDate).toLocaleDateString()}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setRevokeTarget(k)}
                  className="flex items-center gap-1 text-red-600 hover:bg-red-50 rounded px-2 py-1"
                >
                  <Trash2 className="w-4 h-4" /> Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Endpoint + sample payload */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-oe-primary mt-0.5 flex-shrink-0" />
          <div className="text-sm text-gray-700">
            <p>
              Your website POSTs each submission to:
            </p>
            <code className="mt-1 inline-block text-xs bg-white border border-gray-200 rounded px-2 py-1 break-all">
              POST {WEBSITE_SUBMISSIONS_URL}
            </code>
            <p className="mt-2 text-xs text-gray-500">
              Send the key as a Bearer token in the <code>Authorization</code> header.
            </p>
          </div>
        </div>
        <div>
          <h4 className="text-xs font-medium text-gray-600 mb-1">Sample payload</h4>
          <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
            {WEBSITE_SAMPLE_PAYLOAD}
          </pre>
        </div>
      </div>

      {/* Revoke confirmation (inline popup, no toast) */}
      {revokeTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50">
          <div
            className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-md w-full p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-website-key-title"
          >
            <h3 id="revoke-website-key-title" className="text-lg font-semibold text-gray-900">
              Revoke website key?
            </h3>
            <p className="text-sm text-gray-600 mt-2">
              Revoking <span className="font-medium text-gray-800">{revokeTarget.keyName}</span> will
              immediately stop your website from sending submissions with this key. This cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke()}
                disabled={revoking}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface SystemFee {
  name: string;
  amount: number;
  type: 'fixed' | 'percentage';
  description: string;
  enabled: boolean;
  MemberPaid?: boolean;
  FlatOrPercent?: 'Flat' | 'Percent';
  MemberPaidAmount?: number;
}

export interface AdvancedTenantSettings {
  branding: {
    logoFile?: File;
    logoUrl?: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    fontFamily: string;
    customCSS?: string;
    memberIDPrefix?: string;
    /** Optional; when empty, individual members use the same prefix as group/employee (MemberIDPrefix). */
    memberIDPrefixIndividual?: string;
    /** Optional; when empty, agents use the default 'AW' prefix. */
    agentIDPrefix?: string;
  };
  domain: {
    customDomain?: string;
    subdomain?: 'app' | 'portal' | 'enroll';
    verificationStatus: 'pending' | 'verified' | 'failed';
    sslEnabled: boolean;
    defaultUrlPath?: string; // Clear naming for default domain paths
  };
  email: {
    customFromAddress?: string;
    dkimEnabled: boolean;
    dkimDomain?: string;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dkimPrivateKey?: string;
    smtpEnabled: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    // New SendGrid DKIM fields
    sendgridDomainId?: string | null;
    dnsRecords?: DnsRecord[];
    verificationStatus?: 'none' | 'pending' | 'verified' | 'failed';
  };
  sms: {
    customFromPhone?: string;
  };
  notifications: {
    enrollmentEnabled: boolean;
    paymentEnabled: boolean;
    systemEnabled: boolean;
    marketingEnabled: boolean;
  };
  features: {
    showLandingPage: boolean;
    enableSelfService: boolean;
    requireEmailVerification: boolean;
    allowGuestCheckout: boolean;
    enableReferrals: boolean;
    /** When false, the Training item is hidden in the agent portal and training APIs return disabled. Default true when unset. */
    enableAgentPortalTraining: boolean;
    mobileApp: {
      enableAppDownloadStep: boolean;
      appStoreUrl: string;
      playStoreUrl: string;
      appImageUrl?: string;
      appImageFile?: File;
    };
  };
  apiKeys: {
    keys: ApiKey[];
    newKey?: {
      name: string;
      expiresAt?: string;
    };
  };
  systemFees: {
    platformFee: SystemFee;
    mobileAppFee: SystemFee;
    aiAssistantFee: SystemFee;
  };
  paymentProcessing: {
    activeProcessor: string; // 'openenroll', 'stripe', etc.
    chargeFeeToMember: boolean;
    /** When true, skip the charge at enrollment and let DIME recurring charge the first payment on the member's effective date. */
    chargeFirstPaymentWithRecurring: boolean;
    /** Comma-separated emails for daily failed-payment digest (stored in PaymentProcessorSettings JSON) */
    failedPaymentDailyReportEmails: string;
    processors: {
      openenroll: {
        enabled: boolean;
        dime: {
          apiToken: string; // Frontend receives decrypted, backend stores as apiTokenEncrypted
          sid: string; // Not encrypted
          webhookSecret: string; // Frontend receives decrypted, backend stores as webhookSecretEncrypted
          environment: 'demo' | 'production'; // Not encrypted
        };
        nmi: {                          // ← ADD THIS
            securityKey: string,
            collectJsKey: string,
            environment: 'sandbox' | 'production';
        },
        fees: {
          ach: {
            percentageFee: number; // e.g., 0.5 for 0.5%
            flatFee: number; // e.g., 0.30 for $0.30
          };
          creditCard: {
            percentageFee: number; // e.g., 3.0 for 3%
            flatFee: number; // e.g., 0.30 for $0.30
          };
        };
      };
      // Future processors can be added here
      // stripe?: { ... }
      // square?: { ... }
    };
  };
  commissions: {
    holdDays: number;
    holdDaysCountFrom: 'paymentDate' | 'nextDay';
  };
  payouts: {
    vendorBasis: 'effectiveEnrollment' | 'paymentReceived';
    overrideBasis: 'effectiveEnrollment' | 'paymentReceived';
  };
  enrollment: {
    /** When true, group-type-change requests are auto-approved without TenantAdmin review. */
    autoApproveGroupTypeChanges: boolean;
    /** Email addresses notified when a group falls below its vendor minimum. */
    belowMinimumAlertRecipients: string[];
    /** Number of days before the effective date by which agents are expected to have minimum enrollments. Empty/0 = by the effective date itself. Used for the acknowledgment shown on group create/edit; not enforced. */
    enrollmentDeadlineDaysBeforeEffectiveDate?: number;
  };
  billing?: {
    overdueReminders?: {
      enabled: boolean;
      thresholdDays: number;
      cadenceDays: number;
      maxCount: number;
      skipUnderAmount: number;
      channels: { email: boolean; sms: boolean };
      replyToEmail?: string | null;
    };
  };
  marketingLink: {
    /** Query-string parameter name appended to each link, e.g. "id" -> ?id=AGENTCODE. */
    idParam: string;
    /** List of full URLs (with label) shown to agents in the Marketing page. */
    links: Array<{ label: string; url: string }>;
    /** Base URLs agents choose from when creating website/landing prospect sources. */
    destinations: Array<{ type: 'website' | 'landing'; label: string; url: string }>;
  };
  websiteForm: {
    /** Email addresses to receive the daily website-form digest. */
    digestRecipients: string[];
  };
  /** When true, billing is handled externally; merchant/DIME settings are locked. SysAdmin only. */
  isExternalBilling?: boolean;
}

interface Tenant {
  TenantId: string;
  Name: string;
  LogoUrl?: string;
  PrimaryColorHex?: string;
  SecondaryColorHex?: string;
  CustomDomain?: string;
  DefaultUrlPath?: string; // Clear naming for default domain paths
  MemberIDPrefix?: string;
  IndividualMemberIDPrefix?: string | null;
  AgentIDPrefix?: string | null;
  AdvancedSettings?: string;
  SystemFees?: string;
  PaymentProcessorSettings?: string;
  MinimumSetupFee?: number | null;
  IsExternal?: boolean | number;
}

interface UnifiedTenantSettingsModalProps {
  tenant: Tenant;
  onClose: () => void;
  onSave: () => void;
  setError?: (error: string | null) => void;
  initialTab?: string;
}

type DomainVerificationStatus = 'verified' | 'pending' | 'failed' | string;

interface DomainVerificationResultState {
  success: boolean;
  status: DomainVerificationStatus;
  message: string;
  details?: Record<string, any>;
}

const UnifiedTenantSettingsModal: React.FC<UnifiedTenantSettingsModalProps> = ({
  tenant,
  onClose,
  onSave,
  setError,
  initialTab
}) => {
  // Helper function to parse and round percentage fee values to avoid floating point precision issues
  const parsePercentageFee = (value: string): number => {
    if (value === '' || value === '.') return 0;
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return 0;
    // Round to 6 decimal places to avoid floating point precision issues
    return Math.round(parsed * 1000000) / 1000000;
  };
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'branding' | 'mobileapp' | 'domain' | 'email' | 'systemfees' | 'overrideaccounts' | 'tenantpayoutaccount' | 'agentonboarding' | 'paymentprocessing' | 'setupfee' | 'payouts' | 'enrollment' | 'marketinglinks' | 'aiknowledge' | 'websiteintegration'>((initialTab as any) || 'branding');
  /** Local data URL preview for a newly selected mobile app image before save */
  const [mobileAppFilePreview, setMobileAppFilePreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  // Auto-dismiss the save-success toast after a short delay.
  useEffect(() => {
    if (!saveSuccess) return;
    const t = setTimeout(() => setSaveSuccess(null), 3500);
    return () => clearTimeout(t);
  }, [saveSuccess]);
  const [currentTenant, setCurrentTenant] = useState<Tenant>(tenant);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(tenant.LogoUrl || null);
  const [minimumSetupFee, setMinimumSetupFee] = useState<number | null>(tenant.MinimumSetupFee ?? null);
  const [domainVerifying, setDomainVerifying] = useState(false);
  const [domainVerificationResult, setDomainVerificationResult] = useState<DomainVerificationResultState | null>(null);
  const [domainConfiguring, setDomainConfiguring] = useState(false);
  const [domainConfigured, setDomainConfigured] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<{cname: {name: string, value: string}, txt?: {name: string, value: string}} | null>(null);
  const [dnsRecordsLoading, setDnsRecordsLoading] = useState(false);
  const [domainConfigProgress, setDomainConfigProgress] = useState('');
  const [selectedSubdomain, setSelectedSubdomain] = useState<'app' | 'portal' | 'enroll'>('app');

  // Check if running on localhost
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  // Determine user roles/permissions up front (needed by override account helpers below)
  const userRoles = Array.isArray(user?.roles) ? user?.roles : [];
  const isSysAdmin = user?.currentRole === 'SysAdmin' || userRoles.includes('SysAdmin');
  const isTenantAdmin = user?.currentRole === 'TenantAdmin' || userRoles.includes('TenantAdmin');
  const canEditSystemFees = isSysAdmin;
  const canManageMemberPaid = isSysAdmin || isTenantAdmin;
  const showEditableSystemFees = canEditSystemFees || isTenantAdmin;

  const [copyFromTenantModalOpen, setCopyFromTenantModalOpen] = useState(false);
  const [copySourceTenantId, setCopySourceTenantId] = useState('');
  const [copyTenantDropdownOptions, setCopyTenantDropdownOptions] = useState<
    { id: string; value: string; label: string }[]
  >([]);
  const [copyTenantsLoading, setCopyTenantsLoading] = useState(false);
  const [copyApplying, setCopyApplying] = useState(false);

  // Override Accounts state
  const [overrideAccounts, setOverrideAccounts] = useState<OverrideACHAccount[]>([]);
  const [overrideAccountsLoading, setOverrideAccountsLoading] = useState(false);
  const [overrideAccountsLoaded, setOverrideAccountsLoaded] = useState(false);
  const [overrideAccountsError, setOverrideAccountsError] = useState<string | null>(null);
  const [overrideAccountNotice, setOverrideAccountNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [overrideAccountSubmitting, setOverrideAccountSubmitting] = useState(false);
  const [editingOverrideAccount, setEditingOverrideAccount] = useState<OverrideACHAccount | null>(null);
  const [overrideAccountModalMode, setOverrideAccountModalMode] = useState<'create' | 'edit' | null>(null);
  const [currentMaskedRouting, setCurrentMaskedRouting] = useState<string | null>(null);
  const [currentMaskedAccount, setCurrentMaskedAccount] = useState<string | null>(null);
  const [overrideAccountForm, setOverrideAccountForm] = useState({
    name: '',
    accountHolderName: '',
    bankName: '',
    accountNumber: '',
    routingNumber: '',
    bankAccountType: 'Checking' as 'Checking' | 'Savings'
  });
  const isOverrideAccountModalOpen = overrideAccountModalMode !== null;

  // Tenant Payout ACH Account state
  const [tenantPayoutAccounts, setTenantPayoutAccounts] = useState<TenantPayoutACHAccount[]>([]);
  const [tenantPayoutAccountsLoading, setTenantPayoutAccountsLoading] = useState(false);
  const [tenantPayoutAccountsLoaded, setTenantPayoutAccountsLoaded] = useState(false);
  const [tenantPayoutAccountsError, setTenantPayoutAccountsError] = useState<string | null>(null);
  const [tenantPayoutAccountNotice, setTenantPayoutAccountNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [tenantPayoutAccountSubmitting, setTenantPayoutAccountSubmitting] = useState(false);
  const [tenantPayoutAccountEditLoading, setTenantPayoutAccountEditLoading] = useState(false);
  const [editingTenantPayoutAccount, setEditingTenantPayoutAccount] = useState<TenantPayoutACHAccount | null>(null);
  const [tenantPayoutAccountModalMode, setTenantPayoutAccountModalMode] = useState<'create' | 'edit' | null>(null);
  const [currentMaskedTenantPayoutRouting, setCurrentMaskedTenantPayoutRouting] = useState<string | null>(null);
  const [currentMaskedTenantPayoutAccount, setCurrentMaskedTenantPayoutAccount] = useState<string | null>(null);
  const [tenantPayoutAccountForm, setTenantPayoutAccountForm] = useState({
    accountName: '',
    accountHolderName: '',
    bankName: '',
    companyIdentification: '',
    accountNumber: '',
    routingNumber: '',
    bankAccountType: 'Checking' as 'Checking' | 'Savings',
    isDefault: false
  });
  const isTenantPayoutAccountModalOpen = tenantPayoutAccountModalMode !== null;

  const resetTenantPayoutAccountForm = useCallback(() => {
    setTenantPayoutAccountForm({
      accountName: '',
      accountHolderName: '',
      bankName: '',
      companyIdentification: '',
      accountNumber: '',
      routingNumber: '',
      bankAccountType: 'Checking',
      isDefault: false
    });
    setEditingTenantPayoutAccount(null);
    setTenantPayoutAccountModalMode(null);
    setCurrentMaskedTenantPayoutRouting(null);
    setCurrentMaskedTenantPayoutAccount(null);
  }, []);

  const resetOverrideAccountForm = useCallback(() => {
    setOverrideAccountForm({
      name: '',
      accountHolderName: '',
      bankName: '',
      accountNumber: '',
      routingNumber: '',
      bankAccountType: 'Checking'
    });
    setEditingOverrideAccount(null);
    setOverrideAccountModalMode(null);
    setCurrentMaskedRouting(null);
    setCurrentMaskedAccount(null);
  }, []);

  const loadOverrideAccounts = useCallback(
    async (options?: { force?: boolean }) => {
      if (!options?.force && overrideAccountsLoaded) {
        return;
      }

      try {
        setOverrideAccountsLoading(true);
        setOverrideAccountsError(null);

        const response = await ProductOverridesService.getOverrideACHAccounts(
          isSysAdmin ? tenant.TenantId : undefined
        );

        if (response.success && response.data) {
          setOverrideAccounts(response.data);
        } else {
          setOverrideAccountsError(response.message || 'Failed to load override accounts.');
        }
      } catch (error: any) {
        setOverrideAccountsError(
          error?.response?.data?.message || error?.message || 'Failed to load override accounts.'
        );
      } finally {
        setOverrideAccountsLoading(false);
        setOverrideAccountsLoaded(true);
      }
    },
    [overrideAccountsLoaded, tenant.TenantId, isSysAdmin]
  );

  const handleSubmitOverrideAccount = useCallback(async () => {
    const isEditing = overrideAccountModalMode === 'edit' && Boolean(editingOverrideAccount);
    const trimmedName = overrideAccountForm.name.trim();
    const trimmedHolder = overrideAccountForm.accountHolderName.trim();
    const trimmedBank = overrideAccountForm.bankName.trim();
    const sanitizedRouting = overrideAccountForm.routingNumber.replace(/\D/g, '');
    const sanitizedAccount = overrideAccountForm.accountNumber.replace(/\D/g, '');

    if (!trimmedHolder || !trimmedBank) {
      setOverrideAccountsError('Account holder name and bank name are required.');
      return;
    }

    if (!trimmedName) {
      setOverrideAccountsError('Account name is required.');
      return;
    }

    if (!sanitizedRouting || sanitizedRouting.length !== 9) {
      setOverrideAccountsError('Routing number must contain 9 digits.');
      return;
    }

    if (!sanitizedAccount) {
      setOverrideAccountsError('Account number must contain digits.');
      return;
    }

    try {
      setOverrideAccountSubmitting(true);
      setOverrideAccountsError(null);
      setOverrideAccountNotice(null);

      let response: ApiResponse<OverrideACHAccount>;

      if (isEditing && editingOverrideAccount) {
        const updatePayload: {
          accountName?: string;
          accountHolderName?: string;
          bankName?: string;
          accountNumber?: string;
          routingNumber?: string;
          bankAccountType?: 'Checking' | 'Savings' | 'Business' | 'Individual';
        } = {};

        updatePayload.accountName = trimmedName;
        updatePayload.accountHolderName = trimmedHolder;
        updatePayload.bankName = trimmedBank;
        updatePayload.accountNumber = sanitizedAccount;
        updatePayload.routingNumber = sanitizedRouting;
        updatePayload.bankAccountType = overrideAccountForm.bankAccountType;

        response = await ProductOverridesService.updateACHAccount(
          editingOverrideAccount.OverrideACHId,
          updatePayload,
          isSysAdmin ? tenant.TenantId : undefined
        );
      } else {
        response = await ProductOverridesService.createACHAccount(
          {
            accountName: trimmedName,
            accountHolderName: trimmedHolder,
            bankName: trimmedBank,
            accountNumber: sanitizedAccount,
            routingNumber: sanitizedRouting,
            bankAccountType: overrideAccountForm.bankAccountType
          },
          isSysAdmin ? tenant.TenantId : undefined
        );
      }

      if (response.success && response.data) {
        setOverrideAccountNotice({
          type: 'success',
          message: isEditing ? 'Override account updated successfully.' : 'Override account created successfully.'
        });
        resetOverrideAccountForm();
        setOverrideAccountsLoaded(false);
        await loadOverrideAccounts({ force: true });
      } else {
        setOverrideAccountsError(
          response.message || `Failed to ${isEditing ? 'update' : 'create'} override account.`
        );
      }
    } catch (error: any) {
      setOverrideAccountsError(
        error?.response?.data?.message || error?.message || `Failed to ${isEditing ? 'update' : 'create'} override account.`
      );
    } finally {
      setOverrideAccountSubmitting(false);
    }
  }, [
    overrideAccountForm,
    tenant.TenantId,
    loadOverrideAccounts,
    editingOverrideAccount,
    isSysAdmin,
    overrideAccountModalMode,
    resetOverrideAccountForm
  ]);

  const loadTenantPayoutAccounts = useCallback(
    async (options?: { force?: boolean }) => {
      if (!options?.force && tenantPayoutAccountsLoaded) {
        return;
      }

      try {
        setTenantPayoutAccountsLoading(true);
        setTenantPayoutAccountsError(null);

        const response = await TenantPayoutACHService.getTenantPayoutACHAccounts(
          isSysAdmin ? tenant.TenantId : undefined
        );

        if (response.success && response.data) {
          setTenantPayoutAccounts(response.data);
        } else {
          setTenantPayoutAccountsError(response.message || 'Failed to load tenant payout accounts.');
        }
      } catch (error: any) {
        setTenantPayoutAccountsError(
          error?.response?.data?.message || error?.message || 'Failed to load tenant payout accounts.'
        );
      } finally {
        setTenantPayoutAccountsLoading(false);
        setTenantPayoutAccountsLoaded(true);
      }
    },
    [tenantPayoutAccountsLoaded, tenant.TenantId, isSysAdmin]
  );

  const handleSubmitTenantPayoutAccount = useCallback(async () => {
    const isEditing = tenantPayoutAccountModalMode === 'edit' && Boolean(editingTenantPayoutAccount);
    const trimmedHolder = tenantPayoutAccountForm.accountHolderName.trim();
    const trimmedBank = tenantPayoutAccountForm.bankName.trim();
    const sanitizedRouting = tenantPayoutAccountForm.routingNumber.replace(/\D/g, '');
    const sanitizedAccount = tenantPayoutAccountForm.accountNumber.replace(/\D/g, '');
    const sanitizedCompanyId = tenantPayoutAccountForm.companyIdentification.replace(/\D/g, '').slice(0, 10);

    if (!trimmedHolder || !trimmedBank) {
      setTenantPayoutAccountsError('Account holder name and bank name are required.');
      return;
    }

    if (tenantPayoutAccountForm.companyIdentification.trim().length > 0 && (sanitizedCompanyId.length !== 9 && sanitizedCompanyId.length !== 10)) {
      setTenantPayoutAccountsError('Company Identification must be 9 digits (EIN) or 10 digits if provided.');
      return;
    }

    const isUpdatingBankNumbers = sanitizedRouting.length > 0 || sanitizedAccount.length > 0;

    if (!isEditing) {
      // Create requires full bank details
      if (sanitizedRouting.length !== 9) {
        setTenantPayoutAccountsError('Routing number must contain 9 digits.');
        return;
      }
      if (!sanitizedAccount) {
        setTenantPayoutAccountsError('Account number must contain digits.');
        return;
      }
    } else if (isUpdatingBankNumbers) {
      // Edit: allow leaving blank to keep existing; but if user enters either, require both and validate
      if (sanitizedRouting.length !== 9) {
        setTenantPayoutAccountsError('Routing number must contain 9 digits when updating bank details.');
        return;
      }
      if (!sanitizedAccount) {
        setTenantPayoutAccountsError('Account number is required when updating bank details.');
        return;
      }
    }

    try {
      setTenantPayoutAccountSubmitting(true);
      setTenantPayoutAccountsError(null);
      setTenantPayoutAccountNotice(null);

      let response: ApiResponse<TenantPayoutACHAccount>;

      if (isEditing && editingTenantPayoutAccount) {
        const updatePayload: {
          accountName?: string;
          accountHolderName?: string;
          bankName?: string;
          companyIdentification?: string;
          accountNumber?: string;
          routingNumber?: string;
          bankAccountType?: 'Checking' | 'Savings';
          isDefault?: boolean;
          isActive?: boolean;
        } = {};

        updatePayload.accountName = tenantPayoutAccountForm.accountName || trimmedHolder;
        updatePayload.accountHolderName = trimmedHolder;
        updatePayload.bankName = trimmedBank;
        // Include companyIdentification on edit so it can be updated or cleared
        updatePayload.companyIdentification = (sanitizedCompanyId.length === 9 || sanitizedCompanyId.length === 10) ? sanitizedCompanyId : '';
        if (sanitizedAccount) {
          updatePayload.accountNumber = sanitizedAccount;
        }
        if (sanitizedRouting) {
          updatePayload.routingNumber = sanitizedRouting;
        }
        updatePayload.bankAccountType = tenantPayoutAccountForm.bankAccountType;
        updatePayload.isDefault = tenantPayoutAccountForm.isDefault;

        response = await TenantPayoutACHService.updateACHAccount(
          editingTenantPayoutAccount.TenantPayoutACHId,
          updatePayload,
          isSysAdmin ? tenant.TenantId : undefined
        );
      } else {
        response = await TenantPayoutACHService.createACHAccount(
          {
            accountName: tenantPayoutAccountForm.accountName || trimmedHolder,
            accountHolderName: trimmedHolder,
            bankName: trimmedBank,
            ...((sanitizedCompanyId.length === 9 || sanitizedCompanyId.length === 10) ? { companyIdentification: sanitizedCompanyId } : {}),
            accountNumber: sanitizedAccount,
            routingNumber: sanitizedRouting,
            bankAccountType: tenantPayoutAccountForm.bankAccountType,
            isDefault: tenantPayoutAccountForm.isDefault
          },
          isSysAdmin ? tenant.TenantId : undefined
        );
      }

      if (response.success && response.data) {
        setTenantPayoutAccountNotice({
          type: 'success',
          message: isEditing ? 'Tenant payout account updated successfully.' : 'Tenant payout account created successfully.'
        });
        resetTenantPayoutAccountForm();
        setTenantPayoutAccountsLoaded(false);
        await loadTenantPayoutAccounts({ force: true });
      } else {
        setTenantPayoutAccountsError(
          response.message || `Failed to ${isEditing ? 'update' : 'create'} tenant payout account.`
        );
      }
    } catch (error: any) {
      const data = error?.response?.data;
      const errMsg =
        data?.message ||
        (Array.isArray(data?.errors) ? data.errors.map((e: { message?: string }) => e?.message).filter(Boolean).join('; ') : null) ||
        error?.message ||
        `Failed to ${isEditing ? 'update' : 'create'} tenant payout account.`;
      console.error('[TenantPayoutAccount] Save error:', { status: error?.response?.status, data, message: errMsg });
      setTenantPayoutAccountsError(errMsg);
    } finally {
      setTenantPayoutAccountSubmitting(false);
    }
  }, [
    tenantPayoutAccountForm,
    tenant.TenantId,
    loadTenantPayoutAccounts,
    editingTenantPayoutAccount,
    isSysAdmin,
    tenantPayoutAccountModalMode,
    resetTenantPayoutAccountForm
  ]);

  const bankAccountTypeLabel = (value?: string) => {
    if (!value) return 'Checking';
    switch (value.toLowerCase()) {
      case 'checking':
      case 'business':
        return 'Checking';
      case 'savings':
      case 'individual':
        return 'Savings';
      default:
        return value;
    }
  };

  const formatLifecycleStatus = (value?: string) => {
    if (!value) return '';
    const normalized = value.toLowerCase();
    if (['notstarted', 'not started', 'inprogress', 'in progress', 'pending', 'processing'].includes(normalized)) {
      return 'Processing';
    }
    return value;
  };

  const formatEndpointAssociation = (value?: string) => {
    if (!value) return '';
    return value === 'Unassociated' ? 'Associated' : value;
  };

  const statusColorClass = (value?: string) => {
    if (!value) return 'text-oe-primary';
    switch (value) {
      case 'Succeeded':
      case 'Associated':
        return 'text-green-600';
      case 'Failed':
      case 'Error':
        return 'text-red-600';
      case 'Processing':
        return 'text-amber-600';
      default:
        return 'text-oe-primary';
    }
  };
  
  // Domain input state (separate from currentTenant.CustomDomain until configured)
  const [domainInputValue, setDomainInputValue] = useState('');
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  
  // Agent Onboarding state
  const [agentDocuments, setAgentDocuments] = useState<AgentAgreementDocument[]>([]);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [deletingDocument, setDeletingDocument] = useState<string | null>(null);
  
  // Payment Processing state
  const [showApiToken, setShowApiToken] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  // Local state for percentage fee inputs to allow typing partial decimals
  const [achPercentageInput, setAchPercentageInput] = useState<string>('');
  const [creditCardPercentageInput, setCreditCardPercentageInput] = useState<string>('');
  // Track which payment processing fields are being edited
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [editingFees, setEditingFees] = useState(false);
  
  // Fetch fresh tenant data when modal opens
  const fetchTenantData = async () => {
    // Don't fetch if component is unmounted
    if (!isMountedRef.current) {
      console.log('⚠️ Component unmounted, skipping fetchTenantData');
      return;
    }
    
    try {
      if (!isMountedRef.current) return;
      setInitialLoading(true);
      console.log('🔄 Fetching fresh tenant data for:', tenant.TenantId);
      
      // Use the appropriate service based on user role
      let response: any;
      if (user?.currentRole === 'SysAdmin') {
        // For SysAdmin, fetch from tenants endpoint (which returns authenticated URLs and decrypted credentials)
        try {
          console.log('🔄 About to call apiService.get for SysAdmin tenant');
          console.log('🔄 Calling: /api/tenants/' + tenant.TenantId);
          
          // Use AbortController to cancel request if component unmounts
          if (!abortControllerRef.current) {
            abortControllerRef.current = new AbortController();
          }
          
          const apiResponse = await apiService.get(`/api/tenants/${tenant.TenantId}`, {
            signal: abortControllerRef.current.signal
          });
          console.log('✅✅✅ apiService.get AWAIT COMPLETED - Response received!');
          console.log('✅ apiService.get completed, raw response type:', typeof apiResponse);
          console.log('✅ apiService.get completed, raw response keys:', apiResponse && typeof apiResponse === 'object' ? Object.keys(apiResponse) : 'NOT_OBJECT');
          console.log('✅ apiService.get completed, raw response:', apiResponse);
          
          // apiService.get returns response.data from axios, so if backend returns { success: true, data: tenant },
          // then apiResponse = { success: true, data: tenant }
          response = apiResponse as any;
          
          console.log('✅ apiService.get completed, response received:', {
            responseType: typeof response,
            isObject: typeof response === 'object',
            responseKeys: response && typeof response === 'object' ? Object.keys(response) : 'NOT_OBJECT',
            hasSuccess: 'success' in (response || {}),
            successValue: response?.success,
            hasData: 'data' in (response || {}),
            dataType: typeof response?.data,
            dataKeys: response?.data && typeof response?.data === 'object' ? Object.keys(response.data) : [],
            fullResponse: response
          });
          
          // CRITICAL: Check if response has the expected structure
          if (!response) {
            console.error('❌ Response is null or undefined!');
            return;
          }
          
          if (typeof response !== 'object') {
            console.error('❌ Response is not an object!', typeof response, response);
            return;
          }
          
          // apiService.get returns response.data from axios, so if backend returns { success: true, data: tenant },
          // then response = { success: true, data: tenant }
          console.log('🔍 Checking response structure for PaymentProcessorSettings:', {
            responseSuccess: response?.success,
            responseDataExists: !!response?.data,
            responseDataIsObject: typeof response?.data === 'object',
            paymentProcessorSettingsInData: !!response?.data?.PaymentProcessorSettings,
            paymentProcessorSettingsType: typeof response?.data?.PaymentProcessorSettings,
            paymentProcessorSettingsValue: response?.data?.PaymentProcessorSettings ? 
              (typeof response?.data?.PaymentProcessorSettings === 'string' ? 
                response.data.PaymentProcessorSettings.substring(0, 100) : 
                'OBJECT') : 
              'MISSING'
          });
          
          if (response && response.success) {
          const tenantData = response.data; // Backend returns { success: true, data: tenant }
          console.log('🔍 Extracted tenantData from response:', {
            tenantDataExists: !!tenantData,
            tenantDataType: typeof tenantData,
            tenantDataKeys: tenantData && typeof tenantData === 'object' ? Object.keys(tenantData) : [],
            hasPaymentProcessorSettings: !!tenantData?.PaymentProcessorSettings,
            paymentProcessorSettingsType: typeof tenantData?.PaymentProcessorSettings
          });
          if (tenantData) {
            console.log('✅ Fresh tenant data fetched with authenticated URLs:', tenantData);
            console.log('🔍 All tenantData keys:', Object.keys(tenantData));
            console.log('🔍 PaymentProcessorSettings raw value:', tenantData.PaymentProcessorSettings);
            console.log('🔍 PaymentProcessorSettings type:', typeof tenantData.PaymentProcessorSettings);
            
            // Ensure PaymentProcessorSettings and SystemFees are strings (backend returns them as JSON strings after decryption)
            if (tenantData.PaymentProcessorSettings && typeof tenantData.PaymentProcessorSettings !== 'string') {
              console.log('🔄 Converting PaymentProcessorSettings from object to string');
              tenantData.PaymentProcessorSettings = JSON.stringify(tenantData.PaymentProcessorSettings);
            }
            if (tenantData.SystemFees && typeof tenantData.SystemFees !== 'string') {
              tenantData.SystemFees = JSON.stringify(tenantData.SystemFees);
            }
            
            console.log('🔍 DEBUG: PaymentProcessorSettings from SysAdmin endpoint (type):', typeof tenantData.PaymentProcessorSettings);
            console.log('🔍 DEBUG: PaymentProcessorSettings from SysAdmin endpoint (preview):', tenantData.PaymentProcessorSettings ? (typeof tenantData.PaymentProcessorSettings === 'string' ? tenantData.PaymentProcessorSettings.substring(0, 200) : 'OBJECT') : 'MISSING');
            console.log('🔍 DEBUG: SystemFees from SysAdmin endpoint (type):', typeof tenantData.SystemFees);
            console.log('🔍 DEBUG: SystemFees from SysAdmin endpoint (preview):', tenantData.SystemFees ? (typeof tenantData.SystemFees === 'string' ? tenantData.SystemFees.substring(0, 200) : 'OBJECT') : 'MISSING');
            
            console.log('✅ Setting currentTenant with PaymentProcessorSettings:', {
              hasPaymentProcessorSettings: !!tenantData.PaymentProcessorSettings,
              paymentProcessorSettingsLength: tenantData.PaymentProcessorSettings?.length || 0,
              paymentProcessorSettingsValue: tenantData.PaymentProcessorSettings ? tenantData.PaymentProcessorSettings.substring(0, 100) : 'NULL',
              hasSystemFees: !!tenantData.SystemFees,
              systemFeesLength: tenantData.SystemFees?.length || 0
            });
            // Check if component is still mounted before updating state
            if (!isMountedRef.current) {
              console.log('⚠️ Component unmounted, skipping state updates');
              return;
            }
            
            // Create a new object reference to ensure React detects the change
            const updatedTenant = { ...tenantData };
            console.log('🔄 Setting currentTenant with updated tenant object');
            setCurrentTenant(updatedTenant);
            setMinimumSetupFee(tenantData.MinimumSetupFee ?? null);
            // Update logo preview with authenticated URL
            if (tenantData.LogoUrl) {
              setLogoPreview(tenantData.LogoUrl);
            }
            
            // DIRECTLY update settings with payment processing data immediately after setting currentTenant
            // This ensures the UI updates even if the useEffect doesn't trigger
            if (tenantData.PaymentProcessorSettings && isMountedRef.current) {
              console.log('🔄 Directly updating settings with payment processing data');
              const paymentProcessorSettings = parsePaymentProcessorSettings(updatedTenant, true);
              if (paymentProcessorSettings && isMountedRef.current) {
                console.log('✅ Parsed payment processor settings, updating UI immediately');
                setSettings(prev => ({
                  ...prev,
                  paymentProcessing: {
                    activeProcessor: paymentProcessorSettings?.activeProcessor || prev.paymentProcessing.activeProcessor,
                    chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember ?? prev.paymentProcessing.chargeFeeToMember,
                    chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring ?? prev.paymentProcessing.chargeFirstPaymentWithRecurring,
                    failedPaymentDailyReportEmails: paymentProcessorSettings?.failedPaymentDailyReportEmails ?? prev.paymentProcessing.failedPaymentDailyReportEmails,
                    processors: {
                      openenroll: {
                        enabled: paymentProcessorSettings?.processors?.openenroll?.enabled ?? prev.paymentProcessing.processors.openenroll.enabled,
                        dime: {
                          apiToken: paymentProcessorSettings?.processors?.openenroll?.dime?.apiToken || prev.paymentProcessing.processors.openenroll.dime.apiToken,
                          sid: paymentProcessorSettings?.processors?.openenroll?.dime?.sid || prev.paymentProcessing.processors.openenroll.dime.sid,
                          webhookSecret: paymentProcessorSettings?.processors?.openenroll?.dime?.webhookSecret || prev.paymentProcessing.processors.openenroll.dime.webhookSecret,
                          environment: paymentProcessorSettings?.processors?.openenroll?.dime?.environment || prev.paymentProcessing.processors.openenroll.dime.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production')
                        },
                        nmi: {
                          securityKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.securityKey || prev.paymentProcessing.processors.openenroll.nmi?.securityKey || '',
                          collectJsKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.collectJsKey || prev.paymentProcessing.processors.openenroll.nmi?.collectJsKey || '',
                          environment: paymentProcessorSettings?.processors?.openenroll?.nmi?.environment || prev.paymentProcessing.processors.openenroll.nmi?.environment || 'sandbox'
                        },

                        fees: {
                          ach: {
                            percentageFee: (() => {
                              const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.percentageFee;
                              if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.ach.percentageFee;
                              return storedValue >= 1 ? storedValue : storedValue * 100;
                            })(),
                            flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.ach.flatFee
                          },
                          creditCard: {
                            percentageFee: (() => {
                              const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.percentageFee;
                              if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee;
                              return storedValue >= 1 ? storedValue : storedValue * 100;
                            })(),
                            flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.creditCard.flatFee
                          }
                        }
                      }
                    }
                  }
                }));
                console.log('✅ Settings updated directly with payment processing data');
              } else {
                console.warn('⚠️ Failed to parse payment processor settings for direct update');
              }
            }
          } else {
            console.error('❌ SysAdmin tenant data is missing:', tenantData);
          }
        } else {
          console.error('❌ SysAdmin tenant fetch failed:', response);
        }
        } catch (fetchError: any) {
          // Check if this is a canceled request (expected behavior with AbortController)
          const isCanceled = fetchError?.code === 'ERR_CANCELED' || 
                            fetchError?.isCanceled ||
                            fetchError?.message?.toLowerCase().includes('canceled');
          
          if (isCanceled) {
            // Silently ignore canceled requests - this is expected when React StrictMode
            // causes multiple renders or when component unmounts
            console.log('🔄 Request was canceled (expected behavior)');
            return; // Exit early, don't treat as error
          }
          
          console.error('❌ Error fetching SysAdmin tenant data:', fetchError);
          console.error('❌ Error details:', {
            message: fetchError?.message,
            response: fetchError?.response,
            responseData: fetchError?.response?.data,
            status: fetchError?.response?.status,
            stack: fetchError?.stack
          });
          
          // Even if fetch fails, ensure we can still use the modal with existing tenant data
          // The payment processing tab should work with empty/default values
          console.warn('⚠️ Using existing tenant data due to fetch error. Payment processing may need to be configured.');
          
          if (setError) {
            // Don't show a blocking error - just log it
            // The modal should still be usable with default/empty values
            console.warn('Failed to refresh tenant data, using existing data');
          }
        } finally {
          // Only update loading state if component is still mounted
          if (isMountedRef.current) {
            setInitialLoading(false);
          }
          console.log('🔍 SysAdmin fetchTenantData finally block - function completed');
        }
      } else {
        // For TenantAdmin, fetch from tenant-admin settings endpoint
        const response: any = await apiService.get('/api/tenant-admin/settings');
        
        console.log('🔍 TenantAdmin settings response (full):', response);
        console.log('🔍 TenantAdmin settings response structure:', {
          success: response?.success,
          hasData: !!response?.data,
          dataType: typeof response?.data,
          dataKeys: response?.data && typeof response?.data === 'object' ? Object.keys(response.data) : [],
          hasPaymentProcessorSettings: !!response?.data?.paymentProcessorSettings,
          paymentProcessorSettingsType: typeof response?.data?.paymentProcessorSettings,
          hasSystemFees: !!response?.data?.systemFees,
          systemFeesType: typeof response?.data?.systemFees
        });
        
        // Handle both response formats: { success: true, data: {...} } or direct data object
        const settingsData = response?.data || response;
        
        if (response?.success !== false && settingsData) {
          console.log('✅ Fresh tenant settings fetched:', settingsData);
          console.log('🔍 DEBUG: PaymentProcessorSettings type:', typeof settingsData.paymentProcessorSettings);
          console.log('🔍 DEBUG: PaymentProcessorSettings:', settingsData.paymentProcessorSettings ? JSON.stringify(settingsData.paymentProcessorSettings, null, 2) : 'MISSING');
          console.log('🔍 DEBUG: SystemFees type:', typeof settingsData.systemFees);
          console.log('🔍 DEBUG: SystemFees:', settingsData.systemFees ? JSON.stringify(settingsData.systemFees, null, 2) : 'MISSING');
          
            // Transform the settings data to match our Tenant interface
          // PaymentProcessorSettings and SystemFees come as objects from backend, but we need to stringify them for the Tenant interface
            const tenantData = {
              TenantId: tenant.TenantId,
            Name: settingsData.name || tenant.Name,
            LogoUrl: settingsData.branding?.logoUrl || tenant.LogoUrl,
            PrimaryColorHex: settingsData.branding?.primaryColorHex || tenant.PrimaryColorHex,
            SecondaryColorHex: settingsData.branding?.secondaryColorHex || tenant.SecondaryColorHex,
            CustomDomain: settingsData.CustomDomain || settingsData.branding?.customDomain || settingsData.domainSettings?.customUrl || tenant.CustomDomain,
            DefaultUrlPath: settingsData.DefaultUrlPath || settingsData.defaultUrlPath || settingsData.domainSettings?.defaultUrlPath || tenant.DefaultUrlPath,
            MemberIDPrefix: settingsData.branding?.memberIDPrefix || tenant.MemberIDPrefix || 'OED', // Add MemberIDPrefix
            IndividualMemberIDPrefix:
              settingsData.branding?.memberIDPrefixIndividual ?? tenant.IndividualMemberIDPrefix ?? '',
            AgentIDPrefix:
              settingsData.branding?.agentIDPrefix ?? tenant.AgentIDPrefix ?? '',
            AdvancedSettings: typeof settingsData.advancedSettings === 'object' ? JSON.stringify(settingsData.advancedSettings) : (settingsData.advancedSettings || tenant.AdvancedSettings),
            SystemFees: typeof settingsData.systemFees === 'object' && settingsData.systemFees !== null ? JSON.stringify(settingsData.systemFees) : (typeof settingsData.systemFees === 'string' ? settingsData.systemFees : (tenant.SystemFees || null)),
            PaymentProcessorSettings: typeof settingsData.paymentProcessorSettings === 'object' && settingsData.paymentProcessorSettings !== null ? JSON.stringify(settingsData.paymentProcessorSettings) : (typeof settingsData.paymentProcessorSettings === 'string' ? settingsData.paymentProcessorSettings : (tenant.PaymentProcessorSettings || null)),
            MinimumSetupFee: settingsData.MinimumSetupFee ?? tenant.MinimumSetupFee ?? null,
            IsExternal: settingsData.isExternalBilling ? 1 : 0
          };
          console.log('🔍 DEBUG: Created tenantData');
          console.log('🔍 DEBUG: PaymentProcessorSettings in tenantData:', tenantData.PaymentProcessorSettings ? (typeof tenantData.PaymentProcessorSettings === 'string' ? tenantData.PaymentProcessorSettings.substring(0, 200) : 'OBJECT') : 'NULL');
          console.log('🔍 DEBUG: SystemFees in tenantData:', tenantData.SystemFees ? (typeof tenantData.SystemFees === 'string' ? tenantData.SystemFees.substring(0, 200) : 'OBJECT') : 'NULL');
            // Create a new object reference to ensure React detects the change
            // Check if component is still mounted before updating state
            if (!isMountedRef.current) {
              console.log('⚠️ Component unmounted, skipping state updates (TenantAdmin)');
              return;
            }
            
            const updatedTenant = { ...tenantData };
            setCurrentTenant(updatedTenant);
            setMinimumSetupFee(tenantData.MinimumSetupFee ?? null);
            
            // Update logo preview with authenticated URL
          if (settingsData.branding?.logoUrl) {
            setLogoPreview(settingsData.branding.logoUrl);
            }
            
            // DIRECTLY update settings with payment processing data immediately after setting currentTenant
            // This ensures the UI updates even if the useEffect doesn't trigger
            if (tenantData.PaymentProcessorSettings && isMountedRef.current) {
              console.log('🔄 Directly updating settings with payment processing data (TenantAdmin)');
              const paymentProcessorSettings = parsePaymentProcessorSettings(updatedTenant, true);
              if (paymentProcessorSettings && isMountedRef.current) {
                console.log('✅ Parsed payment processor settings, updating UI immediately (TenantAdmin)');
                setSettings(prev => ({
                  ...prev,
                  paymentProcessing: {
                    activeProcessor: paymentProcessorSettings?.activeProcessor || prev.paymentProcessing.activeProcessor,
                    chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember ?? prev.paymentProcessing.chargeFeeToMember,
                    chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring ?? prev.paymentProcessing.chargeFirstPaymentWithRecurring,
                    failedPaymentDailyReportEmails: paymentProcessorSettings?.failedPaymentDailyReportEmails ?? prev.paymentProcessing.failedPaymentDailyReportEmails,
                    processors: {
                      openenroll: {
                        enabled: paymentProcessorSettings?.processors?.openenroll?.enabled ?? prev.paymentProcessing.processors.openenroll.enabled,
                        dime: {
                          apiToken: paymentProcessorSettings?.processors?.openenroll?.dime?.apiToken || prev.paymentProcessing.processors.openenroll.dime.apiToken,
                          sid: paymentProcessorSettings?.processors?.openenroll?.dime?.sid || prev.paymentProcessing.processors.openenroll.dime.sid,
                          webhookSecret: paymentProcessorSettings?.processors?.openenroll?.dime?.webhookSecret || prev.paymentProcessing.processors.openenroll.dime.webhookSecret,
                          environment: paymentProcessorSettings?.processors?.openenroll?.dime?.environment || prev.paymentProcessing.processors.openenroll.dime.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production')
                        },
                        nmi: {
                          securityKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.securityKey || prev.paymentProcessing.processors.openenroll.nmi?.securityKey || '',
                          collectJsKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.collectJsKey || prev.paymentProcessing.processors.openenroll.nmi?.collectJsKey || '',
                          environment: paymentProcessorSettings?.processors?.openenroll?.nmi?.environment || prev.paymentProcessing.processors.openenroll.nmi?.environment || 'sandbox'
                        },
                        fees: {
                          ach: {
                            percentageFee: (() => {
                              const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.percentageFee;
                              if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.ach.percentageFee;
                              return storedValue >= 1 ? storedValue : storedValue * 100;
                            })(),
                            flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.ach.flatFee
                          },
                          creditCard: {
                            percentageFee: (() => {
                              const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.percentageFee;
                              if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee;
                              return storedValue >= 1 ? storedValue : storedValue * 100;
                            })(),
                            flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.creditCard.flatFee
                          }
                        }
                      }
                    }
                  }
                }));
                console.log('✅ Settings updated directly with payment processing data (TenantAdmin)');
              } else {
                console.warn('⚠️ Failed to parse payment processor settings for direct update (TenantAdmin)');
              }
            }
        } else {
          console.error('❌ TenantAdmin settings response missing data:', response);
        }
      }
    } catch (error) {
      console.error('❌ Error fetching tenant data:', error);
      // Don't block the UI - allow modal to work with existing/default data
      console.warn('⚠️ Using existing tenant data due to fetch error. Settings may need to be configured.');
      if (setError) {
        // Log warning but don't show blocking error
        console.warn('Failed to refresh tenant data, using existing data');
      }
    } finally {
      // Only set loading to false if component is still mounted
      if (isMountedRef.current) {
        setInitialLoading(false);
      }
    }
  };
  
  // Helper function to extract subdomain from full domain
  const extractSubdomainFromDomain = (domain: string): 'app' | 'portal' | 'enroll' | null => {
    if (!domain) return null;
    const parts = domain.split('.');
    if (parts.length >= 2) {
      const subdomain = parts[0];
      if (subdomain === 'app' || subdomain === 'portal' || subdomain === 'enroll') {
        return subdomain;
      }
    }
    return null;
  };

  // Helper function to extract base domain from full domain
  const extractBaseDomain = (fullDomain: string): string => {
    if (!fullDomain) return '';
    const parts = fullDomain.split('.');
    if (parts.length >= 2) {
      // Remove the first part (subdomain) and join the rest
      return parts.slice(1).join('.');
    }
    return fullDomain;
  };

  // Helper function to parse AdvancedSettings JSON
  const parseAdvancedSettings = (tenant: Tenant) => {
    let parsedSettings = null;
    
    if (tenant.AdvancedSettings) {
      try {
        // Check if it's already an object or a string
        if (typeof tenant.AdvancedSettings === 'string') {
          parsedSettings = JSON.parse(tenant.AdvancedSettings);
        } else if (typeof tenant.AdvancedSettings === 'object') {
          parsedSettings = tenant.AdvancedSettings;
        }
      } catch (error) {
        console.error('Error parsing AdvancedSettings JSON:', error);
      }
    }
    
    return parsedSettings;
  };

  // Helper function to parse SystemFees JSON
  const parseSystemFees = (tenant: Tenant) => {
    let parsedFees = null;
    
    if (tenant.SystemFees) {
      try {
        if (typeof tenant.SystemFees === 'string') {
          parsedFees = JSON.parse(tenant.SystemFees);
          console.log('✅ Parsed SystemFees from string:', parsedFees);
        } else if (typeof tenant.SystemFees === 'object') {
          parsedFees = tenant.SystemFees;
          console.log('✅ Using SystemFees as object:', parsedFees);
        }
        
        // Log the fees structure
        if (parsedFees) {
          console.log('🔍 System Fees Found:');
          console.log('  - Platform Fee:', parsedFees.platformFee?.amount, parsedFees.platformFee?.enabled ? 'ENABLED' : 'DISABLED');
          console.log('  - Mobile App Fee:', parsedFees.mobileAppFee?.amount, parsedFees.mobileAppFee?.enabled ? 'ENABLED' : 'DISABLED');
          console.log('  - AI Assistant Fee:', parsedFees.aiAssistantFee?.amount, parsedFees.aiAssistantFee?.enabled ? 'ENABLED' : 'DISABLED');
        }
      } catch (error) {
        console.error('❌ Error parsing SystemFees JSON:', error);
        console.error('Raw SystemFees:', tenant.SystemFees);
      }
    } else {
      console.warn('⚠️ No SystemFees found for tenant:', tenant.Name);
    }
    
    return parsedFees;
  };

  // Helper function to parse PaymentProcessorSettings JSON
  const parsePaymentProcessorSettings = (tenant: Tenant, hasFetchedData: boolean = false) => {
    let parsedSettings = null;
    
    if (tenant.PaymentProcessorSettings) {
      try {
        // Check if it's already an object or a string
        if (typeof tenant.PaymentProcessorSettings === 'string') {
          parsedSettings = JSON.parse(tenant.PaymentProcessorSettings);
          console.log('✅ Parsed PaymentProcessorSettings from string:', parsedSettings);
        } else if (typeof tenant.PaymentProcessorSettings === 'object') {
          parsedSettings = tenant.PaymentProcessorSettings;
          console.log('✅ Using PaymentProcessorSettings as object:', parsedSettings);
        }
        
        // Log the DIME credentials (masked for security)
        if (parsedSettings?.processors?.openenroll?.dime) {
          const dime = parsedSettings.processors.openenroll.dime;
          console.log('🔍 Payment Processing Settings Found:');
          console.log('  - SID:', dime.sid ? '***' + dime.sid.slice(-2) : 'NOT SET');
          console.log('  - API Token:', dime.apiToken ? 'SET (' + dime.apiToken.length + ' chars)' : 'NOT SET');
          console.log('  - Webhook Secret:', dime.webhookSecret ? 'SET (' + dime.webhookSecret.length + ' chars)' : 'NOT SET');
          console.log('  - Environment:', dime.environment || 'NOT SET');
          console.log('  - ACH Fees:', parsedSettings.processors?.openenroll?.fees?.ach);
          console.log('  - Credit Card Fees:', parsedSettings.processors?.openenroll?.fees?.creditCard);
        } else {
          // Only warn if data has been fetched - otherwise it might just be loading
          if (hasFetchedData) {
            console.warn('⚠️ PaymentProcessorSettings exists but DIME config is missing');
          }
        }
      } catch (error) {
        console.error('❌ Error parsing PaymentProcessorSettings JSON:', error);
        console.error('Raw PaymentProcessorSettings:', tenant.PaymentProcessorSettings);
      }
    } else {
      // Only warn if data has been fetched and confirmed missing - not during initial render
      if (hasFetchedData) {
        console.warn('⚠️ No PaymentProcessorSettings found for tenant:', tenant.Name);
      }
    }
    
    return parsedSettings;
  };

  // Store initial settings to detect changes (set once when modal opens)
  const [initialSettings, setInitialSettings] = useState<AdvancedTenantSettings | null>(null);
  const [initialDomain, setInitialDomain] = useState<string>('');
  const [initialUrlPath, setInitialUrlPath] = useState<string>('');
  const [initialSetupFee, setInitialSetupFee] = useState<number | null>(null);
  const [initialSettingsSet, setInitialSettingsSet] = useState(false);

  const buildSettingsStateFromTenant = (
    tenantRow: Tenant,
    hasFetchedPaymentData = true
  ): AdvancedTenantSettings => {
    const advancedSettings = parseAdvancedSettings(tenantRow);
    const systemFees = parseSystemFees(tenantRow);
    const paymentProcessorSettings = parsePaymentProcessorSettings(tenantRow, hasFetchedPaymentData);

    return {
      isExternalBilling: tenantRow.IsExternal === true || tenantRow.IsExternal === 1,
      branding: {
        logoUrl: tenantRow.LogoUrl || advancedSettings?.branding?.logoUrl || '',
        primaryColor: tenantRow.PrimaryColorHex || advancedSettings?.branding?.colors?.primary || '#1f6db0',
        secondaryColor: tenantRow.SecondaryColorHex || advancedSettings?.branding?.colors?.secondary || '#424242',
        accentColor: advancedSettings?.branding?.colors?.accent || '#FF6B6B',
        fontFamily: advancedSettings?.branding?.typography?.fontFamily || 'Inter, system-ui, sans-serif',
        customCSS: advancedSettings?.branding?.customCSS || '',
        memberIDPrefix: tenantRow.MemberIDPrefix || advancedSettings?.branding?.memberIDPrefix || 'OED',
        memberIDPrefixIndividual:
          (tenantRow.IndividualMemberIDPrefix != null && tenantRow.IndividualMemberIDPrefix !== ''
            ? tenantRow.IndividualMemberIDPrefix
            : advancedSettings?.branding?.memberIDPrefixIndividual) || '',
        agentIDPrefix:
          (tenantRow.AgentIDPrefix != null && tenantRow.AgentIDPrefix !== ''
            ? tenantRow.AgentIDPrefix
            : advancedSettings?.branding?.agentIDPrefix) || ''
      },
      domain: {
        customDomain: tenantRow.CustomDomain || '',
        subdomain: extractSubdomainFromDomain(tenantRow.CustomDomain || '') || 'app',
        verificationStatus: advancedSettings?.domain?.verificationStatus || 'pending',
        sslEnabled: advancedSettings?.domain?.sslEnabled !== undefined ? advancedSettings.domain.sslEnabled : true,
        defaultUrlPath: tenantRow.DefaultUrlPath || ''
      },
      email: {
        customFromAddress: advancedSettings?.email?.customFromAddress || '',
        dkimEnabled: advancedSettings?.email?.dkimEnabled || false,
        dkimDomain: advancedSettings?.email?.dkimDomain || '',
        dkimSelector: advancedSettings?.email?.dkimSelector || '',
        dkimPublicKey: advancedSettings?.email?.dkimPublicKey || '',
        smtpEnabled: advancedSettings?.email?.smtpEnabled || false,
        smtpHost: advancedSettings?.email?.smtpHost || '',
        smtpPort: advancedSettings?.email?.smtpPort || 587,
        smtpUsername: advancedSettings?.email?.smtpUsername || '',
        // SendGrid DKIM fields
        sendgridDomainId: advancedSettings?.email?.sendgridDomainId || null,
        dnsRecords: advancedSettings?.email?.dnsRecords || [],
        verificationStatus: advancedSettings?.email?.verificationStatus || 'none'
      },
      sms: {
        customFromPhone: advancedSettings?.sms?.customFromPhone || ''
      },
      notifications: {
        enrollmentEnabled: advancedSettings?.notifications?.enrollmentEnabled !== undefined ? advancedSettings.notifications.enrollmentEnabled : true,
        paymentEnabled: advancedSettings?.notifications?.paymentEnabled !== undefined ? advancedSettings.notifications.paymentEnabled : true,
        systemEnabled: advancedSettings?.notifications?.systemEnabled !== undefined ? advancedSettings.notifications.systemEnabled : true,
        marketingEnabled: advancedSettings?.notifications?.marketingEnabled || false
      },
      features: {
        showLandingPage: advancedSettings?.features?.showLandingPage !== undefined ? advancedSettings.features.showLandingPage : true,
        enableSelfService: advancedSettings?.features?.enableSelfService !== undefined ? advancedSettings.features.enableSelfService : true,
        requireEmailVerification: advancedSettings?.features?.requireEmailVerification !== undefined ? advancedSettings.features.requireEmailVerification : true,
        allowGuestCheckout: advancedSettings?.features?.allowGuestCheckout || false,
        enableReferrals: advancedSettings?.features?.enableReferrals || false,
        enableAgentPortalTraining:
          advancedSettings?.features?.enableAgentPortalTraining !== undefined
            ? advancedSettings.features.enableAgentPortalTraining
            : true,
        mobileApp: {
          enableAppDownloadStep: advancedSettings?.features?.mobileApp?.enableAppDownloadStep || false,
          appStoreUrl: advancedSettings?.features?.mobileApp?.appStoreUrl || '',
          playStoreUrl: advancedSettings?.features?.mobileApp?.playStoreUrl || '',
          appImageUrl: advancedSettings?.features?.mobileApp?.appImageUrl || ''
        }
      },
      apiKeys: {
        keys: advancedSettings?.apiKeys?.keys || [],
        newKey: { name: '', expiresAt: '' }
      },
      systemFees: {
        platformFee: {
          name: systemFees?.platformFee?.name || 'Platform Fee',
          amount: systemFees?.platformFee?.amount || 6.00,
          type: systemFees?.platformFee?.type || 'fixed',
          description: systemFees?.platformFee?.description || 'Platform usage and maintenance fee',
          enabled: systemFees?.platformFee?.enabled !== undefined ? systemFees.platformFee.enabled : true,
          MemberPaid: systemFees?.platformFee?.MemberPaid ?? false,
          FlatOrPercent: systemFees?.platformFee?.FlatOrPercent || 'Flat',
          MemberPaidAmount: systemFees?.platformFee?.MemberPaidAmount ?? undefined
        },
        mobileAppFee: {
          name: systemFees?.mobileAppFee?.name || 'Mobile App Fee',
          amount: systemFees?.mobileAppFee?.amount || 5.00,
          type: systemFees?.mobileAppFee?.type || 'fixed',
          description: systemFees?.mobileAppFee?.description || 'Mobile application access fee',
          enabled: systemFees?.mobileAppFee?.enabled !== undefined ? systemFees.mobileAppFee.enabled : false,
          MemberPaid: systemFees?.mobileAppFee?.MemberPaid ?? false,
          FlatOrPercent: systemFees?.mobileAppFee?.FlatOrPercent || 'Flat',
          MemberPaidAmount: systemFees?.mobileAppFee?.MemberPaidAmount ?? undefined
        },
        aiAssistantFee: {
          name: systemFees?.aiAssistantFee?.name || 'AI Assistant Fee',
          amount: systemFees?.aiAssistantFee?.amount || 3.00,
          type: systemFees?.aiAssistantFee?.type || 'fixed',
          description: systemFees?.aiAssistantFee?.description || 'AI-powered assistant and automation fee',
          enabled: systemFees?.aiAssistantFee?.enabled !== undefined ? systemFees.aiAssistantFee.enabled : false,
          MemberPaid: systemFees?.aiAssistantFee?.MemberPaid ?? false,
          FlatOrPercent: systemFees?.aiAssistantFee?.FlatOrPercent || 'Flat',
          MemberPaidAmount: systemFees?.aiAssistantFee?.MemberPaidAmount ?? undefined
        }
      },
      paymentProcessing: {
        activeProcessor: paymentProcessorSettings?.activeProcessor || 'openenroll',
        chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember || false,
        // Default ON when unset: we'd rather vault the card and let DIME recurring handle the first
        // charge on the effective date than surprise a brand-new member with an immediate charge that
        // can decline and leave behind an orphaned account. Tenants can opt out by unchecking and saving.
        chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring !== false,
        failedPaymentDailyReportEmails: paymentProcessorSettings?.failedPaymentDailyReportEmails || '',
        processors: {
          openenroll: {
            enabled: paymentProcessorSettings?.processors?.openenroll?.enabled !== undefined 
              ? paymentProcessorSettings.processors.openenroll.enabled 
              : true,
            dime: {
              apiToken: paymentProcessorSettings?.processors?.openenroll?.dime?.apiToken || '',
              sid: paymentProcessorSettings?.processors?.openenroll?.dime?.sid || '',
              webhookSecret: paymentProcessorSettings?.processors?.openenroll?.dime?.webhookSecret || '',
              environment: paymentProcessorSettings?.processors?.openenroll?.dime?.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production')
            },
            nmi: {
                securityKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.securityKey || '',
                collectJsKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.collectJsKey || '',
                environment: paymentProcessorSettings?.processors?.openenroll?.nmi?.environment || 'sandbox'
            },
            fees: {
              ach: {
                // ACH percentageFee should be stored as decimal (0.0025 for 0.25%)
                // Convert to percentage for display. Handle both formats: if >= 1, it's already in percentage format
                percentageFee: (() => {
                  const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.percentageFee;
                  if (storedValue === undefined || storedValue === null) return 0;
                  // If value >= 1, assume it's in percentage format (legacy data), use as-is
                  // If value < 1, assume it's in decimal format, convert to percentage
                  return storedValue >= 1 ? storedValue : storedValue * 100;
                })(),
                flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.flatFee ?? 0.00
              },
              creditCard: {
                // Credit card percentageFee should be stored as decimal (0.03 for 3%)
                // Convert to percentage for display. Handle both formats: if >= 1, it's already in percentage format
                percentageFee: (() => {
                  const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.percentageFee;
                  if (storedValue === undefined || storedValue === null) return 0;
                  // If value >= 1, assume it's in percentage format (legacy data), use as-is
                  // If value < 1, assume it's in decimal format, convert to percentage
                  return storedValue >= 1 ? storedValue : storedValue * 100;
                })(),
                flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.flatFee ?? 0
              }
            }
          }
        }
      },
      commissions: {
        holdDays: advancedSettings?.commissions?.holdDays ?? 0,
        holdDaysCountFrom: advancedSettings?.commissions?.holdDaysCountFrom ?? 'paymentDate'
      },
      payouts: {
        vendorBasis: advancedSettings?.payouts?.vendorBasis ?? 'effectiveEnrollment',
        overrideBasis: advancedSettings?.payouts?.overrideBasis ?? 'paymentReceived'
      },
      enrollment: {
        autoApproveGroupTypeChanges: advancedSettings?.enrollment?.autoApproveGroupTypeChanges ?? false,
        belowMinimumAlertRecipients: advancedSettings?.enrollment?.belowMinimumAlertRecipients ?? [],
        enrollmentDeadlineDaysBeforeEffectiveDate: advancedSettings?.enrollment?.enrollmentDeadlineDaysBeforeEffectiveDate
      },
      billing: {
        // Default to enabled when no setting saved yet — feature is opt-OUT.
        // An explicit `false` silences it; absence means "use defaults".
        overdueReminders: {
          enabled: advancedSettings?.billing?.overdueReminders?.enabled !== false,
          thresholdDays: Number(advancedSettings?.billing?.overdueReminders?.thresholdDays ?? 6),
          cadenceDays: Number(advancedSettings?.billing?.overdueReminders?.cadenceDays ?? 7),
          maxCount: Number(advancedSettings?.billing?.overdueReminders?.maxCount ?? 4),
          skipUnderAmount: Number(advancedSettings?.billing?.overdueReminders?.skipUnderAmount ?? 0),
          channels: {
            email: advancedSettings?.billing?.overdueReminders?.channels?.email !== false,
            sms: advancedSettings?.billing?.overdueReminders?.channels?.sms === true
          },
          replyToEmail: advancedSettings?.billing?.overdueReminders?.replyToEmail ?? null
        }
      },
      marketingLink: {
        idParam: (advancedSettings?.marketingLink?.idParam ?? 'id').toString(),
        links: Array.isArray(advancedSettings?.marketingLink?.links)
          ? advancedSettings.marketingLink.links
              .filter((l: any) => l && typeof l === 'object')
              .map((l: any) => ({ label: (l.label ?? '').toString(), url: (l.url ?? '').toString() }))
          : [],
        destinations: Array.isArray(advancedSettings?.marketingLink?.destinations)
          ? advancedSettings.marketingLink.destinations
              .filter((d: any) => d && typeof d === 'object')
              .map((d: any) => ({
                type: d.type === 'landing' ? 'landing' : 'website',
                label: (d.label ?? '').toString(),
                url: (d.url ?? '').toString()
              }))
          : []
      },
      websiteForm: {
        digestRecipients: Array.isArray(advancedSettings?.websiteForm?.digestRecipients)
          ? advancedSettings.websiteForm.digestRecipients
              .map((e: any) => (e ?? '').toString().trim())
              .filter(Boolean)
          : []
      }
    };
  };

  const [settings, setSettings] = useState<AdvancedTenantSettings>(() => buildSettingsStateFromTenant(tenant, false));


  // 🔧 CRITICAL: Add useEffect to populate data when currentTenant changes
  useEffect(() => {
    console.log('🔄 Modal currentTenant changed:', {
      TenantId: currentTenant.TenantId,
      Name: currentTenant.Name,
      hasPaymentProcessorSettings: !!currentTenant.PaymentProcessorSettings,
      paymentProcessorSettingsType: typeof currentTenant.PaymentProcessorSettings,
      paymentProcessorSettingsPreview: currentTenant.PaymentProcessorSettings ? 
        (typeof currentTenant.PaymentProcessorSettings === 'string' ? 
          currentTenant.PaymentProcessorSettings.substring(0, 100) : 
          'OBJECT') : 
        'MISSING',
      hasSystemFees: !!currentTenant.SystemFees
    });
    const newSettings = buildSettingsStateFromTenant(currentTenant, true);
    const paymentProcessorSettings = parsePaymentProcessorSettings(currentTenant, true);
    
    console.log('🔄 Setting newSettings with payment processing:', {
      hasPaymentProcessorSettings: !!paymentProcessorSettings,
      apiToken: paymentProcessorSettings?.processors?.openenroll?.dime?.apiToken ? 'SET (' + paymentProcessorSettings.processors.openenroll.dime.apiToken.length + ' chars)' : 'NOT SET',
      sid: paymentProcessorSettings?.processors?.openenroll?.dime?.sid || 'NOT SET',
      webhookSecret: paymentProcessorSettings?.processors?.openenroll?.dime?.webhookSecret ? 'SET (' + paymentProcessorSettings.processors.openenroll.dime.webhookSecret.length + ' chars)' : 'NOT SET',
      environment: paymentProcessorSettings?.processors?.openenroll?.dime?.environment || 'NOT SET',
      achPercentageFee: newSettings.paymentProcessing.processors.openenroll.fees.ach.percentageFee,
      achFlatFee: newSettings.paymentProcessing.processors.openenroll.fees.ach.flatFee,
      ccPercentageFee: newSettings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee,
      ccFlatFee: newSettings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee,
      chargeFeeToMember: newSettings.paymentProcessing.chargeFeeToMember
    });
    
    setSettings(newSettings);
    
    // Store initial state for change detection
    // Update initial settings if payment data is available and we haven't set it yet, or if it arrived later
    const hasPaymentData = !!currentTenant.PaymentProcessorSettings;
    const hasInitialPaymentData = !!initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken;
    
    if (!initialSettingsSet) {
      if (hasPaymentData) {
        console.log('📝 Setting initial settings for change detection (with payment data)');
        setInitialSettings(JSON.parse(JSON.stringify(newSettings)));
        setInitialDomain(currentTenant.CustomDomain || '');
        setInitialUrlPath(currentTenant.DefaultUrlPath || '');
        setInitialSetupFee(currentTenant.MinimumSetupFee ?? null);
        setInitialSettingsSet(true);
      } else if (currentTenant.TenantId) {
        // Set initial settings even without payment data (for other fields)
        console.log('📝 Setting initial settings for change detection (payment data will arrive later)');
        setInitialSettings(JSON.parse(JSON.stringify(newSettings)));
        setInitialDomain(currentTenant.CustomDomain || '');
        setInitialUrlPath(currentTenant.DefaultUrlPath || '');
        setInitialSetupFee(currentTenant.MinimumSetupFee ?? null);
        // Don't set initialSettingsSet to true yet - wait for payment data
      }
    } else if (hasPaymentData && !hasInitialPaymentData) {
      // Payment data arrived after initial settings were set - update them
      console.log('📝 Updating initial settings with payment data that arrived later');
      setInitialSettings(JSON.parse(JSON.stringify(newSettings)));
    }
  }, [
    currentTenant.TenantId, 
    currentTenant.CustomDomain, 
    currentTenant.DefaultUrlPath, 
    currentTenant.AdvancedSettings, 
    currentTenant.SystemFees, 
    currentTenant.PaymentProcessorSettings, 
    currentTenant.MinimumSetupFee, 
    initialSettingsSet
  ]);

  useEffect(() => {
    if (!isSysAdmin || !copyFromTenantModalOpen) {
      return;
    }
    let cancelled = false;
    (async () => {
      setCopyTenantsLoading(true);
      try {
        const res = await TenantService.getTenants();
        if (cancelled) return;
        if (res.success && res.data) {
          setCopyTenantDropdownOptions(
            res.data
              .filter((t) => t.TenantId !== tenant.TenantId)
              .map((t) => ({
                id: t.TenantId,
                value: t.TenantId,
                label: t.Name
              }))
          );
        } else {
          setCopyTenantDropdownOptions([]);
        }
      } catch {
        if (!cancelled) setCopyTenantDropdownOptions([]);
      } finally {
        if (!cancelled) setCopyTenantsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSysAdmin, copyFromTenantModalOpen, tenant.TenantId]);

  const handleApplyCopyFromTenant = useCallback(async () => {
    if (!copySourceTenantId) return;
    setCopyApplying(true);
    try {
      const res = await TenantService.getTenant(copySourceTenantId);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Could not load tenant');
      }
      const source: Tenant = { ...(res.data as Tenant) };
      if (source.PaymentProcessorSettings && typeof source.PaymentProcessorSettings !== 'string') {
        source.PaymentProcessorSettings = JSON.stringify(source.PaymentProcessorSettings);
      }
      if (source.SystemFees && typeof source.SystemFees !== 'string') {
        source.SystemFees = JSON.stringify(source.SystemFees);
      }
      const src = buildSettingsStateFromTenant(source, true);

      switch (activeTab) {
        case 'agentonboarding':
          alert(
            'Agent onboarding documents are not copied from other tenants. Upload agreements for this organization separately.'
          );
          setCopyFromTenantModalOpen(false);
          setCopySourceTenantId('');
          return;
        case 'overrideaccounts': {
          const listRes = await ProductOverridesService.getOverrideACHAccounts(copySourceTenantId);
          if (!listRes.success || !listRes.data?.length) {
            alert('No override accounts found on the source tenant.');
            setCopyFromTenantModalOpen(false);
            setCopySourceTenantId('');
            return;
          }
          let copiedOverride = 0;
          const overrideFailed: string[] = [];
          for (const row of listRes.data) {
            const label =
              (row.AccountName && String(row.AccountName).trim()) ||
              row.AccountHolderName ||
              row.OverrideACHId;
            const detail = await ProductOverridesService.getOverrideACHAccountForEdit(
              row.OverrideACHId,
              copySourceTenantId
            );
            if (
              !detail.success ||
              !detail.data ||
              !detail.data.routingNumber ||
              !detail.data.accountNumber
            ) {
              overrideFailed.push(String(label));
              continue;
            }
            const d = detail.data;
            const accountName =
              (d.AccountName && String(d.AccountName).trim()) ||
              String(d.AccountHolderName || '').trim();
            const holder = String(d.AccountHolderName || '').trim();
            const bank = String(d.BankName || '').trim();
            if (!accountName || !holder || !bank) {
              overrideFailed.push(String(label));
              continue;
            }
            const bankAccountType =
              String(d.BankAccountType || '').toLowerCase() === 'savings' ? 'Savings' : 'Checking';
            const routingNumber = String(d.routingNumber);
            const accountNumber = String(d.accountNumber);
            const createRes = await ProductOverridesService.createACHAccount(
              {
                accountName,
                accountHolderName: holder,
                bankName: bank,
                accountNumber,
                routingNumber,
                bankAccountType,
                isDefault: !!d.IsDefault
              },
              tenant.TenantId
            );
            if (createRes.success) {
              copiedOverride += 1;
            } else {
              overrideFailed.push(String(label));
            }
          }
          await loadOverrideAccounts({ force: true });
          alert(
            `Copied ${copiedOverride} override account(s) to ${tenant.Name}.` +
              (overrideFailed.length
                ? ` Could not copy: ${overrideFailed.join(', ')}.`
                : '')
          );
          break;
        }
        case 'tenantpayoutaccount': {
          const payoutListRes = await TenantPayoutACHService.getTenantPayoutACHAccounts(copySourceTenantId);
          if (!payoutListRes.success || !payoutListRes.data?.length) {
            alert('No tenant payout accounts found on the source tenant.');
            setCopyFromTenantModalOpen(false);
            setCopySourceTenantId('');
            return;
          }
          let copiedPayout = 0;
          const payoutFailed: string[] = [];
          for (const row of payoutListRes.data) {
            const label = row.AccountHolderName || row.TenantPayoutACHId;
            const detail = await TenantPayoutACHService.getTenantPayoutACHAccountForEdit(
              row.TenantPayoutACHId,
              copySourceTenantId
            );
            if (
              !detail.success ||
              !detail.data ||
              !detail.data.routingNumber ||
              !detail.data.accountNumber
            ) {
              payoutFailed.push(String(label));
              continue;
            }
            const d = detail.data;
            const holder = String(d.AccountHolderName || '').trim();
            const bank = String(d.BankName || '').trim();
            if (!holder || !bank) {
              payoutFailed.push(String(label));
              continue;
            }
            const companyId =
              typeof d.CompanyIdentification === 'string' && d.CompanyIdentification.trim()
                ? d.CompanyIdentification.replace(/\D/g, '')
                : undefined;
            const bankAccountType = d.BankAccountType === 'Savings' ? 'Savings' : 'Checking';
            const payoutRouting = String(d.routingNumber);
            const payoutAccount = String(d.accountNumber);
            const createRes = await TenantPayoutACHService.createACHAccount(
              {
                accountName: (d.AccountName && String(d.AccountName).trim()) || holder,
                accountHolderName: holder,
                bankName: bank,
                ...(companyId ? { companyIdentification: companyId } : {}),
                accountNumber: payoutAccount,
                routingNumber: payoutRouting,
                bankAccountType,
                isDefault: !!d.IsDefault
              },
              tenant.TenantId
            );
            if (createRes.success) {
              copiedPayout += 1;
            } else {
              payoutFailed.push(String(label));
            }
          }
          await loadTenantPayoutAccounts({ force: true });
          alert(
            `Copied ${copiedPayout} tenant payout account(s) to ${tenant.Name}.` +
              (payoutFailed.length ? ` Could not copy: ${payoutFailed.join(', ')}.` : '')
          );
          break;
        }
        case 'branding':
          setSettings((prev) => ({
            ...prev,
            branding: { ...src.branding, logoFile: undefined }
          }));
          setCurrentTenant((prev) => ({
            ...prev,
            LogoUrl: source.LogoUrl ?? prev.LogoUrl,
            PrimaryColorHex: source.PrimaryColorHex ?? prev.PrimaryColorHex,
            SecondaryColorHex: source.SecondaryColorHex ?? prev.SecondaryColorHex,
            MemberIDPrefix: source.MemberIDPrefix ?? prev.MemberIDPrefix,
            IndividualMemberIDPrefix: source.IndividualMemberIDPrefix ?? prev.IndividualMemberIDPrefix,
            AgentIDPrefix: source.AgentIDPrefix ?? prev.AgentIDPrefix
          }));
          if (source.LogoUrl) setLogoPreview(source.LogoUrl);
          break;
        case 'mobileapp':
          setSettings((prev) => ({
            ...prev,
            features: {
              ...prev.features,
              mobileApp: {
                ...src.features.mobileApp,
                appImageFile: undefined
              }
            }
          }));
          setMobileAppFilePreview(null);
          break;
        case 'domain':
          setSettings((prev) => ({
            ...prev,
            domain: { ...src.domain }
          }));
          setCurrentTenant((prev) => ({
            ...prev,
            CustomDomain: source.CustomDomain ?? prev.CustomDomain,
            DefaultUrlPath: source.DefaultUrlPath ?? prev.DefaultUrlPath
          }));
          break;
        case 'email':
          setSettings((prev) => ({ ...prev, email: { ...src.email } }));
          break;
        case 'paymentprocessing':
          setSettings((prev) => ({
            ...prev,
            paymentProcessing: JSON.parse(JSON.stringify(src.paymentProcessing))
          }));
          setAchPercentageInput('');
          setCreditCardPercentageInput('');
          break;
        case 'systemfees':
          setSettings((prev) => ({
            ...prev,
            systemFees: JSON.parse(JSON.stringify(src.systemFees))
          }));
          break;
        case 'setupfee':
          setMinimumSetupFee(source.MinimumSetupFee ?? null);
          break;
        case 'payouts':
          setSettings((prev) => ({
            ...prev,
            payouts: { ...src.payouts }
          }));
          break;
        default:
          break;
      }

      setCopyFromTenantModalOpen(false);
      setCopySourceTenantId('');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to copy settings');
    } finally {
      setCopyApplying(false);
    }
  }, [
    activeTab,
    copySourceTenantId,
    tenant.TenantId,
    tenant.Name,
    loadOverrideAccounts,
    loadTenantPayoutAccounts
  ]);
  
  // Additional effect to ensure payment processing settings are updated when data loads
  // This runs whenever PaymentProcessorSettings becomes available, even if it arrives after initial load
  useEffect(() => {
    if (currentTenant.PaymentProcessorSettings) {
      const paymentProcessorSettings = parsePaymentProcessorSettings(currentTenant, true);
      const currentApiToken = settings.paymentProcessing.processors.openenroll.dime.apiToken;
      const currentSid = settings.paymentProcessing.processors.openenroll.dime.sid;
      const currentWebhookSecret = settings.paymentProcessing.processors.openenroll.dime.webhookSecret;
      const loadedApiToken = paymentProcessorSettings?.processors?.openenroll?.dime?.apiToken || '';
      const loadedSid = paymentProcessorSettings?.processors?.openenroll?.dime?.sid || '';
      const loadedWebhookSecret = paymentProcessorSettings?.processors?.openenroll?.dime?.webhookSecret || '';
      
      // Only update if the loaded data is different from current (to avoid unnecessary updates)
      const needsUpdate =
        loadedApiToken !== currentApiToken ||
        loadedSid !== currentSid ||
        loadedWebhookSecret !== currentWebhookSecret ||
        paymentProcessorSettings?.chargeFeeToMember !== settings.paymentProcessing.chargeFeeToMember ||
        // Default ON when unset (see loader comment) — keep this compare aligned or we'll flag the
        // modal as "dirty" on every open for tenants that have never explicitly saved the flag.
        (paymentProcessorSettings?.chargeFirstPaymentWithRecurring ?? true) !== (settings.paymentProcessing.chargeFirstPaymentWithRecurring ?? true) ||
        paymentProcessorSettings?.processors?.openenroll?.enabled !== settings.paymentProcessing.processors.openenroll.enabled ||
        !deepEqual(paymentProcessorSettings?.processors?.openenroll?.fees, settings.paymentProcessing.processors.openenroll.fees);
      
      if (paymentProcessorSettings && needsUpdate) {
        console.log('🔄 PaymentProcessorSettings detected, updating settings with loaded data');
        console.log('🔍 Current vs Loaded:', {
          currentApiToken: currentApiToken ? 'SET' : 'EMPTY',
          loadedApiToken: loadedApiToken ? 'SET' : 'EMPTY',
          currentSid: currentSid || 'EMPTY',
          loadedSid: loadedSid || 'EMPTY',
          currentWebhookSecret: currentWebhookSecret ? 'SET' : 'EMPTY',
          loadedWebhookSecret: loadedWebhookSecret ? 'SET' : 'EMPTY'
        });
        
        setSettings(prev => ({
          ...prev,
          paymentProcessing: {
            activeProcessor: paymentProcessorSettings?.activeProcessor || prev.paymentProcessing.activeProcessor,
            chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember ?? prev.paymentProcessing.chargeFeeToMember,
            chargeFirstPaymentWithRecurring: paymentProcessorSettings?.chargeFirstPaymentWithRecurring ?? prev.paymentProcessing.chargeFirstPaymentWithRecurring,
            failedPaymentDailyReportEmails: paymentProcessorSettings?.failedPaymentDailyReportEmails ?? prev.paymentProcessing.failedPaymentDailyReportEmails,
            processors: {
              openenroll: {
                enabled: paymentProcessorSettings?.processors?.openenroll?.enabled ?? prev.paymentProcessing.processors.openenroll.enabled,
                dime: {
                  apiToken: loadedApiToken || prev.paymentProcessing.processors.openenroll.dime.apiToken,
                  sid: loadedSid || prev.paymentProcessing.processors.openenroll.dime.sid,
                  webhookSecret: loadedWebhookSecret || prev.paymentProcessing.processors.openenroll.dime.webhookSecret,
                  environment: paymentProcessorSettings?.processors?.openenroll?.dime?.environment || prev.paymentProcessing.processors.openenroll.dime.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production')
                },
                nmi: {
                  securityKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.securityKey || prev.paymentProcessing.processors.openenroll.nmi?.securityKey || '',
                  collectJsKey: paymentProcessorSettings?.processors?.openenroll?.nmi?.collectJsKey || prev.paymentProcessing.processors.openenroll.nmi?.collectJsKey || '',
                  environment: paymentProcessorSettings?.processors?.openenroll?.nmi?.environment || prev.paymentProcessing.processors.openenroll.nmi?.environment || 'sandbox'
                },

                fees: {
                  ach: {
                    percentageFee: (() => {
                      const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.percentageFee;
                      if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.ach.percentageFee;
                      return storedValue >= 1 ? storedValue : storedValue * 100;
                    })(),
                    flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.ach?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.ach.flatFee
                  },
                  creditCard: {
                    percentageFee: (() => {
                      const storedValue = paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.percentageFee;
                      if (storedValue === undefined || storedValue === null) return prev.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee;
                      return storedValue >= 1 ? storedValue : storedValue * 100;
                    })(),
                    flatFee: paymentProcessorSettings?.processors?.openenroll?.fees?.creditCard?.flatFee ?? prev.paymentProcessing.processors.openenroll.fees.creditCard.flatFee
                  }
                }
              }
            }
          }
        }));
        console.log('✅ Payment processing settings updated from additional effect');
      } else if (paymentProcessorSettings) {
        console.log('ℹ️ PaymentProcessorSettings available but no update needed (already in sync)');
      }
    }
  }, [currentTenant.PaymentProcessorSettings]);

  // 🔄 Fetch fresh data when modal opens
  useEffect(() => {
    isMountedRef.current = true;
    
    if (tenant.TenantId && isMountedRef.current) {
      console.log('🔄 Modal opened, fetching fresh data for tenant:', tenant.TenantId);
      // Reset initial settings tracking when modal opens to ensure fresh data is loaded
      setInitialSettingsSet(false);
      setInitialSettings(null);
      setEditingCredentials(false);
      setEditingFees(false);
      
      // Cancel any pending requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      
      fetchTenantData();
    }
    
    // Cleanup function - cancel requests and mark as unmounted
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [tenant.TenantId]);

  useEffect(() => {
    setOverrideAccounts([]);
    setOverrideAccountsLoaded(false);
    setOverrideAccountsError(null);
    setOverrideAccountNotice(null);
    setOverrideAccountModalMode(null);
    setEditingOverrideAccount(null);
    setCurrentMaskedRouting(null);
    setCurrentMaskedAccount(null);
    resetOverrideAccountForm();
  }, [tenant.TenantId, resetOverrideAccountForm]);

  useEffect(() => {
    if (activeTab === 'overrideaccounts') {
      loadOverrideAccounts();
    }
  }, [activeTab, loadOverrideAccounts]);

  useEffect(() => {
    if (overrideAccountNotice) {
      const timer = window.setTimeout(() => setOverrideAccountNotice(null), 5000);
      return () => window.clearTimeout(timer);
    }
  }, [overrideAccountNotice]);

  useEffect(() => {
    setTenantPayoutAccounts([]);
    setTenantPayoutAccountsLoaded(false);
    setTenantPayoutAccountsError(null);
    setTenantPayoutAccountNotice(null);
    setTenantPayoutAccountModalMode(null);
    setEditingTenantPayoutAccount(null);
    setCurrentMaskedTenantPayoutRouting(null);
    setCurrentMaskedTenantPayoutAccount(null);
    resetTenantPayoutAccountForm();
  }, [tenant.TenantId, resetTenantPayoutAccountForm]);

  useEffect(() => {
    if (activeTab === 'tenantpayoutaccount') {
      loadTenantPayoutAccounts();
    }
  }, [activeTab, loadTenantPayoutAccounts]);

  useEffect(() => {
    if (tenantPayoutAccountNotice) {
      const timer = window.setTimeout(() => setTenantPayoutAccountNotice(null), 5000);
      return () => window.clearTimeout(timer);
    }
  }, [tenantPayoutAccountNotice]);

  // Sync selectedSubdomain with currentTenant.CustomDomain
  useEffect(() => {
    const subdomain = extractSubdomainFromDomain(currentTenant.CustomDomain || '');
    if (subdomain) {
      setSelectedSubdomain(subdomain);
    }
  }, [currentTenant.CustomDomain]);

  // Load agent documents when agent onboarding tab is active
  useEffect(() => {
    if (activeTab === 'agentonboarding') {
      loadAgentDocuments();
    }
  }, [activeTab]);

  // Load DNS records when custom domain tab is active (disabled - handled in initialization)
  useEffect(() => {
    // DNS records are now handled in the initialization useEffect
    // This prevents unnecessary API calls
  }, [activeTab, currentTenant.CustomDomain]);

  // Initialize domain input value when modal opens or tenant changes
  useEffect(() => {
    if (currentTenant.CustomDomain) {
      const baseDomain = extractBaseDomain(currentTenant.CustomDomain);
      setDomainInputValue(baseDomain);
      setDomainConfigured(true);

      // Fetch complete DNS records from Azure API
      fetchDNSRecords();
    } else {
      setDomainInputValue('');
      setDomainConfigured(false);
      setDnsRecords(null);
      setDomainVerificationResult(null);
    }
  }, [currentTenant.CustomDomain]);

  // Copy to clipboard helper
  const handleCopyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedValue(`${type}: ${text}`);
      setTimeout(() => setCopiedValue(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Fetch DNS records for existing domains
  const fetchDNSRecords = async () => {
    if (!currentTenant.CustomDomain) return;
    
    setDnsRecordsLoading(true);
    try {
      const baseDomain = extractBaseDomain(currentTenant.CustomDomain);
      const subdomain = currentTenant.CustomDomain.split('.')[0];
      
      const response: any = await apiService.post(`/api/custom-domains/configure`, {
        tenantId: tenant.TenantId,
        subdomainOption: subdomain as 'app' | 'portal' | 'enroll',
        domainName: baseDomain
      });

      if (response.success && response.data) {
        if (response.data.needsVerification) {
          // Existing domain - show verification message and DNS records if returned
          if (response.data.cname) {
            setDnsRecords({
              cname: response.data.cname,
              txt: response.data.txt ?? undefined
            });
          }
          setDomainVerificationResult({
            success: true,
            status: 'pending',
            message: 'Domain is already configured. Use the Verify button to check DNS status.',
            details: {
              hostName: response.data.hostName,
              isExisting: true,
              needsVerification: true,
              status: 'pending'
            }
          });
        } else {
          // New domain - show DNS records
          setDnsRecords({
            cname: response.data.cname,
            txt: response.data.txt
          });
          
          setDomainVerificationResult({
            success: true,
            status: 'pending',
            message: 'Please add both DNS records below and then click Verify.',
            details: {
              cname: response.data.cname,
              txt: response.data.txt,
              hostName: response.data.hostName,
              isExisting: false,
              status: 'pending'
            }
          });
        }
      }
    } catch (error) {
      console.error('Error fetching DNS records:', error);
    } finally {
      setDnsRecordsLoading(false);
    }
  };

  // Agent Onboarding Functions
  const loadAgentDocuments = async () => {
    try {
      const response = await AgentOnboardingService.getDocuments();
      if (response.success && response.data) {
        setAgentDocuments(response.data);
      }
    } catch (error) {
      console.error('Error loading agent documents:', error);
    }
  };

  const handleDocumentUpload = async (file: File) => {
    setUploadingDocument(true);
    try {
      const response = await AgentOnboardingService.uploadDocument(file);
      if (response.success) {
        await loadAgentDocuments(); // Reload documents
        console.log('Document uploaded successfully');
      } else {
        console.error('Failed to upload document:', response.message);
      }
    } catch (error) {
      console.error('Error uploading document:', error);
    } finally {
      setUploadingDocument(false);
    }
  };

  const handleDocumentDelete = async (fileId: string) => {
    setDeletingDocument(fileId);
    try {
      const response = await AgentOnboardingService.deleteDocument(fileId);
      if (response.success) {
        await loadAgentDocuments(); // Reload documents
        console.log('Document deleted successfully');
      } else {
        console.error('Failed to delete document:', response.message);
      }
    } catch (error) {
      console.error('Error deleting document:', error);
    } finally {
      setDeletingDocument(null);
    }
  };

  const handleDocumentDownload = async (filePath: string, fileName: string) => {
    try {
      await AgentOnboardingService.downloadDocument(filePath, fileName);
    } catch (error) {
      console.error('Error downloading document:', error);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  // Helper function to deep compare objects (for change detection)
  const deepEqual = (obj1: any, obj2: any): boolean => {
    if (obj1 === obj2) return true;
    if (obj1 == null || obj2 == null) return false;
    if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;
    
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (const key of keys1) {
      if (!keys2.includes(key)) return false;
      if (!deepEqual(obj1[key], obj2[key])) return false;
    }
    
    return true;
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const isMerchantSetupTab = activeTab === 'paymentprocessing';
      await handleAdvancedConfigSave(
        settings,
        isMerchantSetupTab
          ? { includePaymentProcessing: true, includeFees: true, includeCredentials: true }
          : undefined
      );
    } catch (error) {
      console.error('Error in modal save:', error);
    } finally {
      setLoading(false);
    }
  };

  // Save handler specifically for payment processing credentials
  const handleSaveCredentials = async () => {
    setLoading(true);
    try {
      await handleAdvancedConfigSave(settings, { includePaymentProcessing: true, includeFees: false, includeCredentials: true });
      // Close editing mode after successful save
      setEditingCredentials(false);
      // Refresh data to get updated initial settings
      await fetchTenantData();
    } catch (error) {
      console.error('Error saving payment processing credentials:', error);
      if (setError) {
        setError('Failed to save payment processing credentials. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Save handler specifically for payment processing fees
  const handleSaveFees = async () => {
    setLoading(true);
    try {
      await handleAdvancedConfigSave(settings, { includePaymentProcessing: true, includeFees: true, includeCredentials: false });
      // Close editing mode after successful save
      setEditingFees(false);
      // Refresh data to get updated initial settings
      await fetchTenantData();
    } catch (error) {
      console.error('Error saving payment processing fees:', error);
      if (setError) {
        setError('Failed to save payment processing fees. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Save failed-payment daily report notification emails (stored in PaymentProcessorSettings JSON)
  const handleSaveFailedPaymentReportEmails = async () => {
    setLoading(true);
    try {
      await handleAdvancedConfigSave(settings, { includePaymentProcessing: true, includeFees: false, includeCredentials: false });
      await fetchTenantData();
    } catch (error) {
      console.error('Error saving failed payment notification emails:', error);
      if (setError) {
        setError('Failed to save notification emails. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Advanced Configuration Save Handler with API Keys and System Fees Support
  // Options: { includePaymentProcessing: boolean, includeFees: boolean, includeCredentials: boolean }
  // By default, payment processing is NOT included; Merchant Setup tab footer Save passes includePaymentProcessing.
  const handleAdvancedConfigSave = async (
    settings: AdvancedTenantSettings, 
    options: { includePaymentProcessing?: boolean; includeFees?: boolean; includeCredentials?: boolean } = {}
  ) => {
    const { includePaymentProcessing = false, includeFees = true, includeCredentials = true } = options;
    if (settings.isExternalBilling && includePaymentProcessing) {
      const msg = 'Merchant settings cannot be edited for external billing tenants.';
      setLocalError(msg);
      if (setError) setError(msg);
      throw new Error(msg);
    }
    try {
      console.log('💾 Starting save process with settings:', {
        hasLogoFile: !!settings.branding.logoFile,
        logoFileName: settings.branding.logoFile?.name,
        logoFileSize: settings.branding.logoFile?.size,
        logoFileType: settings.branding.logoFile?.type
      });
      
      let logoUrl = tenant.LogoUrl || '';

      // Handle logo upload
      if (settings.branding.logoFile) {
        const formData = new FormData();
        formData.append('files', settings.branding.logoFile);
        formData.append('uploadType', 'logos');
        formData.append('entityId', tenant.TenantId);
        formData.append('category', 'branding');
        
        console.log('📤 Uploading logo file:', {
          fileName: settings.branding.logoFile.name,
          fileSize: settings.branding.logoFile.size,
          fileType: settings.branding.logoFile.type,
          uploadType: 'logos',
          entityId: tenant.TenantId
        });
        
        const uploadResponse: any = await apiService.post('/api/uploads', formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
        
        console.log('📤 Upload response:', uploadResponse);
        
        if (uploadResponse.success) {
          // Handle both response formats from uploads.js
          if (uploadResponse.data && Array.isArray(uploadResponse.data) && uploadResponse.data[0]?.url) {
            logoUrl = uploadResponse.data[0].url;
            console.log('✅ Logo uploaded to Azure Blob Storage:', logoUrl);
          } else if (uploadResponse.url) {
            logoUrl = uploadResponse.url;
            console.log('✅ Logo URL set successfully:', logoUrl);
          } else {
            throw new Error('No URL returned from upload response');
          }
          
          // CRITICAL: Strip SAS token from logo URL before saving
          // Images should be public and stored without SAS tokens per backend-system.md
          if (logoUrl.includes('?')) {
            logoUrl = logoUrl.split('?')[0];
            console.log('✅ Stripped SAS token from logo URL:', logoUrl);
          }
        } else {
          throw new Error(`Logo upload failed: ${uploadResponse.message || 'Unknown error'}`);
        }
      }
      
      // Upload mobile app image if provided
      if (settings.features.mobileApp.appImageFile) {
        const appImgFormData = new FormData();
        appImgFormData.append('files', settings.features.mobileApp.appImageFile);
        appImgFormData.append('uploadType', 'logos');
        appImgFormData.append('entityId', tenant.TenantId);
        appImgFormData.append('category', 'mobile-app');

        const appImgResponse: any = await apiService.post('/api/uploads', appImgFormData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });

        if (appImgResponse.success) {
          let appImgUrl = '';
          if (appImgResponse.data && Array.isArray(appImgResponse.data) && appImgResponse.data[0]?.url) {
            appImgUrl = appImgResponse.data[0].url;
          } else if (appImgResponse.url) {
            appImgUrl = appImgResponse.url;
          }
          if (appImgUrl.includes('?')) {
            appImgUrl = appImgUrl.split('?')[0];
          }
          settings.features.mobileApp.appImageUrl = appImgUrl;
        }
      }

      // Prepare the AdvancedSettings JSON with ALL advanced settings
      const advancedSettingsJson = {
        branding: {
          logoUrl: logoUrl,
          colors: {
            primary: settings.branding.primaryColor,
            secondary: settings.branding.secondaryColor,
            accent: settings.branding.accentColor
          },
          typography: {
            fontFamily: settings.branding.fontFamily
          },
          customCSS: settings.branding.customCSS || ''
        },
        // Domain settings are now stored in database fields, not JSON
        email: {
          customFromAddress: settings.email.customFromAddress || '',
          dkimEnabled: settings.email.dkimEnabled,
          dkimDomain: settings.email.dkimDomain || '',
          dkimSelector: settings.email.dkimSelector || '',
          dkimPublicKey: settings.email.dkimPublicKey || '',
          smtpEnabled: settings.email.smtpEnabled,
          smtpHost: settings.email.smtpHost || '',
          smtpPort: settings.email.smtpPort || 587,
          smtpUsername: settings.email.smtpUsername || '',
          // SendGrid DKIM fields
          sendgridDomainId: settings.email.sendgridDomainId || null,
          dnsRecords: settings.email.dnsRecords || [],
          verificationStatus: settings.email.verificationStatus || 'none'
        },
        sms: {
          customFromPhone: settings.sms?.customFromPhone || ''
        },
        notifications: {
          enrollmentEnabled: settings.notifications.enrollmentEnabled,
          paymentEnabled: settings.notifications.paymentEnabled,
          systemEnabled: settings.notifications.systemEnabled,
          marketingEnabled: settings.notifications.marketingEnabled
        },
        features: {
          showLandingPage: settings.features.showLandingPage,
          enableSelfService: settings.features.enableSelfService,
          requireEmailVerification: settings.features.requireEmailVerification,
          allowGuestCheckout: settings.features.allowGuestCheckout,
          enableReferrals: settings.features.enableReferrals,
          enableAgentPortalTraining: settings.features.enableAgentPortalTraining,
          mobileApp: {
            enableAppDownloadStep: settings.features.mobileApp.enableAppDownloadStep,
            appStoreUrl: (settings.features.mobileApp.appStoreUrl || '').trim(),
            playStoreUrl: (settings.features.mobileApp.playStoreUrl || '').trim(),
            appImageUrl: settings.features.mobileApp.appImageUrl || ''
          }
        },
        apiKeys: {
          keys: settings.apiKeys.keys,
          enabled: settings.apiKeys.keys.length > 0
        },
        commissions: {
          holdDays: settings.commissions.holdDays,
          holdDaysCountFrom: settings.commissions.holdDaysCountFrom
        },
        payouts: {
          vendorBasis: settings.payouts.vendorBasis,
          overrideBasis: settings.payouts.overrideBasis
        },
        enrollment: {
          autoApproveGroupTypeChanges: settings.enrollment.autoApproveGroupTypeChanges,
          belowMinimumAlertRecipients: settings.enrollment.belowMinimumAlertRecipients,
          enrollmentDeadlineDaysBeforeEffectiveDate: settings.enrollment.enrollmentDeadlineDaysBeforeEffectiveDate
        },
        billing: {
          overdueReminders: settings.billing?.overdueReminders
            ? {
                enabled: settings.billing.overdueReminders.enabled,
                thresholdDays: settings.billing.overdueReminders.thresholdDays,
                cadenceDays: settings.billing.overdueReminders.cadenceDays,
                maxCount: settings.billing.overdueReminders.maxCount,
                skipUnderAmount: settings.billing.overdueReminders.skipUnderAmount,
                channels: {
                  email: settings.billing.overdueReminders.channels.email,
                  sms: settings.billing.overdueReminders.channels.sms
                },
                replyToEmail: settings.billing.overdueReminders.replyToEmail || null
              }
            : { enabled: false }
        },
        marketingLink: {
          idParam: (settings.marketingLink?.idParam || 'id').trim() || 'id',
          links: (settings.marketingLink?.links || [])
            .map((l) => ({ label: (l.label || '').trim(), url: (l.url || '').trim() }))
            .filter((l) => l.url),
          destinations: (settings.marketingLink?.destinations || [])
            .map((d) => ({
              type: d.type === 'landing' ? 'landing' : 'website',
              label: (d.label || '').trim(),
              url: (d.url || '').trim()
            }))
            .filter((d) => d.url)
        },
        websiteForm: {
          digestRecipients: (settings.websiteForm?.digestRecipients || [])
            .map((e) => (e || '').trim())
            .filter(Boolean)
        }
      };

      // Prepare the SystemFees JSON with all properties including enabled status
      const systemFeesJson = {
        platformFee: {
          name: settings.systemFees.platformFee.name,
          amount: settings.systemFees.platformFee.amount,
          type: settings.systemFees.platformFee.type,
          description: settings.systemFees.platformFee.description,
          enabled: settings.systemFees.platformFee.enabled,
          MemberPaid: settings.systemFees.platformFee.MemberPaid,
          FlatOrPercent: settings.systemFees.platformFee.FlatOrPercent,
          MemberPaidAmount: settings.systemFees.platformFee.MemberPaidAmount
        },
        mobileAppFee: {
          name: settings.systemFees.mobileAppFee.name,
          amount: settings.systemFees.mobileAppFee.amount,
          type: settings.systemFees.mobileAppFee.type,
          description: settings.systemFees.mobileAppFee.description,
          enabled: settings.systemFees.mobileAppFee.enabled,
          MemberPaid: settings.systemFees.mobileAppFee.MemberPaid,
          FlatOrPercent: settings.systemFees.mobileAppFee.FlatOrPercent,
          MemberPaidAmount: settings.systemFees.mobileAppFee.MemberPaidAmount
        },
        aiAssistantFee: {
          name: settings.systemFees.aiAssistantFee.name,
          amount: settings.systemFees.aiAssistantFee.amount,
          type: settings.systemFees.aiAssistantFee.type,
          description: settings.systemFees.aiAssistantFee.description,
          enabled: settings.systemFees.aiAssistantFee.enabled,
          MemberPaid: settings.systemFees.aiAssistantFee.MemberPaid,
          FlatOrPercent: settings.systemFees.aiAssistantFee.FlatOrPercent,
          MemberPaidAmount: settings.systemFees.aiAssistantFee.MemberPaidAmount
        }
      };

      // Payment processing is saved when includePaymentProcessing is true (dedicated section buttons,
      // or the modal footer Save while on the Merchant Setup tab).
      let paymentProcessorSettingsJson: any = null;
      
      if (includePaymentProcessing) {
        // Determine what changed based on what we're saving
        const current = settings.paymentProcessing;
        const initial = initialSettings?.paymentProcessing;
        
        // Check if credentials changed (only if includeCredentials is true)
        let credentialsChanged = false;
        if (includeCredentials) {
          const currentApiToken = (current.processors.openenroll.dime.apiToken || '').trim();
          const initialApiToken = (initial?.processors?.openenroll?.dime?.apiToken || '').trim();
          const currentWebhookSecret = (current.processors.openenroll.dime.webhookSecret || '').trim();
          const initialWebhookSecret = (initial?.processors?.openenroll?.dime?.webhookSecret || '').trim();
          const currentSid = (current.processors.openenroll.dime.sid || '').trim();
          const initialSid = (initial?.processors?.openenroll?.dime?.sid || '').trim();

          const currentNmiSecurityKey = (current.processors.openenroll.nmi?.securityKey || '').trim();
          const initialNmiSecurityKey = (initial?.processors?.openenroll?.nmi?.securityKey || '').trim();
          const currentNmiCollectJsKey = (current.processors.openenroll.nmi?.collectJsKey || '').trim();
          const initialNmiCollectJsKey = (initial?.processors?.openenroll?.nmi?.collectJsKey || '').trim();
          const currentNmiEnvironment = current.processors.openenroll.nmi?.environment || 'sandbox';
          const initialNmiEnvironment = initial?.processors?.openenroll?.nmi?.environment || 'sandbox';
          
          credentialsChanged = 
            currentApiToken !== initialApiToken ||
            currentWebhookSecret !== initialWebhookSecret ||
            currentSid !== initialSid ||
            current.processors.openenroll.dime.environment !== initial?.processors?.openenroll?.dime?.environment ||
            currentNmiSecurityKey !== initialNmiSecurityKey ||
            currentNmiCollectJsKey !== initialNmiCollectJsKey ||
            currentNmiEnvironment !== initialNmiEnvironment;
        }
        
        // Check if fees changed (only if includeFees is true)
        let feesChanged = false;
        if (includeFees) {
          feesChanged = 
            current.chargeFeeToMember !== initial?.chargeFeeToMember ||
            current.processors.openenroll.enabled !== initial?.processors?.openenroll?.enabled ||
            !deepEqual(current.processors.openenroll.fees, initial?.processors?.openenroll?.fees || {});
        }
        
        // Check if other non-sensitive fields changed
        const otherFieldsChanged =
          current.activeProcessor !== initial?.activeProcessor ||
          (current.failedPaymentDailyReportEmails || '').trim() !== (initial?.failedPaymentDailyReportEmails || '').trim() ||
          // Default ON when unset (see loader comment).
          (current.chargeFirstPaymentWithRecurring ?? true) !== (initial?.chargeFirstPaymentWithRecurring ?? true);
        
        // Only save if something actually changed
        const shouldSave = credentialsChanged || feesChanged || otherFieldsChanged;
        
        if (shouldSave) {
          const initialPaymentProcessor = initialSettings?.paymentProcessing;
          const currentDime = settings.paymentProcessing.processors.openenroll.dime;
          const initialDime = initialPaymentProcessor?.processors?.openenroll?.dime;
          
          // For sensitive fields (apiToken, webhookSecret, sid), preserve existing values if:
          // 1. Current is empty/blank AND
          // 2. Initial had a non-empty value
          // Otherwise use current value (user intentionally changed it)
          const preservedApiToken = (!currentDime.apiToken || currentDime.apiToken.trim() === '') && 
                                    initialDime?.apiToken && 
                                    initialDime.apiToken.trim() !== '' 
                                    ? initialDime.apiToken 
                                    : currentDime.apiToken;
          
          const preservedWebhookSecret = (!currentDime.webhookSecret || currentDime.webhookSecret.trim() === '') && 
                                         initialDime?.webhookSecret && 
                                         initialDime.webhookSecret.trim() !== '' 
                                         ? initialDime.webhookSecret 
                                         : currentDime.webhookSecret;
          
          const preservedSid = (!currentDime.sid || currentDime.sid.trim() === '') && 
                               initialDime?.sid && 
                               initialDime.sid.trim() !== '' 
                               ? initialDime.sid 
                               : currentDime.sid;
          
          // Build payment processor settings - include only what's requested
          paymentProcessorSettingsJson = {
            activeProcessor: settings.paymentProcessing.activeProcessor || initialPaymentProcessor?.activeProcessor || 'openenroll',
            chargeFeeToMember: includeFees
              ? (settings.paymentProcessing.chargeFeeToMember ?? initialPaymentProcessor?.chargeFeeToMember ?? false)
              : (initialPaymentProcessor?.chargeFeeToMember ?? false),
            // Default ON when unset (see loader comment).
            chargeFirstPaymentWithRecurring: settings.paymentProcessing.chargeFirstPaymentWithRecurring ?? initialPaymentProcessor?.chargeFirstPaymentWithRecurring ?? true,
            failedPaymentDailyReportEmails: (settings.paymentProcessing.failedPaymentDailyReportEmails || '').trim(),
            processors: {
              openenroll: {
                enabled: includeFees
                  ? (settings.paymentProcessing.processors.openenroll.enabled ?? initialPaymentProcessor?.processors?.openenroll?.enabled ?? true)
                  : (initialPaymentProcessor?.processors?.openenroll?.enabled ?? true),
                dime: {
                  apiToken: includeCredentials ? preservedApiToken : (initialDime?.apiToken || ''),
                  sid: includeCredentials ? preservedSid : (initialDime?.sid || ''),
                  webhookSecret: includeCredentials ? preservedWebhookSecret : (initialDime?.webhookSecret || ''),
                  environment: includeCredentials
                    ? (settings.paymentProcessing.processors.openenroll.dime.environment || initialDime?.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production'))
                    : (initialDime?.environment || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'demo' : 'production'))
                },
                nmi: {
                    securityKey: includeCredentials
                      ? (settings.paymentProcessing.processors.openenroll.nmi?.securityKey || 
                        initialSettings?.paymentProcessing?.processors?.openenroll?.nmi?.securityKey || '')
                      : (initialSettings?.paymentProcessing?.processors?.openenroll?.nmi?.securityKey || ''),
                    collectJsKey: settings.paymentProcessing.processors.openenroll.nmi?.collectJsKey || 
                                  initialSettings?.paymentProcessing?.processors?.openenroll?.nmi?.collectJsKey || '',
                    environment: settings.paymentProcessing.processors.openenroll.nmi?.environment || 
                                initialSettings?.paymentProcessing?.processors?.openenroll?.nmi?.environment || 'sandbox'
                  },
                fees: includeFees ? {
                  ach: {
                    // ACH percentageFee must be stored as decimal (0.0025 for 0.25%), convert from percentage
                    percentageFee: settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee / 100,
                    flatFee: settings.paymentProcessing.processors.openenroll.fees.ach.flatFee
                  },
                  creditCard: {
                    // Credit card percentageFee must be stored as decimal (0.03 for 3%), convert from percentage
                    percentageFee: settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee / 100,
                    flatFee: settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee
                  }
                } : (initialPaymentProcessor?.processors?.openenroll?.fees || {
                  ach: { percentageFee: 0, flatFee: 0 },
                  creditCard: { percentageFee: 0, flatFee: 0 }
                })
              }
            }
          };
        }
      }

      // Build update payload - only include fields that actually changed
      const tenantUpdateData: Partial<Tenant> = {};
      
      // Check if domain settings changed
      if (settings.domain.customDomain !== initialDomain) {
        tenantUpdateData.CustomDomain = settings.domain.customDomain || '';
      }
      if (settings.domain.defaultUrlPath !== initialUrlPath) {
        tenantUpdateData.DefaultUrlPath = settings.domain.defaultUrlPath || '';
      }
      if (minimumSetupFee !== initialSetupFee) {
        tenantUpdateData.MinimumSetupFee = minimumSetupFee !== null && minimumSetupFee !== undefined ? minimumSetupFee : null;
      }
      
      // Check if MemberIDPrefix changed
      const currentPrefix = settings.branding.memberIDPrefix || 'OED';
      const initialPrefix = initialSettings?.branding?.memberIDPrefix || currentTenant.MemberIDPrefix || 'OED';
      if (currentPrefix !== initialPrefix) {
        tenantUpdateData.MemberIDPrefix = currentPrefix;
      }

      const currentInd = (settings.branding.memberIDPrefixIndividual || '').trim();
      const initialInd = (
        initialSettings?.branding?.memberIDPrefixIndividual ??
        (currentTenant.IndividualMemberIDPrefix || '')
      ).trim();
      if (currentInd !== initialInd) {
        tenantUpdateData.IndividualMemberIDPrefix = currentInd === '' ? null : currentInd.toUpperCase();
      }

      // Check if AgentIDPrefix changed
      const currentAgentPrefix = (settings.branding.agentIDPrefix || '').trim();
      const initialAgentPrefix = (
        initialSettings?.branding?.agentIDPrefix ??
        (currentTenant.AgentIDPrefix || '')
      ).trim();
      if (currentAgentPrefix !== initialAgentPrefix) {
        tenantUpdateData.AgentIDPrefix = currentAgentPrefix === '' ? null : currentAgentPrefix.toUpperCase();
      }

      const initialExternalBilling = !!(
        initialSettings?.isExternalBilling ??
        (currentTenant.IsExternal === true || currentTenant.IsExternal === 1)
      );
      if (isSysAdmin && !!settings.isExternalBilling !== initialExternalBilling) {
        tenantUpdateData.IsExternal = settings.isExternalBilling ? 1 : 0;
      }

      // Check if AdvancedSettings sections changed (compare individual sections)
      const brandingChanged = !initialSettings || !deepEqual(settings.branding, initialSettings.branding) || settings.branding.logoFile || (logoUrl && logoUrl !== tenant.LogoUrl);
      const emailChanged = !initialSettings || !deepEqual(settings.email, initialSettings.email);
      const smsChanged = !initialSettings || !deepEqual(settings.sms, initialSettings.sms);
      const notificationsChanged = !initialSettings || !deepEqual(settings.notifications, initialSettings.notifications);
      const featuresChanged = !initialSettings || !deepEqual(settings.features, initialSettings.features);
      const apiKeysChanged = !initialSettings || !deepEqual(settings.apiKeys.keys, initialSettings.apiKeys.keys);
      const commissionsChanged = !initialSettings || !deepEqual(settings.commissions, initialSettings.commissions);
      const payoutsChanged = !initialSettings || !deepEqual(settings.payouts, initialSettings.payouts);
      const enrollmentChanged = !initialSettings || !deepEqual(settings.enrollment, initialSettings.enrollment);
      const marketingLinkChanged = !initialSettings || !deepEqual(settings.marketingLink, initialSettings.marketingLink);
      const websiteFormChanged = !initialSettings || !deepEqual(settings.websiteForm, initialSettings.websiteForm);

      if (brandingChanged || emailChanged || smsChanged || notificationsChanged || featuresChanged || apiKeysChanged || commissionsChanged || payoutsChanged || enrollmentChanged || marketingLinkChanged || websiteFormChanged) {
        tenantUpdateData.AdvancedSettings = JSON.stringify(advancedSettingsJson);
      }
      
      // Check if SystemFees changed
      if (!initialSettings || !deepEqual(settings.systemFees, initialSettings.systemFees)) {
        tenantUpdateData.SystemFees = JSON.stringify(systemFeesJson);
      }
      
      // Only include PaymentProcessorSettings when includePaymentProcessing is true and something changed
      if (includePaymentProcessing && paymentProcessorSettingsJson !== null) {
        tenantUpdateData.PaymentProcessorSettings = JSON.stringify(paymentProcessorSettingsJson);
      }
      
      // If no changes detected, notify parent but keep modal open
      if (Object.keys(tenantUpdateData).length === 0) {
        onSave();
        if (setError) setError(null);
        setLocalError(null);
        setSaveSuccess('No changes to save.');
        return;
      }

      // Update tenant in database - use role-appropriate service
      let updateResponse;
      if (user?.currentRole === 'SysAdmin') {
        updateResponse = await TenantService.updateTenant(tenant.TenantId, tenantUpdateData);
      } else {
        updateResponse = await TenantAdminService.updateTenantSettings(tenantUpdateData);
      }

      if (updateResponse.success) {
        console.log('✅ Tenant settings updated in database');
        
        // If logo was updated, clear cached tenant info to force refresh
        if (settings.branding.logoFile || (logoUrl && logoUrl !== tenant.LogoUrl)) {
          console.log('🧹 Clearing cached tenant info to refresh logo');
          localStorage.removeItem('currentTenantInfo');
        }
        
        setMobileAppFilePreview(null);
        onSave();
        await fetchTenantData();
        if (setError) setError(null);
        setLocalError(null);
        setSaveSuccess('Settings saved successfully.');
        console.log('🎉 Advanced tenant settings saved successfully!');
      } else {
        throw new Error('Database update failed: ' + (updateResponse.message || 'Unknown error'));
      }
      
    } catch (error) {
      console.error('❌ Error saving advanced tenant settings:', error);
      const msg = 'Failed to save settings: ' + (error instanceof Error ? error.message : 'Unknown error');
      if (setError) {
        setError(msg);
      }
      setLocalError(msg);
      setSaveSuccess(null);
    }
  };

  // Handler functions
  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    console.log('📁 File selected:', file);
    
    if (file) {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        alert('Please upload a valid image file (JPEG, PNG, GIF, or WebP)');
        return;
      }
      
      if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
        alert(`File size must be ${MAX_DOCUMENT_UPLOAD_MB}MB or less`);
        return;
      }
      
      console.log('✅ File validation passed, setting logoFile in settings');
      setSettings(prev => ({
        ...prev,
        branding: { ...prev.branding, logoFile: file }
      }));
      
      const reader = new FileReader();
      reader.onload = (e) => {
        setLogoPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      console.log('❌ No file selected');
    }
  };

  const handleRemoveLogo = () => {
    setSettings(prev => ({
      ...prev,
      branding: { ...prev.branding, logoFile: undefined, logoUrl: '' }
    }));
    setLogoPreview(null);
  };

  const handleMobileAppImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      alert('Please upload a valid image file (JPEG, PNG, GIF, or WebP)');
      return;
    }
    if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      alert(`File size must be ${MAX_DOCUMENT_UPLOAD_MB}MB or less`);
      return;
    }
    setSettings((prev) => ({
      ...prev,
      features: {
        ...prev.features,
        mobileApp: {
          ...prev.features.mobileApp,
          appImageFile: file
        }
      }
    }));
    const reader = new FileReader();
    reader.onload = (e) => {
      setMobileAppFilePreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const handleRemoveMobileAppImage = () => {
    setSettings((prev) => ({
      ...prev,
      features: {
        ...prev.features,
        mobileApp: {
          ...prev.features.mobileApp,
          appImageFile: undefined,
          appImageUrl: ''
        }
      }
    }));
    setMobileAppFilePreview(null);
  };

  const handleVerifyDomain = async () => {
    if (!currentTenant.CustomDomain) {
      if (setError) setError('Please enter a domain to verify');
      return;
    }

    setDomainVerifying(true);
    setDomainVerificationResult(null);
    
    try {
      const response: any = await apiService.post(`/api/custom-domains/verify`, {
        tenantId: tenant.TenantId,
        subdomainOption: selectedSubdomain,
        domainName: extractBaseDomain(currentTenant.CustomDomain)
      });

      if (!response.success) {
        throw new Error(response.message || 'Domain verification failed');
      }

      const responseData = response.data;
      const verificationStatus = (responseData.status as DomainVerificationStatus) || 'pending';
      const normalizedVerificationStatus: 'pending' | 'verified' | 'failed' =
        verificationStatus === 'verified'
          ? 'verified'
          : verificationStatus === 'failed'
            ? 'failed'
            : 'pending';
      
      setDomainVerificationResult({
        success: verificationStatus === 'verified',
        status: verificationStatus,
        message: responseData.message,
        details: {
          provisioningState: responseData.provisioningState,
          deploymentStatus: responseData.deploymentStatus,
          domainValidationState: responseData.domainValidationState,
          endpointAssociation: responseData.endpointAssociation,
          hostName: responseData.hostName,
          validationToken: responseData.validationToken,
          id: responseData.id,
          status: verificationStatus,
          associationError: responseData.associationError ?? undefined
        }
      });
      
      setSettings(prev => ({
        ...prev,
        domain: { ...prev.domain, verificationStatus: normalizedVerificationStatus }
      }));
      
    } catch (error) {
      console.error('Error verifying domain:', error);
      setDomainVerificationResult({
        success: false,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Domain verification failed'
      });
      setSettings(prev => ({
        ...prev,
        domain: { ...prev.domain, verificationStatus: 'failed' }
      }));
    } finally {
      setDomainVerifying(false);
    }
  };

  const handleConfigureDomain = async () => {
    if (!domainInputValue.trim()) {
      if (setError) setError('Please enter a domain to configure');
      return;
    }

    // If tenant already has a custom domain, don't call configure API
    if (currentTenant.CustomDomain) {
      if (setError) setError('Domain is already configured. Please use the Verify button to check DNS status.');
      return;
    }

    setDomainConfiguring(true);
    setDomainVerificationResult(null);
    setDomainConfigProgress('Creating domain in Azure...');
    
    try {
      // Set longer timeout for domain configuration (up to 3 minutes)
      const response: any = await apiService.post(`/api/custom-domains/configure`, {
        tenantId: tenant.TenantId,
        subdomainOption: selectedSubdomain,
        domainName: domainInputValue.trim()
      }, {
        timeout: 200000 // 3 minutes 20 seconds to account for polling
      });

      console.log('🔍 FRONTEND RECEIVED RESPONSE:', JSON.stringify(response, null, 2));

      if (!response.success) {
        throw new Error(response.message || 'Domain configuration failed');
      }

      const responseData = response.data;
      
      // Store DNS records for display
      console.log('🔍 Setting DNS records:', {
        cname: responseData.cname,
        txt: responseData.txt
      });
      
      setDnsRecords({
        cname: responseData.cname,
        txt: responseData.txt
      });
      setDnsRecordsLoading(false);
      
      setDomainConfigured(true);
      setDomainVerificationResult({
        success: true,
        status: 'pending',
        message: responseData.message,
        details: {
          cname: responseData.cname,
          hostName: responseData.hostName,
          validationToken: responseData.validationToken,
          provisioningState: responseData.provisioningState,
          domainId: responseData.domainId,
          isNewDomain: !responseData.isExisting,
          status: 'pending'
        }
      });

      // Update tenant state with the new custom domain
      setCurrentTenant(prev => ({
        ...prev,
        CustomDomain: responseData.hostName
      }));
      
    } catch (error) {
      console.error('Error configuring domain:', error);
      const errorMessage = error instanceof Error ? error.message : 'Domain configuration failed';
      
      // Check if it's the "domain already configured" error
      if (errorMessage.includes('Domain is already configured') || errorMessage.includes('already configured')) {
        setDomainConfigured(true);
        setDomainVerificationResult({
          success: true,
          status: 'pending',
          message: errorMessage,
          details: { isExisting: true, status: 'pending' }
        });
      } else {
        setDomainVerificationResult({
          success: false,
          status: 'failed',
          message: errorMessage
        });
      }
    } finally {
      setDomainConfiguring(false);
      setDomainConfigProgress('');
    }
  };

  const handleResetDomain = async (removeFromAzure: boolean) => {
    if (!currentTenant.CustomDomain) {
      return;
    }

    const message = removeFromAzure
      ? 'Remove this domain from Azure Front Door and from this tenant? The domain will no longer point here.'
      : 'Remove this domain from the tenant only? The domain will remain in Azure (you can reattach it later or use it elsewhere).';
    if (!confirm(message)) {
      return;
    }

    setDomainConfiguring(true);
    
    try {
      const response: any = await apiService.delete(`/api/custom-domains`, {
        data: {
          tenantId: tenant.TenantId,
          subdomainOption: selectedSubdomain,
          domainName: extractBaseDomain(currentTenant.CustomDomain),
          removeFromAzure
        }
      });

      if (!response.success) {
        throw new Error(response.message || 'Domain reset failed');
      }

      // Reset state
      setDomainConfigured(false);
      setDnsRecords(null);
      setDnsRecordsLoading(false);
      setDomainVerificationResult(null);
      setDomainInputValue(''); // Reset input field
      
      // Reset domain to empty
      setCurrentTenant(prev => ({
        ...prev,
        CustomDomain: ''
      }));
      
    } catch (error) {
      console.error('Error resetting domain:', error);
      if (setError) setError(error instanceof Error ? error.message : 'Failed to reset domain');
    } finally {
      setDomainConfiguring(false);
    }
  };

  const tabs = [
    { id: 'branding', label: 'Branding', icon: Palette },
    { id: 'mobileapp', label: 'Mobile App', icon: Smartphone },
    { id: 'aiknowledge', label: 'AI Knowledge', icon: Brain },
    { id: 'domain', label: 'Custom Domain', icon: Globe },
    { id: 'email', label: 'Email Settings', icon: Mail },
    { id: 'agentonboarding', label: 'Agent Onboarding', icon: UserPlus },
    { id: 'paymentprocessing', label: 'Merchant Setup', icon: DollarSign },
    { id: 'overrideaccounts', label: 'Override Accounts', icon: CreditCard },
    { id: 'tenantpayoutaccount', label: 'Tenant Payout Account', icon: CreditCard },
    { id: 'systemfees', label: 'System Fees', icon: DollarSign },
    { id: 'setupfee', label: 'Setup Fee', icon: DollarSign },
    { id: 'payouts', label: 'Payouts', icon: Banknote },
    { id: 'enrollment', label: 'Enrollment', icon: Settings },
    { id: 'marketinglinks', label: 'Marketing Links', icon: Link },
    { id: 'websiteintegration', label: 'Website Integration', icon: KeyRound }
  ];

  const visibleTabs = settings.isExternalBilling
    ? tabs.filter((tab) => tab.id !== 'paymentprocessing')
    : tabs;

  useEffect(() => {
    if (settings.isExternalBilling && activeTab === 'paymentprocessing') {
      setActiveTab('enrollment');
    }
  }, [settings.isExternalBilling, activeTab]);

  const verificationStatus = domainVerificationResult?.status ?? (domainVerificationResult?.success ? 'verified' : undefined);
  const isVerificationProcessing = verificationStatus === 'pending';
  const isVerificationFailed = verificationStatus === 'failed';
  const isVerificationSucceeded = verificationStatus === 'verified';
  const deploymentStatusDisplay = domainVerificationResult?.details
    ? formatLifecycleStatus(domainVerificationResult.details.deploymentStatus)
    : '';
  const provisioningStateDisplay = domainVerificationResult?.details
    ? formatLifecycleStatus(domainVerificationResult.details.provisioningState)
    : '';
  const endpointAssociationDisplay = domainVerificationResult?.details
    ? formatEndpointAssociation(domainVerificationResult.details.endpointAssociation)
    : '';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] min-h-[70vh] overflow-hidden flex">
        {/* Sidebar */}
        <div className="w-64 bg-gray-50 border-r border-gray-200 p-4">
          <div className="flex items-center gap-3 mb-6">
            <div 
              className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold overflow-hidden"
              style={{ backgroundColor: logoPreview ? 'transparent' : (tenant.PrimaryColorHex || '#1f6db0') }}
            >
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt={`${tenant.Name} logo`}
                  className="w-full h-full object-contain"
                />
              ) : (
                tenant.Name.charAt(0)
              )}
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{tenant.Name}</h3>
              <p className="text-sm text-gray-500">Advanced Configuration</p>
            </div>
          </div>

          <nav className="space-y-2">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-oe-primary text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">
                {visibleTabs.find(t => t.id === activeTab)?.label ?? tabs.find(t => t.id === activeTab)?.label}
              </h2>
              <p className="text-gray-600 mt-1">
                Configure advanced settings for {tenant.Name}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {isSysAdmin && !initialLoading && (
                <button
                  type="button"
                  onClick={() => {
                    setCopySourceTenantId('');
                    setCopyFromTenantModalOpen(true);
                  }}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  <Copy className="h-4 w-4" />
                  Copy from tenant
                </button>
              )}
              <button onClick={() => {
              // Refresh tenants list when modal closes
              if (onSave) {
                onSave();
              }
              onClose();
            }} className="text-gray-400 hover:text-gray-600">
              <X size={24} />
            </button>
            </div>
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto p-6">
            {initialLoading && (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                <span className="ml-3 text-gray-600">Loading settings...</span>
              </div>
            )}
            {!initialLoading && (
              <>
            {/* Domain Tab with improved DNS settings */}
            {activeTab === 'domain' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Custom Domain
                  </label>
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <select
                        value={selectedSubdomain}
                        onChange={(e) => {
                          const newSubdomain = e.target.value as 'app' | 'portal' | 'enroll';
                          setSelectedSubdomain(newSubdomain);
                        }}
                        className={`px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-white ${
                          domainConfigured ? 'bg-gray-50 cursor-not-allowed' : ''
                        }`}
                        disabled={domainConfigured}
                      >
                        <option value="app">app</option>
                        <option value="portal">portal</option>
                        <option value="enroll">enroll</option>
                      </select>
                      <span className="flex items-center text-gray-500">.</span>
                      <input
                        type="text"
                        value={domainConfigured ? extractBaseDomain(currentTenant.CustomDomain || '') : domainInputValue}
                        onChange={(e) => {
                          if (!domainConfigured) {
                            setDomainInputValue(e.target.value);
                          }
                        }}
                        className={`flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                          domainConfigured ? 'bg-gray-50 cursor-not-allowed' : ''
                        }`}
                        placeholder="yourdomain.com"
                        disabled={domainConfigured}
                      />
                      {!domainConfigured ? (
                        <button
                          onClick={handleConfigureDomain}
                          disabled={domainConfiguring || !domainInputValue.trim() || !!currentTenant.CustomDomain}
                          className="btn-primary flex items-center disabled:opacity-50 disabled:cursor-not-allowed mr-2"
                        >
                          {domainConfiguring ? (
                            <>
                              <Loader2 className="animate-spin mr-2" size={16} />
                              {domainConfigProgress || 'Configuring...'}
                            </>
                          ) : (
                            <>
                              <Settings size={16} className="mr-2" />
                              Configure
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={handleVerifyDomain}
                          disabled={domainVerifying}
                          className="btn-secondary flex items-center disabled:opacity-50 disabled:cursor-not-allowed mr-2"
                        >
                          {domainVerifying ? (
                            <>
                              <Loader2 className="animate-spin mr-2" size={16} />
                              Verifying...
                            </>
                          ) : (
                            <>
                              <CheckCircle size={16} className="mr-2" />
                              Verify DNS
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    
                    
                    
                    {/* Domain status display */}
                    {currentTenant.CustomDomain && (
                      <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start">
                            <Info className="h-5 w-5 text-blue-400 mr-2 mt-0.5" />
                            <div className="text-sm text-blue-800">
                              <p className="font-medium mb-2">Current Custom Domain</p>
                              <p className="font-mono text-blue-900">{currentTenant.CustomDomain}</p>
                              <p className="text-xs mt-2 text-oe-primary-dark">
                                You can only have one custom domain configured. To change it, delete the current domain first.
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <button
                              onClick={() => handleResetDomain(false)}
                              disabled={domainConfiguring}
                              className="border border-gray-300 text-gray-700 hover:bg-gray-50 px-3 py-1 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                              title="Remove from this tenant only; domain stays in Azure"
                            >
                              Remove from app only
                            </button>
                            <button
                              onClick={() => handleResetDomain(true)}
                              disabled={domainConfiguring}
                              className="btn-danger flex items-center disabled:opacity-50 disabled:cursor-not-allowed text-sm px-3 py-1"
                              title="Remove from Azure Front Door and this tenant"
                            >
                              <X size={14} className="mr-1" />
                              Delete from Azure & app
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Domain verification result */}
                    {domainVerificationResult && (
                      <div className={`border rounded-md p-3 ${
                        isVerificationSucceeded
                          ? (domainVerificationResult.details?.provisioningState === 'Succeeded'
                              ? 'bg-green-50 border-green-200'
                              : 'bg-blue-50 border-blue-200')
                          : isVerificationProcessing
                            ? 'bg-amber-50 border-amber-200'
                            : 'bg-red-50 border-red-200'
                      }`}>
                        <div className="flex items-start">
                          {isVerificationSucceeded ? (
                            domainVerificationResult.details?.provisioningState === 'Succeeded' ? (
                              <CheckCircle className="h-4 w-4 text-green-500 mr-2 mt-0.5" />
                            ) : (
                              <Info className="h-4 w-4 text-blue-500 mr-2 mt-0.5" />
                            )
                          ) : isVerificationProcessing ? (
                            <Info className="h-4 w-4 text-amber-500 mr-2 mt-0.5" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-red-500 mr-2 mt-0.5" />
                          )}
                          <div className="text-sm flex-1">
                            <p className={`font-medium ${
                              isVerificationSucceeded
                                ? 'text-green-800'
                                : isVerificationProcessing
                                  ? 'text-amber-800'
                                  : 'text-red-800'
                            }`}>
                              {isVerificationSucceeded
                                ? (domainVerificationResult.details?.provisioningState === 'Succeeded'
                                    ? 'Domain Verified Successfully'
                                    : 'DNS Configuration Required')
                                : isVerificationProcessing
                                  ? 'Verification Processing'
                                  : 'Verification Failed'}
                            </p>
                            <p className={`text-xs mt-1 ${
                              isVerificationSucceeded
                                ? 'text-oe-primary-dark'
                                : isVerificationProcessing
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }`}>
                              {domainVerificationResult.message}
                            </p>
                            {domainVerificationResult.details?.associationError && (
                              <div className="mt-2 p-2 rounded border border-amber-300 bg-amber-50 text-amber-900 text-xs">
                                <p className="font-medium">Route association error (traffic may not reach your app until fixed):</p>
                                <p className="mt-1 font-mono break-all">{domainVerificationResult.details.associationError}</p>
                                <p className="mt-1 italic">Add this domain to the route in Azure Portal (Front Door → Routes → default-route → Custom domains) or retry Verify after a backend update.</p>
                              </div>
                            )}
                            {/* Show Azure Front Door validation details */}
                            {domainVerificationResult.details && (
                              <div className="mt-2 text-xs space-y-2">
                                {domainVerificationResult.details.provisioningState && (
                                  <div className="bg-blue-50 border border-blue-200 rounded p-2">
                                    <p className="font-medium text-blue-800">Provisioning State:</p>
                                    <p className={`text-xs ${statusColorClass(provisioningStateDisplay || domainVerificationResult.details.provisioningState)}`}>
                                      {provisioningStateDisplay || domainVerificationResult.details.provisioningState}
                                    </p>
                                  </div>
                                )}
                                {domainVerificationResult.details.deploymentStatus && (
                                  <div className="bg-blue-50 border border-blue-200 rounded p-2">
                                    <p className="font-medium text-blue-800">Deployment Status:</p>
                                    <p className={`text-xs ${statusColorClass(deploymentStatusDisplay || domainVerificationResult.details.deploymentStatus)}`}>
                                      {deploymentStatusDisplay || domainVerificationResult.details.deploymentStatus}
                                    </p>
                                  </div>
                                )}
                                {domainVerificationResult.details.endpointAssociation && (
                                  <div className="bg-blue-50 border border-blue-200 rounded p-2">
                                    <p className="font-medium text-blue-800">Endpoint Association:</p>
                                    <p className={`text-xs ${statusColorClass(endpointAssociationDisplay || domainVerificationResult.details.endpointAssociation)}`}>
                                      {endpointAssociationDisplay || domainVerificationResult.details.endpointAssociation}
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                            
                            {(isVerificationProcessing || isVerificationFailed) && (
                              <p className={`text-xs mt-2 rounded p-2 ${
                                isVerificationProcessing
                                  ? 'text-amber-700 bg-amber-50 border border-amber-200'
                                  : 'text-red-700 bg-red-50 border border-red-200'
                              }`}>
                                <strong>Note:</strong> Please verify your DNS setup is correct and allow up to 24 hours for DNS changes to propagate globally. If you just made changes, try again later.
                              </p>
                            )}
                            
                            {domainVerificationResult.details && (
                              <div className="mt-2 text-xs space-y-1">
                                {domainVerificationResult.details.dnsRecords?.cname && (
                                  <div className="bg-white/50 rounded p-2">
                                    <p className="font-medium text-gray-700">CNAME Record:</p>
                                    <p className="text-gray-600">
                                      {domainVerificationResult.details.dnsRecords.cname.name} → {domainVerificationResult.details.dnsRecords.cname.value}
                                    </p>
                                    <p className={`text-xs ${
                                      domainVerificationResult.details.dnsRecords.cname.status === 'verified' 
                                        ? 'text-green-600' 
                                        : 'text-red-600'
                                    }`}>
                                      Status: {domainVerificationResult.details.dnsRecords.cname.status}
                                    </p>
                                  </div>
                                )}
                                {domainVerificationResult.details.dnsRecords?.ip && (
                                  <div className="bg-white/50 rounded p-2">
                                    <p className="font-medium text-gray-700">IP Resolution:</p>
                                    <p className="text-gray-600">
                                      Custom: {domainVerificationResult.details.dnsRecords.ip.customDomain}
                                    </p>
                                    <p className="text-gray-600">
                                      Reference: {domainVerificationResult.details.dnsRecords.ip.referenceDomain}
                                    </p>
                                    <p className={`text-xs ${
                                      domainVerificationResult.details.dnsRecords.ip.status === 'verified' 
                                        ? 'text-green-600' 
                                        : 'text-red-600'
                                    }`}>
                                      Status: {domainVerificationResult.details.dnsRecords.ip.status}
                                    </p>
                                  </div>
                                )}
                                {domainVerificationResult.details.instructions && (
                                  <div className="bg-yellow-50 border border-yellow-200 rounded p-2">
                                    <p className="font-medium text-yellow-800">Setup Instructions:</p>
                                    <p className="text-yellow-700 text-xs mt-1">
                                      {domainVerificationResult.details.instructions.cname}
                                    </p>
                                    <p className="text-yellow-700 text-xs">
                                      {domainVerificationResult.details.instructions.a}
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <div className="flex items-start">
                    <AlertCircle className="h-5 w-5 text-blue-400 mr-2 mt-0.5" />
                    <div className="text-sm text-blue-800">
                      <p className="font-medium mb-2">DNS Configuration Required</p>
                      <p className="mb-3">Add the following DNS record to your domain:</p>
                      <div className="bg-white border rounded p-3 font-mono text-xs w-full">
                        <div className="grid grid-cols-12 gap-6 mb-2 font-semibold">
                          <span className="col-span-1">Type</span>
                          <span className="col-span-2">Name</span>
                          <span className="col-span-8">Point To</span>
                          <span className="col-span-1" style={{marginLeft: '-20px'}}>TTL</span>
                        </div>
                        <div className="space-y-3">
                          {/* CNAME Record */}
                          <div className="grid grid-cols-12 gap-4 items-center">
                            <span className="col-span-1 text-sm font-medium">CNAME</span>
                            <div className="col-span-3 flex items-center">
                              <span className="text-sm font-mono bg-gray-50 px-2 py-1 rounded border flex-1">
                                {dnsRecords?.cname.name || selectedSubdomain}
                              </span>
                              <button
                                onClick={() => handleCopyToClipboard(dnsRecords?.cname.name || selectedSubdomain, 'CNAME Name')}
                                className="ml-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                title="Copy name"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              </button>
                            </div>
                            <div className="col-span-7 flex items-center">
                              <span className="text-sm font-mono bg-gray-50 px-2 py-1 rounded border flex-1 break-all">
                                {dnsRecordsLoading ? (
                                  <span className="text-gray-500 italic">Loading...</span>
                                ) : dnsRecords?.cname.value ? (
                                  dnsRecords.cname.value
                                ) : (
                                  <span className="text-gray-500 italic">Not configured</span>
                                )}
                              </span>
                              <button
                                onClick={() => dnsRecords?.cname.value && handleCopyToClipboard(dnsRecords.cname.value, 'CNAME Value')}
                                className="ml-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                title="Copy value"
                                disabled={!dnsRecords?.cname.value}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              </button>
                            </div>
                            <span className="col-span-1 text-sm text-gray-500">3600</span>
                          </div>
                          
                          {/* TXT Record */}
                          {dnsRecords?.txt && (
                            <div className="grid grid-cols-12 gap-4 items-center">
                              <span className="col-span-1 text-sm font-medium">TXT</span>
                              <div className="col-span-3 flex items-center">
                                <span className="text-sm font-mono bg-gray-50 px-2 py-1 rounded border flex-1 break-all">
                                  {dnsRecords.txt?.name}
                                </span>
                                <button
                                  onClick={() => dnsRecords.txt && handleCopyToClipboard(dnsRecords.txt.name, 'TXT Name')}
                                  className="ml-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                  title="Copy name"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                              </div>
                              <div className="col-span-7 flex items-center">
                                <span className="text-sm font-mono bg-gray-50 px-2 py-1 rounded border flex-1 break-all">
                                  {dnsRecords.txt?.value}
                                </span>
                                <button
                                  onClick={() => dnsRecords.txt && handleCopyToClipboard(dnsRecords.txt.value, 'TXT Value')}
                                  className="ml-2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                  title="Copy value"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                              </div>
                              <span className="col-span-1 text-sm text-gray-500">3600</span>
                            </div>
                          )}
                        </div>
                        
                        {/* Copy notification */}
                        {copiedValue && (
                          <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded-md">
                            <p className="text-sm text-green-800">
                              ✅ Copied: {copiedValue}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* URL Path Management Section */}
            {activeTab === 'domain' && (
              <div className="border-t pt-8">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Original URL</h3>
                <UrlPathManager
                  tenantId={tenant.TenantId}
                  currentUrlPath={currentTenant.DefaultUrlPath}
                  canEdit={canEditSystemFees}
                  onUrlPathSet={(urlPath) => {
                    setCurrentTenant(prev => ({
                      ...prev,
                      DefaultUrlPath: urlPath
                    }));
                  }}
                />
              </div>
            )}

            {/* Email Settings Tab with SendGrid DKIM integration */}
            {activeTab === 'email' && (
              <div className="space-y-8">
                <EmailSettingsSection 
                  settings={settings}
                  setSettings={setSettings}
                  onSave={handleSave}
                  loading={loading}
                  tenantId={currentTenant.TenantId}
                />
                {/* SMS Settings - custom from number for tenant (falls back to TWILIO_PHONE_NUMBER env) */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">SMS From Number</h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Override the default Twilio from number for this tenant. Leave blank to use the platform default (TWILIO_PHONE_NUMBER).
                  </p>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Custom SMS From Number</label>
                    <input
                      type="tel"
                      value={settings.sms?.customFromPhone || ''}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        sms: { ...(prev.sms || {}), customFromPhone: e.target.value.trim() }
                      }))}
                      placeholder="+19047365004"
                      className="form-input w-full max-w-xs"
                    />
                    <p className="mt-1 text-xs text-gray-500">E.164 format, e.g. +19047365004</p>
                  </div>
                </div>
              </div>
            )}

            {/* Branding Tab */}
            {activeTab === 'branding' && (
              <div className="space-y-8">
                {/* Logo Upload Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="mb-4">
                    <h3 className="text-lg font-medium text-gray-900 mb-2">Company Branding</h3>
                    <p className="text-sm text-gray-600">Configure your organization's visual identity and branding</p>
                  </div>
                  
                  <div>
                    <label className="form-label mb-3">
                      Company Logo
                    </label>
                  
                  <div className="flex items-start gap-4">
                    <div className="w-64 h-32 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center bg-gray-50">
                      {logoPreview ? (
                        <div className="relative w-full h-full">
                          <img
                            src={logoPreview}
                            alt="Logo preview"
                            className="w-full h-full object-contain rounded-lg"
                          />
                          <button
                            onClick={handleRemoveLogo}
                            className="absolute -top-2 -right-2 bg-oe-error text-white rounded-full p-1 hover:bg-red-700 transition-colors"
                            title="Remove logo"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <div className="text-center">
                          <Image size={24} className="text-gray-400 mx-auto mb-2" />
                          <p className="text-xs text-gray-500">No logo</p>
                        </div>
                      )}
                    </div>
                    
                    <div className="flex-1">
                      <input
                        type="file"
                        id="logoUpload"
                        accept="image/*"
                        onChange={handleLogoUpload}
                        className="hidden"
                      />
                      <label
                        htmlFor="logoUpload"
                        className="btn-primary inline-flex items-center cursor-pointer"
                      >
                        <Upload size={16} className="mr-2" />
                        Upload Logo
                      </label>
                      
                      <div className="mt-2 text-sm text-gray-500">
                        <p>• Supported formats: JPEG, PNG, GIF, WebP</p>
                        <p>• Maximum file size: {MAX_DOCUMENT_UPLOAD_MB}MB</p>
                        <p>• Recommended size: 400x400px</p>
                        <p>• Stored securely in Azure Blob Storage</p>
                      </div>
                      
                      {settings.branding.logoFile && (
                        <div className="mt-2 p-2 alert-info text-sm">
                          ✓ New logo selected: {settings.branding.logoFile.name}
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                </div>

                {/* Color Configuration Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="mb-4">
                    <h3 className="text-lg font-medium text-gray-900 mb-2">Color Configuration</h3>
                    <p className="text-sm text-gray-600">Set your organization's primary, secondary, and accent colors</p>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="form-label">
                      Primary Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={settings.branding.primaryColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, primaryColor: e.target.value }
                        }))}
                        className="w-12 h-10 border border-gray-300 rounded-md"
                      />
                      <input
                        type="text"
                        value={settings.branding.primaryColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, primaryColor: e.target.value }
                        }))}
                        className="form-input flex-1"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="form-label">
                      Secondary Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={settings.branding.secondaryColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, secondaryColor: e.target.value }
                        }))}
                        className="w-12 h-10 border border-gray-300 rounded-md"
                      />
                      <input
                        type="text"
                        value={settings.branding.secondaryColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, secondaryColor: e.target.value }
                        }))}
                        className="form-input flex-1"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="form-label">
                      Accent Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={settings.branding.accentColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, accentColor: e.target.value }
                        }))}
                        className="w-12 h-10 border border-gray-300 rounded-md"
                      />
                      <input
                        type="text"
                        value={settings.branding.accentColor}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          branding: { ...prev.branding, accentColor: e.target.value }
                        }))}
                        className="form-input flex-1"
                      />
                    </div>
                  </div>
                  </div>
                </div>

                {/* Advanced Branding Options */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <Monitor className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Advanced Branding Options</h3>
                      <p className="text-sm text-gray-600 mb-4">Additional customization options for your organization's branding</p>
                      
                      {/* Font Family Section */}
                      <div className="mb-6">
                        <h4 className="text-md font-medium text-gray-900 mb-3">Font Family</h4>
                        <select
                          value={settings.branding.fontFamily}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            branding: { ...prev.branding, fontFamily: e.target.value }
                          }))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-white"
                        >
                          <option value="Inter, system-ui, sans-serif">Inter (Default)</option>
                          <option value="Roboto, sans-serif">Roboto</option>
                          <option value="Poppins, sans-serif">Poppins</option>
                          <option value="Montserrat, sans-serif">Montserrat</option>
                          <option value="Open Sans, sans-serif">Open Sans</option>
                        </select>
                        <p className="text-xs text-gray-500 mt-2">Choose the primary font family for your organization's interface</p>
                      </div>

                      {/* Member ID Prefix Section */}
                      <div className="mb-6">
                        <h4 className="text-md font-medium text-gray-900 mb-3">Group / employee member ID prefix</h4>
                        <input
                          type="text"
                          value={settings.branding.memberIDPrefix || 'OED'}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            branding: { ...prev.branding, memberIDPrefix: e.target.value.toUpperCase() }
                          }))}
                          maxLength={10}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          placeholder="OED"
                        />
                        <p className="text-xs text-gray-500 mt-2">
                          Prefix for household member IDs when the member belongs to a group (has a GroupId), e.g. &quot;MW&quot; for MW15990123. Only affects new IDs unless you run a bulk update. Default: OED
                        </p>
                      </div>

                      <div className="mb-6">
                        <h4 className="text-md font-medium text-gray-900 mb-3">Individual member ID prefix (optional)</h4>
                        <input
                          type="text"
                          value={settings.branding.memberIDPrefixIndividual ?? ''}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            branding: {
                              ...prev.branding,
                              memberIDPrefixIndividual: e.target.value.toUpperCase()
                            }
                          }))}
                          maxLength={10}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          placeholder="Leave blank to use group prefix for everyone"
                        />
                        <p className="text-xs text-gray-500 mt-2">
                          When set, members with no GroupId (individual / direct bill) use this prefix instead of the group prefix, e.g. SW for SW15990123. Leave empty to use one prefix for all members.
                        </p>
                      </div>

                      <div className="mb-6">
                        <h4 className="text-md font-medium text-gray-900 mb-3">Agent ID prefix (optional)</h4>
                        <input
                          type="text"
                          value={settings.branding.agentIDPrefix ?? ''}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            branding: {
                              ...prev.branding,
                              agentIDPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
                            }
                          }))}
                          maxLength={10}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          placeholder="Leave blank to use default (AW)"
                        />
                        <p className="text-xs text-gray-500 mt-2">
                          Prefix for new agent IDs, e.g. &quot;MWA&quot; for MWA000124. Only affects newly-generated codes; existing agents keep their assigned IDs. Default: AW
                        </p>
                      </div>

                      {/* Custom CSS Section */}
                      <div>
                        <h4 className="text-md font-medium text-gray-900 mb-3">Custom CSS</h4>
                        <textarea
                          value={settings.branding.customCSS || ''}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            branding: { ...prev.branding, customCSS: e.target.value }
                          }))}
                          rows={6}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary font-mono text-sm"
                          placeholder="Add custom CSS here to override default styles..."
                        />
                        <p className="text-xs text-gray-500 mt-2">Add custom CSS rules to further customize your organization's appearance</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Mobile App — store links & enrollment download step */}
            {activeTab === 'mobileapp' && (
              <div className="space-y-8">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start gap-3 mb-6">
                    <Smartphone className="h-6 w-6 text-oe-primary shrink-0 mt-0.5" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-1">Mobile app links</h3>
                      <p className="text-sm text-gray-600">
                        When at least one store URL is set, members see download options on the member dashboard (desktop). If
                        &quot;Enrollment download step&quot; is on, the enrollment wizard includes an app download step at the end
                        using these URLs and the optional promo image.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-4 mb-6 pb-6 border-b border-gray-200">
                    <div>
                      <h4 className="text-md font-medium text-gray-900">Enrollment download step</h4>
                      <p className="text-sm text-gray-600 mt-1">
                        Adds a &quot;Download App&quot; step at the end of enrollment when the tenant has this enabled.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          features: {
                            ...prev.features,
                            mobileApp: {
                              ...prev.features.mobileApp,
                              enableAppDownloadStep: !prev.features.mobileApp.enableAppDownloadStep
                            }
                          }
                        }))
                      }
                      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary ${
                        settings.features.mobileApp.enableAppDownloadStep
                          ? 'bg-oe-primary justify-end'
                          : 'bg-gray-300 justify-start'
                      }`}
                    >
                      <span className="sr-only">Toggle enrollment app download step</span>
                      <span className="h-4 w-4 rounded-full bg-white shadow" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="mobile-app-store-url">
                        App Store URL (iOS)
                      </label>
                      <input
                        id="mobile-app-store-url"
                        type="url"
                        value={settings.features.mobileApp.appStoreUrl}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            features: {
                              ...prev.features,
                              mobileApp: {
                                ...prev.features.mobileApp,
                                appStoreUrl: e.target.value
                              }
                            }
                          }))
                        }
                        placeholder="https://apps.apple.com/..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="mobile-play-store-url">
                        Google Play URL (Android)
                      </label>
                      <input
                        id="mobile-play-store-url"
                        type="url"
                        value={settings.features.mobileApp.playStoreUrl}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            features: {
                              ...prev.features,
                              mobileApp: {
                                ...prev.features.mobileApp,
                                playStoreUrl: e.target.value
                              }
                            }
                          }))
                        }
                        placeholder="https://play.google.com/store/apps/..."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Promo image (optional)</label>
                    <p className="text-sm text-gray-600 mb-4">
                      Shown on the enrollment app download step. Square or phone-screenshot style images work best.
                    </p>
                    <div className="flex items-start gap-4">
                      <div className="w-48 h-48 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center bg-gray-50 overflow-hidden">
                        {mobileAppFilePreview || settings.features.mobileApp.appImageUrl ? (
                          <div className="relative w-full h-full">
                            <img
                              src={mobileAppFilePreview || settings.features.mobileApp.appImageUrl || ''}
                              alt="Mobile app promo"
                              className="w-full h-full object-contain"
                            />
                            <button
                              type="button"
                              onClick={handleRemoveMobileAppImage}
                              className="absolute -top-2 -right-2 bg-white border border-gray-200 text-red-600 rounded-full p-1 hover:bg-red-50 transition-colors"
                              title="Remove image"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <div className="text-center p-2">
                            <Image size={24} className="text-gray-400 mx-auto mb-2" />
                            <p className="text-xs text-gray-500">No image</p>
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <input
                          type="file"
                          id="mobileAppImageUpload"
                          accept="image/*"
                          onChange={handleMobileAppImageUpload}
                          className="hidden"
                        />
                        <label
                          htmlFor="mobileAppImageUpload"
                          className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark cursor-pointer"
                        >
                          <Upload size={16} className="mr-2" />
                          Upload image
                        </label>
                        <div className="mt-2 text-sm text-gray-500">
                          <p>JPEG, PNG, GIF, or WebP — max {MAX_DOCUMENT_UPLOAD_MB}MB</p>
                        </div>
                        {settings.features.mobileApp.appImageFile && (
                          <div className="mt-2 p-2 bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg">
                            New image selected: {settings.features.mobileApp.appImageFile.name}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Agent Onboarding Tab */}
            {activeTab === 'agentonboarding' && (
              <div className="space-y-8">
                {/* Header Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <UserPlus className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900 mb-2">
                        Agent Onboarding Documents
                      </h3>
                      <p className="text-gray-600 text-sm mb-4">
                        Manage required documents that agents must sign during the onboarding process. You can upload multiple agreement documents.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Document Upload Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h4 className="text-md font-semibold text-gray-900 mb-4">Upload Agent Agreement Documents</h4>
                  <div className="space-y-4">
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-gray-400 transition-colors">
                      <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                      <p className="text-sm text-gray-600 mb-2">
                        Upload agent agreement documents (PDF, DOC, DOCX)
                      </p>
                      <p className="text-xs text-gray-500 mb-4">
                        Maximum file size: {MAX_DOCUMENT_UPLOAD_MB}MB
                      </p>
                      <input
                        type="file"
                        accept=".pdf,.doc,.docx"
                        className="hidden"
                        id="agent-agreement-upload"
                        disabled={uploadingDocument}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            handleDocumentUpload(file);
                          }
                        }}
                      />
                      <label
                        htmlFor="agent-agreement-upload"
                        className={`inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 cursor-pointer ${
                          uploadingDocument ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                      >
                        {uploadingDocument ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="h-4 w-4 mr-2" />
                            Choose File
                          </>
                        )}
                      </label>
                    </div>
                  </div>
                </div>

                {/* Current Documents Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h4 className="text-md font-semibold text-gray-900 mb-4">Current Documents</h4>
                  <div className="space-y-3">
                    {agentDocuments.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                        <p className="text-sm">No agent agreement documents uploaded yet</p>
                      </div>
                    ) : (
                      agentDocuments.map((doc) => (
                        <div key={doc.FileId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                          <div className="flex items-center">
                            <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center mr-3">
                              <span className="text-red-600 text-xs font-semibold">
                                {doc.MimeType === 'application/pdf' ? 'PDF' : 'DOC'}
                              </span>
                            </div>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{doc.FileName}</p>
                              <p className="text-xs text-gray-500">
                                Uploaded on {formatDate(doc.CreatedDate)} • {formatFileSize(doc.FileSize)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button 
                              onClick={() => handleDocumentDownload(doc.FilePath, doc.FileName)}
                              className="text-oe-primary hover:text-blue-800 text-sm font-medium"
                            >
                              Download
                            </button>
                            <button 
                              onClick={() => handleDocumentDelete(doc.FileId)}
                              disabled={deletingDocument === doc.FileId}
                              className="text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                            >
                              {deletingDocument === doc.FileId ? (
                                <>
                                  <Loader2 className="h-3 w-3 inline mr-1 animate-spin" />
                                  Removing...
                                </>
                              ) : (
                                'Remove'
                              )}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Instructions Section */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex">
                    <Info className="h-5 w-5 text-blue-400 mr-2 mt-0.5" />
                    <div className="text-sm text-blue-800">
                      <p className="font-medium mb-1">How it works:</p>
                      <ul className="list-disc list-inside space-y-1 text-oe-primary-dark">
                        <li>Upload agent agreement documents that agents must sign during onboarding</li>
                        <li>You can upload multiple documents to provide different agreement types</li>
                        <li>The documents will be available in the Agent Onboarding Links section</li>
                        <li>Agents will be required to sign the appropriate document before completing their onboarding</li>
                        <li>All uploaded documents remain active and available for use</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Payment Processing Tab */}
            {activeTab === 'paymentprocessing' && (
              <div className="space-y-8">
                {/* Header Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <DollarSign className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Payment Processing Configuration</h3>
                      <p className="text-sm text-gray-600">
                        Configure which payment processor to use and how payment processing fees are handled.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Payment Processor Selection */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h4 className="text-lg font-medium text-gray-900 mb-4">Payment Processor</h4>
                  <div className="space-y-4">
                    <div>
                      <label className="form-label">
                        Select Payment Processor
                      </label>
                      <select
                        value={settings.paymentProcessing.activeProcessor}
                        onChange={(e) => {
                          setSettings(prev => ({
                            ...prev,
                            paymentProcessing: {
                              ...prev.paymentProcessing,
                              activeProcessor: e.target.value
                            }
                          }));
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-white"
                      >
                        {/* The underlying key is still "openenroll" for backward-compat with existing
                            tenant rows + backend routing, but the user-facing name is DIME — that's the
                            actual processor we integrate with (everything else is window-dressing). */}
                        <option value="openenroll">DIME</option>
                        <option value="nmi">NMI</option>

                        {/* Add more options here in the future */}
                      </select>
                      <p className="text-xs text-gray-500 mt-2">
                        Choose your preferred payment processing provider
                      </p>
                    </div>
                  </div>
                </div>

                {/* Billing timing — defer first charge to recurring schedule */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h4 className="text-lg font-medium text-gray-900 mb-4">Billing Timing</h4>
                  <div className="flex items-start">
                    <input
                      type="checkbox"
                      id="chargeFirstPaymentWithRecurring"
                      checked={settings.paymentProcessing.chargeFirstPaymentWithRecurring}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        paymentProcessing: {
                          ...prev.paymentProcessing,
                          chargeFirstPaymentWithRecurring: e.target.checked
                        }
                      }))}
                      className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary flex-shrink-0 mt-1 mr-4"
                    />
                    <div className="flex-1">
                      <label htmlFor="chargeFirstPaymentWithRecurring" className="text-base font-medium text-gray-900 cursor-pointer">
                        Charge first payment with recurring schedule
                      </label>
                      <p className="text-sm text-gray-600 mt-1">
                        When enabled, members aren&apos;t charged at enrollment. The Dime recurring schedule starts on their effective date and charges the first payment automatically. When disabled, the first month is charged immediately at enrollment and the recurring schedule starts one month later.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Daily failed-payment report (email digest) */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start mb-4">
                    <Mail className="h-5 w-5 text-blue-500 mr-2 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-lg font-medium text-gray-900">Failed payment daily report</h4>
                      <p className="text-sm text-gray-600 mt-1">
                        Each morning (UTC), we email a summary of payment attempts that failed the previous calendar day (UTC),
                        including retry number, member name, expected billing date, and days late. Leave blank to disable.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="failedPaymentDailyReportEmails">
                        Notification email addresses
                      </label>
                      <input
                        id="failedPaymentDailyReportEmails"
                        type="text"
                        value={settings.paymentProcessing.failedPaymentDailyReportEmails}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            paymentProcessing: {
                              ...prev.paymentProcessing,
                              failedPaymentDailyReportEmails: e.target.value
                            }
                          }))
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="billing@example.com, ops@example.com"
                        autoComplete="off"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Comma-separated list. Saved with Merchant Setup (PaymentProcessorSettings).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSaveFailedPaymentReportEmails}
                      disabled={loading}
                      className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Save notification emails
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* DIME Credentials */}
                {settings.paymentProcessing.activeProcessor === 'openenroll' && (
                  <div className="bg-white border border-gray-200 rounded-lg p-6">
                    {/* Webhook URL for DIME dashboard */}
                    <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                      <p className="text-sm font-medium text-gray-700 mb-1">Webhook URL (use in DIME dashboard)</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs text-gray-600 break-all bg-white px-2 py-1.5 rounded border border-gray-200">
                          {PAYMENT_WEBHOOK_URL}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(PAYMENT_WEBHOOK_URL);
                          }}
                          className="inline-flex items-center px-2 py-1.5 text-sm text-oe-primary hover:bg-blue-50 rounded border border-gray-200"
                          title="Copy URL"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-lg font-medium text-gray-900">DIME Payment Credentials</h4>
                      {(() => {
                        // Only check initialSettings to determine if credentials are configured (not current settings while editing)
                        const hasApiToken = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                            initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                        const hasWebhookSecret = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                  initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                        const hasSid = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                       initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                        const allConfigured = hasApiToken && hasWebhookSecret && hasSid;
                        
                        if (allConfigured && !editingCredentials) {
                          return (
                            <button
                              onClick={() => setEditingCredentials(true)}
                              className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-oe-primary bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                            >
                              <Settings className="h-4 w-4 mr-1.5" />
                              Edit Credentials
                            </button>
                          );
                        } else if (editingCredentials) {
                          return (
                            <button
                              onClick={() => setEditingCredentials(false)}
                              className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                            >
                              Cancel Edit
                            </button>
                          );
                        }
                        return null;
                      })()}
                    </div>
                    
                    {/* Credentials Summary - Show when configured and NOT editing */}
                    {(() => {
                      // ALWAYS hide summary when editing - show inputs instead
                      if (editingCredentials) {
                        return null;
                      }
                      
                      // Only check initialSettings to determine if credentials are configured
                      const hasApiToken = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                          initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                      const hasWebhookSecret = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                      const hasSid = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                     initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                      const environment = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.environment || 
                                         settings.paymentProcessing.processors.openenroll.dime.environment || 
                                         'demo';
                      const allConfigured = hasApiToken && hasWebhookSecret && hasSid;
                      
                      if (allConfigured) {
                        return (
                          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                            <div className="flex items-start">
                              <CheckCircle className="h-5 w-5 text-green-600 mr-3 mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <h5 className="font-medium text-green-900 mb-2">Credentials Configured</h5>
                                <div className="space-y-2 text-sm text-green-800">
                                  <div className="flex items-center justify-between">
                                    <span>API Token:</span>
                                    <span className="font-mono text-xs bg-green-100 px-2 py-1 rounded">
                                      {hasApiToken ? '••••••••••••••••' : 'Not set'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span>Webhook Secret:</span>
                                    <span className="font-mono text-xs bg-green-100 px-2 py-1 rounded">
                                      {hasWebhookSecret ? '••••••••••••••••' : 'Not set'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span>SID:</span>
                                    <span className="font-mono text-xs bg-green-100 px-2 py-1 rounded">
                                      {settings.paymentProcessing.processors.openenroll.dime.sid || 
                                       initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid || 
                                       'Not set'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between pt-2 border-t border-green-200">
                                    <span>Environment:</span>
                                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                                      environment === 'production' 
                                        ? 'bg-blue-100 text-blue-800' 
                                        : 'bg-yellow-100 text-yellow-800'
                                    }`}>
                                      {environment === 'production' ? 'Production' : 'Demo/Testing'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    
                    <div className={`space-y-4 ${(() => {
                      // ALWAYS show inputs when editing
                      if (editingCredentials) {
                        return '';
                      }
                      
                      // Hide inputs when credentials are configured and not editing (show summary instead)
                      // Only check initialSettings to determine if configured (not current settings while editing)
                      const hasApiToken = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                          initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                      const hasWebhookSecret = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                      const hasSid = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                     initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                      const allConfigured = hasApiToken && hasWebhookSecret && hasSid;
                      return allConfigured ? 'hidden' : '';
                    })()}`}>
                      {editingCredentials && (() => {
                        const hasApiToken = (initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                            initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '') ||
                                           (settings.paymentProcessing.processors.openenroll.dime.apiToken && 
                                            settings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '');
                        const hasWebhookSecret = (initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                  initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '') ||
                                                 (settings.paymentProcessing.processors.openenroll.dime.webhookSecret && 
                                                  settings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '');
                        if (hasApiToken || hasWebhookSecret) {
                          return (
                            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                              <div className="flex items-start">
                                <Info className="h-4 w-4 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
                                <div className="text-sm text-blue-800">
                                  <p className="font-medium mb-1">Updating Credentials</p>
                                  <p>Enter new values to update your credentials. Leave fields blank to keep existing values. Sensitive credentials (API Token, Webhook Secret) are not displayed for security reasons.</p>
                                </div>
                              </div>
                            </div>
                          );
                        }
                        return null;
                      })()}

                      {/* API Token */}
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <label className="form-label mb-0">
                            API Token
                          </label>
                          {(() => {
                            const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                                   initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                            const currentValue = settings.paymentProcessing.processors.openenroll.dime.apiToken?.trim() || '';
                            // Only show "Saved" if there's an initial value AND current value matches it (or is empty, meaning using saved value)
                            const isSaved = hasInitialValue && (currentValue === '' || currentValue === initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim());
                            
                            if (isSaved) {
                              return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Saved
                                </span>
                              );
                            }
                            return null;
                          })()}
                          <div className="relative group">
                            <HelpCircle className="h-4 w-4 text-gray-400 cursor-help" />
                            <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 bg-gray-900 text-white text-xs rounded-lg p-3 z-10">
                              <p className="mb-1 font-medium">How to get your API Token:</p>
                              <p>1. Log in to your DIME account</p>
                              <p>2. Go to Settings → API Keys</p>
                              <p>3. Copy the API Token</p>
                              <div className="absolute left-4 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                            </div>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type={showApiToken ? 'text' : 'password'}
                            value={settings.paymentProcessing.processors.openenroll.dime.apiToken}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              paymentProcessing: {
                                ...prev.paymentProcessing,
                                processors: {
                                  ...prev.paymentProcessing.processors,
                                  openenroll: {
                                    ...prev.paymentProcessing.processors.openenroll,
                                    dime: {
                                      ...prev.paymentProcessing.processors.openenroll.dime,
                                      apiToken: e.target.value
                                    }
                                  }
                                }
                              }
                            }))}
                            className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            placeholder={(() => {
                              const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                                     initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                              const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.apiToken && 
                                                     settings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                              if (hasInitialValue && !hasCurrentValue) {
                                return "✓ Credential saved (leave blank to keep existing value)";
                              }
                              return "Enter your DIME API Token";
                            })()}
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiToken(!showApiToken)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          >
                            {showApiToken ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                        {(() => {
                          const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.apiToken && 
                                                 initialSettings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                          const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.apiToken && 
                                                 settings.paymentProcessing.processors.openenroll.dime.apiToken.trim() !== '';
                          if (hasInitialValue && !hasCurrentValue) {
                            return (
                              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                                <CheckCircle className="h-3 w-3" />
                                Credential is saved. Leave blank to keep existing value or enter new value to update.
                              </p>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* SID (Subscriber ID) */}
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <label className="form-label mb-0">
                            SID (Subscriber ID)
                          </label>
                          {(() => {
                            const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                                   initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                            const currentValue = settings.paymentProcessing.processors.openenroll.dime.sid?.trim() || '';
                            // Only show "Saved" if there's an initial value AND current value matches it (or is empty, meaning using saved value)
                            const isSaved = hasInitialValue && (currentValue === '' || currentValue === initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim());
                            
                            if (isSaved) {
                              return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Saved
                                </span>
                              );
                            }
                            return null;
                          })()}
                          <div className="relative group">
                            <HelpCircle className="h-4 w-4 text-gray-400 cursor-help" />
                            <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 bg-gray-900 text-white text-xs rounded-lg p-3 z-10">
                              <p className="mb-1 font-medium">How to get your SID:</p>
                              <p>1. Log in to your DIME account</p>
                              <p>2. Go to Settings → Account Info</p>
                              <p>3. Copy your Subscriber ID (SID)</p>
                              <div className="absolute left-4 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                            </div>
                          </div>
                        </div>
                        <input
                          type="text"
                          value={settings.paymentProcessing.processors.openenroll.dime.sid}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            paymentProcessing: {
                              ...prev.paymentProcessing,
                              processors: {
                                ...prev.paymentProcessing.processors,
                                openenroll: {
                                  ...prev.paymentProcessing.processors.openenroll,
                                  dime: {
                                    ...prev.paymentProcessing.processors.openenroll.dime,
                                    sid: e.target.value
                                  }
                                }
                              }
                            }
                          }))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          placeholder={(() => {
                            const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                                   initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                            const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.sid && 
                                                   settings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                            if (hasInitialValue && !hasCurrentValue) {
                              return "✓ Credential saved (leave blank to keep existing value)";
                            }
                            return "Enter your DIME SID (e.g., 00119)";
                          })()}
                        />
                        {(() => {
                          const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.sid && 
                                                 initialSettings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                          const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.sid && 
                                                 settings.paymentProcessing.processors.openenroll.dime.sid.trim() !== '';
                          if (hasInitialValue && !hasCurrentValue) {
                            return (
                              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                                <CheckCircle className="h-3 w-3" />
                                Credential is saved. Leave blank to keep existing value or enter new value to update.
                              </p>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* Webhook Secret */}
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <label className="form-label mb-0">
                            Webhook Secret
                          </label>
                          {(() => {
                            const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                   initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                            const currentValue = settings.paymentProcessing.processors.openenroll.dime.webhookSecret?.trim() || '';
                            // Only show "Saved" if there's an initial value AND current value matches it (or is empty, meaning using saved value)
                            const isSaved = hasInitialValue && (currentValue === '' || currentValue === initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim());
                            
                            if (isSaved) {
                              return (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Saved
                                </span>
                              );
                            }
                            return null;
                          })()}
                          <div className="relative group">
                            <HelpCircle className="h-4 w-4 text-gray-400 cursor-help" />
                            <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 bg-gray-900 text-white text-xs rounded-lg p-3 z-10">
                              <p className="mb-1 font-medium">How to get your Webhook Secret:</p>
                              <p>1. Log in to your DIME account</p>
                              <p>2. Go to Settings → Webhooks</p>
                              <p>3. Create or view your webhook</p>
                              <p>4. Copy the Webhook Secret</p>
                              <div className="absolute left-4 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                            </div>
                          </div>
                        </div>
                        <div className="relative">
                          <input
                            type={showWebhookSecret ? 'text' : 'password'}
                            value={settings.paymentProcessing.processors.openenroll.dime.webhookSecret}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              paymentProcessing: {
                                ...prev.paymentProcessing,
                                processors: {
                                  ...prev.paymentProcessing.processors,
                                  openenroll: {
                                    ...prev.paymentProcessing.processors.openenroll,
                                    dime: {
                                      ...prev.paymentProcessing.processors.openenroll.dime,
                                      webhookSecret: e.target.value
                                    }
                                  }
                                }
                              }
                            }))}
                            className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            placeholder={(() => {
                              const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                     initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                              const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.webhookSecret && 
                                                     settings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                              if (hasInitialValue && !hasCurrentValue) {
                                return "✓ Credential saved (leave blank to keep existing value)";
                              }
                              return "Enter your DIME Webhook Secret";
                            })()}
                          />
                          <button
                            type="button"
                            onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          >
                            {showWebhookSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                        {(() => {
                          const hasInitialValue = initialSettings?.paymentProcessing?.processors?.openenroll?.dime?.webhookSecret && 
                                                 initialSettings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                          const hasCurrentValue = settings.paymentProcessing.processors.openenroll.dime.webhookSecret && 
                                                 settings.paymentProcessing.processors.openenroll.dime.webhookSecret.trim() !== '';
                          if (hasInitialValue && !hasCurrentValue) {
                            return (
                              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                                <CheckCircle className="h-3 w-3" />
                                Credential is saved. Leave blank to keep existing value or enter new value to update.
                              </p>
                            );
                          }
                          return (
                        <p className="text-xs text-gray-500 mt-1">
                          Required for receiving payment status updates
                        </p>
                          );
                        })()}
                      </div>

                      {/* Environment Selection - Always visible */}
                        <div>
                          <label className="form-label">
                            Environment
                          </label>
                          <select
                            value={settings.paymentProcessing.processors.openenroll.dime.environment}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              paymentProcessing: {
                                ...prev.paymentProcessing,
                                processors: {
                                  ...prev.paymentProcessing.processors,
                                  openenroll: {
                                    ...prev.paymentProcessing.processors.openenroll,
                                    dime: {
                                      ...prev.paymentProcessing.processors.openenroll.dime,
                                      environment: e.target.value as 'demo' | 'production'
                                    }
                                  }
                                }
                              }
                            }))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-white"
                          >
                            <option value="production">Production</option>
                            <option value="demo">Demo/Testing</option>
                          </select>
                        <p className="text-xs text-gray-500 mt-1">
                          {isLocalhost ? 'You can switch between demo and production on localhost' : 'Environment is set by the system'}
                        </p>
                        </div>
                      
                      {/* Save Button for Credentials */}
                      {editingCredentials && (
                        <div className="mt-6 pt-6 border-t border-gray-200">
                          <button
                            type="button"
                            onClick={handleSaveCredentials}
                            disabled={loading}
                            className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                          >
                            {loading ? (
                              <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Saving...
                              </>
                            ) : (
                              <>
                                <Save className="h-4 w-4 mr-2" />
                                Confirm & Save
                              </>
                            )}
                          </button>
                          <p className="text-xs text-gray-500 mt-2">
                            This will save your payment processing credentials.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* NMI Credentials — only show when NMI is selected */}
{settings.paymentProcessing.activeProcessor === 'nmi' && (
  <div className="bg-white border border-gray-200 rounded-lg p-6">
    <h4 className="text-lg font-medium text-gray-900 mb-4">NMI Credentials</h4>
    <div className="space-y-4">

      {/* Security Key */}
      <div>
        <label className="form-label">Security Key</label>
        <input
          type="password"
          value={settings.paymentProcessing.processors.openenroll.nmi?.securityKey || ''}
          onChange={(e) => setSettings(prev => ({
            ...prev,
            paymentProcessing: {
              ...prev.paymentProcessing,
              processors: {
                ...prev.paymentProcessing.processors,
                openenroll: {
                  ...prev.paymentProcessing.processors.openenroll,
                  nmi: {
                    ...prev.paymentProcessing.processors.openenroll.nmi,
                    securityKey: e.target.value
                  }
                }
              }
            }
          }))}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
          placeholder="Enter your NMI Security Key"
        />
        <p className="text-xs text-gray-500 mt-1">
          Found in NMI dashboard → Settings → Security Keys
        </p>
      </div>

      {/* Collect.js Tokenization Key */}
      <div>
        <label className="form-label">Collect.js Public Key</label>
        <input
          type="text"
          value={settings.paymentProcessing.processors.openenroll.nmi?.collectJsKey || ''}
          onChange={(e) => setSettings(prev => ({
            ...prev,
            paymentProcessing: {
              ...prev.paymentProcessing,
              processors: {
                ...prev.paymentProcessing.processors,
                openenroll: {
                  ...prev.paymentProcessing.processors.openenroll,
                  nmi: {
                    ...prev.paymentProcessing.processors.openenroll.nmi,
                    collectJsKey: e.target.value
                  }
                }
              }
            }
          }))}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
          placeholder="Enter your NMI Collect.js Public Key"
        />
        <p className="text-xs text-gray-500 mt-1">
          Public key for card tokenization — safe to expose in frontend
        </p>
      </div>

      {/* Environment Toggle */}
      <div>
        <label className="form-label">Environment</label>
        <select
          value={settings.paymentProcessing.processors.openenroll.nmi?.environment || 'sandbox'}
          onChange={(e) => setSettings(prev => ({
            ...prev,
            paymentProcessing: {
              ...prev.paymentProcessing,
              processors: {
                ...prev.paymentProcessing.processors,
                openenroll: {
                  ...prev.paymentProcessing.processors.openenroll,
                  nmi: {
                    ...prev.paymentProcessing.processors.openenroll.nmi,
                    environment: e.target.value as 'sandbox' | 'production'
                  }
                }
              }
            }
          }))}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-white"
        >
          <option value="sandbox">Sandbox (Testing)</option>
          <option value="production">Production (Live)</option>
        </select>
      </div>

    </div>
  </div>
)}

                {/* Processing Fees Configuration */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="text-lg font-medium text-gray-900">Processing Fees</h4>
                    {(() => {
                      const hasAchFees = (settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee > 0 || 
                                         settings.paymentProcessing.processors.openenroll.fees.ach.flatFee > 0) ||
                                        ((initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.percentageFee ?? 0) > 0 ||
                                         (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.flatFee ?? 0) > 0);
                      const hasCreditCardFees = (settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee > 0 || 
                                                settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee > 0) ||
                                               ((initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.percentageFee ?? 0) > 0 ||
                                                (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.flatFee ?? 0) > 0);
                      const feesConfigured = hasAchFees || hasCreditCardFees;
                      
                      if (feesConfigured && !editingFees) {
                        return (
                          <button
                            onClick={() => setEditingFees(true)}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-oe-primary bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                          >
                            <Settings className="h-4 w-4 mr-1.5" />
                            Edit Fees
                          </button>
                        );
                      } else if (editingFees) {
                        return (
                          <button
                            onClick={() => setEditingFees(false)}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                          >
                            Cancel Edit
                          </button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  
                  {/* Fees Summary - Show when configured and NOT editing */}
                  {(() => {
                    // ALWAYS hide summary when editing - show inputs instead
                    if (editingFees) {
                      return null;
                    }
                    
                    // Check if we have payment processor settings with fees structure (even if values are 0)
                    const hasPaymentSettings = !!initialSettings?.paymentProcessing || 
                                              (settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee > 0 || 
                                               settings.paymentProcessing.processors.openenroll.fees.ach.flatFee > 0 ||
                                               settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee > 0 ||
                                               settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee > 0);
                    
                    const achPercentage = settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee || 
                                         (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.percentageFee || 0);
                    const achFlat = settings.paymentProcessing.processors.openenroll.fees.ach.flatFee || 
                                   initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.flatFee || 0;
                    const ccPercentage = settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee || 
                                        (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.percentageFee || 0);
                    const ccFlat = settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee || 
                                  initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.flatFee || 0;
                    const hasAchFees = achPercentage > 0 || achFlat > 0;
                    const hasCreditCardFees = ccPercentage > 0 || ccFlat > 0;
                    const feesConfigured = hasPaymentSettings && (hasAchFees || hasCreditCardFees);
                    const chargeToMember = settings.paymentProcessing.chargeFeeToMember ?? 
                                         initialSettings?.paymentProcessing?.chargeFeeToMember ?? false;
                    
                    if (feesConfigured) {
                      return (
                        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                          <div className="flex items-start">
                            <CheckCircle className="h-5 w-5 text-green-600 mr-3 mt-0.5 flex-shrink-0" />
                            <div className="flex-1">
                              <h5 className="font-medium text-green-900 mb-2">Processing Fees Configured</h5>
                              <div className="space-y-2 text-sm text-green-800">
                                <div className="flex items-center justify-between pt-2 border-t border-green-200">
                                  <span>Fee Charged To:</span>
                                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                                    chargeToMember 
                                      ? 'bg-blue-100 text-blue-800' 
                                      : 'bg-gray-100 text-gray-800'
                                  }`}>
                                    {chargeToMember ? 'Member' : 'Organization'}
                                  </span>
                                </div>
                                {hasAchFees && (
                                  <div className="pt-2 border-t border-green-200">
                                    <div className="font-medium mb-1">ACH (Bank Account) Fees:</div>
                                    <div className="pl-2 space-y-1">
                                      {achPercentage > 0 && (
                                        <div className="flex items-center justify-between">
                                          <span>Percentage:</span>
                                          <span className="font-mono">{achPercentage.toFixed(6)}%</span>
                                        </div>
                                      )}
                                      {achFlat > 0 && (
                                        <div className="flex items-center justify-between">
                                          <span>Flat Fee:</span>
                                          <span className="font-mono">${achFlat.toFixed(2)}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                                {hasCreditCardFees && (
                                  <div className="pt-2 border-t border-green-200">
                                    <div className="font-medium mb-1">Credit Card Fees:</div>
                                    <div className="pl-2 space-y-1">
                                      {ccPercentage > 0 && (
                                        <div className="flex items-center justify-between">
                                          <span>Percentage:</span>
                                          <span className="font-mono">{ccPercentage.toFixed(6)}%</span>
                                        </div>
                                      )}
                                      {ccFlat > 0 && (
                                        <div className="flex items-center justify-between">
                                          <span>Flat Fee:</span>
                                          <span className="font-mono">${ccFlat.toFixed(2)}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}
                  
                  {/* Fees Form Fields - Show when editing OR when fees not configured OR when initialSettings not loaded yet */}
                  <div className={`${(() => {
                    // ALWAYS show inputs when editing
                    if (editingFees) {
                      return '';
                    }
                    
                    // Show form if initialSettings hasn't loaded yet (data fetch in progress or failed)
                    // This ensures SysAdmin sees the form even if data fetch times out
                    if (!initialSettings || !initialSettings.paymentProcessing) {
                      return '';
                    }
                    
                    // Hide inputs when fees are configured and not editing (show summary instead)
                    const hasAchFees = (settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee > 0 || 
                                       settings.paymentProcessing.processors.openenroll.fees.ach.flatFee > 0) ||
                                      ((initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.percentageFee ?? 0) > 0 ||
                                       (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.ach?.flatFee ?? 0) > 0);
                    const hasCreditCardFees = (settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee > 0 || 
                                              settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee > 0) ||
                                             ((initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.percentageFee ?? 0) > 0 ||
                                              (initialSettings?.paymentProcessing?.processors?.openenroll?.fees?.creditCard?.flatFee ?? 0) > 0);
                    const feesConfigured = hasAchFees || hasCreditCardFees;
                    return feesConfigured ? 'hidden' : '';
                  })()}`}>
                  {/* Charge Fee to Member Toggle */}
                  <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-200">
                    <div className="flex-1">
                      <label htmlFor="chargeFeeToMember" className="text-base font-medium text-gray-900 cursor-pointer">
                        Charge payment processing fee to member
                      </label>
                      <p className="text-sm text-gray-600 mt-1">
                        When enabled, the payment processing fee will be added to the member's total payment amount.
                        When disabled, your organization will absorb the processing fees.
                      </p>
                    </div>
                    <div className="ml-6">
                      <input
                        type="checkbox"
                        id="chargeFeeToMember"
                        checked={settings.paymentProcessing.chargeFeeToMember}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          paymentProcessing: {
                            ...prev.paymentProcessing,
                            chargeFeeToMember: e.target.checked
                          }
                        }))}
                        className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary"
                      />
                    </div>
                  </div>

                  {/* ACH Fees */}
                  <div className="mb-6">
                    <h5 className="text-md font-medium text-gray-900 mb-3">ACH (Bank Account) Fees</h5>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">
                          Percentage Fee (%)
                        </label>
                        <div className="relative">
                          <input
                            type="text"
                            value={achPercentageInput || (settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee === 0 ? '' : Number(settings.paymentProcessing.processors.openenroll.fees.ach.percentageFee.toFixed(6)).toString())}
                            onChange={(e) => {
                              const inputValue = e.target.value;
                              // Allow empty, decimal point, and partial decimals while typing
                              if (inputValue === '' || inputValue === '.' || /^-?\d*\.?\d*$/.test(inputValue)) {
                                setAchPercentageInput(inputValue);
                                // Only update settings if it's a complete valid number
                                if (inputValue !== '' && inputValue !== '.' && !inputValue.endsWith('.') && !isNaN(parseFloat(inputValue))) {
                                  const numValue = parsePercentageFee(inputValue);
                                  setSettings(prev => ({
                                    ...prev,
                                    paymentProcessing: {
                                      ...prev.paymentProcessing,
                                      processors: {
                                        ...prev.paymentProcessing.processors,
                                        openenroll: {
                                          ...prev.paymentProcessing.processors.openenroll,
                                          fees: {
                                            ...prev.paymentProcessing.processors.openenroll.fees,
                                            ach: {
                                              ...prev.paymentProcessing.processors.openenroll.fees.ach,
                                              percentageFee: numValue
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }));
                                }
                              }
                            }}
                            onBlur={(e) => {
                              // Round on blur to ensure clean value and fix any floating point precision issues
                              const inputValue = e.target.value;
                              setAchPercentageInput(''); // Clear local state
                              if (inputValue !== '' && inputValue !== '.') {
                                const numValue = parsePercentageFee(inputValue);
                                setSettings(prev => ({
                                  ...prev,
                                  paymentProcessing: {
                                    ...prev.paymentProcessing,
                                    processors: {
                                      ...prev.paymentProcessing.processors,
                                      openenroll: {
                                        ...prev.paymentProcessing.processors.openenroll,
                                        fees: {
                                          ...prev.paymentProcessing.processors.openenroll.fees,
                                          ach: {
                                            ...prev.paymentProcessing.processors.openenroll.fees.ach,
                                            percentageFee: numValue
                                          }
                                        }
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            disabled={!settings.paymentProcessing.chargeFeeToMember}
                            className="w-full px-3 py-2 pr-8 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                            placeholder="0"
                            step="any"
                            min="0"
                          />
                          <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
                        </div>
                      </div>
                      <div>
                        <label className="form-label">
                          Flat Fee ($)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          <input
                            type="number"
                            value={settings.paymentProcessing.processors.openenroll.fees.ach.flatFee === 0 ? '' : settings.paymentProcessing.processors.openenroll.fees.ach.flatFee}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              paymentProcessing: {
                                ...prev.paymentProcessing,
                                processors: {
                                  ...prev.paymentProcessing.processors,
                                  openenroll: {
                                    ...prev.paymentProcessing.processors.openenroll,
                                    fees: {
                                      ...prev.paymentProcessing.processors.openenroll.fees,
                                      ach: {
                                        ...prev.paymentProcessing.processors.openenroll.fees.ach,
                                        flatFee: e.target.value === '' ? 0 : parseFloat(e.target.value) || 0
                                      }
                                    }
                                  }
                                }
                              }
                            }))}
                            disabled={!settings.paymentProcessing.chargeFeeToMember}
                            className="w-full px-3 py-2 pl-8 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                            placeholder="0"
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Credit Card Fees */}
                  <div>
                    <h5 className="text-md font-medium text-gray-900 mb-3">Credit Card Fees</h5>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">
                          Percentage Fee (%)
                        </label>
                        <div className="relative">
                          <input
                            type="text"
                            value={creditCardPercentageInput || (settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee === 0 ? '' : Number(settings.paymentProcessing.processors.openenroll.fees.creditCard.percentageFee.toFixed(6)).toString())}
                            onChange={(e) => {
                              const inputValue = e.target.value;
                              // Allow empty, decimal point, and partial decimals while typing
                              if (inputValue === '' || inputValue === '.' || /^-?\d*\.?\d*$/.test(inputValue)) {
                                setCreditCardPercentageInput(inputValue);
                                // Only update settings if it's a complete valid number
                                if (inputValue !== '' && inputValue !== '.' && !inputValue.endsWith('.') && !isNaN(parseFloat(inputValue))) {
                                  const numValue = parsePercentageFee(inputValue);
                                  setSettings(prev => ({
                                    ...prev,
                                    paymentProcessing: {
                                      ...prev.paymentProcessing,
                                      processors: {
                                        ...prev.paymentProcessing.processors,
                                        openenroll: {
                                          ...prev.paymentProcessing.processors.openenroll,
                                          fees: {
                                            ...prev.paymentProcessing.processors.openenroll.fees,
                                            creditCard: {
                                              ...prev.paymentProcessing.processors.openenroll.fees.creditCard,
                                              percentageFee: numValue
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }));
                                }
                              }
                            }}
                            onBlur={(e) => {
                              // Round on blur to ensure clean value and fix any floating point precision issues
                              const inputValue = e.target.value;
                              setCreditCardPercentageInput(''); // Clear local state
                              if (inputValue !== '' && inputValue !== '.') {
                                const numValue = parsePercentageFee(inputValue);
                                setSettings(prev => ({
                                  ...prev,
                                  paymentProcessing: {
                                    ...prev.paymentProcessing,
                                    processors: {
                                      ...prev.paymentProcessing.processors,
                                      openenroll: {
                                        ...prev.paymentProcessing.processors.openenroll,
                                        fees: {
                                          ...prev.paymentProcessing.processors.openenroll.fees,
                                          creditCard: {
                                            ...prev.paymentProcessing.processors.openenroll.fees.creditCard,
                                            percentageFee: numValue
                                          }
                                        }
                                      }
                                    }
                                  }
                                }));
                              }
                            }}
                            disabled={!settings.paymentProcessing.chargeFeeToMember}
                            className="w-full px-3 py-2 pr-8 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                            placeholder="0"
                            step="any"
                            min="0"
                          />
                          <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
                        </div>
                      </div>
                      <div>
                        <label className="form-label">
                          Flat Fee ($)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          <input
                            type="number"
                            value={settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee === 0 ? '' : settings.paymentProcessing.processors.openenroll.fees.creditCard.flatFee}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              paymentProcessing: {
                                ...prev.paymentProcessing,
                                processors: {
                                  ...prev.paymentProcessing.processors,
                                  openenroll: {
                                    ...prev.paymentProcessing.processors.openenroll,
                                    fees: {
                                      ...prev.paymentProcessing.processors.openenroll.fees,
                                      creditCard: {
                                        ...prev.paymentProcessing.processors.openenroll.fees.creditCard,
                                        flatFee: e.target.value === '' ? 0 : parseFloat(e.target.value) || 0
                                      }
                                    }
                                  }
                                }
                              }
                            }))}
                            disabled={!settings.paymentProcessing.chargeFeeToMember}
                            className="w-full px-3 py-2 pl-8 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:bg-gray-100 disabled:cursor-not-allowed"
                            placeholder="0"
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  </div>
                  {/* End of conditional fees form wrapper */}
                </div>
                
                {/* Save Button for Fees - Shows when editing fees */}
                {editingFees && (
                  <div className="mt-6 pt-6 border-t border-gray-200">
                    <button
                      type="button"
                      onClick={handleSaveFees}
                      disabled={loading}
                      className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Confirm & Save
                        </>
                      )}
                    </button>
                    <p className="text-xs text-gray-500 mt-2">
                      This will save your payment processing fees settings.
                    </p>
                  </div>
                )}

                {/* Overdue Invoice Reminders */}
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">Overdue Invoice Reminders</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        Automatically email (and optionally SMS) the responsible party when an invoice becomes overdue. Reminders stop once the invoice is paid, the member is terminated, or DIME is actively retrying.
                      </p>
                    </div>

                    <label className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={settings.billing?.overdueReminders?.enabled === true}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            billing: {
                              ...(prev.billing || {}),
                              overdueReminders: {
                                ...(prev.billing?.overdueReminders || {
                                  enabled: false,
                                  thresholdDays: 6,
                                  cadenceDays: 7,
                                  maxCount: 4,
                                  skipUnderAmount: 0,
                                  channels: { email: true, sms: false },
                                  replyToEmail: null
                                }),
                                enabled: e.target.checked
                              }
                            }
                          }))
                        }
                        className="h-4 w-4"
                      />
                      <span className="text-sm font-medium text-gray-900">Send overdue invoice reminders</span>
                    </label>

                    <div className={`grid grid-cols-1 md:grid-cols-3 gap-4 ${settings.billing?.overdueReminders?.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
                      <div>
                        <label htmlFor="overdueThresholdDays" className="block text-sm font-medium text-gray-700 mb-1">
                          Send first reminder
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="overdueThresholdDays"
                            type="number"
                            min="0"
                            max="365"
                            value={settings.billing?.overdueReminders?.thresholdDays ?? 14}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                billing: {
                                  ...(prev.billing || {}),
                                  overdueReminders: {
                                    ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                    thresholdDays: Math.max(0, Math.min(365, parseInt(e.target.value || '0', 10)))
                                  }
                                }
                              }))
                            }
                            className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                          <span className="text-sm text-gray-600">days after due date</span>
                        </div>
                      </div>
                      <div>
                        <label htmlFor="overdueCadenceDays" className="block text-sm font-medium text-gray-700 mb-1">
                          Then send another every
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="overdueCadenceDays"
                            type="number"
                            min="1"
                            max="90"
                            value={settings.billing?.overdueReminders?.cadenceDays ?? 7}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                billing: {
                                  ...(prev.billing || {}),
                                  overdueReminders: {
                                    ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                    cadenceDays: Math.max(1, Math.min(90, parseInt(e.target.value || '1', 10)))
                                  }
                                }
                              }))
                            }
                            className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                          <span className="text-sm text-gray-600">days</span>
                        </div>
                      </div>
                      <div>
                        <label htmlFor="overdueMaxCount" className="block text-sm font-medium text-gray-700 mb-1">
                          Stop after
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="overdueMaxCount"
                            type="number"
                            min="1"
                            max="20"
                            value={settings.billing?.overdueReminders?.maxCount ?? 4}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                billing: {
                                  ...(prev.billing || {}),
                                  overdueReminders: {
                                    ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                    maxCount: Math.max(1, Math.min(20, parseInt(e.target.value || '1', 10)))
                                  }
                                }
                              }))
                            }
                            className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                          <span className="text-sm text-gray-600">reminders</span>
                        </div>
                      </div>
                      <div className="md:col-span-2">
                        <label htmlFor="overdueSkipUnder" className="block text-sm font-medium text-gray-700 mb-1">
                          Skip invoices under
                        </label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-600">$</span>
                          <input
                            id="overdueSkipUnder"
                            type="number"
                            min="0"
                            step="0.01"
                            value={settings.billing?.overdueReminders?.skipUnderAmount ?? 0}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                billing: {
                                  ...(prev.billing || {}),
                                  overdueReminders: {
                                    ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                    skipUnderAmount: Math.max(0, parseFloat(e.target.value || '0'))
                                  }
                                }
                              }))
                            }
                            className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          />
                          <span className="text-xs text-gray-500">small invoices won't be chased</span>
                        </div>
                      </div>
                      <div>
                        <span className="block text-sm font-medium text-gray-700 mb-1">Channels</span>
                        <div className="flex flex-col gap-2">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={settings.billing?.overdueReminders?.channels?.email !== false}
                              onChange={(e) =>
                                setSettings((prev) => ({
                                  ...prev,
                                  billing: {
                                    ...(prev.billing || {}),
                                    overdueReminders: {
                                      ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                      channels: {
                                        email: e.target.checked,
                                        sms: prev.billing?.overdueReminders?.channels?.sms === true
                                      }
                                    }
                                  }
                                }))
                              }
                              className="h-4 w-4"
                            />
                            <span className="text-sm text-gray-700">Email</span>
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={settings.billing?.overdueReminders?.channels?.sms === true}
                              onChange={(e) =>
                                setSettings((prev) => ({
                                  ...prev,
                                  billing: {
                                    ...(prev.billing || {}),
                                    overdueReminders: {
                                      ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                      channels: {
                                        email: prev.billing?.overdueReminders?.channels?.email !== false,
                                        sms: e.target.checked
                                      }
                                    }
                                  }
                                }))
                              }
                              className="h-4 w-4"
                            />
                            <span className="text-sm text-gray-700">SMS (members only — requires consent)</span>
                          </label>
                        </div>
                      </div>
                      <div className="md:col-span-3">
                        <label htmlFor="overdueReplyTo" className="block text-sm font-medium text-gray-700 mb-1">
                          Reply-to email <span className="text-gray-400 font-normal">(optional)</span>
                        </label>
                        <input
                          id="overdueReplyTo"
                          type="email"
                          value={settings.billing?.overdueReminders?.replyToEmail || ''}
                          onChange={(e) =>
                            setSettings((prev) => ({
                              ...prev,
                              billing: {
                                ...(prev.billing || {}),
                                overdueReminders: {
                                  ...(prev.billing?.overdueReminders || { enabled: false, thresholdDays: 6, cadenceDays: 7, maxCount: 4, skipUnderAmount: 0, channels: { email: true, sms: false }, replyToEmail: null }),
                                  replyToEmail: e.target.value.trim() || null
                                }
                              }
                            }))
                          }
                          placeholder="billing@yourtenant.com"
                          className="w-full md:w-1/2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Defaults to your tenant billing contact email.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3 pt-2 border-t border-gray-100">
                      <button
                        type="button"
                        onClick={async () => {
                          setLoading(true);
                          try {
                            await handleAdvancedConfigSave(settings, { includePaymentProcessing: false, includeFees: false, includeCredentials: false });
                            await fetchTenantData();
                          } catch (err) {
                            console.error('Error saving overdue reminder settings:', err);
                            if (setError) setError('Failed to save overdue reminder settings.');
                          } finally {
                            setLoading(false);
                          }
                        }}
                        disabled={loading}
                        className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                      >
                        {loading ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <Save className="h-4 w-4 mr-2" />
                            Save reminder settings
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const channels = {
                              email: settings.billing?.overdueReminders?.channels?.email !== false,
                              sms: settings.billing?.overdueReminders?.channels?.sms === true
                            };
                            const res: any = await apiService.post(
                              `/api/tenants/${tenant.TenantId}/overdue-reminders-sample`,
                              { channels, variant: 'member' }
                            );
                            if (res?.success) {
                              setSaveSuccess('Sample reminder sent.');
                            } else if (setError) {
                              setError(res?.message || 'Failed to send sample reminder.');
                            }
                          } catch (err: any) {
                            const msg =
                              err?.responseData?.message ||
                              err?.response?.data?.message ||
                              err?.message ||
                              'Failed to send sample reminder.';
                            if (setError) setError(msg);
                          }
                        }}
                        disabled={loading}
                        className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                      >
                        Send me a sample
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'overrideaccounts' && (
              <div className="space-y-6">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">Override Accounts</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        Manage bank accounts used for override payments. Account and routing numbers are encrypted when saved.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setOverrideAccountsError(null);
                        setOverrideAccountNotice(null);
                        resetOverrideAccountForm();
                        setOverrideAccountModalMode('create');
                      }}
                      className="inline-flex items-center px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-lg hover:bg-oe-dark transition-colors"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Override Account
                    </button>
                  </div>
                </div>

                {overrideAccountNotice && (
                  <div
                    className={`px-4 py-3 border rounded-lg text-sm ${
                      overrideAccountNotice.type === 'success'
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : 'bg-red-50 border-red-200 text-red-800'
                    }`}
                  >
                    {overrideAccountNotice.message}
                  </div>
                )}

                {overrideAccountsError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm">
                    {overrideAccountsError}
                  </div>
                )}

                {isOverrideAccountModalOpen && (
                  <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
                    <div className="bg-white border border-gray-200 rounded-lg w-full max-w-2xl p-6 space-y-5 shadow-2xl">
                      {(() => {
                        const routingDigits = overrideAccountForm.routingNumber.replace(/\D/g, '');
                        const accountDigits = overrideAccountForm.accountNumber.replace(/\D/g, '');
                        const disableSubmit =
                          overrideAccountSubmitting ||
                          !overrideAccountForm.name.trim() ||
                          !overrideAccountForm.accountHolderName.trim() ||
                          !overrideAccountForm.bankName.trim() ||
                          routingDigits.length !== 9 ||
                          accountDigits.length === 0;
                        return (
                          <>
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-base font-semibold text-gray-900">
                            {overrideAccountModalMode === 'edit' ? 'Edit Override Account' : 'New Override Account'}
                          </h4>
                          <p className="text-sm text-gray-600 mt-1">
                            Provide the banking information for override distributions. Sensitive fields are stored securely.
                          </p>
                          {overrideAccountModalMode === 'edit' && (
                            <p className="text-xs text-gray-500 mt-2">
                              Routing and account numbers are required when saving changes.
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            setOverrideAccountsError(null);
                            setOverrideAccountNotice(null);
                            resetOverrideAccountForm();
                          }}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <X className="h-5 w-5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={overrideAccountForm.name}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({ ...prev, name: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Override Account"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Holder Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={overrideAccountForm.accountHolderName}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({
                                ...prev,
                                accountHolderName: e.target.value
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Health LLC"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Bank Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={overrideAccountForm.bankName}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({ ...prev, bankName: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., Chase Bank"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Type <span className="text-red-500">*</span>
                          </label>
                          <select
                            value={overrideAccountForm.bankAccountType}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({
                                ...prev,
                                bankAccountType: e.target.value as 'Checking' | 'Savings'
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="Checking">Checking</option>
                            <option value="Savings">Savings</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Routing Number <span className="text-red-500">*</span>
                          </label>
                          {overrideAccountModalMode === 'edit' && currentMaskedRouting && (
                            <p className="text-xs text-gray-500 mb-1">Current: {currentMaskedRouting}</p>
                          )}
                          <input
                            type="text"
                            value={overrideAccountForm.routingNumber}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({
                                ...prev,
                                routingNumber: e.target.value.replace(/\D/g, '').slice(0, 9)
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="Enter 9-digit routing number"
                            maxLength={9}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Number <span className="text-red-500">*</span>
                          </label>
                          {overrideAccountModalMode === 'edit' && currentMaskedAccount && (
                            <p className="text-xs text-gray-500 mb-1">Current: {currentMaskedAccount}</p>
                          )}
                          <input
                            type="text"
                            value={overrideAccountForm.accountNumber}
                            onChange={(e) =>
                              setOverrideAccountForm((prev) => ({
                                ...prev,
                                accountNumber: e.target.value.replace(/\D/g, '')
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="Enter account number"
                          />
                        </div>
                      </div>

                      <div className="text-xs text-gray-500 border-t border-gray-200 pt-3">
                        Routing numbers must contain 9 digits. Account numbers are encrypted and never displayed after saving.
                      </div>

                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => {
                            setOverrideAccountsError(null);
                            setOverrideAccountNotice(null);
                            resetOverrideAccountForm();
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSubmitOverrideAccount}
                          disabled={disableSubmit}
                          className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {overrideAccountSubmitting
                            ? 'Saving...'
                            : overrideAccountModalMode === 'edit'
                            ? 'Save Changes'
                            : 'Create Account'}
                        </button>
                      </div>
                    </>
                        );
                      })()}
                    </div>
                  </div>
                )}

                <div className="bg-white border border-gray-200 rounded-lg">
                  {overrideAccountsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-oe-primary"></div>
                    </div>
                  ) : overrideAccounts.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                      <CreditCard className="mx-auto mb-4 h-12 w-12 text-gray-300" />
                      <h4 className="text-lg font-medium text-gray-900 mb-2">No Override Accounts</h4>
                      <p className="text-sm">
                        Add an override account to prepare for managing override payment distributions.
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-[480px] overflow-y-auto pr-1">
                      <div className="divide-y divide-gray-200">
                        {overrideAccounts.map((account) => (
                        <div
                          key={account.OverrideACHId}
                          className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                        >
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <h4 className="text-lg font-semibold text-gray-900">
                                {account.AccountName || account.AccountHolderName || 'Override Account'}
                              </h4>
                              {account.IsDefault && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
                                  Default
                                </span>
                              )}
                              {!account.IsActive && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
                                  Inactive
                                </span>
                              )}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-gray-700">
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Bank Name</p>
                                <p className="text-gray-900 font-medium">{account.BankName}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Account Holder</p>
                                <p className="text-gray-900 font-medium">{account.AccountHolderName}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Account Type</p>
                                <p className="text-gray-900 font-medium">{bankAccountTypeLabel(account.BankAccountType)}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Created</p>
                                <p className="text-gray-900 font-medium">
                                  {account.CreatedDate ? new Date(account.CreatedDate).toLocaleDateString() : '—'}
                                </p>
                              </div>
                              {account.maskedRoutingNumber && (
                                <div>
                                  <p className="text-xs uppercase tracking-wide text-gray-500">Routing Number</p>
                                  <p className="text-gray-900 font-medium">{account.maskedRoutingNumber}</p>
                                </div>
                              )}
                              {account.maskedAccountNumber && (
                                <div>
                                  <p className="text-xs uppercase tracking-wide text-gray-500">Account Number</p>
                                  <p className="text-gray-900 font-medium">{account.maskedAccountNumber}</p>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center justify-end">
                            <button
                              onClick={() => {
                                setOverrideAccountsError(null);
                                setOverrideAccountNotice(null);
                                setEditingOverrideAccount(account);
                                setCurrentMaskedAccount(account.maskedAccountNumber ?? null);
                                setCurrentMaskedRouting(account.maskedRoutingNumber ?? null);
                                setOverrideAccountForm({
                                  name:
                                    account.AccountName && account.AccountName !== account.AccountHolderName
                                      ? account.AccountName
                                      : account.AccountHolderName || '',
                                  accountHolderName: account.AccountHolderName || '',
                                  bankName: account.BankName || '',
                                  accountNumber: '',
                                  routingNumber: '',
                                  bankAccountType:
                                    bankAccountTypeLabel(account.BankAccountType) === 'Savings' ? 'Savings' : 'Checking'
                                });
                                setOverrideAccountModalMode('edit');
                              }}
                              className="px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-primary hover:text-white transition-colors"
                            >
                              Edit
                            </button>
                          </div>
                        </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tenant Payout Account Tab */}
            {activeTab === 'tenantpayoutaccount' && (
              <div className="space-y-6">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">Tenant Payout Account</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        Manage the bank account used to fund tenant payouts (e.g., vendor payouts). This account will be debited when generating NACHA files for tenant payments. Account and routing numbers are encrypted when saved.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setTenantPayoutAccountsError(null);
                        setTenantPayoutAccountNotice(null);
                        resetTenantPayoutAccountForm();
                        // If no accounts exist, force default to true
                        if (tenantPayoutAccounts.length === 0) {
                          setTenantPayoutAccountForm(prev => ({ ...prev, isDefault: true }));
                        }
                        setTenantPayoutAccountModalMode('create');
                      }}
                      className="inline-flex items-center px-4 py-2 bg-oe-primary text-white text-sm font-medium rounded-lg hover:bg-oe-dark transition-colors"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Tenant Payout Account
                    </button>
                  </div>
                </div>

                {tenantPayoutAccountNotice && (
                  <div
                    className={`px-4 py-3 border rounded-lg text-sm ${
                      tenantPayoutAccountNotice.type === 'success'
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : 'bg-red-50 border-red-200 text-red-800'
                    }`}
                  >
                    {tenantPayoutAccountNotice.message}
                  </div>
                )}

                {tenantPayoutAccountsError && (
                  <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm">
                    {tenantPayoutAccountsError}
                  </div>
                )}

                {isTenantPayoutAccountModalOpen && (
                  <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
                    <div className="bg-white border border-gray-200 rounded-lg w-full max-w-2xl p-6 space-y-5 shadow-2xl">
                      {(() => {
                        const isEditing =
                          tenantPayoutAccountModalMode === 'edit' && Boolean(editingTenantPayoutAccount);
                        const routingDigits = tenantPayoutAccountForm.routingNumber.replace(/\D/g, '');
                        const accountDigits = tenantPayoutAccountForm.accountNumber.replace(/\D/g, '');
                        const isUpdatingBankNumbers = routingDigits.length > 0 || accountDigits.length > 0;
                        const bankNumbersValid = isEditing
                          ? (!isUpdatingBankNumbers || (routingDigits.length === 9 && accountDigits.length > 0))
                          : (routingDigits.length === 9 && accountDigits.length > 0);
                        const disableSubmit =
                          tenantPayoutAccountSubmitting ||
                          !tenantPayoutAccountForm.accountHolderName.trim() ||
                          !tenantPayoutAccountForm.bankName.trim() ||
                          !bankNumbersValid;
                        return (
                          <>
                      {(tenantPayoutAccountsError || (tenantPayoutAccountNotice?.type === 'error' && tenantPayoutAccountNotice?.message)) && (
                        <div className="px-4 py-3 border rounded-lg text-sm bg-red-50 border-red-200 text-red-800">
                          {tenantPayoutAccountsError || tenantPayoutAccountNotice?.message}
                        </div>
                      )}
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-base font-semibold text-gray-900">
                            {tenantPayoutAccountModalMode === 'edit' ? 'Edit Tenant Payout Account' : 'New Tenant Payout Account'}
                          </h4>
                          <p className="text-sm text-gray-600 mt-1">
                            Provide the banking information for commission payout funding. Sensitive fields are stored securely.
                          </p>
                          {tenantPayoutAccountModalMode === 'edit' && (
                            <p className="text-xs text-gray-500 mt-2">
                              Leave routing/account blank to keep existing bank details. Enter both only if you want to update them.
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            setTenantPayoutAccountsError(null);
                            setTenantPayoutAccountNotice(null);
                            resetTenantPayoutAccountForm();
                          }}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <X className="h-5 w-5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Name (Optional)
                          </label>
                          <input
                            type="text"
                            value={tenantPayoutAccountForm.accountName}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({ ...prev, accountName: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Commission Account"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Holder Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={tenantPayoutAccountForm.accountHolderName}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({
                                ...prev,
                                accountHolderName: e.target.value
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., MightyWELL Health LLC"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Bank Name <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="text"
                            value={tenantPayoutAccountForm.bankName}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({ ...prev, bankName: e.target.value }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., Old Glory Bank"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Company Identification (Optional, EIN 9 digits or 10)
                          </label>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={tenantPayoutAccountForm.companyIdentification}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({
                                ...prev,
                                companyIdentification: e.target.value.replace(/\D/g, '').slice(0, 10)
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g., 12-3456789 (EIN) or 1123456789"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Used to auto-fill NACHA “Company Identification” when this account is selected as the funding source. Enter 9-digit EIN (e.g., 12-3456789) or 10-digit format.
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Type <span className="text-red-500">*</span>
                          </label>
                          <select
                            value={tenantPayoutAccountForm.bankAccountType}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({
                                ...prev,
                                bankAccountType: e.target.value as 'Checking' | 'Savings'
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="Checking">Checking</option>
                            <option value="Savings">Savings</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Routing Number <span className="text-red-500">*</span>
                          </label>
                          {tenantPayoutAccountModalMode === 'edit' && currentMaskedTenantPayoutRouting && (
                            <p className="text-xs text-gray-500 mb-1">Current: {currentMaskedTenantPayoutRouting}</p>
                          )}
                          <input
                            type="text"
                            value={tenantPayoutAccountForm.routingNumber}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({
                                ...prev,
                                routingNumber: e.target.value.replace(/\D/g, '').slice(0, 9)
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder={tenantPayoutAccountModalMode === 'edit' ? 'Leave blank to keep existing' : 'Enter 9-digit routing number'}
                            maxLength={9}
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Account Number <span className="text-red-500">*</span>
                          </label>
                          {tenantPayoutAccountModalMode === 'edit' && currentMaskedTenantPayoutAccount && (
                            <p className="text-xs text-gray-500 mb-1">Current: {currentMaskedTenantPayoutAccount}</p>
                          )}
                          <input
                            type="text"
                            value={tenantPayoutAccountForm.accountNumber}
                            onChange={(e) =>
                              setTenantPayoutAccountForm((prev) => ({
                                ...prev,
                                accountNumber: e.target.value.replace(/\D/g, '')
                              }))
                            }
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder={tenantPayoutAccountModalMode === 'edit' ? 'Leave blank to keep existing' : 'Enter account number'}
                          />
                        </div>

                        <div className="md:col-span-2">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={tenantPayoutAccountForm.isDefault}
                              onChange={(e) =>
                                setTenantPayoutAccountForm((prev) => ({ ...prev, isDefault: e.target.checked }))
                              }
                              disabled={tenantPayoutAccountModalMode === 'create' && tenantPayoutAccounts.length === 0}
                              className="h-4 w-4 text-oe-primary rounded focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <span className="text-sm text-gray-700">
                              Set as default account
                              {tenantPayoutAccountModalMode === 'create' && tenantPayoutAccounts.length === 0 && (
                                <span className="text-xs text-gray-500 ml-1">(required for first account)</span>
                              )}
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="text-xs text-gray-500 border-t border-gray-200 pt-3">
                        Routing numbers must contain 9 digits. Account numbers are encrypted and never displayed after saving.
                      </div>

                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => {
                            setTenantPayoutAccountsError(null);
                            setTenantPayoutAccountNotice(null);
                            resetTenantPayoutAccountForm();
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSubmitTenantPayoutAccount}
                          disabled={disableSubmit}
                          className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {tenantPayoutAccountSubmitting
                            ? 'Saving...'
                            : tenantPayoutAccountModalMode === 'edit'
                            ? 'Save Changes'
                            : 'Create Account'}
                        </button>
                      </div>
                    </>
                        );
                      })()}
                    </div>
                  </div>
                )}

                <div className="bg-white border border-gray-200 rounded-lg">
                  {tenantPayoutAccountsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-oe-primary"></div>
                    </div>
                  ) : tenantPayoutAccounts.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                      <CreditCard className="mx-auto mb-4 h-12 w-12 text-gray-300" />
                      <h4 className="text-lg font-medium text-gray-900 mb-2">No Tenant Payout Account</h4>
                      <p className="text-sm">
                        Add a tenant payout account to configure the bank account that will fund tenant payments (e.g., vendor payouts).
                      </p>
                    </div>
                  ) : (
                    <div className="max-h-[480px] overflow-y-auto pr-1">
                      <div className="divide-y divide-gray-200">
                        {tenantPayoutAccounts.map((account) => (
                        <div
                          key={account.TenantPayoutACHId}
                          className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
                        >
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <h4 className="text-lg font-semibold text-gray-900">
                                {account.AccountName || account.AccountHolderName || 'Tenant Payout Account'}
                              </h4>
                              {account.IsDefault && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
                                  Default
                                </span>
                              )}
                              {!account.IsActive && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
                                  Inactive
                                </span>
                              )}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-gray-700">
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Bank Name</p>
                                <p className="text-gray-900 font-medium">{account.BankName}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Account Holder</p>
                                <p className="text-gray-900 font-medium">{account.AccountHolderName}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Account Type</p>
                                <p className="text-gray-900 font-medium">{bankAccountTypeLabel(account.BankAccountType)}</p>
                              </div>
                              <div>
                                <p className="text-xs uppercase tracking-wide text-gray-500">Created</p>
                                <p className="text-gray-900 font-medium">
                                  {account.CreatedDate ? new Date(account.CreatedDate).toLocaleDateString() : '—'}
                                </p>
                              </div>
                              {account.maskedRoutingNumber && (
                                <div>
                                  <p className="text-xs uppercase tracking-wide text-gray-500">Routing Number</p>
                                  <p className="text-gray-900 font-medium">{account.maskedRoutingNumber}</p>
                                </div>
                              )}
                              {account.maskedAccountNumber && (
                                <div>
                                  <p className="text-xs uppercase tracking-wide text-gray-500">Account Number</p>
                                  <p className="text-gray-900 font-medium">{account.maskedAccountNumber}</p>
                                </div>
                              )}
                              {account.CompanyIdentification && (
                                <div>
                                  <p className="text-xs uppercase tracking-wide text-gray-500">Company Identification</p>
                                  <p className="text-gray-900 font-medium">{account.CompanyIdentification}</p>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center justify-end">
                            <button
                              onClick={async () => {
                                setTenantPayoutAccountsError(null);
                                setTenantPayoutAccountNotice(null);
                                setEditingTenantPayoutAccount(account);
                                setCurrentMaskedTenantPayoutAccount(account.maskedAccountNumber ?? null);
                                setCurrentMaskedTenantPayoutRouting(account.maskedRoutingNumber ?? null);
                                setTenantPayoutAccountForm({
                                  accountName: account.AccountName || '',
                                  accountHolderName: account.AccountHolderName || '',
                                  bankName: account.BankName || '',
                                  companyIdentification: account.CompanyIdentification || '',
                                  accountNumber: '',
                                  routingNumber: '',
                                  bankAccountType:
                                    bankAccountTypeLabel(account.BankAccountType) === 'Savings' ? 'Savings' : 'Checking',
                                  isDefault: account.IsDefault || false
                                });
                                setTenantPayoutAccountModalMode('edit');
                                setTenantPayoutAccountEditLoading(true);
                                try {
                                  const response = await TenantPayoutACHService.getTenantPayoutACHAccountForEdit(
                                    account.TenantPayoutACHId,
                                    isSysAdmin ? tenant.TenantId : undefined
                                  );
                                  if (response.success && response.data) {
                                    const decrypted = response.data as { routingNumber?: string; accountNumber?: string };
                                    setTenantPayoutAccountForm((prev) => ({
                                      ...prev,
                                      routingNumber: decrypted.routingNumber ?? '',
                                      accountNumber: decrypted.accountNumber ?? ''
                                    }));
                                  }
                                } catch (e) {
                                  console.error('Error fetching decrypted payout account for edit:', e);
                                  setTenantPayoutAccountNotice({ type: 'error', message: 'Could not load account details for editing. You can still update other fields.' });
                                } finally {
                                  setTenantPayoutAccountEditLoading(false);
                                }
                              }}
                              disabled={tenantPayoutAccountEditLoading}
                              className="px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-primary hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {tenantPayoutAccountEditLoading && editingTenantPayoutAccount?.TenantPayoutACHId === account.TenantPayoutACHId ? 'Loading...' : 'Edit'}
                            </button>
                          </div>
                        </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* System Fees Tab - Editable for SysAdmin */}
            {activeTab === 'systemfees' && showEditableSystemFees && (
              <div className="space-y-8">

                {/* Header Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <DollarSign className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">System Fees Configuration</h3>
                      <p className="text-sm text-gray-600 mb-2">
                        Configure system-wide fees that will be applied to all products for this tenant. 
                        These fees are added on top of the tenant's negotiated rates.
                      </p>
                      <div className="text-xs text-oe-primary">
                        <strong>Note:</strong> All fees are PEPM (Per Employee Per Month) unless otherwise specified.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Platform Fee */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-medium text-gray-900">Platform Fee</h3>
                        <button
                          onClick={() => {
                            if (!canEditSystemFees) return;
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                platformFee: {
                                  ...prev.systemFees.platformFee,
                                  enabled: !prev.systemFees.platformFee.enabled
                                }
                              }
                            }));
                          }}
                          type="button"
                          disabled={!canEditSystemFees}
                          className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                            settings.systemFees.platformFee.enabled
                              ? 'bg-oe-primary justify-end'
                              : 'bg-gray-300 justify-start'
                          } ${canEditSystemFees ? 'focus:ring-oe-primary' : 'cursor-not-allowed opacity-80'}`}
                        >
                          <span className="sr-only">Toggle Platform Fee</span>
                          <span className="h-4 w-4 rounded-full bg-white shadow" />
                        </button>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        Core platform usage and maintenance fee for all enrolled members
                      </p>
                    </div>
                  </div>

                  <div className={`space-y-4 ${!settings.systemFees.platformFee.enabled ? 'opacity-50' : ''}`}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">
                          Fee Amount (PEPM)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          <input
                            type="number"
                            value={settings.systemFees.platformFee.amount}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                platformFee: {
                                  ...prev.systemFees.platformFee,
                                  amount: e.target.value === '' ? 0 : parseFloat(e.target.value)
                                }
                              }
                            }))}
                            disabled={!canEditSystemFees || !settings.systemFees.platformFee.enabled}
                            className="form-input pl-8 disabled:bg-gray-100"
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="form-label">
                          Fee Type
                        </label>
                        <select
                          value={settings.systemFees.platformFee.type}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              platformFee: {
                                ...prev.systemFees.platformFee,
                                type: e.target.value as 'fixed' | 'percentage'
                              }
                            }
                          }))}
                          disabled={!canEditSystemFees || !settings.systemFees.platformFee.enabled}
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="fixed">Fixed Amount</option>
                          <option value="percentage">Percentage</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">
                        Description
                      </label>
                      <input
                        type="text"
                        value={settings.systemFees.platformFee.description}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          systemFees: {
                            ...prev.systemFees,
                            platformFee: {
                              ...prev.systemFees.platformFee,
                              description: e.target.value
                            }
                          }
                        }))}
                        disabled={!canEditSystemFees || !settings.systemFees.platformFee.enabled}
                        className="form-input disabled:bg-gray-100"
                        placeholder="Platform usage and maintenance fee"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className="flex items-center space-x-2 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          className="form-checkbox h-5 w-5 text-oe-primary"
                          checked={!!settings.systemFees.platformFee.MemberPaid}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              platformFee: {
                                ...prev.systemFees.platformFee,
                                MemberPaid: e.target.checked
                              }
                            }
                          }))}
                          disabled={!canManageMemberPaid || !settings.systemFees.platformFee.enabled}
                        />
                        <span>Member Paid</span>
                      </label>
                      <div>
                        <label className="form-label">Member Paid Type</label>
                        <select
                          value={settings.systemFees.platformFee.FlatOrPercent || 'Flat'}
                          onChange={(e) => {
                            const value = (e.target.value === 'Percent' ? 'Percent' : 'Flat') as 'Flat' | 'Percent';
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                platformFee: {
                                  ...prev.systemFees.platformFee,
                                  FlatOrPercent: value
                                }
                              }
                            }));
                          }}
                          disabled={
                            !canManageMemberPaid ||
                            !settings.systemFees.platformFee.enabled ||
                            !settings.systemFees.platformFee.MemberPaid
                          }
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="Flat">Flat Rate</option>
                          <option value="Percent">Percent</option>
                        </select>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Amount</label>
                        <div className="relative">
                          {settings.systemFees.platformFee.FlatOrPercent === 'Percent' ? (
                            <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
                          ) : (
                            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          )}
                          <input
                            type="number"
                            value={settings.systemFees.platformFee.MemberPaidAmount ?? ''}
                            onChange={(e) => {
                              const { value } = e.target;
                              setSettings(prev => ({
                                ...prev,
                                systemFees: {
                                  ...prev.systemFees,
                                  platformFee: {
                                    ...prev.systemFees.platformFee,
                                    MemberPaidAmount: value === '' ? undefined : parseFloat(value)
                                  }
                                }
                              }));
                            }}
                            disabled={
                              !canManageMemberPaid ||
                              !settings.systemFees.platformFee.enabled ||
                              !settings.systemFees.platformFee.MemberPaid
                            }
                            className={`form-input disabled:bg-gray-100 ${settings.systemFees.platformFee.FlatOrPercent === 'Percent' ? 'pr-8 pl-3' : 'pl-8'}`}
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Member Paid amount will be added to the member enrollment at the time of checkout.
                    </p>
                  </div>
                </div>

                {/* Mobile App Fee */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-medium text-gray-900">Mobile App Fee</h3>
                        <button
                          onClick={() => {
                            if (!canManageMemberPaid) return;
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                mobileAppFee: {
                                  ...prev.systemFees.mobileAppFee,
                                  enabled: !prev.systemFees.mobileAppFee.enabled
                                }
                              }
                            }));
                          }}
                          type="button"
                          disabled={!canManageMemberPaid}
                          className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                            settings.systemFees.mobileAppFee.enabled
                              ? 'bg-oe-primary justify-end'
                              : 'bg-gray-300 justify-start'
                          } ${canManageMemberPaid ? 'focus:ring-oe-primary' : 'cursor-not-allowed opacity-80'}`}
                        >
                          <span className="sr-only">Toggle Mobile App Fee</span>
                          <span className="h-4 w-4 rounded-full bg-white shadow" />
                        </button>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        Access to mobile applications for iOS and Android devices
                      </p>
                    </div>
                  </div>

                  <div className={`space-y-4 ${!settings.systemFees.mobileAppFee.enabled ? 'opacity-50' : ''}`}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">
                          Fee Amount (PEPM)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          <input
                            type="number"
                            value={settings.systemFees.mobileAppFee.amount}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                mobileAppFee: {
                                  ...prev.systemFees.mobileAppFee,
                                  amount: e.target.value === '' ? 0 : parseFloat(e.target.value)
                                }
                              }
                            }))}
                            disabled={!canEditSystemFees || !settings.systemFees.mobileAppFee.enabled}
                            className="form-input pl-8 disabled:bg-gray-100"
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="form-label">
                          Fee Type
                        </label>
                        <select
                          value={settings.systemFees.mobileAppFee.type}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              mobileAppFee: {
                                ...prev.systemFees.mobileAppFee,
                                type: e.target.value as 'fixed' | 'percentage'
                              }
                            }
                          }))}
                          disabled={!canEditSystemFees || !settings.systemFees.mobileAppFee.enabled}
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="fixed">Fixed Amount</option>
                          <option value="percentage">Percentage</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">
                        Description
                      </label>
                      <input
                        type="text"
                        value={settings.systemFees.mobileAppFee.description}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          systemFees: {
                            ...prev.systemFees,
                            mobileAppFee: {
                              ...prev.systemFees.mobileAppFee,
                              description: e.target.value
                            }
                          }
                        }))}
                        disabled={!canEditSystemFees || !settings.systemFees.mobileAppFee.enabled}
                        className="form-input disabled:bg-gray-100"
                        placeholder="Mobile application access fee"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className="flex items-center space-x-2 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          className="form-checkbox h-5 w-5 text-oe-primary"
                          checked={!!settings.systemFees.mobileAppFee.MemberPaid}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              mobileAppFee: {
                                ...prev.systemFees.mobileAppFee,
                                MemberPaid: e.target.checked
                              }
                            }
                          }))}
                          disabled={!canManageMemberPaid || !settings.systemFees.mobileAppFee.enabled}
                        />
                        <span>Member Paid</span>
                      </label>
                      <div>
                        <label className="form-label">Member Paid Type</label>
                        <select
                          value={settings.systemFees.mobileAppFee.FlatOrPercent || 'Flat'}
                          onChange={(e) => {
                            const value = (e.target.value === 'Percent' ? 'Percent' : 'Flat') as 'Flat' | 'Percent';
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                mobileAppFee: {
                                  ...prev.systemFees.mobileAppFee,
                                  FlatOrPercent: value
                                }
                              }
                            }));
                          }}
                          disabled={
                            !canManageMemberPaid ||
                            !settings.systemFees.mobileAppFee.enabled ||
                            !settings.systemFees.mobileAppFee.MemberPaid
                          }
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="Flat">Flat Rate</option>
                          <option value="Percent">Percent</option>
                        </select>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Amount</label>
                        <div className="relative">
                          {settings.systemFees.mobileAppFee.FlatOrPercent === 'Percent' ? (
                            <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
                          ) : (
                            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          )}
                          <input
                            type="number"
                            value={settings.systemFees.mobileAppFee.MemberPaidAmount ?? ''}
                            onChange={(e) => {
                              const { value } = e.target;
                              setSettings(prev => ({
                                ...prev,
                                systemFees: {
                                  ...prev.systemFees,
                                  mobileAppFee: {
                                    ...prev.systemFees.mobileAppFee,
                                    MemberPaidAmount: value === '' ? undefined : parseFloat(value)
                                  }
                                }
                              }));
                            }}
                            disabled={
                              !canManageMemberPaid ||
                              !settings.systemFees.mobileAppFee.enabled ||
                              !settings.systemFees.mobileAppFee.MemberPaid
                            }
                            className={`form-input disabled:bg-gray-100 ${settings.systemFees.mobileAppFee.FlatOrPercent === 'Percent' ? 'pr-8 pl-3' : 'pl-8'}`}
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Member Paid amount will be added to the member enrollment at the time of checkout.
                    </p>
                  </div>
                </div>

                {/* AI Assistant Fee */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-medium text-gray-900">AI Assistant Fee</h3>
                        <button
                          onClick={() => {
                            if (!canManageMemberPaid) return;
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                aiAssistantFee: {
                                  ...prev.systemFees.aiAssistantFee,
                                  enabled: !prev.systemFees.aiAssistantFee.enabled
                                }
                              }
                            }));
                          }}
                          type="button"
                          disabled={!canManageMemberPaid}
                          className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                            settings.systemFees.aiAssistantFee.enabled
                              ? 'bg-oe-primary justify-end'
                              : 'bg-gray-300 justify-start'
                          } ${canManageMemberPaid ? 'focus:ring-oe-primary' : 'cursor-not-allowed opacity-80'}`}
                        >
                          <span className="sr-only">Toggle AI Assistant Fee</span>
                          <span className="h-4 w-4 rounded-full bg-white shadow" />
                        </button>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        AI-powered assistant for member support and automated workflows
                      </p>
                    </div>
                  </div>

                  <div className={`space-y-4 ${!settings.systemFees.aiAssistantFee.enabled ? 'opacity-50' : ''}`}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">
                          Fee Amount (PEPM)
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          <input
                            type="number"
                            value={settings.systemFees.aiAssistantFee.amount}
                            onChange={(e) => setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                aiAssistantFee: {
                                  ...prev.systemFees.aiAssistantFee,
                                  amount: e.target.value === '' ? 0 : parseFloat(e.target.value)
                                }
                              }
                            }))}
                            disabled={!canEditSystemFees || !settings.systemFees.aiAssistantFee.enabled}
                            className="form-input pl-8 disabled:bg-gray-100"
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="form-label">
                          Fee Type
                        </label>
                        <select
                          value={settings.systemFees.aiAssistantFee.type}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              aiAssistantFee: {
                                ...prev.systemFees.aiAssistantFee,
                                type: e.target.value as 'fixed' | 'percentage'
                              }
                            }
                          }))}
                          disabled={!canEditSystemFees || !settings.systemFees.aiAssistantFee.enabled}
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="fixed">Fixed Amount</option>
                          <option value="percentage">Percentage</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">
                        Description
                      </label>
                      <input
                        type="text"
                        value={settings.systemFees.aiAssistantFee.description}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          systemFees: {
                            ...prev.systemFees,
                            aiAssistantFee: {
                              ...prev.systemFees.aiAssistantFee,
                              description: e.target.value
                            }
                          }
                        }))}
                        disabled={!canEditSystemFees || !settings.systemFees.aiAssistantFee.enabled}
                        className="form-input disabled:bg-gray-100"
                        placeholder="AI-powered assistant and automation fee"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <label className="flex items-center space-x-2 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          className="form-checkbox h-5 w-5 text-oe-primary"
                          checked={!!settings.systemFees.aiAssistantFee.MemberPaid}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            systemFees: {
                              ...prev.systemFees,
                              aiAssistantFee: {
                                ...prev.systemFees.aiAssistantFee,
                                MemberPaid: e.target.checked
                              }
                            }
                          }))}
                          disabled={!canManageMemberPaid || !settings.systemFees.aiAssistantFee.enabled}
                        />
                        <span>Member Paid</span>
                      </label>
                      <div>
                        <label className="form-label">Member Paid Type</label>
                        <select
                          value={settings.systemFees.aiAssistantFee.FlatOrPercent || 'Flat'}
                          onChange={(e) => {
                            const value = (e.target.value === 'Percent' ? 'Percent' : 'Flat') as 'Flat' | 'Percent';
                            setSettings(prev => ({
                              ...prev,
                              systemFees: {
                                ...prev.systemFees,
                                aiAssistantFee: {
                                  ...prev.systemFees.aiAssistantFee,
                                  FlatOrPercent: value
                                }
                              }
                            }));
                          }}
                          disabled={
                            !canManageMemberPaid ||
                            !settings.systemFees.aiAssistantFee.enabled ||
                            !settings.systemFees.aiAssistantFee.MemberPaid
                          }
                          className="form-select disabled:bg-gray-100"
                        >
                          <option value="Flat">Flat Rate</option>
                          <option value="Percent">Percent</option>
                        </select>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Amount</label>
                        <div className="relative">
                          {settings.systemFees.aiAssistantFee.FlatOrPercent === 'Percent' ? (
                            <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500">%</span>
                          ) : (
                            <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                          )}
                          <input
                            type="number"
                            value={settings.systemFees.aiAssistantFee.MemberPaidAmount ?? ''}
                            onChange={(e) => {
                              const { value } = e.target;
                              setSettings(prev => ({
                                ...prev,
                                systemFees: {
                                  ...prev.systemFees,
                                  aiAssistantFee: {
                                    ...prev.systemFees.aiAssistantFee,
                                    MemberPaidAmount: value === '' ? undefined : parseFloat(value)
                                  }
                                }
                              }));
                            }}
                            disabled={
                              !canManageMemberPaid ||
                              !settings.systemFees.aiAssistantFee.enabled ||
                              !settings.systemFees.aiAssistantFee.MemberPaid
                            }
                            className={`form-input disabled:bg-gray-100 ${settings.systemFees.aiAssistantFee.FlatOrPercent === 'Percent' ? 'pr-8 pl-3' : 'pl-8'}`}
                            step="0.01"
                            min="0"
                          />
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Member Paid amount will be added to the member enrollment at the time of checkout.
                    </p>
                  </div>
                </div>

                {/* Fee Summary */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900 mb-3">Monthly Fee Summary</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-600">Total Enabled Fees (PEPM):</span>
                      <span className="font-semibold text-lg">
                        ${(
                          (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                          (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                          (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="pt-2 border-t text-xs text-gray-500">
                      <p className="mb-1">Example calculation for 100 members:</p>
                      <p className="font-mono">
                        100 members × ${(
                          (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                          (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                          (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                        ).toFixed(2)} = ${(
                          100 * (
                            (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                            (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                            (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                          )
                        ).toFixed(2)}/month
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* System Fees Tab - Read-only view for TenantAdmin */}
            {activeTab === 'systemfees' && !showEditableSystemFees && (
              <div className="space-y-8">

                {/* Header Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <DollarSign className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">System Fees Overview</h3>
                      <p className="text-sm text-gray-600">View current system fees configured for your organization</p>
                    </div>
                  </div>
                </div>

                {/* Platform Fee - Read Only */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900 mb-2">Platform Fee</h4>
                      <p className="text-sm text-gray-600">Core platform usage and maintenance fee</p>
                    </div>
                    <div className="ml-6">
                      <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                        settings.systemFees.platformFee.enabled 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {settings.systemFees.platformFee.enabled ? 'Enabled' : 'Disabled'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Fee Amount (PEPM)</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          ${settings.systemFees.platformFee.amount}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Fee Type</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.platformFee.type === 'fixed' ? 'Fixed Amount' : 'Percentage'}
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">Description</label>
                      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                        {settings.systemFees.platformFee.description}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Member Paid</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.platformFee.MemberPaid ? 'Yes' : 'No'}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Details</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.platformFee.MemberPaid
                            ? settings.systemFees.platformFee.MemberPaidAmount !== undefined
                              ? `${settings.systemFees.platformFee.FlatOrPercent === 'Percent'
                                  ? `${settings.systemFees.platformFee.MemberPaidAmount}%`
                                  : `$${settings.systemFees.platformFee.MemberPaidAmount}`}`
                              : '—'
                            : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Mobile App Fee - Read Only */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900 mb-2">Mobile App Fee</h4>
                      <p className="text-sm text-gray-600">Access to mobile applications for iOS and Android devices</p>
                    </div>
                    <div className="ml-6">
                      <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                        settings.systemFees.mobileAppFee.enabled 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {settings.systemFees.mobileAppFee.enabled ? 'Enabled' : 'Disabled'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Fee Amount (PEPM)</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          ${settings.systemFees.mobileAppFee.amount}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Fee Type</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.mobileAppFee.type === 'fixed' ? 'Fixed Amount' : 'Percentage'}
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">Description</label>
                      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                        {settings.systemFees.mobileAppFee.description}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Member Paid</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.mobileAppFee.MemberPaid ? 'Yes' : 'No'}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Details</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.mobileAppFee.MemberPaid
                            ? settings.systemFees.mobileAppFee.MemberPaidAmount !== undefined
                              ? `${settings.systemFees.mobileAppFee.FlatOrPercent === 'Percent'
                                  ? `${settings.systemFees.mobileAppFee.MemberPaidAmount}%`
                                  : `$${settings.systemFees.mobileAppFee.MemberPaidAmount}`}`
                              : '—'
                            : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* AI Assistant Fee - Read Only */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900 mb-2">AI Assistant Fee</h4>
                      <p className="text-sm text-gray-600">AI-powered assistant for member support and automated workflows</p>
                    </div>
                    <div className="ml-6">
                      <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                        settings.systemFees.aiAssistantFee.enabled 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {settings.systemFees.aiAssistantFee.enabled ? 'Enabled' : 'Disabled'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Fee Amount (PEPM)</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          ${settings.systemFees.aiAssistantFee.amount}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Fee Type</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.aiAssistantFee.type === 'fixed' ? 'Fixed Amount' : 'Percentage'}
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">Description</label>
                      <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                        {settings.systemFees.aiAssistantFee.description}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Member Paid</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.aiAssistantFee.MemberPaid ? 'Yes' : 'No'}
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Member Paid Details</label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {settings.systemFees.aiAssistantFee.MemberPaid
                            ? settings.systemFees.aiAssistantFee.MemberPaidAmount !== undefined
                              ? `${settings.systemFees.aiAssistantFee.FlatOrPercent === 'Percent'
                                  ? `${settings.systemFees.aiAssistantFee.MemberPaidAmount}%`
                                  : `$${settings.systemFees.aiAssistantFee.MemberPaidAmount}`}`
                              : '—'
                            : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Fee Summary */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900 mb-3">Monthly Fee Summary</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-gray-600">Total Enabled Fees (PEPM):</span>
                      <span className="font-semibold text-lg">
                        ${(
                          (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                          (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                          (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="pt-2 border-t text-xs text-gray-500">
                      <p className="mb-1">Example calculation for 100 members:</p>
                      <p className="font-mono">
                        100 members × ${(
                          (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                          (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                          (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                        ).toFixed(2)} = ${(
                          100 * (
                            (settings.systemFees.platformFee.enabled ? settings.systemFees.platformFee.amount : 0) +
                            (settings.systemFees.mobileAppFee.enabled ? settings.systemFees.mobileAppFee.amount : 0) +
                            (settings.systemFees.aiAssistantFee.enabled ? settings.systemFees.aiAssistantFee.amount : 0)
                          )
                        ).toFixed(2)}/month
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Setup Fee Tab */}
            {activeTab === 'setupfee' && (
              <div className="space-y-8">
                {/* Header Section */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start">
                    <DollarSign className="h-6 w-6 text-blue-500 mr-3 mt-0.5" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900 mb-2">Minimum Setup Fee</h3>
                      <p className="text-sm text-gray-600">
                        Set a minimum setup fee that enrollment link templates must meet. Templates cannot have a setup fee below this minimum.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Setup Fee Input */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Minimum Setup Fee Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">$</span>
                      <input
                        type="number"
                        value={minimumSetupFee ?? ''}
                        onChange={(e) => {
                          const value = e.target.value === '' ? null : parseFloat(e.target.value);
                          setMinimumSetupFee(value !== null && !isNaN(value) ? value : null);
                        }}
                        className="w-full px-3 py-2 pl-8 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        placeholder="0.00"
                        step="0.01"
                        min="0"
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Leave empty to allow any setup fee amount. When set, enrollment link templates must have a setup fee equal to or greater than this amount.
                    </p>
                    {minimumSetupFee !== null && minimumSetupFee !== undefined && (
                      <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-md">
                        <p className="text-sm text-blue-800">
                          <strong>Current minimum:</strong> ${minimumSetupFee.toFixed(2)}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Payouts Tab */}
            {activeTab === 'payouts' && (
              <div className="space-y-6">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">Payout Timing Settings</h3>
                  <p className="text-sm text-gray-500 mb-6">Configure when each payout type is calculated relative to member payments.</p>

                  <div className="space-y-8">
                    {/* Vendor Payouts */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-3">Vendor Payouts</h4>
                      <div className="space-y-3">
                        <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                          <input
                            type="radio"
                            name="vendorBasis"
                            value="paymentReceived"
                            checked={settings.payouts.vendorBasis === 'paymentReceived'}
                            onChange={() => setSettings(prev => ({ ...prev, payouts: { ...prev.payouts, vendorBasis: 'paymentReceived' } }))}
                            className="mt-0.5 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Pay when payment is received</span>
                            <p className="text-xs text-gray-500 mt-0.5">Pay vendors after the invoice is fully funded (fulfillment date). Partial captures do not move this clock until the invoice reaches Paid (or credit-settled). Unlinked legacy payments still use payment date.</p>
                          </div>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                          <input
                            type="radio"
                            name="vendorBasis"
                            value="effectiveEnrollment"
                            checked={settings.payouts.vendorBasis === 'effectiveEnrollment'}
                            onChange={() => setSettings(prev => ({ ...prev, payouts: { ...prev.payouts, vendorBasis: 'effectiveEnrollment' } }))}
                            className="mt-0.5 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Pay when coverage is effective</span>
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-800">RECOMMENDED</span>
                            <p className="text-xs text-gray-500 mt-0.5">Vendors are paid based on the enrollment's effective coverage period. A payment collected in March for April coverage will be included in the April vendor payout.</p>
                          </div>
                        </label>
                      </div>
                    </div>

                    {/* Product Override Distributions */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-3">Product Override Distributions</h4>
                      <div className="space-y-3">
                        <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                          <input
                            type="radio"
                            name="overrideBasis"
                            value="paymentReceived"
                            checked={settings.payouts.overrideBasis === 'paymentReceived'}
                            onChange={() => setSettings(prev => ({ ...prev, payouts: { ...prev.payouts, overrideBasis: 'paymentReceived' } }))}
                            className="mt-0.5 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Pay when payment is received</span>
                            <p className="text-xs text-gray-500 mt-0.5">Override distributions release on the same fulfillment anchor as vendor “payment received” when the invoice is linked; unlinked payments use payment date.</p>
                          </div>
                        </label>
                        <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
                          <input
                            type="radio"
                            name="overrideBasis"
                            value="effectiveEnrollment"
                            checked={settings.payouts.overrideBasis === 'effectiveEnrollment'}
                            onChange={() => setSettings(prev => ({ ...prev, payouts: { ...prev.payouts, overrideBasis: 'effectiveEnrollment' } }))}
                            className="mt-0.5 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                          />
                          <div>
                            <span className="text-sm font-medium text-gray-700">Pay when coverage is effective</span>
                            <p className="text-xs text-gray-500 mt-0.5">Override distributions are paid based on the enrollment's effective coverage period.</p>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div className="rounded-lg border border-blue-200 bg-blue-50/80 p-4 text-sm text-blue-950">
                      <p className="font-medium text-blue-900">Agent commission NACHA vs vendor timing</p>
                      <p className="mt-1 text-blue-900/90">
                        Vendor and override “pay when payment is received” use the invoice <strong>fulfillment</strong> date
                        (<code className="text-xs bg-blue-100/80 px-1 rounded">PaymentReceivedDate</code> and related anchors)—not partial processor
                        captures. <strong>Agent commissions</strong> in NACHA are bucketed by each invoice’s <strong>due date</strong> within the
                        date range you select, and only after that invoice is fully <strong>Paid</strong>; a February payout run that only
                        includes January due dates will not pick up January-due items paid in February unless you widen the range.
                      </p>
                    </div>

                    {/* Agent Commission Hold */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-3">Agent Commission Hold</h4>
                      <div className="p-3 rounded-lg border border-gray-200">
                        <div className="flex items-center gap-3">
                          <label className="text-sm text-gray-700 whitespace-nowrap">Hold period</label>
                          <input
                            type="number"
                            value={settings.commissions.holdDays}
                            onChange={(e) => {
                              const value = parseInt(e.target.value, 10);
                              if (!isNaN(value) && value >= 0 && value <= 365) {
                                setSettings(prev => ({ ...prev, commissions: { ...prev.commissions, holdDays: value } }));
                              } else if (e.target.value === '' || e.target.value === '0') {
                                setSettings(prev => ({ ...prev, commissions: { ...prev.commissions, holdDays: 0 } }));
                              }
                            }}
                            className="w-20 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            placeholder="0"
                            min="0"
                            max="365"
                            step="1"
                          />
                          <span className="text-sm text-gray-500">days after payment</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          Number of days commissions are held before becoming eligible for payout. Set to 0 for no hold.
                        </p>
                        {settings.commissions.holdDays > 0 && (
                          <label className="flex items-center mt-3">
                            <input
                              type="checkbox"
                              checked={settings.commissions.holdDaysCountFrom === 'nextDay'}
                              onChange={(e) => setSettings(prev => ({ ...prev, commissions: { ...prev.commissions, holdDaysCountFrom: e.target.checked ? 'nextDay' : 'paymentDate' } }))}
                              className="mr-2 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                            />
                            <span className="text-sm text-gray-700">Count from day after payment date</span>
                          </label>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'enrollment' && (
              <div className="space-y-6">
                {isSysAdmin && (
                  <div className="bg-white border border-gray-200 rounded-lg p-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-1">External billing</h3>
                    <p className="text-sm text-gray-500 mb-4">
                      External tenants use master invoicing without member-level NACHA or commission processing.
                      When enabled, Merchant Setup is hidden and cannot be edited.
                    </p>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        id="isExternalBilling"
                        checked={!!settings.isExternalBilling}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            isExternalBilling: e.target.checked
                          }))
                        }
                        className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary flex-shrink-0 mt-0.5"
                      />
                      <div>
                        <label htmlFor="isExternalBilling" className="text-sm font-medium text-gray-900 cursor-pointer">
                          External billing tenant
                        </label>
                        <p className="text-xs text-gray-500 mt-1">
                          Billing is handled outside OpenEnroll (e.g. vendor master invoice). Member payment
                          collection and merchant credentials are disabled for this tenant.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!isSysAdmin && settings.isExternalBilling && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
                    This tenant uses external billing. Merchant Setup is managed by the platform administrator.
                  </div>
                )}

                {/* Auto-approve group type changes */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">Group Type Changes</h3>
                  <p className="text-sm text-gray-500 mb-4">Control how group-type conversion requests are handled.</p>
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id="autoApproveGroupTypeChanges"
                      checked={settings.enrollment.autoApproveGroupTypeChanges}
                      onChange={(e) =>
                        setSettings((prev) => ({
                          ...prev,
                          enrollment: {
                            ...prev.enrollment,
                            autoApproveGroupTypeChanges: e.target.checked
                          }
                        }))
                      }
                      className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary flex-shrink-0 mt-0.5"
                    />
                    <div>
                      <label htmlFor="autoApproveGroupTypeChanges" className="text-sm font-medium text-gray-900 cursor-pointer">
                        Auto-approve group type changes
                      </label>
                      <p className="text-xs text-gray-500 mt-1">
                        When enabled, agents can convert groups between Standard and List Bill without TenantAdmin review.
                        Requests are still logged for audit.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Enrollment deadline (days before effective date) */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">Enrollment deadline</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Number of days before a group&apos;s effective date by which agents are expected to have the
                    vendor-minimum number of members enrolled. Shown to agents as an acknowledgment on the group
                    products step. Leave blank for &quot;by the effective date&quot; (no buffer).
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      id="enrollmentDeadlineDaysBeforeEffectiveDate"
                      value={settings.enrollment.enrollmentDeadlineDaysBeforeEffectiveDate ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = raw === '' ? undefined : Math.max(0, Math.floor(Number(raw)));
                        setSettings((prev) => ({
                          ...prev,
                          enrollment: {
                            ...prev.enrollment,
                            enrollmentDeadlineDaysBeforeEffectiveDate: Number.isFinite(parsed as number) ? (parsed as number) : undefined
                          }
                        }));
                      }}
                      className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="0"
                    />
                    <span className="text-sm text-gray-700">days before the effective date</span>
                  </div>
                </div>

                {/* Tenant notification recipients */}
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-start mb-4">
                    <Mail className="h-5 w-5 text-blue-500 mr-2 mt-0.5 flex-shrink-0" />
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">Tenant notification recipients</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        These addresses receive tenant-wide notifications, including:
                      </p>
                      <ul className="text-sm text-gray-500 mt-1 ml-4 list-disc">
                        <li>Group-type change requests submitted by agents (review queue)</li>
                        <li>Below-minimum alerts when a group falls below its vendor-required minimum (T-10 warning and T-5 lock)</li>
                      </ul>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="belowMinimumAlertRecipients">
                      Notification email addresses
                    </label>
                    <textarea
                      id="belowMinimumAlertRecipients"
                      rows={4}
                      value={settings.enrollment.belowMinimumAlertRecipients.join('\n')}
                      onChange={(e) => {
                        const lines = e.target.value
                          .split('\n')
                          .map((l) => l.trim())
                          .filter(Boolean);
                        setSettings((prev) => ({
                          ...prev,
                          enrollment: {
                            ...prev.enrollment,
                            belowMinimumAlertRecipients: lines
                          }
                        }));
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono text-sm"
                      placeholder={"ops@example.com\nadmin@example.com"}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      One email address per line. Leave blank to disable alerts.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'marketinglinks' && (
              <div className="space-y-6">
                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">Attribution Parameter</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    The query-string parameter appended to each link, e.g. <span className="font-mono">?id=AG12345</span>.
                    Most tenants use <span className="font-mono">id</span>. Change this only if your website expects a different parameter name.
                  </p>
                  <input
                    type="text"
                    value={settings.marketingLink.idParam}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        marketingLink: { ...prev.marketingLink, idParam: e.target.value }
                      }))
                    }
                    placeholder="id"
                    className="w-48 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono text-sm"
                  />
                </div>

                {/*
                  The legacy "Marketing Links" (label + url) editor was removed when the
                  WebsiteLinkCard that consumed it was retired. The `links` data is still
                  hydrated and saved (pass-through) so existing stored links aren't wiped —
                  agents now create trackable links via Prospects → Sources, backed by the
                  "Link Destinations" editor below.
                */}

                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-lg font-medium text-gray-900">Link Destinations</h3>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((prev) => ({
                          ...prev,
                          marketingLink: {
                            ...prev.marketingLink,
                            destinations: [
                              ...prev.marketingLink.destinations,
                              { type: 'website', label: '', url: '' }
                            ]
                          }
                        }))
                      }
                      className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg text-sm"
                    >
                      <Plus className="h-4 w-4" />
                      Add destination
                    </button>
                  </div>
                  <p className="text-sm text-gray-500 mb-4">
                    Base URLs agents choose from when creating website/landing sources.
                  </p>

                  {settings.marketingLink.destinations.length === 0 ? (
                    <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-3">
                      No destinations yet. Click <span className="font-medium">Add destination</span> to create one.
                    </div>
                  ) : null}
                  {settings.marketingLink.destinations.length > 0 && (
                    <div className="space-y-3">
                      {settings.marketingLink.destinations.map((dest, idx) => (
                        <div key={idx} className="border border-gray-200 rounded-md p-3 grid grid-cols-12 gap-2 items-start">
                          <div className="col-span-3">
                            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                            <select
                              value={dest.type}
                              onChange={(e) => {
                                const value = e.target.value === 'landing' ? 'landing' : 'website';
                                setSettings((prev) => ({
                                  ...prev,
                                  marketingLink: {
                                    ...prev.marketingLink,
                                    destinations: prev.marketingLink.destinations.map((d, i) =>
                                      i === idx ? { ...d, type: value } : d
                                    )
                                  }
                                }));
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm bg-white"
                            >
                              <option value="website">Website</option>
                              <option value="landing">Landing Page</option>
                            </select>
                          </div>
                          <div className="col-span-3">
                            <label className="block text-xs font-medium text-gray-600 mb-1">Label</label>
                            <input
                              type="text"
                              value={dest.label}
                              onChange={(e) => {
                                const value = e.target.value;
                                setSettings((prev) => ({
                                  ...prev,
                                  marketingLink: {
                                    ...prev.marketingLink,
                                    destinations: prev.marketingLink.destinations.map((d, i) =>
                                      i === idx ? { ...d, label: value } : d
                                    )
                                  }
                                }));
                              }}
                              placeholder="Get-Covered Landing"
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                            />
                          </div>
                          <div className="col-span-5">
                            <label className="block text-xs font-medium text-gray-600 mb-1">URL</label>
                            <input
                              type="url"
                              value={dest.url}
                              onChange={(e) => {
                                const value = e.target.value;
                                setSettings((prev) => ({
                                  ...prev,
                                  marketingLink: {
                                    ...prev.marketingLink,
                                    destinations: prev.marketingLink.destinations.map((d, i) =>
                                      i === idx ? { ...d, url: value } : d
                                    )
                                  }
                                }));
                              }}
                              placeholder="https://..."
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono text-sm"
                            />
                          </div>
                          <div className="col-span-1 flex justify-end pt-5">
                            <button
                              type="button"
                              onClick={() =>
                                setSettings((prev) => ({
                                  ...prev,
                                  marketingLink: {
                                    ...prev.marketingLink,
                                    destinations: prev.marketingLink.destinations.filter((_, i) => i !== idx)
                                  }
                                }))
                              }
                              className="p-2 text-red-600 hover:bg-red-50 rounded-md"
                              title="Remove destination"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white border border-gray-200 rounded-lg p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">Daily Digest Recipients</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    Email addresses that receive the daily website-form digest (one email per
                    day summarizing how many submissions came in, broken down by advisor and
                    by status). Includes a warning if forms appear to be broken.
                    Leave blank to disable.
                  </p>
                  <textarea
                    rows={3}
                    value={settings.websiteForm.digestRecipients.join('\n')}
                    onChange={(e) => {
                      const list = e.target.value
                        .split(/[\n,;]+/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                      setSettings((prev) => ({
                        ...prev,
                        websiteForm: { ...prev.websiteForm, digestRecipients: list }
                      }));
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary font-mono text-sm"
                    placeholder={"joey@example.com\nops@example.com"}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    One email address per line.
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'aiknowledge' && (
              <AIKnowledgeSection />
            )}

            {activeTab === 'websiteintegration' && (
              <WebsiteIntegrationSection />
            )}

              </>
            )}

          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-3 p-6 border-t border-gray-200">
            {/* Inline save feedback — keeps modal open so user sees confirmation */}
            {saveSuccess && (
              <div
                role="status"
                aria-live="polite"
                className="mr-auto flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5"
              >
                <CheckCircle size={16} className="text-green-600" />
                <span>{saveSuccess}</span>
              </div>
            )}
            {localError && !saveSuccess && (
              <div
                role="alert"
                className="mr-auto flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5"
              >
                <X size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
                <span className="break-words">{localError}</span>
              </div>
            )}
            <button
              onClick={onClose}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="btn-primary flex items-center"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin mr-2" size={16} />
                  Saving...
                </>
              ) : (
                <>
                  <Save size={16} className="mr-2" />
                  Save Changes
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {copyFromTenantModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50">
          <div
            className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-md w-full p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="copy-from-tenant-title"
          >
            <h3 id="copy-from-tenant-title" className="text-lg font-semibold text-gray-900">
              Copy from tenant
            </h3>
            <p className="text-sm text-gray-600 mt-2">
              {activeTab === 'overrideaccounts' || activeTab === 'tenantpayoutaccount' ? (
                <>
                  Copy <span className="font-medium text-gray-800">{tabs.find((t) => t.id === activeTab)?.label}</span> from
                  the source tenant into <span className="font-medium text-gray-800">{tenant.Name}</span> immediately (same
                  bank details; new records on this tenant). SysAdmin only.
                </>
              ) : (
                <>
                  Load the <span className="font-medium text-gray-800">{tabs.find((t) => t.id === activeTab)?.label}</span>{' '}
                  configuration from another tenant into this form. Review changes, then use Save Changes to apply them to{' '}
                  {tenant.Name}.
                </>
              )}
            </p>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Source tenant</label>
              <SearchableDropdown
                options={copyTenantDropdownOptions}
                value={copySourceTenantId}
                onChange={(value) => setCopySourceTenantId(value)}
                placeholder={copyTenantsLoading ? 'Loading tenants…' : 'Search and select a tenant…'}
                searchPlaceholder="Search tenants…"
                loading={copyTenantsLoading}
                disabled={copyApplying}
                className="w-full"
              />
            </div>
            <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => {
                  setCopyFromTenantModalOpen(false);
                  setCopySourceTenantId('');
                }}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
                disabled={copyApplying}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleApplyCopyFromTenant()}
                disabled={!copySourceTenantId || copyApplying}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {copyApplying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Applying…
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Apply
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UnifiedTenantSettingsModal;
