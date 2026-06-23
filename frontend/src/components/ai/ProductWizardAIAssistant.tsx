import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  IconButton,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/api.service';
import type {
  AIProductReply,
  ProductWizardAIAssistantProps,
  ProductWizardChatMessage,
} from '../../types/ai/productWizardAssistant.types';
import type { PaymentProcessorSettings } from '../../types/paymentProcessorSettings';
import { buildProductFormSnapshot } from '../../utils/buildProductFormSnapshot';
import { formatAssistantMessageText } from '../../utils/productAiChatDisplay';
import { getChangedFields, normalizeProductAiPatch, isProductPatchApplyable } from '../../utils/productAiMerge';
import { ProductAiProposalPreview } from './ProductAiProposalPreview';
import {
  loadProductAiChatSession,
  saveProductAiChatSession,
} from '../../utils/productWizardAiSession';
import { AiChatMarkdown } from '../commissions/ai/AiChatMarkdown';
import { AiChatComposer } from './AiChatComposer';
import { isAssistantStreamingMessage } from '../../utils/aiChatMessageGuards';
import { postAiAssistantTurnStream } from '../../utils/aiAssistantStreamTurn';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const sessionFileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export default function ProductWizardAIAssistant({
  open,
  onClose,
  formData,
  currentStep,
  storageKey,
  draftSessionId,
  editingProductId,
  onApplyPatch,
}: ProductWizardAIAssistantProps) {
  const [messages, setMessages] = useState<ProductWizardChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [sessionDocExtract, setSessionDocExtract] = useState('');
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);
  const [quotaWarning, setQuotaWarning] = useState(false);
  const [appliedMsgId, setAppliedMsgId] = useState<string | null>(null);
  const [tenantPaymentSettings, setTenantPaymentSettings] = useState<PaymentProcessorSettings | null>(null);

  const sessionFilesRef = useRef<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const latestAssistantMsgRef = useRef<HTMLDivElement>(null);
  const pendingScrollToResponseRef = useRef(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      sessionFilesRef.current = [];
      setPendingFiles([]);
      setAppliedMsgId(null);
      return;
    }
    const stored = loadProductAiChatSession(storageKey);
    if (stored?.messages?.length) {
      setMessages(stored.messages);
      setSessionDocExtract(stored.sessionDocExtract || '');
      seededRef.current = true;
    } else {
      setMessages([]);
      setSessionDocExtract('');
      seededRef.current = false;
    }
  }, [open, storageKey]);

  const persistSession = useCallback(
    (msgs: ProductWizardChatMessage[], extract: string) => {
      const result = saveProductAiChatSession(storageKey, {
        messages: msgs,
        sessionDocExtract: extract || undefined,
        draftSessionId,
        updatedAt: Date.now(),
      });
      if (result.quotaWarning) setQuotaWarning(true);
    },
    [storageKey, draftSessionId]
  );

  useEffect(() => {
    if (!open) return;
    void apiService
      .get<{ success: boolean; available: boolean }>('/api/ai/product-assistant/status')
      .then((res) => setAiAvailable(Boolean(res.available)))
      .catch(() => setAiAvailable(false));
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    const ownerId = formData.productOwnerId?.trim();
    if (!open || !ownerId) {
      setTenantPaymentSettings(null);
      return;
    }
    void apiService
      .get(`/api/tenants/${ownerId}/payment-settings`)
      .then((resp: { success?: boolean; data?: { paymentProcessorSettings?: PaymentProcessorSettings } }) => {
        if (!cancelled) {
          setTenantPaymentSettings(resp?.success ? resp.data?.paymentProcessorSettings ?? null : null);
        }
      })
      .catch(() => {
        if (!cancelled) setTenantPaymentSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, formData.productOwnerId]);

  const seedPrimer = useCallback(() => {
    const snap = buildProductFormSnapshot(formData, currentStep, editingProductId);
    const primer: ProductWizardChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'question',
      text:
        `You're editing **${snap.name || 'this product'}** (step ${snap.currentStep}: **${snap.currentStepLabel}**). ` +
        `${snap.pricingTierIds.length} pricing tier(s), ${snap.configurationFieldCount} config field(s), ` +
        `${snap.acknowledgementQuestionCount} acknowledgement question(s). ` +
        `Describe what to change, or attach benefit grids / spreadsheets. ` +
        `I'll ask if anything is unclear before proposing partial updates.`,
    };
    setMessages([primer]);
    persistSession([primer], sessionDocExtract);
  }, [formData, currentStep, editingProductId, persistSession, sessionDocExtract]);

  useEffect(() => {
    if (!open || seededRef.current) return;
    seedPrimer();
    seededRef.current = true;
  }, [open, seedPrimer]);

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (loading || !pendingScrollToResponseRef.current) return;
    pendingScrollToResponseRef.current = false;
    requestAnimationFrame(() => {
      latestAssistantMsgRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [loading, messages, lastAssistantMessageId]);

  const historyForApi = useCallback((msgs: ProductWizardChatMessage[]) => {
    const capped = msgs.slice(-24);
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of capped) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant' && m.kind === 'question') {
        out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'proposal') {
        out.push({
          role: 'assistant',
          content: `PRODUCT_PROPOSAL_JSON:${JSON.stringify({
            summary: m.reply.summary,
            patch: m.reply.patch,
            warnings: m.reply.warnings,
          })}`,
        });
      } else if (m.role === 'assistant' && m.kind === 'error') {
        out.push({ role: 'assistant', content: `Error: ${m.text}` });
      } else if (m.role === 'assistant' && m.kind === 'streaming') {
        if (m.text.trim()) out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'system') {
        out.push({ role: 'assistant', content: m.text });
      }
    }
    return out;
  }, []);

  const mergeSessionFiles = (newFiles: File[]) => {
    const map = new Map<string, File>();
    for (const f of sessionFilesRef.current) map.set(sessionFileKey(f), f);
    for (const f of newFiles) map.set(sessionFileKey(f), f);
    const merged = Array.from(map.values()).slice(0, 20);
    sessionFilesRef.current = merged;
    return merged;
  };

  const sendTurn = async (text: string, files: File[]) => {
    if (!aiAvailable) return;
    const trimmed = text.trim();
    const newFilesThisTurn = files.length > 0;
    const filesToSend = mergeSessionFiles(files);
    if (!trimmed && filesToSend.length === 0 && !sessionDocExtract) return;

    setLoading(true);
    const historyPayload = historyForApi(messages);
    const formSnapshot = buildProductFormSnapshot(formData, currentStep, editingProductId);

    const attachNote =
      filesToSend.length > 0
        ? `\n\n[${filesToSend.length} file(s) in session${newFilesThisTurn ? ' (incl. new)' : ' (from earlier)'}]`
        : '';
    const userMsg: ProductWizardChatMessage = {
      id: uid(),
      role: 'user',
      content: (trimmed || '(See attachments)') + attachNote,
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setPrompt('');
    setPendingFiles([]);

    const fd = new FormData();
    fd.append('prompt', trimmed || '(See attachments)');
    fd.append('history', JSON.stringify(historyPayload));
    fd.append('formSnapshot', JSON.stringify(formSnapshot));
    fd.append('currentStep', String(currentStep));
    if (sessionDocExtract) fd.append('sessionDocExtract', sessionDocExtract);
    fd.append('refreshDocExtract', newFilesThisTurn ? '1' : '0');
    filesToSend.forEach((f) => fd.append('files', f));

    const streamId = uid();
    setMessages([...nextMessages, { id: streamId, role: 'assistant', kind: 'streaming', text: '' }]);

    try {
      const res = await postAiAssistantTurnStream('/api/ai/product-assistant/turn', fd, {
        timeoutMs: 180000,
        onDelta: (text) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId && isAssistantStreamingMessage(m) ? { ...m, text } : m))
          );
        },
      });

      if (!res.reply) {
        throw new Error(res.message || 'Assistant returned no reply');
      }

      let extract = sessionDocExtract;
      if (res.sessionDocExtract?.trim()) {
        extract = res.sessionDocExtract.trim();
        setSessionDocExtract(extract);
      }

      const reply = res.reply as AIProductReply;
      let assistantMsgs: ProductWizardChatMessage[];

      if (reply.kind === 'question') {
        assistantMsgs = [
          ...nextMessages,
          { id: uid(), role: 'assistant', kind: 'question', text: reply.text },
        ];
      } else if (reply.kind === 'proposal') {
        const changes = getChangedFields(formData, reply.patch);
        const enriched = { ...reply, changes };
        assistantMsgs = [
          ...nextMessages,
          { id: uid(), role: 'assistant', kind: 'proposal', reply: enriched },
        ];
      } else {
        assistantMsgs = [
          ...nextMessages,
          { id: uid(), role: 'assistant', kind: 'error', text: reply.text },
        ];
      }

      setMessages(assistantMsgs);
      persistSession(assistantMsgs, extract);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      const withErr: ProductWizardChatMessage[] = [
        ...nextMessages,
        { id: uid(), role: 'assistant', kind: 'error', text: msg },
      ];
      setMessages(withErr);
      persistSession(withErr, sessionDocExtract);
    } finally {
      pendingScrollToResponseRef.current = true;
      setLoading(false);
    }
  };

  const handleApply = (msgId: string, reply: Extract<AIProductReply, { kind: 'proposal' }>) => {
    const normalizedPatch = normalizeProductAiPatch(reply.patch);
    onApplyPatch(normalizedPatch);
    setAppliedMsgId(msgId);
    const changes = getChangedFields(formData, normalizedPatch);
    const visibleChanges = changes.filter(
      (c) => !['pricingTierIds', 'pricingTiersSummary', 'currentStep', 'currentStepLabel'].includes(c.field)
    );
    const pricingNote =
      normalizedPatch.pricingTiers !== undefined
        ? ' Review the **Pricing** step — tier list and processing fee checkboxes should reflect the update.'
        : '';
    const feeNote =
      normalizedPatch.includeProcessingFee !== undefined ||
      normalizedPatch.roundUpProcessingFee !== undefined ||
      normalizedPatch.processingFeePercentage !== undefined
        ? ' Processing fee settings were included.'
        : '';
    const note: ProductWizardChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'system',
      text: `Applied ${visibleChanges.length || (normalizedPatch.pricingTiers ? 1 : 0)} proposed change(s) — see green banner on the wizard.${pricingNote}${feeNote}`,
    };
    setMessages((prev) => {
      const updated = [...prev, note];
      persistSession(updated, sessionDocExtract);
      return updated;
    });
  };

  const renderProposal = (msg: Extract<ProductWizardChatMessage, { kind: 'proposal' }>) => {
    const { reply } = msg;
    const changes = reply.changes ?? getChangedFields(formData, reply.patch);
    const applied = appliedMsgId === msg.id;
    const canApply = isProductPatchApplyable(formData, reply.patch);

    return (
      <Box
        sx={{
          ml: 0,
          p: 2,
          bgcolor: 'grey.50',
          borderRadius: 2,
          border: '1px solid',
          borderColor: 'divider',
          maxWidth: '100%',
        }}
      >
        <Typography variant="subtitle2" gutterBottom>
          {reply.summary}
        </Typography>
        {reply.warnings && reply.warnings.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {reply.warnings.map((w, i) => (
              <Box key={i} sx={{ mb: i < reply.warnings!.length - 1 ? 1 : 0 }}>
                <AiChatMarkdown>{w}</AiChatMarkdown>
              </Box>
            ))}
          </Alert>
        )}
        <Box sx={{ mb: 2 }}>
          <ProductAiProposalPreview
            formData={formData}
            patch={reply.patch}
            changes={changes}
            configurationFields={formData.configurationFields}
            tenantPaymentSettings={tenantPaymentSettings}
          />
        </Box>
        <Button
          size="small"
          color="inherit"
          sx={{ textTransform: 'none', fontSize: 11 }}
          onClick={() => setExpandedJsonId(expandedJsonId === msg.id ? null : msg.id)}
        >
          {expandedJsonId === msg.id ? 'Hide technical details' : 'Technical details'}
        </Button>
        <Collapse in={expandedJsonId === msg.id}>
          <Box
            component="pre"
            sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, overflow: 'auto' }}
          >
            {JSON.stringify(reply.patch, null, 2)}
          </Box>
        </Collapse>
        <Box display="flex" gap={1} mt={2}>
          <Button
            variant="contained"
            size="small"
            disabled={applied || !canApply}
            onClick={() => handleApply(msg.id, { ...reply, changes })}
          >
            {applied ? 'Applied' : 'Apply to wizard'}
          </Button>
        </Box>
      </Box>
    );
  };

  const sendDisabled =
    loading ||
    !aiAvailable ||
    (!prompt.trim() && pendingFiles.length === 0 && sessionFilesRef.current.length === 0 && !sessionDocExtract);

  const dialog = (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={loading}
      slotProps={{
        paper: { sx: { zIndex: 2147483648 } },
      }}
      sx={{ zIndex: 2147483648 }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 3,
          py: 2,
          background: 'linear-gradient(90deg, #7c3aed, #2563eb)',
          color: 'white',
        }}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <AutoAwesomeIcon />
          <Typography variant="h6" color="inherit">
            Edit product with AI
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose} disabled={loading} sx={{ color: 'white' }} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </Box>

      <Box sx={{ px: 3, pb: 2, display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}>
        {!aiAvailable && (
          <Alert severity="warning" sx={{ mt: 2, mb: 1 }}>
            AI assist is not configured (missing OPENAI_API_KEY).
          </Alert>
        )}
        {quotaWarning && (
          <Alert severity="info" sx={{ mb: 1 }}>
            Chat history was trimmed to fit browser storage. Documents are remembered as text; re-attach files if
            amounts look wrong.
          </Alert>
        )}

        <Box ref={scrollContainerRef} sx={{ flex: 1, overflow: 'auto', py: 2, minHeight: 280 }}>
          {messages.map((m) => (
            <Box
              key={m.id}
              ref={m.id === lastAssistantMessageId ? latestAssistantMsgRef : undefined}
              sx={{ mb: 2, scrollMarginTop: 8 }}
            >
              {m.role === 'user' ? (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Box
                    sx={{
                      maxWidth: '85%',
                      p: 1.5,
                      bgcolor: 'primary.light',
                      color: 'primary.contrastText',
                      borderRadius: 2,
                    }}
                  >
                    <AiChatMarkdown sx={{ '& code': { bgcolor: 'rgba(0,0,0,0.12)' } }}>
                      {m.content}
                    </AiChatMarkdown>
                  </Box>
                </Box>
              ) : m.kind === 'streaming' || m.kind === 'question' || m.kind === 'system' ? (
                <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <Box sx={{ maxWidth: '90%', p: 1.5, bgcolor: 'grey.100', borderRadius: 2 }}>
                    <AiChatMarkdown>{formatAssistantMessageText(m.text)}</AiChatMarkdown>
                  </Box>
                </Box>
              ) : m.kind === 'proposal' ? (
                renderProposal(m)
              ) : (
                <Alert severity="error">{m.text}</Alert>
              )}
            </Box>
          ))}
          {loading && !messages.some((m) => isAssistantStreamingMessage(m)) && (
            <Box display="flex" alignItems="center" gap={1}>
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                Thinking…
              </Typography>
            </Box>
          )}
        </Box>

        <Box sx={{ pt: 2, borderTop: 1, borderColor: 'divider' }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.txt"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              setPendingFiles((prev) => [...prev, ...files].slice(0, 20));
              e.target.value = '';
            }}
          />
          {(pendingFiles.length > 0 || sessionFilesRef.current.length > 0) && (
            <Box sx={{ mb: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {[...pendingFiles, ...sessionFilesRef.current].map((f, i) => (
                <Chip key={`${f.name}-${i}`} size="small" label={f.name} />
              ))}
            </Box>
          )}
          <AiChatComposer
            prompt={prompt}
            onPromptChange={setPrompt}
            onSend={() => void sendTurn(prompt, pendingFiles)}
            loading={loading}
            disabled={!aiAvailable}
            sendDisabled={sendDisabled}
            placeholder="Describe changes or ask a question…"
            showAttach
            onAttachClick={() => fileInputRef.current?.click()}
            attachDisabled={loading}
          />
          {sessionFilesRef.current.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Documents stay in this chat session — you do not need to re-attach for follow-up answers (text is
              remembered).
            </Typography>
          )}
        </Box>
      </Box>
    </Dialog>
  );

  if (!open) return null;
  return createPortal(dialog, document.body);
}
