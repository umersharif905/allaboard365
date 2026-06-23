import { Mail, MessageSquare, Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../components/common/Toast';
import CreateForField, { type CreateForValue } from '../../components/messaging/CreateForField';
import {
  campaignService,
  messageCenterUtils,
  messageTemplateService,
  type Campaign,
  type MessageTemplate,
} from '../../services/messageCenter.service';

interface TenantOption {
  TenantId: string;
  Name: string;
}

interface CampaignEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  campaignId?: string | null;
  tenantId: string;
  /** SysAdmin-only props — when set, renders the "Create for" picker in create mode. */
  isSysAdmin?: boolean;
  tenants?: TenantOption[];
  createFor?: CreateForValue;
  onCreateForChange?: (next: CreateForValue) => void;
}

interface LocalStep {
  stepId?: string;
  delayDays: number;
  emailTemplateId: string | null;
  smsTemplateId: string | null;
  emailTemplateName?: string;
  smsTemplateName?: string;
}

const TRIGGER_OPTIONS: { value: Campaign['triggerType']; label: string }[] = [
  { value: 'EnrollmentCompletion', label: 'Enrollment Completion' },
  { value: 'PlanTermination', label: 'Plan Termination' },
];

const RECIPIENT_OPTIONS: { value: Campaign['recipientType']; label: string; hint: string }[] = [
  { value: 'Member', label: 'The Member', hint: 'Sent to the person who enrolled' },
  { value: 'Agent', label: "The Member's Agent", hint: 'Notify the agent of the new enrollment' },
];

const DELAY_UNITS = [
  { value: 'days', label: 'Days', multiplier: 1 },
  { value: 'weeks', label: 'Weeks', multiplier: 7 },
  { value: 'months', label: 'Months', multiplier: 30 },
];

const COMMON_VARIABLES = [
  'member.FirstName',
  'member.LastName',
  'member.Email',
  'member.FullName',
  'member.EffectiveDate',
  'member.TerminationDate',
  'agent.FirstName',
  'agent.LastName',
  'agent.Name',
  'agent.Email',
  'plan.Name',
  'tenant.Name',
  'tenant.Phone',
  'tenant.Email',
  'tenant.Website',
  'system.CurrentDate',
  'system.LoginUrl',
];

