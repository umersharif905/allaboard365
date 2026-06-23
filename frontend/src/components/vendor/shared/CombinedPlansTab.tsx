import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, CreditCard, Mail, MessageSquare, Package, User } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { useMemberPlanTenure } from '../../../hooks/members/useMemberPlanTenure';
import { Member } from '../../../types/member.types';
import {
  MemberEnrollment,
  MemberEnrollmentService,
  fetchMemberEnrollmentsAllStatuses,
  formatPlanStatusLabel,
  isVendorVisiblePlanEnrollment,
  normalizeEnrollmentStatus,
} from '../../../services/member/member-enrollments.service';
import SysAdminMemberIDCardsTab from '../../../pages/members/tabs/MemberIDCardsTab';
import SendIDCardModal from './SendIDCardModal';
import SendIDCardSmsModal from './SendIDCardSmsModal';
import ProductDocumentsLinks from '../../shared/ProductDocumentsLinks';
import { hasProductDocuments } from '../../../utils/productDocuments';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';

interface CombinedPlansTabProps {
  memberId: string;
}

interface SendTarget {
  enrollmentId: string;
  productName: string;
  defaultRecipient: string;
  memberId: string;
}

interface SmsTarget {
  enrollmentId: string;
  productName: string;
  defaultPhone: string;
  memberId: string;
}

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

const formatDate = (raw?: string) => {
  if (!raw) return '-';
  try {
    const [datePart] = raw.split('T');
    if (datePart) {
      const [y, m, d] = datePart.split('-');
      if (y && m && d) {
        return new Date(parseInt(y), parseInt(m) - 1, parseInt(d)).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }
    }
    return new Date(raw).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return raw;
  }
};

// Pair an enrollment's configValue1..5 with the product's RequiredDataFields
// names, so the tile can show "Unshared Amount $: 1500" instead of raw values.
const buildConfigFields = (enrollment: MemberEnrollment) => {
  const rdf = enrollment.product?.requiredDataFields;
  const fields: { name: string; value: string }[] = [];
  const values = [
    enrollment.configValue1,
    enrollment.configValue2,
    enrollment.configValue3,
    enrollment.configValue4,
    enrollment.configValue5,
  ];
  if (Array.isArray(rdf)) {
    rdf.forEach((f: any, idx: number) => {
      const v = values[idx];
      if (v != null && String(v).trim() !== '') {
        fields.push({ name: f?.fieldName || `Field ${idx + 1}`, value: String(v) });
      }
    });
  }
  return fields;
};

