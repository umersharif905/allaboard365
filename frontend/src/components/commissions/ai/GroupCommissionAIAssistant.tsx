// Bulk AI assistant for Tiered commission rules within one commission group.
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSplitDisplayForRule, getTierDisplayForRule } from '../../../constants/form-options';
import type { CommissionGroupRule } from '../../../services/commissionGroups.service';
import { commissionRuleService } from '../../../services/commissionRules.service';
import { apiService } from '../../../services/api.service';
import { mergeAiPatchIntoTiers } from '../../../utils/commissionAiMerge';
import { fetchProductCommissionAiEnrichment } from '../../../utils/fetchProductCommissionAiEnrichment';
import {
  clearGroupCommissionAiChatSession,
  groupCommissionAiChatStorageKey,
  isLockedRuleWarning,
  loadGroupCommissionAiChatSession,
  saveGroupCommissionAiChatSession,
} from '../../../utils/groupCommissionAiSession';
import { stripGuidsFromCommissionAiText } from '../../../utils/sanitizeCommissionAiUserText';
import { mapCommissionRuleToFormData } from '../RuleCreationWizard';
import type { AIProposalPatch } from './CommissionRuleAIAssistant';
import {
  buildProposalPreviewColumns,
  formatAiCommissionCell,
} from './CommissionRuleAIAssistant';
import { AiChatMarkdown } from './AiChatMarkdown';
import { AiChatComposer } from '../../ai/AiChatComposer';
import {
  COMMISSION_NESTED_DIALOG_Z,
  commissionDialogSlotProps,
  commissionNestedConfirmDialogProps,
} from '../commissionDialogZIndex';
import { isAssistantStreamingMessage } from '../../../utils/aiChatMessageGuards';
import { postAiAssistantTurnStream } from '../../../utils/aiAssistantStreamTurn';

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/** Group list API sometimes omits CommissionType=Tiered while CommissionJson has tiers. */
export function ruleLooksTiered(r: CommissionGroupRule): boolean {
  if (r.CommissionType === 'Tiered') return true;
  if (r.CommissionJson == null || r.CommissionJson === '') return false;
  try {
    const json =
      typeof r.CommissionJson === 'string' ? JSON.parse(r.CommissionJson as string) : r.CommissionJson;
    return Array.isArray(json?.tiers) && json.tiers.length > 0;
  } catch {
    return false;
  }
}

function commissionJsonAiHints(commissionJson: string | object | null | undefined): string | null {
  if (commissionJson == null || commissionJson === '') return null;
  try {
    const json =
      typeof commissionJson === 'string' ? JSON.parse(commissionJson as string) : commissionJson;
    const parts: string[] = [];
    const d = json?.description != null ? String(json.description).trim() : '';
    if (d) parts.push(d);
    const n = json?.notes != null ? String(json.notes).trim() : '';
    if (n) parts.push(`Notes: ${n.slice(0, 240)}`);
    return parts.length ? parts.join(' · ') : null;
  } catch {
    return null;
  }
}

/** Same product • Tiers pattern as CommissionRulesManager group cards (keyword matching for AI). */
function catalogSubtitleFromGroupRule(r: CommissionGroupRule): string | null {
  const pid = (r.ProductId || '').trim();
  const isAll = !pid || pid.toLowerCase() === ALL_PRODUCTS_GUID.toLowerCase();
  const productLine = isAll ? 'All Products' : (r.ProductName || r.ProductId || '').trim() || pid;
  const tierPart = getTierDisplayForRule(r);
  const splitPart = getSplitDisplayForRule(r);
  if (tierPart) return `${productLine} • Tiers: ${tierPart}`;
  if (splitPart) return `${productLine} • Split: ${splitPart}`;
  if (r.EntityType) return `${productLine} • ${r.EntityType}`;
  return productLine;
}

export type ProductVendorCommissionCatalog = {
  /** VendorCommission USD pools for latest effective pricing wave (min/max across age bands per EE–EF). */
  poolsByTier: Record<string, { minUsd: number; maxUsd: number }>;
  globalMaxUsd: number | null;
  note?: string;
};

export type GroupRuleCatalogEntry = {
  /** Stable # for AI prompts (1-based, tiered rows in catalog order). */
  catalogIndex?: number;
  ruleId: string;
  ruleName: string;
  productLabel: string;
  /** Concrete product when not “All Products”; null for wildcard rules. */
  productId: string | null;
  /** oe.Products.SalesType: Individual | Group | Both */
  productSalesType: string | null;
  productIsBundle: boolean;
  /** oe.Products.Name — canonical product title (e.g. Essential (ShareWELL)). */
  productName: string | null;
  /** Mirrors UI: "Product • Tiers: Associate, …". */
  catalogDisplaySubtitle: string | null;
  /** CommissionJson description / notes when present. */
  commissionJsonHints: string | null;
  /** oe.Vendors — carrier for this product (from group rules API + product enrichment). */
  vendorId: string | null;
  vendorName: string | null;
  vendorCommission: ProductVendorCommissionCatalog | null;
  vendorCommissionLoadError: string | null;
  commissionType: string;
  locked: boolean;
  snapshot: Record<string, unknown>;
};

