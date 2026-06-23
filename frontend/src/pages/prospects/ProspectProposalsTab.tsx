// frontend/src/pages/prospects/ProspectProposalsTab.tsx
// Proposals + quotes for a prospect. Opens the real QuickQuote and SendProposal modals
// so the agent uses the same tool whether they start from the Quote page or from a prospect.

import { ExternalLink, FileText, Loader2, Receipt, Send, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import QuickQuoteWizardModal from '../../components/agents/QuickQuoteWizardModal';
import SendProposalModal from '../../components/proposals/SendProposalModal';
import { useProspectProposals } from '../../hooks/useProspects';
import { apiService } from '../../services/api.service';
import { Prospect } from '../../services/prospect.service';

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString() : '—');

interface QuickQuoteProduct {
  productId: string;
  productName: string;
  productType: string;
  isBundle?: boolean;
  subscriptionStatus?: string;
  salesType?: string;
  productDocumentUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: Array<{ productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }>;
  bundleProducts?: Array<{
    name?: string;
    productName?: string;
    productId?: string;
    productDocumentUrl?: string;
    ProductDocumentUrl?: string;
    productDocuments?: Array<{ productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }>;
  }>;
}

export default function ProspectProposalsTab({ prospect }: { prospect: Prospect }) {
  const qc = useQueryClient();
  const { data, isLoading } = useProspectProposals(prospect.ProspectId);

  const [showQuickQuote, setShowQuickQuote] = useState(false);
  const [showSendProposal, setShowSendProposal] = useState(false);
  const [quickQuoteProducts, setQuickQuoteProducts] = useState<QuickQuoteProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const proposals = data?.proposals || [];
  const quotes = data?.quotes || [];

  const prospectName = [prospect.FirstName, prospect.LastName].filter(Boolean).join(' ').trim() || undefined;
  const initialProspect = {
    name: prospectName,
    email: prospect.Email || undefined,
    phone: prospect.Phone || undefined,
  };

  const invalidateProspect = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['prospects', 'proposals', prospect.ProspectId] });
    qc.invalidateQueries({ queryKey: ['prospects', 'detail', prospect.ProspectId] });
  }, [qc, prospect.ProspectId]);

  const openQuickQuote = async () => {
    setLoadingProducts(true);
    try {
      const response = await apiService.get<{ success: boolean; data?: any[]; message?: string }>(
        '/api/me/agent/products?includeHidden=false'
      );
      const mapped: QuickQuoteProduct[] = (response?.data || []).map((product: Record<string, unknown>) => ({
        productId: product.ProductId as string,
        productName: product.Name as string,
        productType: (product.ProductType as string) || 'Other',
        isBundle: Boolean(product.IsBundle),
        subscriptionStatus: (product.SubscriptionStatus as string) || (product.subscriptionStatus as string) || 'Active',
        salesType: (product.SalesType as string) || (product.salesType as string),
        productDocumentUrl: product.ProductDocumentUrl as string | undefined,
        ProductDocumentUrl: product.ProductDocumentUrl as string | undefined,
        productDocuments: Array.isArray(product.ProductDocuments)
          ? (product.ProductDocuments as any[]).map((doc: any) => ({
              productDocumentId: doc.ProductDocumentId || doc.productDocumentId,
              documentUrl: doc.DocumentUrl || doc.documentUrl || '',
              displayName: doc.DisplayName || doc.displayName,
              sortOrder: doc.SortOrder || doc.sortOrder
            }))
          : undefined,
        bundleProducts: Array.isArray(product.BundleProducts)
          ? (product.BundleProducts as any[]).map((bp: any) => ({
              productId: bp.ProductId || bp.productId,
              name: bp.Name || bp.name || bp.ProductName || bp.productName,
              productName: bp.ProductName || bp.productName || bp.Name || bp.name,
              productDocumentUrl: bp.ProductDocumentUrl || bp.productDocumentUrl,
              ProductDocumentUrl: bp.ProductDocumentUrl || bp.productDocumentUrl,
              productDocuments: Array.isArray(bp.ProductDocuments)
                ? (bp.ProductDocuments as any[]).map((doc: any) => ({
                    productDocumentId: doc.ProductDocumentId || doc.productDocumentId,
                    documentUrl: doc.DocumentUrl || doc.documentUrl || '',
                    displayName: doc.DisplayName || doc.displayName,
                    sortOrder: doc.SortOrder || doc.sortOrder
                  }))
                : undefined
            }))
          : undefined
      }));
      setQuickQuoteProducts(mapped);
      setShowQuickQuote(true);
    } catch {
      // silently ignore load errors; the modal will open with empty products
      setQuickQuoteProducts([]);
      setShowQuickQuote(true);
    } finally {
      setLoadingProducts(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void openQuickQuote()}
          disabled={loadingProducts}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
        >
          {loadingProducts ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          Quick Quote
        </button>
        <button
          onClick={() => setShowSendProposal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
        >
          <Send className="w-4 h-4" />
          Individual Proposal
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <>
          <h3 className="text-sm font-medium text-gray-700">Quotes</h3>
          {quotes.length === 0 ? (
            <p className="text-sm text-gray-500">No quotes yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {quotes.map((q) => (
                <li key={q.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                  <Receipt className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 truncate">{q.name || 'Quote'}</p>
                    <p className="text-xs text-gray-400">{fmtDate(q.sentDate)} · {q.status}</p>
                  </div>
                  <span className="text-gray-900">{fmtMoney(q.premium)}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="text-sm font-medium text-gray-700 pt-2">Proposals sent</h3>
          {proposals.length === 0 ? (
            <p className="text-sm text-gray-500">No proposals sent.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {proposals.map((pr) => (
                <li key={pr.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                  <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 truncate">{pr.documentName || pr.name || 'Proposal'}</p>
                    <p className="text-xs text-gray-400">{fmtDate(pr.sentDate)} · {pr.sendMethod || ''}</p>
                  </div>
                  {pr.pdfUrl && (
                    <a
                      href={pr.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-oe-primary hover:text-oe-dark"
                    >
                      <ExternalLink className="w-4 h-4" /> PDF
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {showQuickQuote && (
        <QuickQuoteWizardModal
          isOpen={showQuickQuote}
          onClose={() => {
            setShowQuickQuote(false);
            invalidateProspect();
          }}
          products={quickQuoteProducts}
          initialProspect={initialProspect}
          onSent={invalidateProspect}
        />
      )}

      {showSendProposal && (
        <SendProposalModal
          isOpen={showSendProposal}
          onClose={() => {
            setShowSendProposal(false);
            invalidateProspect();
          }}
          initialProspect={initialProspect}
          onSent={invalidateProspect}
        />
      )}
    </div>
  );
}