const CampaignEditorModal: React.FC<CampaignEditorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  campaignId,
  tenantId,
  isSysAdmin = false,
  tenants = [],
  createFor,
  onCreateForChange,
}) => {
  // Campaign fields
  const [campaignName, setCampaignName] = useState('');
  const [triggerType, setTriggerType] = useState<Campaign['triggerType']>('EnrollmentCompletion');
  const [recipientType, setRecipientType] = useState<Campaign['recipientType']>('Member');
  const [isActive, setIsActive] = useState(false);
  const [steps, setSteps] = useState<LocalStep[]>([]);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  // Template lists
  const [emailTemplates, setEmailTemplates] = useState<MessageTemplate[]>([]);
  const [smsTemplates, setSmsTemplates] = useState<MessageTemplate[]>([]);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showQuickSms, setShowQuickSms] = useState(false);
  const [quickSmsName, setQuickSmsName] = useState('');
  const [quickSmsBody, setQuickSmsBody] = useState('');
  const [quickSmsSaving, setQuickSmsSaving] = useState(false);

  // For tracking original steps when editing (to diff on save)
  const [originalStepIds, setOriginalStepIds] = useState<Set<string>>(new Set());

  const smsBodyRef = useRef<HTMLTextAreaElement>(null);

  const isEditMode = !!campaignId;

  // Load templates & campaign data
  useEffect(() => {
    if (!isOpen) return;

    const loadTemplates = async () => {
      try {
        const [emailRes, smsRes] = await Promise.all([
          messageTemplateService.getTemplates({ templateType: 'Email', limit: 200, isActive: true }),
          messageTemplateService.getTemplates({ templateType: 'SMS', limit: 200, isActive: true }),
        ]);
        if (emailRes.success) setEmailTemplates(emailRes.data.data);
        if (smsRes.success) setSmsTemplates(smsRes.data.data);
      } catch {
        toast.error('Failed to load templates');
      }
    };

    const loadCampaign = async () => {
      if (!campaignId) return;
      setIsLoading(true);
      try {
        const res = await campaignService.getCampaign(campaignId);
        if (res.success && res.data) {
          const c = res.data;
          setCampaignName(c.campaignName);
          setTriggerType(c.triggerType);
          setRecipientType(c.recipientType || 'Member');
          setIsActive(c.isActive);
          const loadedSteps: LocalStep[] = (c.steps || [])
            .sort((a, b) => a.stepOrder - b.stepOrder)
            .map((s) => ({
              stepId: s.stepId,
              delayDays: s.delayDays,
              emailTemplateId: s.emailTemplateId,
              smsTemplateId: s.smsTemplateId,
              emailTemplateName: s.emailTemplateName,
              smsTemplateName: s.smsTemplateName,
            }));
          setSteps(loadedSteps);
          setOriginalStepIds(new Set(loadedSteps.map((s) => s.stepId!).filter(Boolean)));
        }
      } catch {
        toast.error('Failed to load campaign');
      } finally {
        setIsLoading(false);
      }
    };

    loadTemplates();
    loadCampaign();
  }, [isOpen, campaignId]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setCampaignName('');
      setTriggerType('EnrollmentCompletion');
      setRecipientType('Member');
      setIsActive(false);
      setSteps([]);
      setSelectedStepIndex(null);
      setOriginalStepIds(new Set());
      setShowQuickSms(false);
      setQuickSmsName('');
      setQuickSmsBody('');
    }
  }, [isOpen]);

  // Helpers
  const getTemplateName = useCallback(
    (templateId: string | null, type: 'email' | 'sms') => {
      if (!templateId) return null;
      const list = type === 'email' ? emailTemplates : smsTemplates;
      return list.find((t) => t.templateId === templateId)?.templateName ?? null;
    },
    [emailTemplates, smsTemplates]
  );

  const addStepAt = useCallback(
    (index: number) => {
      const newStep: LocalStep = {
        delayDays: 0,
        emailTemplateId: null,
        smsTemplateId: null,
      };
      setSteps((prev) => {
        const next = [...prev];
        next.splice(index, 0, newStep);
        return next;
      });
      setSelectedStepIndex(index);
    },
    []
  );

  const deleteStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    setSelectedStepIndex((prev) => {
      if (prev === null) return null;
      if (prev === index) return null;
      if (prev > index) return prev - 1;
      return prev;
    });
  }, []);

  const updateStep = useCallback((index: number, updates: Partial<LocalStep>) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...updates } : s))
    );
  }, []);

  // Delay unit helpers for the step editor
  const getDelayUnit = (days: number): { value: number; unit: string } => {
    if (days > 0 && days % 30 === 0) return { value: days / 30, unit: 'months' };
    if (days > 0 && days % 7 === 0) return { value: days / 7, unit: 'weeks' };
    return { value: days, unit: 'days' };
  };

  // Quick SMS creation
  const handleQuickSmsCreate = async () => {
    if (!quickSmsName.trim() || !quickSmsBody.trim()) {
      toast.error('Name and body are required');
      return;
    }
    setQuickSmsSaving(true);
    try {
      const res = await messageTemplateService.createTemplate({
        tenantId,
        templateName: quickSmsName.trim(),
        messageType: 'SMS',
        body: quickSmsBody.trim(),
        isActive: true,
      });
      if (res.success && res.data) {
        setSmsTemplates((prev) => [...prev, res.data]);
        if (selectedStepIndex !== null) {
          updateStep(selectedStepIndex, {
            smsTemplateId: res.data.templateId,
            smsTemplateName: res.data.templateName,
          });
        }
        toast.success('SMS template created');
        setShowQuickSms(false);
        setQuickSmsName('');
        setQuickSmsBody('');
      }
    } catch {
      toast.error('Failed to create SMS template');
    } finally {
      setQuickSmsSaving(false);
    }
  };

  const insertVariable = (variable: string) => {
    const tag = messageCenterUtils.formatVariable(variable);
    const textarea = smsBodyRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newBody = quickSmsBody.slice(0, start) + tag + quickSmsBody.slice(end);
      setQuickSmsBody(newBody);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(start + tag.length, start + tag.length);
      }, 0);
    } else {
      setQuickSmsBody((prev) => prev + tag);
    }
  };

  // Save campaign
  const handleSave = async () => {
    if (!campaignName.trim()) {
      toast.error('Campaign name is required');
      return;
    }
    setIsSaving(true);
    try {
      if (isEditMode && campaignId) {
        // Update campaign metadata.
        // For SysAdmin, also send the "Owned by" reassignment from the CreateForField picker.
        const updatePayload: any = {
          campaignName: campaignName.trim(),
          triggerType,
          recipientType,
          isActive,
        };
        if (isSysAdmin && createFor) {
          if (createFor.mode === 'tenant') {
            if (!createFor.tenantId) {
              toast.error('Please pick a tenant in the "Owned by" picker');
              setIsSaving(false);
              return;
            }
            updatePayload.tenantId = createFor.tenantId;
            updatePayload.vendorId = null;
          } else {
            if (!createFor.vendorId) {
              toast.error('Please pick a vendor in the "Owned by" picker');
              setIsSaving(false);
              return;
            }
            updatePayload.tenantId = null;
            updatePayload.vendorId = createFor.vendorId;
          }
        }
        await campaignService.updateCampaign(campaignId, updatePayload);

        // Sync steps: delete removed, update existing, add new
        const currentStepIds = new Set(steps.filter((s) => s.stepId).map((s) => s.stepId!));
        const deletedIds = [...originalStepIds].filter((id) => !currentStepIds.has(id));

        // Delete removed steps
        await Promise.all(deletedIds.map((id) => campaignService.deleteStep(campaignId, id)));

        // Update or add steps in order
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step.stepId && originalStepIds.has(step.stepId)) {
            await campaignService.updateStep(campaignId, step.stepId, {
              delayDays: step.delayDays,
              emailTemplateId: step.emailTemplateId,
              smsTemplateId: step.smsTemplateId,
              stepOrder: i + 1,
            });
          } else {
            await campaignService.addStep(campaignId, {
              delayDays: step.delayDays,
              emailTemplateId: step.emailTemplateId,
              smsTemplateId: step.smsTemplateId,
            });
          }
        }

        toast.success('Campaign updated');
      } else {
        // Create new campaign
        // SysAdmin must supply "Create for" tenant (and optional vendor).
        const createPayload: {
          campaignName: string;
          triggerType: string;
          recipientType: Campaign['recipientType'];
          isActive: boolean;
          tenantId?: string;
          createForTenantId?: string;
          createForVendorId?: string | null;
        } = {
          campaignName: campaignName.trim(),
          triggerType,
          recipientType,
          isActive,
          tenantId,
        };
        if (isSysAdmin && createFor) {
          // SysAdmin "Create for":
          //   - Tenant mode: must pick a tenant; send createForTenantId only.
          //   - Vendor mode: must pick a vendor; send createForVendorId only
          //     (backend infers TenantId from oe.Users for that vendor).
          if (createFor.mode === 'tenant') {
            if (!createFor.tenantId) {
              toast.error('Please pick a tenant to create this campaign for');
              setIsSaving(false);
              return;
            }
            createPayload.createForTenantId = createFor.tenantId;
          } else {
            if (!createFor.vendorId) {
              toast.error('Please pick a vendor to create this campaign for');
              setIsSaving(false);
              return;
            }
            createPayload.createForVendorId = createFor.vendorId;
          }
        }
        const createRes = await campaignService.createCampaign(createPayload);
        if (createRes.success && createRes.data) {
          const newId = createRes.data.campaignId;
          // Add steps sequentially to preserve order
          for (const step of steps) {
            await campaignService.addStep(newId, {
              delayDays: step.delayDays,
              emailTemplateId: step.emailTemplateId,
              smsTemplateId: step.smsTemplateId,
            });
          }
          toast.success('Campaign created');
        }
      }
      onSave();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save campaign');
    } finally {
      setIsSaving(false);
    }
  };

  // Timeline preview text
  const timelineText = steps.length > 0
    ? steps.map((s) => `Day ${s.delayDays}`).join(' → ')
    : 'No steps added';

  if (!isOpen) return null;

  const selectedStep = selectedStepIndex !== null ? steps[selectedStepIndex] : null;
  const selectedDelay = selectedStep ? getDelayUnit(selectedStep.delayDays) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col mx-4">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex flex-col min-w-0 flex-1 max-w-md">
              <label className="text-xs font-medium text-gray-500 mb-1">Campaign Name</label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="Enter campaign name..."
                className="text-base font-semibold border border-gray-300 rounded-lg px-3 py-2 bg-white focus:border-[#1f8dbf] focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] min-w-0 w-full"
              />
            </div>
          </div>
          <div className="flex items-center gap-4 ml-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="sr-only"
                />
                <div className={`w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-green-500' : 'bg-gray-300'}`}></div>
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow ${isActive ? 'translate-x-5' : 'translate-x-0'}`}></div>
              </div>
              <span className={`text-sm font-medium ${isActive ? 'text-green-700' : 'text-gray-500'}`}>
                {isActive ? 'Active' : 'Inactive'}
              </span>
            </label>
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 bg-[#1f8dbf] text-white rounded-md text-sm hover:bg-[#1a7ba8] disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Campaign'}
            </button>
          </div>
        </div>

        {/* SysAdmin-only: "Owned by" picker (visible in both create and edit modes). */}
        {isSysAdmin && createFor && onCreateForChange && (
          <div className="px-6 pt-4">
            <CreateForField tenants={tenants} value={createFor} onChange={onCreateForChange} />
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]" />
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* Left panel — Flowchart */}
            <div className="w-1/2 border-r overflow-y-auto p-6">
              {/* Trigger block */}
              <div className="bg-white border-2 border-gray-200 rounded-lg p-4 shadow-sm">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Trigger
                </div>
                <select
                  value={triggerType}
                  onChange={(e) => setTriggerType(e.target.value as Campaign['triggerType'])}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                >
                  {TRIGGER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                {/* Recipient — who the campaign messages are delivered to */}
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-4 mb-2">
                  Send To
                </div>
                <select
                  value={recipientType}
                  onChange={(e) => setRecipientType(e.target.value as Campaign['recipientType'])}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                >
                  {RECIPIENT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  {RECIPIENT_OPTIONS.find((o) => o.value === recipientType)?.hint}
                </p>
              </div>

              {/* Connector after trigger */}
              <div className="flex flex-col items-center">
                <div className="w-0.5 h-4 bg-gray-300" />
                <button
                  onClick={() => addStepAt(0)}
                  className="w-8 h-8 rounded-full bg-white border-2 border-gray-300 flex items-center justify-center text-gray-400 hover:border-[#1f8dbf] hover:text-[#1f8dbf] -my-1 relative z-10 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <div className="w-0.5 h-4 bg-gray-300" />
              </div>

              {/* Steps */}
              {steps.map((step, index) => (
                <React.Fragment key={index}>
                  {/* Step card */}
                  <div
                    onClick={() => setSelectedStepIndex(index)}
                    className={`bg-white border-2 rounded-lg p-4 shadow-sm cursor-pointer transition-colors relative ${
                      selectedStepIndex === index
                        ? 'border-[#1f8dbf] ring-1 ring-[#1f8dbf]/20'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteStep(index);
                      }}
                      className="absolute top-2 right-2 text-gray-300 hover:text-red-500 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    <div className="text-sm font-bold text-gray-800 mb-1">
                      Day {step.delayDays}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-600 mb-0.5">
                      <Mail className="h-3 w-3" />
                      {step.emailTemplateName ||
                        getTemplateName(step.emailTemplateId, 'email') || (
                          <span className="italic text-gray-400">No email</span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-600">
                      <MessageSquare className="h-3 w-3" />
                      {step.smsTemplateName ||
                        getTemplateName(step.smsTemplateId, 'sms') || (
                          <span className="italic text-gray-400">No SMS</span>
                        )}
                    </div>
                  </div>

                  {/* Connector after step */}
                  <div className="flex flex-col items-center">
                    <div className="w-0.5 h-4 bg-gray-300" />
                    <button
                      onClick={() => addStepAt(index + 1)}
                      className="w-8 h-8 rounded-full bg-white border-2 border-gray-300 flex items-center justify-center text-gray-400 hover:border-[#1f8dbf] hover:text-[#1f8dbf] -my-1 relative z-10 transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    <div className="w-0.5 h-4 bg-gray-300" />
                  </div>
                </React.Fragment>
              ))}

              {/* Final add button when no steps */}
              {steps.length === 0 && (
                <div className="text-center text-sm text-gray-400 mt-2">
                  Click <strong>+</strong> to add a step
                </div>
              )}

              {/* Timeline preview */}
              <div className="mt-6 pt-4 border-t border-gray-200">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                  Timeline
                </div>
                <div className="text-sm text-gray-600 font-mono">{timelineText}</div>
              </div>
            </div>

            {/* Right panel — Step Editor */}
            <div className="w-1/2 overflow-y-auto p-6">
              {selectedStep && selectedStepIndex !== null ? (
                <div className="space-y-6">
                  <h3 className="text-base font-semibold text-gray-800">
                    Edit Step {selectedStepIndex + 1}
                  </h3>

                  {/* Delay input */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Delay After Trigger
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={0}
                        value={selectedDelay?.value ?? 0}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          const unit = selectedDelay?.unit || 'days';
                          const mult = DELAY_UNITS.find((u) => u.value === unit)?.multiplier || 1;
                          updateStep(selectedStepIndex, { delayDays: val * mult });
                        }}
                        className="w-24 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                      />
                      <select
                        value={selectedDelay?.unit || 'days'}
                        onChange={(e) => {
                          const unit = e.target.value;
                          const mult = DELAY_UNITS.find((u) => u.value === unit)?.multiplier || 1;
                          const currentVal = selectedDelay?.value ?? 0;
                          updateStep(selectedStepIndex, { delayDays: currentVal * mult });
                        }}
                        className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                      >
                        {DELAY_UNITS.map((u) => (
                          <option key={u.value} value={u.value}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Email template */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      <Mail className="h-3.5 w-3.5 inline mr-1" />
                      Email Template
                    </label>
                    <select
                      value={selectedStep.emailTemplateId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const name = id
                          ? emailTemplates.find((t) => t.templateId === id)?.templateName
                          : undefined;
                        updateStep(selectedStepIndex, {
                          emailTemplateId: id,
                          emailTemplateName: name,
                        });
                      }}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                    >
                      <option value="">-- None --</option>
                      {emailTemplates.map((t) => (
                        <option key={t.templateId} value={t.templateId}>
                          {t.templateName}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* SMS template */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      <MessageSquare className="h-3.5 w-3.5 inline mr-1" />
                      SMS Template
                    </label>
                    <select
                      value={selectedStep.smsTemplateId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value || null;
                        const name = id
                          ? smsTemplates.find((t) => t.templateId === id)?.templateName
                          : undefined;
                        updateStep(selectedStepIndex, {
                          smsTemplateId: id,
                          smsTemplateName: name,
                        });
                      }}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                    >
                      <option value="">-- None --</option>
                      {smsTemplates.map((t) => (
                        <option key={t.templateId} value={t.templateId}>
                          {t.templateName}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => setShowQuickSms((v) => !v)}
                      className="mt-2 text-xs text-[#1f8dbf] hover:underline"
                    >
                      {showQuickSms ? 'Cancel quick create' : '+ Quick Create SMS Template'}
                    </button>
                  </div>

                  {/* Quick SMS creator */}
                  {showQuickSms && (
                    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
                      <h4 className="text-sm font-semibold text-gray-700">Quick Create SMS</h4>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Template Name
                        </label>
                        <input
                          type="text"
                          value={quickSmsName}
                          onChange={(e) => setQuickSmsName(e.target.value)}
                          placeholder="e.g. Welcome SMS"
                          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Body
                        </label>
                        <textarea
                          ref={smsBodyRef}
                          value={quickSmsBody}
                          onChange={(e) => setQuickSmsBody(e.target.value)}
                          rows={4}
                          placeholder="Type your SMS message..."
                          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf] resize-none"
                        />
                        <div className="text-xs text-gray-400 mt-0.5">
                          {quickSmsBody.length}/160 chars per segment
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Insert Variable
                        </label>
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) insertVariable(e.target.value);
                          }}
                          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                        >
                          <option value="">Select a variable...</option>
                          {COMMON_VARIABLES.map((v) => (
                            <option key={v} value={v}>
                              {messageCenterUtils.formatVariable(v)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        onClick={handleQuickSmsCreate}
                        disabled={quickSmsSaving}
                        className="px-4 py-1.5 bg-[#1f8dbf] text-white rounded-md text-sm hover:bg-[#1a7ba8] disabled:opacity-50"
                      >
                        {quickSmsSaving ? 'Creating...' : 'Save SMS Template'}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  Select a step to edit
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CampaignEditorModal;
