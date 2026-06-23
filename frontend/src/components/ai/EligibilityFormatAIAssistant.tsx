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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/api.service';
import type {
  AIEligibilityFormatReply,
  EligibilityFormatAIAssistantProps,
  EligibilityFormatChatMessage,
} from '../../types/ai/eligibilityFormatAssistant.types';
import { buildEligibilityFormatSnapshot, hasEligibilityPatchDiff } from '../../utils/eligibilityFormatAiMerge';
import { validateTemplatePlaceholders } from '../../utils/eligibilityRowTemplate';
import { formatAssistantMessageText } from '../../utils/productAiChatDisplay';
import { isAssistantStreamingMessage } from '../../utils/aiChatMessageGuards';
import {
  loadEligibilityAiChatSession,
  saveEligibilityAiChatSession,
} from '../../utils/eligibilityFormatAiSession';
import { AiChatMarkdown } from '../commissions/ai/AiChatMarkdown';
import { AiChatComposer } from './AiChatComposer';
import { postAiAssistantTurnStream } from '../../utils/aiAssistantStreamTurn';
import { EligibilityFormatProposalPreview } from './EligibilityFormatProposalPreview';
import EligibilityFormatSetupProposalPreview from './EligibilityFormatSetupProposalPreview';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const sessionFileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export default function EligibilityFormatAIAssistant({
  open,
  onClose,
  formData,
  storageKey,
  onApplyPatch,
}: EligibilityFormatAIAssistantProps) {
  const [messages, setMessages] = useState<EligibilityFormatChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [sessionDocExtract, setSessionDocExtract] = useState('');
  const [expandedTechId, setExpandedTechId] = useState<string | null>(null);
  const [quotaWarning, setQuotaWarning] = useState(false);
  const [appliedMsgId, setAppliedMsgId] = useState<string | null>(null);
  const [showAppliedHint, setShowAppliedHint] = useState(false);

  const sessionFilesRef = useRef<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  const vendorId = formData.Id || '';

  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      sessionFilesRef.current = [];
      setPendingFiles([]);
      setAppliedMsgId(null);
      setShowAppliedHint(false);
      return;
    }
    const stored = loadEligibilityAiChatSession(storageKey);
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
    (msgs: EligibilityFormatChatMessage[], extract: string) => {
      const result = saveEligibilityAiChatSession(storageKey, {
        messages: msgs,
        sessionDocExtract: extract || undefined,
        updatedAt: Date.now(),
      });
      if (result.quotaWarning) setQuotaWarning(true);
    },
    [storageKey]
  );

  useEffect(() => {
    if (!open) return;
    void apiService
      .get<{ success: boolean; available: boolean }>('/api/ai/eligibility-format-assistant/status')
      .then((res) => setAiAvailable(Boolean(res.available)))
      .catch(() => setAiAvailable(false));
  }, [open]);

  const seedPrimer = useCallback(() => {
    const snap = buildEligibilityFormatSnapshot(formData);
    const invalidNote =
      snap.invalidPlaceholders.length > 0
        ? ` **${snap.invalidPlaceholders.length} invalid placeholder(s)** in the current template.`
        : '';
    const primer: EligibilityFormatChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'question',
      text:
        `You're editing eligibility export format for **${snap.vendorName || 'this vendor'}**. ` +
        `${snap.columnCount} custom column(s), date format **${snap.eligibilityDateFormat}**, ` +
        `integration partner **${snap.eligibilityIntegrationPartner || '(default)'}**.${invalidNote} ` +
        `Describe the CSV layout you need, or attach a vendor spec sheet. ` +
        `Changes apply to this form when you click **Apply** — then **Save Vendor** to persist. ` +
        `**Create sample CSV** and production exports use the saved vendor until then.`,
    };
    setMessages([primer]);
    persistSession([primer], sessionDocExtract);
  }, [formData, persistSession, sessionDocExtract]);

  useEffect(() => {
    if (!open || seededRef.current) return;
    seedPrimer();
    seededRef.current = true;
  }, [open, seedPrimer]);

  const historyForApi = useCallback((msgs: EligibilityFormatChatMessage[]) => {
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
          content: `ELIGIBILITY_PROPOSAL_JSON:${JSON.stringify({
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
    if (!aiAvailable || !vendorId) return;
    const trimmed = text.trim();
    const newFilesThisTurn = files.length > 0;
    const filesToSend = mergeSessionFiles(files);
    if (!trimmed && filesToSend.length === 0 && !sessionDocExtract) return;

    setLoading(true);
    const historyPayload = historyForApi(messages);
    const formSnapshot = buildEligibilityFormatSnapshot(formData);

    const attachNote =
      filesToSend.length > 0
        ? `\n\n[${filesToSend.length} file(s) in session${newFilesThisTurn ? ' (incl. new)' : ''}]`
        : '';
    const userMsg: EligibilityFormatChatMessage = {
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
    fd.append('vendorId', vendorId);
    if (sessionDocExtract) fd.append('sessionDocExtract', sessionDocExtract);
    fd.append('refreshDocExtract', newFilesThisTurn ? '1' : '0');
    filesToSend.forEach((f) => fd.append('files', f));

    const streamId = uid();
    setMessages([...nextMessages, { id: streamId, role: 'assistant', kind: 'streaming', text: '' }]);

    try {
      const res = await postAiAssistantTurnStream('/api/ai/eligibility-format-assistant/turn', fd, {
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

      const reply = res.reply as AIEligibilityFormatReply;
      let assistantMsgs: EligibilityFormatChatMessage[];

      if (reply.kind === 'question') {
        assistantMsgs = [
          ...nextMessages,
          { id: uid(), role: 'assistant', kind: 'question', text: reply.text },
        ];
      } else if (reply.kind === 'proposal') {
        const hasDiff = hasEligibilityPatchDiff(formData, reply.patch);
        assistantMsgs = [
          ...nextMessages,
          {
            id: uid(),
            role: 'assistant',
            kind: 'proposal',
            reply: { ...reply, hasEffectiveDiff: hasDiff },
          },
        ];
      } else if (reply.kind === 'setupProposal') {
        assistantMsgs = [
          ...nextMessages,
          { id: uid(), role: 'assistant', kind: 'setupProposal', reply },
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
      const withErr: EligibilityFormatChatMessage[] = [
        ...nextMessages,
        { id: uid(), role: 'assistant', kind: 'error', text: msg },
      ];
      setMessages(withErr);
      persistSession(withErr, sessionDocExtract);
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const handleApply = (msgId: string, reply: Extract<AIEligibilityFormatReply, { kind: 'proposal' }>) => {
    onApplyPatch(reply.patch);
    setAppliedMsgId(msgId);
    setShowAppliedHint(true);
    const note: EligibilityFormatChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'system',
      text: 'Applied to the vendor form on the Eligibility tab. Click **Save Vendor** to persist.',
    };
    setMessages((prev) => {
      const updated = [...prev, note];
      persistSession(updated, sessionDocExtract);
      return updated;
    });
  };

  const renderProposal = (msg: Extract<EligibilityFormatChatMessage, { kind: 'proposal' }>) => {
    const { reply } = msg;
    const applied = appliedMsgId === msg.id;
    const hasDiff = reply.hasEffectiveDiff ?? hasEligibilityPatchDiff(formData, reply.patch);
    const invalidPlaceholders =
      reply.patch.eligibilityRowTemplate !== undefined
        ? validateTemplatePlaceholders(reply.patch.eligibilityRowTemplate)
        : [];
    const applyDisabled = applied || !hasDiff || invalidPlaceholders.length > 0;

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
          <EligibilityFormatProposalPreview
            vendorId={vendorId}
            formData={formData}
            patch={reply.patch}
          />
        </Box>
        <Button
          size="small"
          color="inherit"
          sx={{ textTransform: 'none', fontSize: 11 }}
          onClick={() => setExpandedTechId(expandedTechId === msg.id ? null : msg.id)}
        >
          {expandedTechId === msg.id ? 'Hide technical details' : 'Technical details'}
        </Button>
        <Collapse in={expandedTechId === msg.id}>
          <Box
            component="pre"
            sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, overflow: 'auto' }}
          >
            {reply.patch.eligibilityRowTemplate ?? '(no template change)'}
          </Box>
        </Collapse>
        {applied && showAppliedHint && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Applied to this form. Click <strong>Save Vendor</strong> to persist.{' '}
            <strong>Create sample CSV</strong> and production exports use the saved vendor until then.
          </Alert>
        )}
        <Box display="flex" gap={1} mt={2}>
          <Button
            variant="contained"
            size="small"
            disabled={applyDisabled}
            onClick={() => handleApply(msg.id, reply)}
          >
            {applied ? 'Applied' : 'Apply to vendor'}
          </Button>
        </Box>
      </Box>
    );
  };

  const sendDisabled =
    loading ||
    !aiAvailable ||
    !vendorId ||
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
          background: 'linear-gradient(90deg, #0d9488, #2563eb)',
          color: 'white',
        }}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <AutoAwesomeIcon />
          <Typography variant="h6" color="inherit">
            Edit eligibility format with AI
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
            Chat history was trimmed to fit browser storage.
          </Alert>
        )}

        <Box sx={{ flex: 1, overflow: 'auto', py: 2, minHeight: 280 }}>
          {messages.map((m) => (
            <Box key={m.id} sx={{ mb: 2 }}>
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
              ) : m.kind === 'setupProposal' ? (
                <EligibilityFormatSetupProposalPreview
                  summary={m.reply.summary}
                  products={m.reply.products}
                  keyTierPairings={m.reply.keyTierPairings}
                  patch={m.reply.patch}
                  warnings={m.reply.warnings}
                  disabled={loading}
                  onApply={(patch) => {
                    if (patch && Object.keys(patch).length) onApplyPatch(patch);
                  }}
                />
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
          <div ref={bottomRef} />
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
            placeholder="Describe column layout or attach vendor spec…"
            showAttach
            onAttachClick={() => fileInputRef.current?.click()}
            attachDisabled={loading}
          />
        </Box>
      </Box>
    </Dialog>
  );

  if (!open) return null;
  return createPortal(dialog, document.body);
}