export type AIGroupProposalRuleEntry = {
  ruleId: string;
  summary?: string;
  patch: AIProposalPatch;
};

export type AIGroupReply =
  | { kind: 'question'; text: string }
  | { kind: 'proposal'; summary: string; rules: AIGroupProposalRuleEntry[]; warnings?: string[] };

type ChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | { id: string; role: 'assistant'; kind: 'streaming'; text: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'groupProposal';
      reply: AIGroupReply & { kind: 'proposal' };
    }
  | { id: string; role: 'assistant'; kind: 'error'; text: string };

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sessionFileKey(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function productLabelFromGroupRule(r: CommissionGroupRule): string {
  const pid = r.ProductId || '';
  if (!pid || pid === ALL_PRODUCTS_GUID) return 'All Products';
  return r.ProductName || pid;
}

/** One patch per ruleId; keep last if the model duplicated an entry. */
export function dedupeGroupProposalRules(rules: AIGroupProposalRuleEntry[]): {
  rules: AIGroupProposalRuleEntry[];
  duplicateWarnings: string[];
} {
  const byId = new Map<string, AIGroupProposalRuleEntry>();
  const duplicateWarnings: string[] = [];
  for (const entry of rules) {
    const k = entry.ruleId.trim().toLowerCase();
    if (byId.has(k)) {
      duplicateWarnings.push(
        `Duplicate proposal card for the same rule (${entry.ruleId}) — showing the last version only. The AI may have mapped two plan rows to one product.`
      );
    }
    byId.set(k, entry);
  }
  return { rules: Array.from(byId.values()), duplicateWarnings };
}

const PLAN_TIER_WORDS = ['basic', 'silver', 'gold', 'concierge', 'hsa', 'preventive', 'preventative', 'copay'];

function summaryProductMismatch(summary: string, productName: string | null | undefined): string | null {
  if (!summary?.trim() || !productName?.trim()) return null;
  const s = summary.toLowerCase();
  const p = productName.toLowerCase();
  for (const word of PLAN_TIER_WORDS) {
    if (s.includes(word) && !p.includes(word)) {
      return `Summary mentions "${word}" but product is "${productName}" — confirm this patch targets the right rule.`;
    }
  }
  return null;
}

export interface GroupCommissionAIAssistantProps {
  open: boolean;
  onClose: () => void;
  commissionGroupId: string;
  groupName: string;
  /** Rules currently in the group (metadata); Tiered rows get full snapshots loaded inside modal. */
  groupRules: CommissionGroupRule[];
  tenantTierLevels: Array<{ level: number; name: string }>;
  onApplied: () => void;
}

export const GroupCommissionAIAssistant: React.FC<GroupCommissionAIAssistantProps> = ({
  open,
  onClose,
  commissionGroupId,
  groupName,
  groupRules,
  tenantTierLevels,
  onApplied,
}) => {
  const [aiAvailable, setAiAvailable] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sessionGridExtract, setSessionGridExtract] = useState<string | null>(null);
  const sessionFilesRef = useRef<File[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [rulesCatalog, setRulesCatalog] = useState<GroupRuleCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);
  const [crossAckDialog, setCrossAckDialog] = useState<{
    reply: AIGroupReply & { kind: 'proposal' };
    impacts: Array<{ ruleId: string; ruleName: string; otherGroups: Array<{ CommissionGroupId: string; Name: string }> }>;
  } | null>(null);
  const [crossAckChecked, setCrossAckChecked] = useState(false);
  const [applying, setApplying] = useState(false);
  /** When true (default), rules updated by Apply are set Locked if they were not already. */
  const [lockModifiedRules, setLockModifiedRules] = useState(true);
  const [newChatConfirmOpen, setNewChatConfirmOpen] = useState(false);
  const [lockedRulesListOpen, setLockedRulesListOpen] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seededForOpenRef = useRef(false);

  const storageKey = useMemo(
    () => groupCommissionAiChatStorageKey(commissionGroupId),
    [commissionGroupId]
  );

  const persistSession = useCallback(
    (msgs: ChatMessage[], gridExtract: string | null) => {
      saveGroupCommissionAiChatSession(storageKey, {
        messages: msgs as Parameters<typeof saveGroupCommissionAiChatSession>[1]['messages'],
        sessionGridExtract: gridExtract || undefined,
        updatedAt: Date.now(),
      });
    },
    [storageKey]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success?: boolean; available?: boolean }>(
          '/api/ai/commission-rule-assistant/status'
        );
        if (!cancelled) setAiAvailable(Boolean(res.available));
      } catch {
        if (!cancelled) setAiAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setLockModifiedRules(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const stored = loadGroupCommissionAiChatSession(storageKey);
    if (stored?.messages?.length) {
      setMessages(stored.messages as ChatMessage[]);
      setSessionGridExtract(stored.sessionGridExtract || null);
      seededForOpenRef.current = true;
    } else {
      setMessages([]);
      setSessionGridExtract(null);
      seededForOpenRef.current = false;
    }
    sessionFilesRef.current = [];
    setPendingFiles([]);
  }, [open, storageKey]);

  const ruleIdToLabel = useMemo(() => {
    const m = new Map<string, string>();
    rulesCatalog.forEach((r, idx) => {
      const n = r.catalogIndex ?? idx + 1;
      const name = r.productName || r.ruleName || r.productLabel || 'rule';
      m.set(r.ruleId.toLowerCase(), `${name} (#${n})`);
    });
    return m;
  }, [rulesCatalog]);

  const catalogMeta = useMemo(() => {
    const m = new Map<
      string,
      {
        catalogIndex?: number;
        ruleName: string;
        productLabel: string;
        productName: string | null;
        catalogDisplaySubtitle: string | null;
        locked: boolean;
      }
    >();
    rulesCatalog.forEach((r, idx) => {
      m.set(r.ruleId.toLowerCase(), {
        catalogIndex: r.catalogIndex ?? idx + 1,
        ruleName: r.ruleName,
        productLabel: r.productLabel,
        productName: r.productName,
        catalogDisplaySubtitle: r.catalogDisplaySubtitle,
        locked: r.locked,
      });
    });
    return m;
  }, [rulesCatalog]);

  const tierNamesLine = useMemo(
    () =>
      tenantTierLevels.length > 0
        ? tenantTierLevels.map((t) => t.name).join(', ')
        : 'your tenant tier ladder',
    [tenantTierLevels]
  );

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const entries: GroupRuleCatalogEntry[] = [];
      for (const r of groupRules) {
        const locked = Boolean(r.Locked === true || r.Locked === 1);
        const pidRaw = (r.ProductId || '').trim();
        const isAllProducts =
          !pidRaw || pidRaw.toLowerCase() === ALL_PRODUCTS_GUID.toLowerCase();

        const base: GroupRuleCatalogEntry = {
          ruleId: r.RuleId,
          ruleName: r.RuleName,
          productLabel: productLabelFromGroupRule(r),
          productId: isAllProducts ? null : pidRaw,
          productSalesType: r.ProductSalesType != null && String(r.ProductSalesType).trim() !== '' ? String(r.ProductSalesType) : null,
          productIsBundle: r.ProductIsBundle === true || r.ProductIsBundle === 1,
          productName:
            !isAllProducts && r.ProductName != null && String(r.ProductName).trim() !== ''
              ? String(r.ProductName).trim()
              : null,
          catalogDisplaySubtitle: catalogSubtitleFromGroupRule(r),
          commissionJsonHints: commissionJsonAiHints(r.CommissionJson),
          vendorId:
            !isAllProducts && r.ProductVendorId != null && String(r.ProductVendorId).trim() !== ''
              ? String(r.ProductVendorId)
              : null,
          vendorName:
            r.ProductVendorName != null && String(r.ProductVendorName).trim() !== ''
              ? String(r.ProductVendorName)
              : null,
          vendorCommission: null,
          vendorCommissionLoadError: null,
          commissionType: r.CommissionType,
          locked,
          snapshot: {},
        };

        if (!ruleLooksTiered(r)) {
          entries.push({
            ...base,
            snapshot: {
              commissionType: r.CommissionType,
              note: 'Not Tiered — patches apply only to Tiered rules.',
            },
          });
          continue;
        }

        try {
          const full = await commissionRuleService.getRuleById(r.RuleId);
          const form = mapCommissionRuleToFormData(full);
          const mergedGroupRow: CommissionGroupRule = {
            ...r,
            ProductName: full.ProductName ?? r.ProductName,
            CommissionJson: full.CommissionJson ?? r.CommissionJson,
            CommissionType: full.CommissionType,
            EntityType: full.EntityType,
            TierLevel: full.TierLevel ?? r.TierLevel,
          };
          const productNameResolved =
            (full.ProductName && String(full.ProductName).trim()) ||
            (form.productName && String(form.productName).trim()) ||
            base.productName;

          const hintsFromForm = [form.description?.trim(), form.notes?.trim()].filter(Boolean).join(' · ');
          const commissionJsonHintsMerged =
            [commissionJsonAiHints(full.CommissionJson), hintsFromForm].filter(Boolean).join(' · ') ||
            base.commissionJsonHints;

          entries.push({
            ...base,
            commissionType:
              full.CommissionType === 'Tiered' ||
              form.commissionType === 'Tiered' ||
              ruleLooksTiered(mergedGroupRow)
                ? 'Tiered'
                : base.commissionType,
            productName: productNameResolved || null,
            catalogDisplaySubtitle: catalogSubtitleFromGroupRule(mergedGroupRow),
            commissionJsonHints: commissionJsonHintsMerged || null,
            snapshot: {
              type: form.type,
              commissionType: form.commissionType,
              tiers: form.tiers || [],
              ...(locked
                ? {
                    locked: true,
                    note: 'Locked rule — AI may propose changes; applying updates this active rule.',
                  }
                : {}),
            },
          });
        } catch {
          entries.push({
            ...base,
            snapshot: { error: 'Could not load rule details' },
          });
        }
      }

      const distinctProductIds = [
        ...new Set(
          groupRules
            .map((r) => (r.ProductId || '').trim())
            .filter((id) => id && id.toLowerCase() !== ALL_PRODUCTS_GUID.toLowerCase())
        ),
      ];

      const enrichByProductId = new Map<
        string,
        Awaited<ReturnType<typeof fetchProductCommissionAiEnrichment>>
      >();
      await Promise.all(
        distinctProductIds.map(async (pid) => {
          try {
            const e = await fetchProductCommissionAiEnrichment(pid);
            enrichByProductId.set(pid.toLowerCase(), e);
          } catch {
            enrichByProductId.delete(pid.toLowerCase());
          }
        })
      );

      for (let i = 0; i < entries.length; i++) {
        const r = groupRules[i];
        const row = entries[i];
        const pid = (r.ProductId || '').trim();
        const isAll = !pid || pid.toLowerCase() === ALL_PRODUCTS_GUID.toLowerCase();

        const en = !isAll ? enrichByProductId.get(pid.toLowerCase()) : undefined;

        const productSalesType =
          row.productSalesType ||
          (en && en.salesType !== 'Unknown' ? en.salesType : null) ||
          null;

        const productIsBundle =
          row.productIsBundle ||
          Boolean(en?.isBundle);

        const vendorId =
          row.vendorId ||
          (en?.vendorId && en.vendorId.trim() !== '' ? en.vendorId : null) ||
          null;
        const vendorName =
          (row.vendorName && row.vendorName.trim()) ||
          (en?.vendorName && en.vendorName.trim() !== '' ? en.vendorName : null) ||
          null;

        let vendorCommission: ProductVendorCommissionCatalog | null = null;
        let vendorCommissionLoadError: string | null = null;

        if (!isAll) {
          if (en && Object.keys(en.poolsByTier).length > 0) {
            vendorCommission = {
              poolsByTier: en.poolsByTier,
              globalMaxUsd: en.globalMaxUsd,
              ...(productIsBundle
                ? {
                    note:
                      'Bundle product: poolsByTier/globalMaxUsd use the tightest (minimum) caps across bundled component products.',
                  }
                : {}),
            };
          } else if (en && Object.keys(en.poolsByTier).length === 0) {
            vendorCommissionLoadError = 'No VendorCommission pricing tiers found for this product on the latest wave.';
          } else {
            vendorCommissionLoadError = 'Could not load product pricing for VendorCommission caps.';
          }
        }

        entries[i] = {
          ...row,
          productName:
            row.productName ||
            (en?.productName && en.productName.trim() !== '' ? en.productName.trim() : null) ||
            row.productLabel ||
            null,
          productSalesType,
          productIsBundle,
          vendorId,
          vendorName,
          vendorCommission,
          vendorCommissionLoadError,
        };
      }

      entries.forEach((e, idx) => {
        e.catalogIndex = idx + 1;
      });
      setRulesCatalog(entries);
    } catch (e: unknown) {
      setCatalogError(e instanceof Error ? e.message : 'Failed to build catalog');
      setRulesCatalog([]);
    } finally {
      setCatalogLoading(false);
    }
  }, [groupRules]);

  const seedPrimer = useCallback(() => {
    const tiered = rulesCatalog.filter((c) => c.commissionType === 'Tiered');
    const lines = rulesCatalog
      .map((c) => {
        const chipParts: string[] = [];
        if (c.commissionType !== 'Tiered') chipParts.push('not tiered');
        else if (c.locked) chipParts.push('locked');
        const chip = chipParts.length ? ` (${chipParts.join(', ')})` : '';
        const sale =
          c.productSalesType && c.productId
            ? ` · ${c.productSalesType}${c.productIsBundle ? ', bundle' : ''}${c.vendorName ? ` · ${c.vendorName}` : ''}`
            : '';
        const productLine = c.productName || c.productLabel;
        return `• **${productLine}** — rule: ${c.ruleName} · ${c.catalogDisplaySubtitle || c.productLabel}${sale}${chip}`;
      })
      .join('\n');

    const primer: ChatMessage = {
      id: uid(),
      role: 'assistant',
      kind: 'question',
      text:
        `You're editing **${groupName}**. I know these rules:\n\n${lines}\n\n` +
        `${tiered.length === 0 ? 'There are no Tiered rules in this group — add or convert rules to Tiered before using AI here.' : `Tiered rules (locked rules can still be updated via AI): **${tiered.length}**. `}` +
        `Describe how commission should split across products. **Bundle split:** totals per agent tier are often the **sum** of $ on several rules (e.g. $15 on ShareWELL + $35 on Copay = $50). Tier ladder (use these **level** integers in patches): ${tenantTierLevels.map((t) => `${t.name}=${t.level}`).join(', ') || tierNamesLine}.`,
    };
    setMessages([primer]);
    setPendingFiles([]);
    setPrompt('');
    setExpandedJsonId(null);
    persistSession([primer], sessionGridExtract);
  }, [groupName, rulesCatalog, tierNamesLine, tenantTierLevels, persistSession, sessionGridExtract]);

  useEffect(() => {
    if (!open) return;
    void loadCatalog();
  }, [open, loadCatalog]);

  useEffect(() => {
    if (!open || catalogLoading || catalogError || seededForOpenRef.current) return;
    seedPrimer();
    seededForOpenRef.current = true;
  }, [open, catalogLoading, catalogError, seedPrimer]);

  const startNewChat = useCallback(() => {
    clearGroupCommissionAiChatSession(storageKey);
    sessionFilesRef.current = [];
    setSessionGridExtract(null);
    setPendingFiles([]);
    setPrompt('');
    setExpandedJsonId(null);
    setLockedRulesListOpen(false);
    seededForOpenRef.current = false;
    if (!catalogLoading && !catalogError && rulesCatalog.length > 0) {
      seedPrimer();
      seededForOpenRef.current = true;
    } else {
      setMessages([]);
    }
  }, [storageKey, catalogLoading, catalogError, rulesCatalog.length, seedPrimer]);

  /** Locked rules referenced in any proposal still in the chat thread. */
  const lockedRulesInProposals = useMemo(() => {
    const seen = new Map<string, { ruleId: string; label: string }>();
    for (const m of messages) {
      if (m.role !== 'assistant' || m.kind !== 'groupProposal') continue;
      for (const entry of m.reply.rules) {
        const meta = catalogMeta.get(entry.ruleId.toLowerCase());
        if (!meta?.locked) continue;
        const key = entry.ruleId.toLowerCase();
        if (seen.has(key)) continue;
        const label = meta.productName || meta.productLabel || meta.ruleName;
        seen.set(key, { ruleId: entry.ruleId, label });
      }
    }
    return Array.from(seen.values());
  }, [messages, catalogMeta]);

  const historyForApi = useCallback((msgs: ChatMessage[]) => {
    const capped = msgs.slice(-22);
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of capped) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant' && m.kind === 'streaming') {
        if (m.text.trim()) out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'question') {
        out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'assistant' && m.kind === 'groupProposal') {
        out.push({
          role: 'assistant',
          content: `GROUP_PROPOSAL_JSON:${JSON.stringify({
            summary: m.reply.summary,
            rules: m.reply.rules,
            warnings: m.reply.warnings,
          })}`,
        });
      } else if (m.role === 'assistant' && m.kind === 'error') {
        out.push({ role: 'assistant', content: `Error: ${m.text}` });
      }
    }
    return out;
  }, []);

  const persistRules = async (reply: AIGroupReply & { kind: 'proposal' }) => {
    setApplying(true);
    try {
      const { rules: rulesToApply } = dedupeGroupProposalRules(reply.rules);
      for (const entry of rulesToApply) {
        const full = await commissionRuleService.getRuleById(entry.ruleId);
        if (full.CommissionType !== 'Tiered') {
          continue;
        }
        let commissionJson: Record<string, unknown> = {};
        if (full.CommissionJson) {
          commissionJson =
            typeof full.CommissionJson === 'string'
              ? JSON.parse(full.CommissionJson)
              : (full.CommissionJson as Record<string, unknown>);
        }
        const existingTiers = Array.isArray(commissionJson.tiers)
          ? (commissionJson.tiers as Parameters<typeof mergeAiPatchIntoTiers>[0])
          : [];
        const mergedTiers = mergeAiPatchIntoTiers(existingTiers, entry.patch, tenantTierLevels);
        const nextJson = {
          ...commissionJson,
          type: entry.patch.mode,
          tiers: mergedTiers,
        };
        const wasLocked = full.Locked === true || full.Locked === 1;
        await commissionRuleService.updateRule(entry.ruleId, {
          commissionJson: JSON.stringify(nextJson),
          commissionType: 'Tiered',
          ...(lockModifiedRules && !wasLocked ? { locked: true } : {}),
        });
      }
      const appliedMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        kind: 'question',
        text: '**Changes applied.** Commission tiers were saved. You can keep chatting to refine, or use **New chat** to start over.',
      };
      setMessages((prev) => {
        const next = [...prev, appliedMsg];
        persistSession(next, sessionGridExtract);
        return next;
      });
      onApplied();
      onClose();
    } finally {
      setApplying(false);
    }
  };

  const startApply = async (reply: AIGroupReply & { kind: 'proposal' }) => {
    const ruleIds = reply.rules.map((r) => r.ruleId);
    if (ruleIds.length === 0) return;

    const memberships = await commissionRuleService.getRulesGroupMemberships(ruleIds);
    const impacts: Array<{
      ruleId: string;
      ruleName: string;
      otherGroups: Array<{ CommissionGroupId: string; Name: string }>;
    }> = [];

    for (const m of memberships) {
      const others = m.groups.filter((g) => g.CommissionGroupId !== commissionGroupId);
      if (others.length > 0) {
        const meta = catalogMeta.get(m.ruleId.toLowerCase());
        impacts.push({
          ruleId: m.ruleId,
          ruleName: meta?.ruleName || m.ruleId,
          otherGroups: others,
        });
      }
    }

    if (impacts.length > 0) {
      setCrossAckChecked(false);
      setCrossAckDialog({ reply, impacts });
      return;
    }

    await persistRules(reply);
  };

  const mergeSessionFiles = (newFiles: File[]) => {
    const map = new Map<string, File>();
    for (const f of sessionFilesRef.current) map.set(sessionFileKey(f), f);
    for (const f of newFiles) map.set(sessionFileKey(f), f);
    const merged = Array.from(map.values()).slice(0, 5);
    sessionFilesRef.current = merged;
    return merged;
  };

  const sendTurn = async (text: string, files: File[]) => {
    if (!aiAvailable || rulesCatalog.length === 0) return;
    const trimmed = text.trim();
    const newFilesThisTurn = files.length > 0;
    const filesToSend = mergeSessionFiles(files);
    if (!trimmed && filesToSend.length === 0 && !sessionGridExtract) return;

    setLoading(true);
    const historyPayload = historyForApi(messages);

    const attachNote =
      filesToSend.length > 0
        ? `\n\n[${filesToSend.length} file(s) in session${newFilesThisTurn ? ' (incl. new)' : ' (from earlier)'}]`
        : '';
    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      content: (trimmed || '(See attachments)') + attachNote,
    };

    setMessages((prev) => {
      const next: ChatMessage[] = [...prev, userMsg];
      persistSession(next, sessionGridExtract);
      return next;
    });
    setPrompt('');
    setPendingFiles([]);

    const fd = new FormData();
    fd.append('prompt', trimmed || '(See attachments)');
    fd.append('history', JSON.stringify(historyPayload));
    fd.append('commissionGroupId', commissionGroupId);
    fd.append('tenantTierLevels', JSON.stringify(tenantTierLevels));
    fd.append('rulesCatalog', JSON.stringify(rulesCatalog));
    if (sessionGridExtract) fd.append('sessionGridExtract', sessionGridExtract);
    fd.append('refreshGridExtract', newFilesThisTurn ? '1' : '0');
    filesToSend.forEach((f) => fd.append('files', f));

    const streamId = uid();
    setMessages((prev) => [
      ...prev,
      { id: streamId, role: 'assistant', kind: 'streaming', text: '' },
    ]);

    try {
      const res = await postAiAssistantTurnStream('/api/ai/commission-rule-assistant/group-turn', fd, {
        timeoutMs: 180000,
        onDelta: (text) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId && isAssistantStreamingMessage(m)
                ? { ...m, text: stripGuidsFromCommissionAiText(text, ruleIdToLabel) }
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

      const reply = res.reply as AIGroupReply;
      const sanitize = (s: string) => stripGuidsFromCommissionAiText(s, ruleIdToLabel);
      if (reply.kind === 'question') {
        setMessages((prev) => {
          const next: ChatMessage[] = [
            ...prev.filter((m) => m.id !== streamId),
            { id: uid(), role: 'assistant', kind: 'question', text: sanitize(reply.text) },
          ];
          persistSession(next, res.sessionGridExtract?.trim() || sessionGridExtract);
          return next;
        });
      } else {
        const { rules: dedupedRules, duplicateWarnings } = dedupeGroupProposalRules(reply.rules);
        const mergedWarnings = [...(reply.warnings || []), ...duplicateWarnings].map(sanitize);
        setMessages((prev) => {
          const next: ChatMessage[] = [
            ...prev.filter((m) => m.id !== streamId),
            {
              id: uid(),
              role: 'assistant',
              kind: 'groupProposal',
              reply: {
                ...reply,
                summary: sanitize(reply.summary),
                rules: dedupedRules.map((r) => ({
                  ...r,
                  summary: r.summary ? sanitize(r.summary) : r.summary,
                })),
                warnings: mergedWarnings.length ? mergedWarnings : undefined,
              },
            },
          ];
          persistSession(next, res.sessionGridExtract?.trim() || sessionGridExtract);
          return next;
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      setMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev.filter((m) => !isAssistantStreamingMessage(m)),
          { id: uid(), role: 'assistant', kind: 'error', text: msg },
        ];
        persistSession(next, sessionGridExtract);
        return next;
      });
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const renderRulePatchCard = (
    msgId: string,
    ruleEntry: AIGroupProposalRuleEntry,
    cardIndex: number
  ) => {
    const meta = catalogMeta.get(ruleEntry.ruleId.toLowerCase());
    const title = meta?.productName || meta?.productLabel || 'Unknown product';
    const sub = [meta?.ruleName, meta?.catalogDisplaySubtitle].filter(Boolean).join(' · ');
    const mismatch = summaryProductMismatch(ruleEntry.summary || '', meta?.productName);
    const patch = ruleEntry.patch;
    const { codes, showBase, showFamily, displayPatch } = buildProposalPreviewColumns(patch);

    return (
      <Box
        key={`${msgId}-${ruleEntry.ruleId}-${cardIndex}`}
        sx={{
          mb: 2,
          p: 2,
          bgcolor: 'background.paper',
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography variant="subtitle2" fontWeight={700}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {sub}
        </Typography>
        {mismatch && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {mismatch}
          </Alert>
        )}
        {ruleEntry.summary && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {ruleEntry.summary}
          </Typography>
        )}
        <Chip
          size="small"
          label={displayPatch.mode === 'percentage' ? 'Percentage' : 'Flat $'}
          color="primary"
          variant="outlined"
          sx={{ mb: 1 }}
        />
        <Table size="small">
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
              <TableRow key={`${msgId}-${ruleEntry.ruleId}-${t.level}-${t.name}`}>
                <TableCell>
                  {t.name} ({t.level})
                </TableCell>
                {showBase && (
                  <TableCell align="right">
                    {displayPatch.mode === 'percentage'
                      ? formatAiCommissionCell('percentage', t.rate, undefined) || '—'
                      : formatAiCommissionCell('flatrate', undefined, t.flatAmount) || '—'}
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
      </Box>
    );
  };

  const renderGroupProposal = (msg: Extract<ChatMessage, { kind: 'groupProposal' }>) => {
    const { reply } = msg;
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
        <Box sx={{ mb: 1 }}>
          <AiChatMarkdown variant="subtitle2">{reply.summary}</AiChatMarkdown>
        </Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
          Matching tiers merge by level into each rule; other tier rows on that rule stay unchanged.
        </Typography>
        {(() => {
          const displayWarnings = (reply.warnings || []).filter((w) => !isLockedRuleWarning(w));
          return displayWarnings.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {displayWarnings.map((w, i) => (
                <Box key={i} sx={{ mb: i < displayWarnings.length - 1 ? 1 : 0 }}>
                  <AiChatMarkdown>{w}</AiChatMarkdown>
                </Box>
              ))}
            </Alert>
          ) : null;
        })()}
        {reply.rules.map((r, i) => renderRulePatchCard(msg.id, r, i))}

        <Button size="small" onClick={() => setExpandedJsonId(expandedJsonId === msg.id ? null : msg.id)}>
          {expandedJsonId === msg.id ? 'Hide raw JSON' : 'Show raw JSON'}
        </Button>
        <Collapse in={expandedJsonId === msg.id}>
          <Box
            component="pre"
            sx={{ mt: 1, p: 1, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, overflow: 'auto' }}
          >
            {JSON.stringify(reply.rules, null, 2)}
          </Box>
        </Collapse>

        <FormControlLabel
          sx={{ mt: 2, display: 'flex', alignItems: 'flex-start', ml: 0 }}
          control={
            <Checkbox
              checked={lockModifiedRules}
              onChange={(e) => setLockModifiedRules(e.target.checked)}
              disabled={applying}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Lock modified rules if needed</Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                After save, mark any updated rule as Locked if it is not already locked (active rule).
              </Typography>
            </Box>
          }
        />

        <Box display="flex" gap={1} mt={1}>
          <Button variant="contained" size="small" disabled={applying} onClick={() => void startApply(reply)}>
            {applying ? <CircularProgress size={18} /> : 'Apply changes'}
          </Button>
        </Box>
      </Box>
    );
  };

  const patchableTieredCount = useMemo(
    () => rulesCatalog.filter((c) => c.commissionType === 'Tiered').length,
    [rulesCatalog]
  );

  const sendDisabled =
    loading ||
    !aiAvailable ||
    catalogLoading ||
    !!catalogError ||
    rulesCatalog.length === 0 ||
    patchableTieredCount === 0 ||
    (!prompt.trim() && pendingFiles.length === 0 && sessionFilesRef.current.length === 0 && !sessionGridExtract);

  return (
    <>
      <Dialog
        open={open}
        onClose={loading || applying ? undefined : onClose}
        maxWidth="lg"
        fullWidth
        disableEscapeKeyDown={loading || applying}
        slotProps={commissionDialogSlotProps(COMMISSION_NESTED_DIALOG_Z)}
        sx={{ zIndex: COMMISSION_NESTED_DIALOG_Z }}
      >
        <DialogTitle>
          <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
            <Box display="flex" alignItems="center" gap={1}>
              <AutoAwesomeIcon color="primary" />
              <Typography variant="h6">Edit group rules with AI</Typography>
            </Box>
            <Box display="flex" alignItems="center" gap={0.5}>
              <Button
                size="small"
                variant="text"
                onClick={() => setNewChatConfirmOpen(true)}
                disabled={loading || applying || catalogLoading}
                sx={{ textTransform: 'none', minWidth: 'auto' }}
              >
                New chat
              </Button>
              <IconButton size="small" onClick={onClose} disabled={loading || applying} aria-label="Close">
                <CloseIcon />
              </IconButton>
            </Box>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {groupName}
          </Typography>
        </DialogTitle>

        <Box sx={{ px: 3, pb: 2, display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}>
          {!aiAvailable && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              AI assist is not configured on this environment (missing OPENAI_API_KEY).
            </Alert>
          )}
          {catalogError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {catalogError}
            </Alert>
          )}
          {!catalogLoading && !catalogError && patchableTieredCount === 0 && rulesCatalog.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This group has no Tiered commission rules. AI can only patch Tiered rules — create or convert rules to
              Tiered first.
            </Alert>
          )}
          {catalogLoading && (
            <Box display="flex" alignItems="center" gap={1} sx={{ mb: 2 }}>
              <CircularProgress size={22} />
              <Typography variant="body2">Loading rule snapshots…</Typography>
            </Box>
          )}

          {lockedRulesInProposals.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                You are modifying rules that are locked / currently live.
              </Typography>
              <Button
                size="small"
                endIcon={
                  <ExpandMoreIcon
                    sx={{
                      transform: lockedRulesListOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  />
                }
                onClick={() => setLockedRulesListOpen((v) => !v)}
                sx={{ mt: 0.5, textTransform: 'none', p: 0, minWidth: 0 }}
              >
                View {lockedRulesInProposals.length} rule
                {lockedRulesInProposals.length === 1 ? '' : 's'}
              </Button>
              <Collapse in={lockedRulesListOpen}>
                <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.25 }}>
                  {lockedRulesInProposals.map((r) => (
                    <Typography key={r.ruleId} component="li" variant="body2" sx={{ mb: 0.25 }}>
                      {r.label}
                    </Typography>
                  ))}
                </Box>
              </Collapse>
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
                  <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <Box sx={{ maxWidth: '90%', p: 1.5, bgcolor: 'grey.100', borderRadius: 2 }}>
                      <AiChatMarkdown>{m.text}</AiChatMarkdown>
                    </Box>
                  </Box>
                ) : m.kind === 'groupProposal' ? (
                  renderGroupProposal(m)
                ) : (
                  <Alert severity="error">{m.text}</Alert>
                )}
              </Box>
            ))}
            <div ref={bottomRef} />
          </Box>

          <Box sx={{ pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setPendingFiles((prev) => [...prev, ...files]);
                e.target.value = '';
              }}
            />
            <AiChatComposer
              prompt={prompt}
              onPromptChange={setPrompt}
              onSend={() => void sendTurn(prompt, pendingFiles)}
              loading={loading}
              disabled={!aiAvailable}
              sendDisabled={sendDisabled || applying}
              placeholder="Describe commissions across these rules…"
              inputRef={inputRef}
              showAttach
              onAttachClick={() => fileInputRef.current?.click()}
              attachDisabled={loading || applying}
            />
            {(pendingFiles.length > 0 || sessionFilesRef.current.length > 0) && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                {pendingFiles.length > 0 && <>New: {pendingFiles.map((f) => f.name).join(', ')}. </>}
                {sessionFilesRef.current.length > 0 &&
                  `Grid files stay in this chat (${sessionFilesRef.current.map((f) => f.name).join(', ')}) — you do not need to re-attach for follow-up answers.`}
              </Typography>
            )}
          </Box>
        </Box>

      <Dialog
        open={newChatConfirmOpen}
        onClose={() => !loading && !applying && setNewChatConfirmOpen(false)}
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
          <Button onClick={() => setNewChatConfirmOpen(false)} disabled={loading || applying}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            disabled={loading || applying}
            onClick={() => {
              setNewChatConfirmOpen(false);
              startNewChat();
            }}
          >
            New chat
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(crossAckDialog)} onClose={() => !applying && setCrossAckDialog(null)} maxWidth="sm" fullWidth {...commissionNestedConfirmDialogProps()}>
        <DialogTitle>Other commission groups use these rules</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Saving will update the underlying commission rules. Agents in other groups that share the same rule will
            see the new payouts too.
          </Typography>
          {crossAckDialog?.impacts.map((row) => (
            <Box key={row.ruleId} sx={{ mb: 2 }}>
              <Typography variant="subtitle2">{row.ruleName}</Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                Also in: {row.otherGroups.map((g) => g.Name || g.CommissionGroupId).join('; ')}
              </Typography>
            </Box>
          ))}
          <FormControlLabel
            sx={{ display: 'flex', alignItems: 'flex-start', ml: 0, mb: 2 }}
            control={
              <Checkbox
                checked={lockModifiedRules}
                onChange={(e) => setLockModifiedRules(e.target.checked)}
                disabled={applying}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Lock modified rules if needed</Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  After save, mark any updated rule as Locked if it is not already locked.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={crossAckChecked}
                onChange={(e) => setCrossAckChecked(e.target.checked)}
                disabled={applying}
              />
            }
            label="I understand other commission groups may be impacted."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCrossAckDialog(null)} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!crossAckChecked || applying}
            onClick={async () => {
              if (!crossAckDialog) return;
              const r = crossAckDialog.reply;
              setCrossAckDialog(null);
              await persistRules(r);
            }}
          >
            Save rules
          </Button>
        </DialogActions>
      </Dialog>

      </Dialog>
    </>
  );
};

export default GroupCommissionAIAssistant;
