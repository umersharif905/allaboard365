// frontend/src/components/commissions/ai/CommissionRuleAIAssistant.tsx
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuleCreationFormData } from '../RuleCreationWizard';
import {
  COMMISSION_NESTED_DIALOG_Z,
  commissionDialogSlotProps,
  commissionNestedConfirmDialogProps,
} from '../commissionDialogZIndex';
import { applyEsEcMirrorToProposalPatch } from '../../../utils/commissionAiMerge';
import { stripGuidsFromCommissionAiText } from '../../../utils/sanitizeCommissionAiUserText';
import { AiChatMarkdown } from './AiChatMarkdown';
import { AiChatComposer } from '../../ai/AiChatComposer';
import { isAssistantStreamingMessage } from '../../../utils/aiChatMessageGuards';
import { postAiAssistantTurnStream } from '../../../utils/aiAssistantStreamTurn';

export type AIProposalPatch = {
  mode: 'percentage' | 'flatrate';
  tiers: Array<{
    level: number;
    name: string;
    rate?: number;
    flatAmount?: number;
    productTiers?: {
      EE?: { rate?: number; flatAmount?: number };
      ES?: { rate?: number; flatAmount?: number };
      EC?: { rate?: number; flatAmount?: number };
      EF?: { rate?: number; flatAmount?: number };
    };
  }>;
};

export type AIReply =
  | { kind: 'question'; text: string }
  | { kind: 'proposal'; summary: string; patch: AIProposalPatch; warnings?: string[] };

type ChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | { id: string; role: 'assistant'; kind: 'streaming'; text: string }
  | { id: string; role: 'assistant'; kind: 'proposal'; reply: AIReply & { kind: 'proposal' } }
  | { id: string; role: 'assistant'; kind: 'error'; text: string };

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sessionFileKey(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

export function formatAiCommissionCell(mode: 'percentage' | 'flatrate', rate?: number, flat?: number): string {
  if (mode === 'percentage') {
    if (rate == null || !Number.isFinite(rate)) return '';
    return `${(Math.round(rate * 10000) / 100).toFixed(2)}%`;
  }
  if (flat == null || !Number.isFinite(flat)) return '';
  return `$${flat.toFixed(2)}`;
}

export function buildProposalPreviewColumns(patch: AIProposalPatch) {
  const displayPatch = applyEsEcMirrorToProposalPatch(patch);
  const codes = ['EE', 'ES', 'EC', 'EF'] as const;
  const showBase = displayPatch.tiers.some((t) =>
    displayPatch.mode === 'percentage' ? t.rate != null : t.flatAmount != null
  );
  const showFamily = displayPatch.tiers.some((t) =>
    codes.some((c) => {
      const v = t.productTiers?.[c];
      return v && (v.rate != null || v.flatAmount != null);
    })
  );
  return { codes, showBase, showFamily, displayPatch };
}

export interface CommissionRuleAIAssistantProps {
  open: boolean;
  onClose: () => void;
  onApply: (patch: AIProposalPatch) => void;
  formSnapshot: Pick<RuleCreationFormData, 'type' | 'tiers' | 'commissionType'>;
  tenantTierLevels: Array<{ level: number; name: string }>;
  aiAvailable: boolean;
}

export const CommissionRuleAIAssistant: React.FC<CommissionRuleAIAssistantProps> = ({
  open,
  onClose,
  onApply,
  formSnapshot,
  tenantTierLevels,
  aiAvailable,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sessionGridExtract, setSessionGridExtract] = useState<string | null>(null);
  const sessionFilesRef = useRef<File[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [latestProposal, setLatestProposal] = useState<AIProposalPatch | null>(null);
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);
  const [retryPayload, setRetryPayload] = useState<{ prompt: string; files: File[] } | null>(null);
  const [newChatConfirmOpen, setNewChatConfirmOpen] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const tierNamesLine = useMemo(
    () =>
      tenantTierLevels.length > 0
        ? tenantTierLevels.map((t) => t.name).join(', ')
        : 'your tenant default tier ladder',
    [tenantTierLevels]
  );

  const seedPrimer = useCallback(() => {
    const primer: ChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'question',
      text: `Upload a commission grid screenshot, paste numbers, or describe how you'd like the tiers set. I'll use these tier names: **${tierNamesLine}**. Tell me what you want.`,
    };
    setMessages([primer]);
    setLatestProposal(null);
    setPendingFiles([]);
    setPrompt('');
    setExpandedJsonId(null);
    setRetryPayload(null);
    sessionFilesRef.current = [];
    setSessionGridExtract(null);
  }, [tierNamesLine]);

  useEffect(() => {
    if (!open) return;
    seedPrimer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset when modal opens
  }, [open]);

  useEffect(() => {
    if (!open) {
      sessionFilesRef.current = [];
      setSessionGridExtract(null);
    }
  }, [open]);

  const historyForApi = useCallback((msgs: ChatMessage[]) => {
    const capped = msgs.slice(-20);
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of capped) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant' && m.kind === 'streaming') {
        if (m.text.trim()) out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'question') {
        out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'proposal') {
        out.push({
          role: 'assistant',
          content: `PROPOSAL_JSON:${JSON.stringify({
            summary: m.reply.summary,
            patch: m.reply.patch,
            warnings: m.reply.warnings,
          })}`,
        });
      } else if (m.role === 'assistant' && m.kind === 'error') {
        out.push({ role: 'assistant', content: `Error: ${m.text}` });
      }
    }
    return out;
  }, []);

  const mergeSessionFiles = (newFiles: File[]) => {
    const map = new Map<string, File>();
    for (const f of sessionFilesRef.current) map.set(sessionFileKey(f), f);
    for (const f of newFiles) map.set(sessionFileKey(f), f);
    const merged = Array.from(map.values()).slice(0, 5);
    sessionFilesRef.current = merged;
    return merged;
  };

  const sendTurn = async (text: string, files: File[]) => {
    if (!aiAvailable) return;
    const trimmed = text.trim();
    const newFilesThisTurn = files.length > 0;
    const filesToSend = mergeSessionFiles(files);
    if (!trimmed && filesToSend.length === 0 && !sessionGridExtract) return;

    setLoading(true);
    setRetryPayload({ prompt: trimmed, files: filesToSend });

    const historyPayload = historyForApi(messages);

    const attachNote =
      filesToSend.length > 0
        ? `\n\n[${filesToSend.length} file(s) in session]`
        : '';
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: (trimmed || '(See attachments)') + attachNote,
    };

    setMessages((prev) => [...prev, userMsg]);
    setPrompt('');
    setPendingFiles([]);

    const fd = new FormData();
    fd.append('prompt', trimmed || '(See attachments)');
    fd.append('history', JSON.stringify(historyPayload));
    if (sessionGridExtract) fd.append('sessionGridExtract', sessionGridExtract);
    fd.append('refreshGridExtract', newFilesThisTurn ? '1' : '0');
    fd.append(
      'formSnapshot',
      JSON.stringify({
        type: formSnapshot.type,
        tiers: formSnapshot.tiers,
        commissionType: formSnapshot.commissionType,
      })
    );
    fd.append('tenantTierLevels', JSON.stringify(tenantTierLevels));
    filesToSend.forEach((f) => fd.append('files', f));

    const streamId = uid();
    setMessages((prev) => [
      ...prev,
      { id: streamId, role: 'assistant', kind: 'streaming', text: '' },
    ]);

    try {
      const res = await postAiAssistantTurnStream('/api/ai/commission-rule-assistant/turn', fd, {
        timeoutMs: 120000,
        onDelta: (text) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId && isAssistantStreamingMessage(m)
                ? { ...m, text: stripGuidsFromCommissionAiText(text) }
                : m
            )
          );
        },
      });

      if (!res.reply) {
        throw new Error(res.message || 'Assistant returned no reply');
      }

      if (res.sessionGridExtract?.trim()) {
        setSessionGridExtract(res.sessionGridExtract.trim());
      }

      const reply = res.reply as AIReply;
      const sanitize = (s: string) => stripGuidsFromCommissionAiText(s);
      if (reply.kind === 'question') {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== streamId),
          { id: uid(), role: 'assistant', kind: 'question', text: sanitize(reply.text) },
        ]);
      } else {
        setLatestProposal(reply.patch);
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== streamId),
          {
            id: uid(),
            role: 'assistant',
            kind: 'proposal',
            reply: {
              ...reply,
              summary: sanitize(reply.summary),
              warnings: reply.warnings?.map(sanitize),
            },
          },
        ]);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      setMessages((prev) => [
        ...prev.filter((m) => !isAssistantStreamingMessage(m)),
        { id: uid(), role: 'assistant', kind: 'error', text: msg },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const handleResetChat = () => {
    seedPrimer();
  };

  const handleApply = (patch: AIProposalPatch) => {
    onApply(patch);
    onClose();
  };

  const handleRefine = () => {
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const renderProposalCard = (msg: Extract<ChatMessage, { kind: 'proposal' }>) => {
    const { reply } = msg;
    const { patch } = reply;
    const { codes, showBase, showFamily, displayPatch } = buildProposalPreviewColumns(patch);

    return (
      <Box
        sx={{
          ml: 2,
          mr: 0,
          p: 2,
          bgcolor: 'grey.50',
          borderRadius: 2,
          border: '1px solid',
          borderColor: 'divider',
          maxWidth: '100%',
        }}
      >
        <Box display="flex" alignItems="flex-start" gap={1} mb={1} flexWrap="wrap">
          <Chip
            size="small"
            label={displayPatch.mode === 'percentage' ? 'Percentage' : 'Flat $'}
            color="primary"
            variant="outlined"
          />
          <Box sx={{ flex: 1, minWidth: 120 }}>
            <AiChatMarkdown variant="subtitle2">{reply.summary}</AiChatMarkdown>
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          Apply updates tiers that appear in this proposal (matched by level); other tier rows in the form stay as they are.
        </Typography>

        {reply.warnings && reply.warnings.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {reply.warnings.map((w, i) => (
              <Box key={i} sx={{ mb: i < reply.warnings!.length - 1 ? 1 : 0 }}>
                <AiChatMarkdown>{w}</AiChatMarkdown>
              </Box>
            ))}
          </Alert>
        )}

        <Table size="small" sx={{ mb: 1 }}>
          <TableHead>
            <TableRow>
              <TableCell>Tier</TableCell>
              {showBase && <TableCell align="right">Base</TableCell>}
              {showFamily &&
                codes.map((c) => {
                  const colUsed = displayPatch.tiers.some((row) => {
                    const x = row.productTiers?.[c];
                    return x && (x.rate != null || x.flatAmount != null);
                  });
                  if (!colUsed) return null;
                  return (
                    <TableCell key={c} align="right">
                      {c}
                    </TableCell>
                  );
                })}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayPatch.tiers.map((t) => (
              <TableRow key={`${t.level}-${t.name}`}>
                <TableCell>
                  {t.name} ({t.level})
                </TableCell>
                {showBase && (
                  <TableCell align="right">
                    {displayPatch.mode === 'percentage'
                      ? formatAiCommissionCell('percentage', t.rate, undefined) || (
                          <Typography component="span" color="text.disabled">
                            —
                          </Typography>
                        )
                      : formatAiCommissionCell('flatrate', undefined, t.flatAmount) || (
                          <Typography component="span" color="text.disabled">
                            —
                          </Typography>
                        )}
                  </TableCell>
                )}
                {showFamily &&
                  codes.map((c) => {
                    const v = t.productTiers?.[c];
                    const has = v && (v.rate != null || v.flatAmount != null);
                    const colUsed = displayPatch.tiers.some((row) => {
                      const x = row.productTiers?.[c];
                      return x && (x.rate != null || x.flatAmount != null);
                    });
                    if (!colUsed) return null;
                    return (
                      <TableCell key={c} align="right">
                        {has && v ? formatAiCommissionCell(displayPatch.mode, v.rate, v.flatAmount) : '—'}
                      </TableCell>
                    );
                  })}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Button size="small" onClick={() => setExpandedJsonId(expandedJsonId === msg.id ? null : msg.id)}>
          {expandedJsonId === msg.id ? 'Hide raw JSON' : 'Show raw JSON'}
        </Button>
        <Collapse in={expandedJsonId === msg.id}>
          <Box
            component="pre"
            sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, overflow: 'auto' }}
          >
            {JSON.stringify(patch, null, 2)}
          </Box>
        </Collapse>

        <Box display="flex" gap={1} mt={2}>
          <Button variant="contained" size="small" onClick={() => handleApply(patch)}>
            Apply
          </Button>
          <Button variant="outlined" size="small" onClick={handleRefine}>
            Refine
          </Button>
        </Box>
      </Box>
    );
  };

  const sendDisabled =
    loading ||
    !aiAvailable ||
    (!prompt.trim() && pendingFiles.length === 0 && sessionFilesRef.current.length === 0 && !sessionGridExtract);

  return (
    <>
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={loading}
      slotProps={commissionDialogSlotProps(COMMISSION_NESTED_DIALOG_Z)}
      sx={{ zIndex: COMMISSION_NESTED_DIALOG_Z }}
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
          <Box display="flex" alignItems="center" gap={1}>
            <AutoAwesomeIcon color="primary" />
            <Typography variant="h6">Edit Commission Rule with AI</Typography>
          </Box>
          <Box display="flex" alignItems="center" gap={1}>
            <Button size="small" onClick={() => setNewChatConfirmOpen(true)} disabled={loading}>
              New chat
            </Button>
            <IconButton size="small" onClick={onClose} disabled={loading} aria-label="Close">
              <CloseIcon />
            </IconButton>
          </Box>
        </Box>
      </DialogTitle>

      <Box sx={{ px: 3, pb: 2, display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}>
        {!aiAvailable && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            AI assist is not configured on this environment (missing OPENAI_API_KEY).
          </Alert>
        )}

        <Box sx={{ flex: 1, overflow: 'auto', py: 1 }}>
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
              ) : m.kind === 'streaming' || m.kind === 'question' ? (
                <Box sx={{ ml: 0 }}>
                  <AiChatMarkdown>{m.text}</AiChatMarkdown>
                </Box>
              ) : m.kind === 'error' ? (
                <Box sx={{ ml: 0 }}>
                  <Alert
                    severity="error"
                    action={
                      retryPayload && (
                        <Button
                          color="inherit"
                          size="small"
                          onClick={() => void sendTurn(retryPayload.prompt, retryPayload.files)}
                        >
                          Retry last turn
                        </Button>
                      )
                    }
                  >
                    <AiChatMarkdown>{m.text}</AiChatMarkdown>
                  </Alert>
                </Box>
              ) : (
                renderProposalCard(m)
              )}
            </Box>
          ))}
          {loading && !messages.some((m) => isAssistantStreamingMessage(m)) && (
            <Box display="flex" alignItems="center" gap={1} sx={{ ml: 2 }}>
              <CircularProgress size={20} />
              <Typography variant="body2" color="text.secondary">
                Thinking…
              </Typography>
            </Box>
          )}
          <div ref={bottomRef} />
        </Box>

        {pendingFiles.length > 0 && (
          <Box display="flex" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
            {pendingFiles.map((f, i) => (
              <Chip
                key={`${f.name}-${i}`}
                label={f.name}
                onDelete={() =>
                  setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                }
                size="small"
              />
            ))}
          </Box>
        )}

        <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.csv,.xlsx,.xls,.doc,.docx,text/plain"
            onChange={(e) => {
              const list = e.target.files ? Array.from(e.target.files) : [];
              if (list.length) setPendingFiles((prev) => [...prev, ...list].slice(0, 5));
              e.target.value = '';
            }}
          />
        <AiChatComposer
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={() => void sendTurn(prompt, pendingFiles)}
          loading={loading}
          disabled={!aiAvailable}
          sendDisabled={sendDisabled}
          placeholder="Describe changes or paste numbers…"
          inputRef={inputRef}
          showAttach
          onAttachClick={() => fileInputRef.current?.click()}
          attachDisabled={loading || pendingFiles.length >= 5}
        />

        {latestProposal && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
            Latest proposal is pinned — scroll up to use Apply on that card, or ask for changes below.
          </Typography>
        )}
      </Box>

      <Dialog
        open={newChatConfirmOpen}
        onClose={() => !loading && setNewChatConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
        {...commissionNestedConfirmDialogProps()}
      >
        <DialogTitle>Start new chat?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Current chat history will be cleared. Uploaded files and AI context for this session will be lost.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewChatConfirmOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            disabled={loading}
            onClick={() => {
              setNewChatConfirmOpen(false);
              handleResetChat();
            }}
          >
            New chat
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>

    </>
  );
};

export default CommissionRuleAIAssistant;