const PlanTile = ({ enrollment }: { enrollment: MemberEnrollment }) => {
  const product = enrollment.product;
  if (!product) return null;
  const configFields = buildConfigFields(enrollment);
  const docProduct = {
    productDocuments: product.productDocuments,
    productDocumentUrl: product.productDocumentUrl,
  };
  const statusLabel = formatPlanStatusLabel(enrollment.status, enrollment.isPendingMigration);
  const normalized = normalizeEnrollmentStatus(enrollment.status);
  const badgeClass =
    normalized === 'Active'
      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
      : enrollment.isPendingMigration
        ? 'bg-violet-50 text-violet-800 ring-1 ring-violet-200'
        : normalized === 'PaymentHold'
          ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200'
          : 'bg-yellow-50 text-yellow-800 ring-1 ring-yellow-200';

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white shadow-soft hover:shadow-medium transition-shadow">
      <div className="flex justify-between items-start mb-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 truncate" title={product.name}>
            {product.name}
          </h3>
          {product.productType && (
            <p className="text-sm text-gray-500">{product.productType}</p>
          )}
        </div>
        <span
          className={`shrink-0 inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${badgeClass}`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="text-sm">
        <span className="text-gray-500">Effective:</span>
        <span className="ml-1 text-gray-900">{formatDate(enrollment.effectiveDate)}</span>
      </div>

      {configFields.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="text-xs text-gray-500 mb-2">Plan Configuration</div>
          <div className="space-y-1">
            {configFields.map((f, idx) => (
              <div
                key={idx}
                className="flex justify-between items-center bg-oe-light/50 px-2 py-1 rounded text-sm"
              >
                <span className="text-gray-700">{f.name}:</span>
                <span className="font-semibold text-oe-primary">{f.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasProductDocuments(docProduct) && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="text-xs text-gray-500 mb-2">Plan Documents</div>
          <ProductDocumentsLinks product={docProduct} variant="button" size="sm" />
        </div>
      )}
    </div>
  );
};

const CombinedPlansTab = ({ memberId }: CombinedPlansTabProps) => {
  const [member, setMember] = useState<Member | null>(null);
  const [memberLoading, setMemberLoading] = useState(true);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<SendTarget | null>(null);
  const [smsTarget, setSmsTarget] = useState<SmsTarget | null>(null);

  const { data: planTenure } = useMemberPlanTenure(memberId);

  // Shared query key with SysAdminMemberIDCardsTab so React Query dedupes the
  // fetch — both sections render off the same enrollment data.
  const {
    data: enrollments,
    isLoading: plansLoading,
  } = useQuery({
    queryKey: ['memberEnrollments', memberId],
    queryFn: () => fetchMemberEnrollmentsAllStatuses(memberId),
    staleTime: 5 * 60 * 1000,
  });

  const visibleProductEnrollments = useMemo(() => {
    if (!enrollments) return [];
    return enrollments.filter((e) => {
      const t = e.enrollmentType;
      if (t && t !== 'Product') return false;
      if (e.productId === ALL_PRODUCTS_GUID) return false;
      return isVendorVisiblePlanEnrollment(e);
    });
  }, [enrollments]);

  const planTiles = useMemo<MemberEnrollment[]>(() => {
    if (!visibleProductEnrollments.length) return [];
    const grouped = MemberEnrollmentService.groupEnrollmentsByBundle(visibleProductEnrollments);
    const tiles: MemberEnrollment[] = [];
    grouped.forEach((g) => {
      if (g.type === 'bundle' && g.componentEnrollments?.length) {
        // One tile per component product so a bundle expands into its members.
        g.componentEnrollments.forEach((c) => tiles.push(c));
      } else if (g.primaryEnrollment) {
        tiles.push(g.primaryEnrollment);
      }
    });
    // Healthcare first, then alpha — matches ID-card section ordering.
    const rank = (e: MemberEnrollment) =>
      String(e.product?.productType || '').toLowerCase() === 'healthcare' ? 0 : 1;
    tiles.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return (a.product?.name || '').localeCompare(b.product?.name || '');
    });
    return tiles;
  }, [visibleProductEnrollments]);

  const pendingMigrationPlanCount = useMemo(
    () => visibleProductEnrollments.filter((e) => e.isPendingMigration || normalizeEnrollmentStatus(e.status) === 'Pending').length,
    [visibleProductEnrollments]
  );

  // Fetch member info (needed to render ID cards via SysAdminMemberIDCardsTab).
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setMemberLoading(true);
      setMemberError(null);
      try {
        const response = await apiService.get<{ success: boolean; data: any }>(
          `/api/me/vendor/members/${memberId}`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (response.success && response.data) {
          const d = response.data;
          setMember({
            MemberId: d.MemberId,
            UserId: d.UserId || '',
            FirstName: d.FirstName || '',
            LastName: d.LastName || '',
            Email: d.Email || '',
            PhoneNumber: d.Phone || d.PhoneNumber || '',
            DateOfBirth: d.DateOfBirth,
            Gender: d.Gender,
            HouseholdId: d.HouseholdId,
            HouseholdMemberID: d.HouseholdMemberID,
            RelationshipType: d.RelationshipType,
            Status: d.Status || 'Active',
          } as Member);
        } else {
          setMemberError('Member not found');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error loading member for ID cards:', err);
        setMemberError('Unable to load member');
      } finally {
        if (!controller.signal.aborted) setMemberLoading(false);
      }
    })();
    return () => controller.abort();
  }, [memberId]);

  const renderSendButton = useMemo(
    () => (enrollment: MemberEnrollment) => {
      if (!member) return null;
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setSendTarget({
                enrollmentId: enrollment.enrollmentId,
                productName: enrollment.product?.name || 'ID Card',
                defaultRecipient: member.Email || '',
                memberId: member.MemberId,
              })
            }
            className="inline-flex items-center px-2 py-1 border border-gray-300 rounded text-xs font-medium text-gray-700 bg-white hover:bg-gray-50"
            title="Email ID card to member"
          >
            <Mail className="h-3 w-3 mr-1" />
            Send Email
          </button>
          <button
            type="button"
            onClick={() =>
              setSmsTarget({
                enrollmentId: enrollment.enrollmentId,
                productName: enrollment.product?.name || 'ID Card',
                defaultPhone: member.PhoneNumber || '',
                memberId: member.MemberId,
              })
            }
            className="inline-flex items-center px-2 py-1 border border-gray-300 rounded text-xs font-medium text-gray-700 bg-white hover:bg-gray-50"
            title="Text ID card download link to member"
          >
            <MessageSquare className="h-3 w-3 mr-1" />
            Send Text
          </button>
        </>
      );
    },
    [member]
  );

  const plansSection = (() => {
    if (plansLoading) {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" rounded="lg" />
          ))}
        </div>
      );
    }
    if (planTiles.length === 0) {
      return (
        <EmptyState
          icon={Package}
          title="No plans"
          description="This member has no active or pending product enrollments for your products."
        />
      );
    }
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-up">
        {planTiles.map((e) => (
          <PlanTile key={e.enrollmentId} enrollment={e} />
        ))}
      </div>
    );
  })();

  const idCardsSection = (() => {
    if (memberLoading) {
      return (
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        </div>
      );
    }
    if (memberError || !member) {
      return <EmptyState icon={User} title={memberError ?? 'Member not found'} tone="error" />;
    }
    return <SysAdminMemberIDCardsTab member={member} extraCardActions={renderSendButton} hideHeading />;
  })();

  return (
    <>
      <div className="px-6 pt-6">
        <div className="flex items-center gap-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            <Package className="h-4 w-4" />
            <span>Plans</span>
          </div>
          <div className="h-px flex-1 bg-gray-200" />
        </div>
        {planTenure?.hasCoverage && planTenure.tenureStartDate && (
          <div className="pt-1 pb-2">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-oe-light text-oe-dark border border-oe-primary/20"
              title={planTenure.chain
                .map(c => `${c.productName || 'Plan'}: ${c.effectiveDate}${c.terminationDate ? ` → ${c.terminationDate}` : ' → present'}`)
                .join('\n')}
            >
              <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
              On plan for {planTenure.daysOnPlan} {planTenure.daysOnPlan === 1 ? 'day' : 'days'} · Since {formatDate(planTenure.tenureStartDate)}
            </span>
          </div>
        )}
        {pendingMigrationPlanCount > 0 && (
          <p className="text-xs text-violet-800 pb-2">
            {pendingMigrationPlanCount} plan(s) are pending migration — imported from E123, not yet live until payment is completed.
          </p>
        )}
      </div>

      <div className="px-6 pb-6 pt-3">{plansSection}</div>

      <div className="px-6">
        <div className="flex items-center gap-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            <CreditCard className="h-4 w-4" />
            <span>ID Cards</span>
          </div>
          <div className="h-px flex-1 bg-gray-200" />
        </div>
      </div>

      {idCardsSection}

      <SendIDCardModal
        isOpen={!!sendTarget}
        memberId={sendTarget?.memberId || ''}
        enrollmentId={sendTarget?.enrollmentId || ''}
        productName={sendTarget?.productName || ''}
        defaultRecipient={sendTarget?.defaultRecipient || ''}
        onClose={() => setSendTarget(null)}
      />

      <SendIDCardSmsModal
        isOpen={!!smsTarget}
        memberId={smsTarget?.memberId || ''}
        enrollmentId={smsTarget?.enrollmentId || ''}
        productName={smsTarget?.productName || ''}
        defaultPhone={smsTarget?.defaultPhone || ''}
        onClose={() => setSmsTarget(null)}
      />
    </>
  );
};

export default CombinedPlansTab;
