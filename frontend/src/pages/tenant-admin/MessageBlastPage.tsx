/**
 * Message Blast - Tenant Admin sends email and/or SMS to agents + manual addresses
 * Separate email body (rich) and SMS body (plain). Live email preview on the right.
 */
import {
  AlertCircle,
  DollarSign,
  Mail,
  MessageSquare,
  Search,
  Send,
  Users
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import RichTextEditor from '../../components/common/RichTextEditor';
import { apiService } from '../../services/api.service';

interface BlastAgent {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

interface AudienceOption {
  id: string;
  name: string;
  isBundle?: boolean;
}

interface AudienceCount {
  emailRecipients: number;
  smsRecipients: number;
  emailOptedOut: number;
  smsOptedOut: number;
  maxRecipients: number;
}

type RecipientMode = 'people' | 'group';
type AudienceType = 'active_members' | 'members_by_product' | 'active_agents' | 'agents_by_agency';

const AUDIENCE_LABELS: Record<AudienceType, string> = {
  active_members: 'All active members',
  members_by_product: 'Active members in a product / bundle',
  active_agents: 'All active agents',
  agents_by_agency: 'Agents in an agency'
};

export default function MessageBlastPage() {
  const [agents, setAgents] = useState<BlastAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [manualEmailsText, setManualEmailsText] = useState('');
  const [manualPhonesText, setManualPhonesText] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [sendSMS, setSendSMS] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [estimate, setEstimate] = useState<{ estimatedCost: number; segmentCount: number; messageCount: number } | null>(null);
  const [loadingEstimate, setLoadingEstimate] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    emailsQueued: number;
    smsQueued: number;
    estimatedCost: number;
    smsQueueMessageIds?: string[];
    sendBatchId?: string;
    bulkJobMessageId?: string;
  } | null>(null);
  const [actualCost, setActualCost] = useState<{ totalActualCost: number; resolvedMessages: number; pendingMessages: number; totalMessages: number; currency?: string } | null>(null);
  const [loadingActualCost, setLoadingActualCost] = useState(false);
  const [actualCostError, setActualCostError] = useState<string | null>(null);

  // Filtered-group audience
  const [recipientMode, setRecipientMode] = useState<RecipientMode>('people');
  const [audienceType, setAudienceType] = useState<AudienceType>('active_members');
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [selectedAgencyIds, setSelectedAgencyIds] = useState<Set<string>>(new Set());
  const [audienceOptions, setAudienceOptions] = useState<{ products: AudienceOption[]; agencies: AudienceOption[] }>({ products: [], agencies: [] });
  const [audienceCount, setAudienceCount] = useState<AudienceCount | null>(null);
  const [loadingAudienceCount, setLoadingAudienceCount] = useState(false);
  const [audienceError, setAudienceError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      setLoadingAgents(true);
      const res = await apiService.get<{ success: boolean; data?: BlastAgent[] }>('/api/me/tenant-admin/message-blast/agents');
      if (res?.success && Array.isArray(res.data)) {
        setAgents(res.data);
      } else {
        setAgents([]);
      }
    } catch (e) {
      console.error('Load agents failed:', e);
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Load product/bundle + agency options for the audience pickers.
  useEffect(() => {
    let cancelled = false;
    apiService
      .get<{ success: boolean; data?: { products: AudienceOption[]; agencies: AudienceOption[] } }>(
        '/api/me/tenant-admin/message-blast/audience-options'
      )
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.data) {
          setAudienceOptions({ products: res.data.products || [], agencies: res.data.agencies || [] });
        }
      })
      .catch((e) => console.error('Load audience options failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Whether the current audience selection is complete enough to resolve.
  const audienceReady =
    recipientMode === 'group' &&
    (audienceType === 'members_by_product'
      ? selectedProductIds.size > 0
      : audienceType === 'agents_by_agency'
        ? selectedAgencyIds.size > 0
        : true);

  const productIdsKey = Array.from(selectedProductIds).sort().join(',');
  const agencyIdsKey = Array.from(selectedAgencyIds).sort().join(',');

  // Live recipient count for the chosen audience (debounced).
  useEffect(() => {
    if (recipientMode !== 'group' || !audienceReady) {
      setAudienceCount(null);
      setAudienceError(null);
      return;
    }
    let cancelled = false;
    setLoadingAudienceCount(true);
    setAudienceError(null);
    const timer = setTimeout(() => {
      apiService
        .post<{ success: boolean; data?: AudienceCount; message?: string }>(
          '/api/me/tenant-admin/message-blast/audience-count',
          {
            audienceType,
            productIds: audienceType === 'members_by_product' ? Array.from(selectedProductIds) : undefined,
            agencyIds: audienceType === 'agents_by_agency' ? Array.from(selectedAgencyIds) : undefined
          }
        )
        .then((res) => {
          if (cancelled) return;
          if (res?.success && res.data) {
            setAudienceCount(res.data);
          } else {
            setAudienceCount(null);
            setAudienceError(res?.message || 'Unable to resolve audience.');
          }
        })
        .catch((e: any) => {
          if (cancelled) return;
          setAudienceCount(null);
          setAudienceError(e?.response?.data?.message || e?.message || 'Unable to resolve audience.');
        })
        .finally(() => {
          if (!cancelled) setLoadingAudienceCount(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipientMode, audienceType, audienceReady, productIdsKey, agencyIdsKey]);

  const manualEmails = manualEmailsText
    .split(/[\n,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e.includes('@'));
  const normalizePhone = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return null;
  };

  const manualPhones = manualPhonesText
    .split(/[\n,;\s]+/)
    .map((p) => p.trim().replace(/\D/g, ''))
    .filter((p) => p.length >= 10);

  const agentSearchLower = agentSearchQuery.trim().toLowerCase();
  const filteredAgents =
    agentSearchLower === ''
      ? agents
      : agents.filter(
          (a) =>
            (a.name && a.name.toLowerCase().includes(agentSearchLower)) ||
            (a.email && a.email.toLowerCase().includes(agentSearchLower))
        );
  const selectedAgents = agents.filter((a) => selectedAgentIds.has(a.id));
  const selectedWithEmail = new Set([...selectedAgents.map((a) => a.email).filter(Boolean), ...manualEmails]).size;
  const selectedWithPhone = new Set([
    ...selectedAgents.map((a) => normalizePhone(a.phone)).filter(Boolean),
    ...manualPhones.map((d) => (d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : null)).filter(Boolean)
  ] as string[]).size;
  const inGroupMode = recipientMode === 'group';
  const groupEmailCount = audienceCount?.emailRecipients ?? 0;
  const groupPhoneCount = audienceCount?.smsRecipients ?? 0;
  const emailCount = sendEmail ? (inGroupMode ? groupEmailCount : selectedWithEmail) : 0;
  const phoneCount = sendSMS ? (inGroupMode ? groupPhoneCount : selectedWithPhone) : 0;
  const maxRecipients = audienceCount?.maxRecipients ?? 5000;
  const overCap = inGroupMode && (emailCount > maxRecipients || phoneCount > maxRecipients);
  const selectedWithoutPhone = sendSMS && selectedAgentIds.size > 0
    ? selectedAgents.filter((a) => !normalizePhone(a.phone)).length
    : 0;

  useEffect(() => {
    if (!sendSMS || phoneCount <= 0) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setLoadingEstimate(true);
    apiService
      .post<{ success: boolean; data?: { estimatedCost: number; segmentCount: number; messageCount: number } }>(
        '/api/me/tenant-admin/message-blast/estimate',
        { sendSMS: true, smsBody: smsBody.trim(), messageBody: body, phoneCount }
      )
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.data) setEstimate(res.data);
        else setEstimate(null);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingEstimate(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sendSMS, phoneCount, smsBody]);

  useEffect(() => {
    const ids = success?.smsQueueMessageIds || [];
    const sendBatchId = success?.sendBatchId;
    if (!success || success.smsQueued <= 0) {
      setActualCost(null);
      return;
    }
    if (ids.length === 0 && !sendBatchId) {
      setActualCost(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const maxAttempts = 60; // up to ~5 minutes at 5s intervals

    const pollActualCost = async () => {
      attempts += 1;
      if (!cancelled) setLoadingActualCost(true);
      try {
        const body =
          ids.length > 0 ? { messageIds: ids } : { sendBatchId: sendBatchId as string };
        const res = await apiService.post<{
          success: boolean;
          data?: { totalActualCost: number; resolvedMessages: number; pendingMessages: number; totalMessages: number; currency?: string };
        }>('/api/me/tenant-admin/message-blast/actual-cost', body);
        if (cancelled) return;
        if (res?.success && res.data) {
          setActualCostError(null);
          setActualCost(res.data);
          if (res.data.pendingMessages > 0 && attempts < maxAttempts) {
            timer = setTimeout(pollActualCost, 5000);
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          const msg = e?.response?.data?.message || e?.message || 'Unable to load Twilio actual cost.';
          setActualCostError(msg);
        }
      } finally {
        if (!cancelled) setLoadingActualCost(false);
      }
    };

    pollActualCost();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [success]);

  const handleSelectAllAgents = (checked: boolean) => {
    if (checked) setSelectedAgentIds(new Set(filteredAgents.map((a) => a.id)));
    else setSelectedAgentIds(new Set());
  };
  const allFilteredSelected =
    filteredAgents.length > 0 && filteredAgents.every((a) => selectedAgentIds.has(a.id));

  const handleSend = async () => {
    setError(null);
    setSuccess(null);
    if (!sendEmail && !sendSMS) {
      setError('Select at least one delivery method (email or SMS).');
      return;
    }
    if (sendEmail && !body.trim()) {
      setError('Email message body is required.');
      return;
    }
    if (sendSMS && !smsBody.trim()) {
      setError('SMS message is required.');
      return;
    }
    if (sendEmail && emailCount === 0) {
      setError(inGroupMode ? 'No email recipients match this audience.' : 'No email recipients. Add agents or manual email addresses.');
      return;
    }
    if (sendSMS && phoneCount === 0) {
      setError(inGroupMode ? 'No SMS recipients match this audience.' : 'No SMS recipients. Add agents or manual phone numbers.');
      return;
    }
    if (overCap) {
      setError(`This audience exceeds the ${maxRecipients.toLocaleString()} recipient limit per send. Narrow your filters.`);
      return;
    }
    try {
      setSending(true);
      // Large recipient lists can take significant queueing time server-side.
      // Use a dynamic timeout with a 15-minute cap.
      const dynamicSendTimeoutMs = Math.min(15 * 60 * 1000, Math.max(30 * 1000, 45 * 1000 + phoneCount * 250 + emailCount * 100));
      const res = await apiService.post<{
        success: boolean;
        data?: {
          emailsQueued: number;
          smsQueued: number;
          estimatedCost: number;
          smsQueueMessageIds?: string[];
          sendBatchId?: string;
          bulkJobMessageId?: string;
        };
        message?: string;
      }>('/api/me/tenant-admin/message-blast/send', {
        sendEmail,
        sendSMS,
        subject: subject.trim() || undefined,
        body: sendEmail ? body.trim() : undefined,
        smsBody: sendSMS ? smsBody.trim() : undefined,
        agentIds: inGroupMode ? [] : Array.from(selectedAgentIds),
        manualEmails: !inGroupMode && manualEmails.length ? manualEmails : undefined,
        manualPhones: !inGroupMode && manualPhones.length ? manualPhones.map((d) => (d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : d)) : undefined,
        audience: inGroupMode
          ? {
              audienceType,
              productIds: audienceType === 'members_by_product' ? Array.from(selectedProductIds) : undefined,
              agencyIds: audienceType === 'agents_by_agency' ? Array.from(selectedAgencyIds) : undefined
            }
          : undefined
      }, {
        timeout: dynamicSendTimeoutMs
      });
      if (res?.success && res.data) {
        setSuccess(res.data);
        setActualCost(null);
        setActualCostError(null);
      } else {
        setError((res as any)?.message || 'Failed to send blast');
      }
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to send blast');
    } finally {
      setSending(false);
    }
  };

  const canSend =
    (sendEmail || sendSMS) &&
    (sendEmail ? body.trim().length > 0 : true) &&
    (sendSMS ? smsBody.trim().length > 0 : true) &&
    (sendEmail ? emailCount > 0 : true) &&
    (sendSMS ? phoneCount > 0 : true) &&
    !overCap &&
    (!inGroupMode || (audienceReady && !loadingAudienceCount));

  const previewHtml =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;margin:0;font-size:14px;line-height:1.5;color:#374151;} a{color:#1d4ed8;text-decoration:underline;}</style></head><body>' +
    (body && body.trim() ? body.trim() : '<p style="color:#9ca3af">Enter email content to see preview.</p>') +
    '</body></html>';

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Message Blast</h1>
        <p className="text-gray-600 mt-1">Send an email and/or SMS to specific people or a filtered group (members, agents, by product or agency).</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              Recipients
            </h2>

            {/* Recipient mode toggle */}
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="recipientMode"
                  checked={recipientMode === 'people'}
                  onChange={() => setRecipientMode('people')}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <span className="text-sm font-medium text-gray-700">Specific people</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="recipientMode"
                  checked={recipientMode === 'group'}
                  onChange={() => setRecipientMode('group')}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <span className="text-sm font-medium text-gray-700">Filtered group</span>
              </label>
            </div>

            {recipientMode === 'group' && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Audience</label>
                  <select
                    value={audienceType}
                    onChange={(e) => setAudienceType(e.target.value as AudienceType)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm bg-white"
                  >
                    {(Object.keys(AUDIENCE_LABELS) as AudienceType[]).map((t) => (
                      <option key={t} value={t}>{AUDIENCE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>

                {audienceType === 'members_by_product' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Products / bundles{selectedProductIds.size > 0 ? ` (${selectedProductIds.size} selected)` : ''}
                    </label>
                    {audienceOptions.products.length === 0 ? (
                      <p className="text-sm text-gray-500">No products with active enrollments.</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-1">
                        {audienceOptions.products.map((p) => (
                          <label key={p.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedProductIds.has(p.id)}
                              onChange={(e) => {
                                const next = new Set(selectedProductIds);
                                if (e.target.checked) next.add(p.id);
                                else next.delete(p.id);
                                setSelectedProductIds(next);
                              }}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                            />
                            <span className="text-sm text-gray-700">
                              {p.name}
                              {p.isBundle && <span className="ml-1 text-xs text-oe-primary font-medium">(bundle)</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {audienceType === 'agents_by_agency' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Agencies{selectedAgencyIds.size > 0 ? ` (${selectedAgencyIds.size} selected)` : ''}
                    </label>
                    {audienceOptions.agencies.length === 0 ? (
                      <p className="text-sm text-gray-500">No agencies found.</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-1">
                        {audienceOptions.agencies.map((ag) => (
                          <label key={ag.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedAgencyIds.has(ag.id)}
                              onChange={(e) => {
                                const next = new Set(selectedAgencyIds);
                                if (e.target.checked) next.add(ag.id);
                                else next.delete(ag.id);
                                setSelectedAgencyIds(next);
                              }}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                            />
                            <span className="text-sm text-gray-700">{ag.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Live recipient count */}
                <div className="rounded-lg border border-oe-light bg-oe-light/40 p-3 text-sm">
                  {!audienceReady ? (
                    <span className="text-gray-600">
                      {audienceType === 'members_by_product'
                        ? 'Select at least one product or bundle.'
                        : 'Select at least one agency.'}
                    </span>
                  ) : loadingAudienceCount ? (
                    <span className="text-gray-600">Calculating recipients…</span>
                  ) : audienceError ? (
                    <span className="text-red-700">{audienceError}</span>
                  ) : audienceCount ? (
                    <div className="space-y-1 text-gray-800">
                      <div className="font-medium">
                        {sendEmail && <>{groupEmailCount.toLocaleString()} email recipient{groupEmailCount !== 1 ? 's' : ''}</>}
                        {sendEmail && sendSMS && ' · '}
                        {sendSMS && <>{groupPhoneCount.toLocaleString()} SMS recipient{groupPhoneCount !== 1 ? 's' : ''}</>}
                        {!sendEmail && !sendSMS && 'Select a delivery method below.'}
                      </div>
                      {(audienceCount.emailOptedOut > 0 || audienceCount.smsOptedOut > 0) && (
                        <div className="text-xs text-gray-600">
                          Excluded due to marketing opt-out:
                          {audienceCount.emailOptedOut > 0 && ` ${audienceCount.emailOptedOut} email`}
                          {audienceCount.emailOptedOut > 0 && audienceCount.smsOptedOut > 0 && ','}
                          {audienceCount.smsOptedOut > 0 && ` ${audienceCount.smsOptedOut} SMS`}
                        </div>
                      )}
                      {overCap && (
                        <div className="flex items-start gap-1 text-red-700 text-xs font-medium">
                          <AlertCircle className="h-4 w-4 flex-shrink-0" />
                          Exceeds the {maxRecipients.toLocaleString()} recipient limit per send. Narrow your filters.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {recipientMode === 'people' && (loadingAgents ? (
              <div className="mt-4 py-4 text-gray-500">Loading agents...</div>
            ) : (
              <div className="mt-4 space-y-4">
                {agents.length > 0 && (
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      value={agentSearchQuery}
                      onChange={(e) => setAgentSearchQuery(e.target.value)}
                      placeholder="Search agents by name or email..."
                      className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                    />
                  </div>
                )}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={(e) => handleSelectAllAgents(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Select all{agentSearchLower ? ` (${filteredAgents.length} shown)` : ` (${agents.length})`}
                  </span>
                </label>
                {agents.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3 bg-gray-50">
                    {filteredAgents.length === 0 ? (
                      <p className="text-sm text-gray-500 py-2">No agents match your search.</p>
                    ) : (
                      <>
                        {agentSearchLower && (
                          <p className="text-xs text-gray-500 mb-2">
                            Showing {filteredAgents.length} of {agents.length} agents
                          </p>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {filteredAgents.map((a) => (
                            <label key={a.id} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={selectedAgentIds.has(a.id)}
                                onChange={(e) => {
                                  const next = new Set(selectedAgentIds);
                                  if (e.target.checked) next.add(a.id);
                                  else next.delete(a.id);
                                  setSelectedAgentIds(next);
                                }}
                                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                              />
                              <span className="text-sm text-gray-700">{a.name || a.email || a.id}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Additional email addresses (one per line or comma-separated)</label>
                  <textarea
                    value={manualEmailsText}
                    onChange={(e) => setManualEmailsText(e.target.value)}
                    placeholder="agent@example.com, other@example.com"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Additional phone numbers (one per line or comma-separated, US)</label>
                  <textarea
                    value={manualPhonesText}
                    onChange={(e) => setManualPhonesText(e.target.value)}
                    placeholder="5551234567 or +1 555 123 4567"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Delivery & content</h2>
            <div className="space-y-4">
              <div className="flex gap-6">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <Mail className="h-4 w-4 text-gray-600" />
                  <span className="text-sm font-medium text-gray-700">Email</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sendSMS}
                    onChange={(e) => setSendSMS(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <MessageSquare className="h-4 w-4 text-gray-600" />
                  <span className="text-sm font-medium text-gray-700">SMS</span>
                </label>
              </div>

              {sendEmail && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Subject line"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email message</label>
                    <RichTextEditor
                      value={body}
                      onChange={(value) => setBody(value)}
                      placeholder="Enter your email. Use the toolbar for formatting, links, and images."
                      minHeight={260}
                      allowHtmlSource={true}
                    />
                  </div>
                </>
              )}

              {sendSMS && (
                <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <MessageSquare className="h-4 w-4 inline mr-1 text-gray-600" />
                    SMS message
                  </label>
                  <textarea
                    value={smsBody}
                    onChange={(e) => setSmsBody(e.target.value)}
                    placeholder="Plain text only. 160 characters per segment."
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">SMS is plain text only. {smsBody.length > 0 && smsBody.length > 160 && 'Longer messages are split into segments.'}</p>
                  {sendSMS && phoneCount > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-sm text-gray-700">
                        <span className="font-medium">SMS will be sent to {phoneCount} recipient{phoneCount !== 1 ? 's' : ''}</span>
                        {' '}(only those with a phone number).
                        {selectedWithoutPhone > 0 && (
                          <span className="block mt-1 text-gray-600">
                            {selectedWithoutPhone} selected recipient{selectedWithoutPhone !== 1 ? 's have' : ' has'} no phone number and will not receive SMS.
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <DollarSign className="h-5 w-5 text-blue-600 flex-shrink-0" />
                        <div>
                          {loadingEstimate ? (
                            <span className="text-sm text-blue-800">Calculating estimate...</span>
                          ) : estimate ? (
                            <span className="text-sm font-medium text-blue-900">
                              Estimated SMS cost: <strong>${estimate.estimatedCost.toFixed(2)}</strong>
                              {' '}({estimate.messageCount} message{estimate.messageCount !== 1 ? 's' : ''} will go out, {estimate.segmentCount} segment{estimate.segmentCount !== 1 ? 's' : ''} each)
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="p-6 flex items-center justify-between gap-4">
            <div className="flex-1">
              {error && (
                <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm">{error}</span>
                </div>
              )}
              {success && (
                <div className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
                  Sent: {success.emailsQueued} email(s), {success.smsQueued} SMS. Estimated SMS cost: ${success.estimatedCost.toFixed(2)}
                  {success.smsQueued > 0 && (
                    <span className="block mt-1">
                      {loadingActualCost && !actualCost
                        ? 'Loading actual Twilio amount...'
                        : actualCostError
                          ? `Actual Twilio amount unavailable: ${actualCostError}`
                          : actualCost
                          ? `Actual Twilio amount: ${actualCost.totalActualCost.toFixed(2)}${actualCost.currency ? ` ${actualCost.currency}` : ''}${actualCost.pendingMessages > 0 ? ` (${actualCost.pendingMessages} pending)` : ''}`
                          : 'Actual Twilio amount pending...'}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !canSend}
              className="px-4 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sending ? (
                <span className="animate-pulse">Sending...</span>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Send blast
                </>
              )}
            </button>
          </div>
        </div>

        {sendEmail && (
          <div className="lg:sticky lg:top-6 self-start">
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                <h3 className="text-sm font-medium text-gray-900">Email preview</h3>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  Subject: {subject.trim() || '(No subject)'}
                </p>
              </div>
              <div className="p-0 overflow-hidden rounded-b-lg" style={{ minHeight: 320 }}>
                <iframe
                  title="Email preview"
                  srcDoc={previewHtml}
                  className="w-full border-0 rounded-b-lg"
                  style={{ height: 420 }}
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
