import React, { useCallback, useState } from 'react';
import { User } from 'lucide-react';
import { apiService } from '../services/api.service';
import { Member } from '../types/member.types';
import MemberManagementModal, { type MemberManagementModalTab } from '../pages/members/MemberManagementModal';

interface EnrollmentRow {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800';
    case 'Pending':
      return 'bg-yellow-100 text-yellow-800';
    case 'Terminated':
      return 'bg-red-100 text-red-800';
    case 'Suspended':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const getRelationshipIcon = (relationshipType?: string) => {
  const color =
    relationshipType === 'P'
      ? 'text-blue-600'
      : relationshipType === 'S'
        ? 'text-pink-500'
        : relationshipType === 'C'
          ? 'text-green-600'
          : 'text-gray-500';
  return <User className={`h-4 w-4 ${color}`} />;
};

const getRelationshipColor = (relationshipType?: string) => {
  switch (relationshipType) {
    case 'P':
      return 'bg-blue-100 text-blue-800';
    case 'S':
      return 'bg-pink-100 text-pink-800';
    case 'C':
      return 'bg-green-100 text-green-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

const formatCurrencyForModal = (amount: number | null | undefined | string): string => {
  if (amount === null || amount === undefined) return '$0.00';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return isNaN(n)
    ? '$0.00'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
};

/**
 * Drop-in launcher for MemberManagementModal. Encapsulates the
 * load-with-household + load-enrollments flow + the ancillary helpers the
 * modal expects, so any caller just needs:
 *
 *   const { openMember, MemberModalElement } = useMemberModalLauncher();
 *   <>
 *     <SomeUi onClickMember={openMember} />
 *     {MemberModalElement}
 *   </>
 */
export function useMemberModalLauncher() {
  const [member, setMember] = useState<Member | null>(null);
  const [household, setHousehold] = useState<Member[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalInitialTab, setModalInitialTab] = useState<MemberManagementModalTab | undefined>(undefined);

  const openMember = useCallback(async (memberId: string, initialTab?: MemberManagementModalTab) => {
    if (!memberId) return;
    setLoading(true);
    setModalInitialTab(initialTab);
    setMember(null);
    setHousehold([]);
    setEnrollments([]);
    try {
      const [householdRes, enrollmentsRes] = await Promise.all([
        apiService.get<{
          success: boolean;
          data: { member: Member; householdMembers: Member[] };
        }>(`/api/members/${memberId}/with-household`),
        apiService.get<{ success: boolean; data: any[] }>(
          `/api/enrollments?memberId=${memberId}`
        ),
      ]);
      if (householdRes.success && householdRes.data) {
        setMember(householdRes.data.member);
        setHousehold(householdRes.data.householdMembers || []);
      }
      if (enrollmentsRes.success && enrollmentsRes.data) {
        setEnrollments(
          (enrollmentsRes.data as any[]).map((e: any) => ({
            EnrollmentId: e.EnrollmentId,
            ProductName: e.ProductName ?? '',
            ProductType: e.ProductType ?? '',
            Status: e.Status ?? '',
            EffectiveDate: e.EffectiveDate ?? '',
            TerminationDate: e.TerminationDate,
            Premium: e.Premium ?? e.PremiumAmount ?? 0,
            PaymentFrequency: e.PaymentFrequency ?? 'Monthly',
          }))
        );
      }
    } catch (err) {
      console.error('useMemberModalLauncher: failed to load member', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setMember(null);
    setHousehold([]);
    setEnrollments([]);
    setModalInitialTab(undefined);
  }, []);

  const MemberModalElement = member ? (
    <div className="relative z-[90]">
      <MemberManagementModal
        key={`${member.MemberId}-${modalInitialTab ?? 'default'}`}
        member={member}
        householdMembers={household}
        memberEnrollments={enrollments}
        enrollmentsLoading={loading}
        initialTab={modalInitialTab}
        onClose={close}
        onEdit={() => {}}
        formatCurrency={formatCurrencyForModal}
        getStatusColor={getStatusColor}
        getRelationshipIcon={getRelationshipIcon}
        getRelationshipColor={getRelationshipColor}
        canEdit={false}
        canDelete={false}
      />
    </div>
  ) : null;

  return { openMember, MemberModalElement, close, isOpen: !!member };
}
