// frontend/src/components/groups/HiddenProductsSection.tsx
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { HiddenProductWithEnrollments } from '../../services/group-products.service';

interface HiddenProductsSectionProps {
  products: HiddenProductWithEnrollments[];
  /**
   * Restore (un-delete) a removed product. Agent clicks the per-row button.
   * Section is read-only when omitted.
   */
  onRestore?: (productId: string, productName: string) => void;
  /** ProductId currently being restored (for spinner / disabled state). */
  restoringProductId?: string | null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

const HiddenProductsSection: React.FC<HiddenProductsSectionProps> = ({
  products,
  onRestore,
  restoringProductId = null,
}) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (products.length === 0) return null;

  const toggle = (productId: string) =>
    setExpanded((prev) => ({ ...prev, [productId]: !prev[productId] }));

  return (
    <section className="mt-8">
      <h3 className="text-lg font-semibold text-gray-900">Removed Products with Active Members</h3>
      <p className="text-sm text-gray-600 mb-4">
        These products were removed from this group but still have members enrolled in them.
        Their existing coverage continues; the products just won't appear in new enrollment links.
        Removed products with no enrolled members aren't listed here — to bring one back, use
        <span className="font-medium"> Add Product</span> at the top of the page.
      </p>

      <ul className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
        {products.map((p) => {
          const isOpen = !!expanded[p.productId];
          const memberWord = p.enrollmentCount === 1 ? 'member' : 'members';
          const hasMembers = p.enrollmentCount > 0;
          const restoring = restoringProductId === p.productId;
          return (
            <li key={p.productId}>
              <div className="w-full flex items-center justify-between px-4 py-3">
                <button
                  type="button"
                  onClick={() => hasMembers && toggle(p.productId)}
                  className={`flex-1 flex items-center gap-2 text-left ${hasMembers ? 'cursor-pointer hover:underline' : 'cursor-default'}`}
                  aria-expanded={isOpen}
                  disabled={!hasMembers}
                >
                  {hasMembers ? (
                    isOpen
                      ? <ChevronDown className="h-4 w-4 text-gray-500" aria-hidden />
                      : <ChevronRight className="h-4 w-4 text-gray-500" aria-hidden />
                  ) : (
                    <span className="h-4 w-4" aria-hidden />
                  )}
                  <span className="font-medium text-gray-900">{p.productName}</span>
                </button>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-gray-600">
                    {hasMembers
                      ? `${p.enrollmentCount} ${memberWord} enrolled`
                      : 'No active enrollments'}
                  </span>
                  {onRestore && (
                    <button
                      type="button"
                      onClick={() => onRestore(p.productId, p.productName)}
                      disabled={restoring}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-md hover:bg-oe-light disabled:opacity-50 disabled:cursor-not-allowed"
                      title={`Add ${p.productName} back to this group`}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      {restoring ? 'Adding…' : 'Add Back'}
                    </button>
                  )}
                </div>
              </div>

              {isOpen && hasMembers && (
                <ul className="px-10 pb-3 text-sm text-gray-700 list-disc">
                  {p.members.map((m) => (
                    <li key={m.memberId} className="py-1">
                      {m.fullName}
                      <span className="text-gray-500"> (enrolled {formatDate(m.enrolledDate)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default HiddenProductsSection;
