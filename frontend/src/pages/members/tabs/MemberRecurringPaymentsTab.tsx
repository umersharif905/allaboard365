// File: frontend/src/pages/members/tabs/MemberRecurringPaymentsTab.tsx
// Recurring payment schedules for the member: group schedules if in a group, or individual (household) schedules. Shown inside Payments tab for TenantAdmin & SysAdmin.
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, Repeat, Settings, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { apiService } from '../../../services/api.service';
import GroupsService, { type ScheduledPayment } from '../../../services/groups.service';
import { Member } from '../../../types/member.types';

interface Props {
  member: Member;
  onRefresh?: () => void;
}

// Calendar dates: parse as local date (YYYY-MM-DD) so UTC does not shift the displayed day (per backend-system date display guidance)
const formatDate = (dateString: string | null | undefined, format?: string) => {
  if (!dateString) return '—';
  try {
    const dateOnly = String(dateString).split('T')[0];
    const parts = dateOnly.split('-');
    if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]) - 1;
      const d = Number(parts[2]);
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
        const localDate = new Date(y, m, d);
        if (format === 'MMM yyyy') return localDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        return localDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
      }
    }
    const d = new Date(dateString);
    if (Number.isNaN(d.getTime())) return dateString;
    if (format === 'MMM yyyy') return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return String(dateString);
  }
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

export default function MemberRecurringPaymentsTab({ member, onRefresh }: Props) {
  const { user } = useAuth();
  const [scheduleToCancel, setScheduleToCancel] = useState<ScheduledPayment | null>(null);
  const [cancelScheduleConfirmOpen, setCancelScheduleConfirmOpen] = useState(false);
  const [cancelingSchedule, setCancelingSchedule] = useState(false);
  // When DIME refuses/fails the cancel but our record still has the schedule, we prompt the user to force a DB-only cancel.
  const [forceCancelInfo, setForceCancelInfo] = useState<{ schedule: ScheduledPayment; dimeError: string } | null>(null);
  const [scheduleForStatusModal, setScheduleForStatusModal] = useState<ScheduledPayment | null>(null);
  const [updatingScheduleStatus, setUpdatingScheduleStatus] = useState(false);
  const [showSetupRecurringModal, setShowSetupRecurringModal] = useState(false);
  const [setupRecurringAmount, setSetupRecurringAmount] = useState('');
  const [setupRecurringStartDate, setSetupRecurringStartDate] = useState('');
  const [setupRecurringCancelExisting, setSetupRecurringCancelExisting] = useState(true);
  const [settingUpRecurring, setSettingUpRecurring] = useState(false);

  const { data: recurringData, isLoading, refetch: refetchRecurring } = useQuery({
    queryKey: ['memberRecurringSchedules', member.MemberId],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data: { scheduledPayments: ScheduledPayment[]; context: 'group' | 'individual'; groupId?: string } }>(
        `/api/payments/recurring-schedules?memberId=${member.MemberId}`
      );
      if (!res.success) throw new Error((res as any).message || 'Failed to fetch recurring schedules');
      return res.data;
    },
    enabled: !!member.MemberId,
  });

  const scheduledPayments: ScheduledPayment[] = recurringData?.scheduledPayments ?? [];
  const context: 'group' | 'individual' = recurringData?.context ?? 'individual';
  const groupIdFromApi = recurringData?.groupId ?? member.GroupId ?? '';
  const isGroupContext = context === 'group' && !!groupIdFromApi;

  const isIndividual = !isGroupContext;
  const canCancelRecurringInProcessor =
    user?.currentRole === 'SysAdmin' || user?.currentRole === 'TenantAdmin';
  const { data: canSetupData } = useQuery({
    queryKey: ['canSetupRecurring', member.MemberId],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data: { canSetup: boolean } }>(`/api/payments/can-setup-recurring?memberId=${member.MemberId}`);
      return (res as any)?.data?.canSetup === true;
    },
    enabled: !!member.MemberId && isIndividual,
    staleTime: 2 * 60 * 1000,
  });
  const canSetupRecurring = canSetupData === true;

  const { data: suggestedStartData } = useQuery({
    queryKey: ['suggestedRecurringStart', member.MemberId],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data: { suggestedStartDate: string } }>(`/api/payments/suggested-recurring-start?memberId=${member.MemberId}`);
      return (res as any)?.data?.suggestedStartDate ?? null;
    },
    enabled: !!member.MemberId && isIndividual && showSetupRecurringModal,
    staleTime: 60 * 1000,
  });
  const suggestedStartDate = suggestedStartData ?? '';
  useEffect(() => {
    if (!showSetupRecurringModal) return;
    setSetupRecurringStartDate((prev) => suggestedStartDate || prev || new Date().toISOString().slice(0, 10));
  }, [showSetupRecurringModal, suggestedStartDate]);

  useEffect(() => {
    if (!showSetupRecurringModal) return;
    const premium = member.MonthlyPremium;
    if (typeof premium === 'number' && premium > 0) {
      setSetupRecurringAmount(String(Math.round(premium * 100) / 100));
    }
  }, [showSetupRecurringModal, member.MonthlyPremium]);

  const handleSetupRecurring = useCallback(async () => {
    const amount = parseFloat(setupRecurringAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error('Enter a valid monthly amount.');
      return;
    }
    if (!setupRecurringStartDate || !/^\d{4}-\d{2}-\d{2}$/.test(setupRecurringStartDate)) {
      toast.error('Enter a valid start date.');
      return;
    }
    setSettingUpRecurring(true);
    try {
      const res = await apiService.post<{ success?: boolean; message?: string; data?: { warning?: string; cancelFailures?: { scheduleId: string; error: string }[]; insertDbError?: string } }>(
        '/api/payments/setup-recurring',
        { memberId: member.MemberId, monthlyAmount: amount, startDate: setupRecurringStartDate, cancelExisting: setupRecurringCancelExisting },
        { timeout: 20000 }
      );
      const body = res as { success?: boolean; message?: string; data?: { warning?: string; cancelFailures?: { scheduleId: string; error: string }[]; insertDbError?: string } };
      if (body?.success) {
        toast.success(body?.message || 'Recurring payment set up.');
        if (body?.data?.warning) {
          toast.error(body.data.warning);
        }
        setSetupRecurringAmount('');
        setShowSetupRecurringModal(false);
        await refetchRecurring();
        onRefresh?.();
      } else {
        toast.error(body?.message || 'Set up recurring failed.');
      }
    } catch (e) {
      const err = e as { message?: string; response?: { data?: { message?: string } }; code?: string };
      const msg = err?.message ?? err?.response?.data?.message ?? 'Failed to set up recurring';
      const isTimeout = (typeof msg === 'string' && (msg.includes('timeout') || msg.includes('Timeout'))) || err?.code === 'ECONNABORTED';
      toast.error(isTimeout ? 'Request timed out. Check backend logs and DIME.' : msg);
    } finally {
      setSettingUpRecurring(false);
    }
  }, [member.MemberId, setupRecurringAmount, setupRecurringStartDate, setupRecurringCancelExisting, refetchRecurring, onRefresh]);

  const confirmCancel = useCallback(async () => {
    if (!scheduleToCancel) return;
    setCancelingSchedule(true);
    try {
      if (isGroupContext && groupIdFromApi) {
        const result = await GroupsService.cancelScheduledPayment(groupIdFromApi, scheduleToCancel.scheduleId);
        if (result.success) {
          setCancelScheduleConfirmOpen(false);
          setScheduleToCancel(null);
          await refetchRecurring();
          onRefresh?.();
          toast.success('Recurring payment canceled');
        } else {
          toast.error(result.message || 'Failed to cancel');
        }
      } else {
        const res = await apiService.post<{ success: boolean; message?: string }>('/api/payments/cancel-recurring-schedule', {
          memberId: member.MemberId,
          scheduleId: scheduleToCancel.scheduleId,
        });
        if ((res as any)?.success) {
          setCancelScheduleConfirmOpen(false);
          setScheduleToCancel(null);
          await refetchRecurring();
          onRefresh?.();
          toast.success('Recurring payment canceled');
        } else {
          toast.error((res as any)?.message || 'Failed to cancel');
        }
      }
    } catch (e) {
      // If DIME refused the cancel but our DB still has the schedule, offer a DB-only fallback.
      const err = e as { message?: string; responseData?: { canForce?: boolean; dimeError?: string; message?: string } };
      const responseData = err?.responseData;
      if (!isGroupContext && responseData?.canForce) {
        setCancelScheduleConfirmOpen(false);
        setForceCancelInfo({
          schedule: scheduleToCancel,
          dimeError: responseData.dimeError || responseData.message || err?.message || 'DIME did not confirm cancellation',
        });
      } else {
        toast.error(e instanceof Error ? e.message : 'Failed to cancel');
      }
    } finally {
      setCancelingSchedule(false);
    }
  }, [scheduleToCancel, isGroupContext, groupIdFromApi, member.MemberId, refetchRecurring, onRefresh]);

  const confirmForceCancel = useCallback(async () => {
    if (!forceCancelInfo) return;
    setCancelingSchedule(true);
    try {
      const res = await apiService.post<{ success: boolean; message?: string; forcedDbOnly?: boolean }>(
        '/api/payments/cancel-recurring-schedule',
        {
          memberId: member.MemberId,
          scheduleId: forceCancelInfo.schedule.scheduleId,
          force: true,
        }
      );
      if ((res as any)?.success) {
        setForceCancelInfo(null);
        setScheduleToCancel(null);
        await refetchRecurring();
        onRefresh?.();
        toast.success('Recurring schedule marked cancelled in our records.');
      } else {
        toast.error((res as any)?.message || 'Failed to cancel');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel');
    } finally {
      setCancelingSchedule(false);
    }
  }, [forceCancelInfo, member.MemberId, refetchRecurring, onRefresh]);

  const updateScheduleStatusInDb = useCallback(
    async (sp: ScheduledPayment, isActive: boolean) => {
      if (!isGroupContext || !groupIdFromApi) return;
      setScheduleForStatusModal(null);
      setUpdatingScheduleStatus(true);
      try {
        const result = await GroupsService.updateScheduledPaymentStatus(groupIdFromApi, sp.scheduleId, isActive);
        if (result.success) {
          await refetchRecurring();
          onRefresh?.();
        }
      } finally {
        setUpdatingScheduleStatus(false);
      }
    },
    [isGroupContext, groupIdFromApi, refetchRecurring, onRefresh]
  );

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse rounded-lg bg-gray-100 h-48" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Recurring payments</h2>
            <p className="mt-1 text-sm text-gray-500">
              {isGroupContext
                ? "Group recurring schedules (DIME) for this member's group. Cancel stops future charges; Settings (SysAdmin) updates our records only."
                : "This member's recurring payment schedule(s) in the payment processor (DIME)."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isIndividual && (
              <button
                type="button"
                onClick={() => canSetupRecurring && setShowSetupRecurringModal(true)}
                disabled={!canSetupRecurring}
                title={!canSetupRecurring ? 'Link both DIME customer ID and payment method ID in Payment methods (Link DIME customer) first.' : undefined}
                className="inline-flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-600"
              >
                <Repeat className="h-4 w-4" />
                Set up recurring payment
              </button>
            )}
            <button
              type="button"
              onClick={() => refetchRecurring()}
              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>
        {scheduledPayments.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-gray-500">
              {isGroupContext ? 'No recurring payment schedules for this group.' : 'No recurring payment schedules for this member.'}
            </p>
            {isIndividual && !canSetupRecurring && (
              <p className="mt-2 text-sm text-gray-500">
                Link a DIME customer <strong>and</strong> payment method ID in the <strong>Payment methods</strong> section above (use &quot;Link DIME customer&quot;) to enable &quot;Set up recurring payment&quot;. Both fields are required.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Processor</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Schedule ID</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Next billing date</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {scheduledPayments.map((sp) => (
                  <tr key={sp.scheduleId} className={sp.isActive === false ? 'bg-gray-50' : ''}>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{sp.locationName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {sp.isActive === false ? (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-800">Cancelled</span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">{sp.processor ?? 'DIME'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500 font-mono" title={sp.scheduleId}>{sp.scheduleId.length > 16 ? `${sp.scheduleId.slice(0, 8)}…` : sp.scheduleId}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">{sp.isActive !== false ? formatDate(sp.nextBillingDate) : (sp.cancelledDate ? `Cancelled ${formatDate(sp.cancelledDate)}` : '—')}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900 text-right">{formatCurrency(sp.monthlyAmount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-2">
                        {sp.isActive !== false && canCancelRecurringInProcessor && (
                          <button
                            type="button"
                            onClick={() => { setScheduleToCancel(sp); setCancelScheduleConfirmOpen(true); }}
                            className="inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                          >
                            <Trash2 className="h-4 w-4 mr-1.5" />
                            Cancel
                          </button>
                        )}
                        {isGroupContext && user?.currentRole === 'SysAdmin' && (
                          <button
                            type="button"
                            onClick={() => setScheduleForStatusModal(sp)}
                            disabled={updatingScheduleStatus}
                            className="inline-flex items-center p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-500"
                            title="Status options (DB only)"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Cancel scheduled payment confirmation */}
      {cancelScheduleConfirmOpen && scheduleToCancel && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !cancelingSchedule && (setCancelScheduleConfirmOpen(false), setScheduleToCancel(null))} />
            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                    <AlertCircle className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">Cancel scheduled payment</h3>
                    <p className="mt-2 text-sm text-gray-500">
                      This will cancel the recurring payment in DIME and stop future charges for this schedule.
                    </p>
                    <div className="mt-3 p-3 bg-gray-50 rounded-md">
                      <p className="text-sm font-medium text-gray-900">{scheduleToCancel.locationName}</p>
                      <p className="text-xs text-gray-500 mt-1">Next billing: {formatDate(scheduleToCancel.nextBillingDate)} · {formatCurrency(scheduleToCancel.monthlyAmount)}/month</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button type="button" onClick={confirmCancel} disabled={cancelingSchedule} className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 sm:ml-3 sm:w-auto sm:text-sm">
                  {cancelingSchedule ? 'Canceling...' : 'Cancel scheduled payment'}
                </button>
                <button type="button" onClick={() => !cancelingSchedule && (setCancelScheduleConfirmOpen(false), setScheduleToCancel(null))} disabled={cancelingSchedule} className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm">
                  Keep
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DIME cancel failed — offer DB-only cancel */}
      {forceCancelInfo && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !cancelingSchedule && setForceCancelInfo(null)} />
            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100 sm:mx-0 sm:h-10 sm:w-10">
                    <AlertCircle className="h-6 w-6 text-yellow-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left flex-1">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">DIME did not confirm the cancel</h3>
                    <p className="mt-2 text-sm text-gray-600">
                      We could not confirm cancellation in DIME for this recurring schedule. This often means the schedule no longer exists in DIME (e.g. it was already cancelled or the token was replaced).
                    </p>
                    <div className="mt-3 rounded-md border border-yellow-200 bg-yellow-50 p-3">
                      <p className="text-xs font-medium text-yellow-900 uppercase tracking-wide">DIME error</p>
                      <p className="text-sm text-yellow-900 mt-1 break-words">{forceCancelInfo.dimeError}</p>
                    </div>
                    <div className="mt-4 p-3 bg-gray-50 rounded-md">
                      <p className="text-sm font-medium text-gray-900">{forceCancelInfo.schedule.locationName}</p>
                      <p className="text-xs text-gray-500 mt-1 font-mono">{forceCancelInfo.schedule.scheduleId}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatCurrency(forceCancelInfo.schedule.monthlyAmount)}/month · Next billing {formatDate(forceCancelInfo.schedule.nextBillingDate)}</p>
                    </div>
                    <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
                      <p className="text-sm text-red-800">
                        <strong>Warning:</strong> Cancelling in our records only will stop us from showing or scheduling this recurring payment, but it will <strong>not</strong> stop any active schedule in DIME. Only do this if you are confident the schedule does not exist (or is already cancelled) in DIME. If unsure, verify in DIME first.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={confirmForceCancel}
                  disabled={cancelingSchedule}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  {cancelingSchedule ? 'Cancelling...' : 'Cancel in our records only'}
                </button>
                <button
                  type="button"
                  onClick={() => !cancelingSchedule && setForceCancelInfo(null)}
                  disabled={cancelingSchedule}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  Keep
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Schedule status (DB only) modal - SysAdmin */}
      {scheduleForStatusModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)} />
            <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-md sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-gray-100 sm:mx-0 sm:h-10 sm:w-10">
                    <Settings className="h-6 w-6 text-gray-600" />
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left flex-1">
                    <h3 className="text-lg leading-6 font-medium text-gray-900">Update schedule status (our records only)</h3>
                    <p className="mt-1 text-sm text-gray-500">This only updates our database. It does not change anything in DIME.</p>
                    <div className="mt-4 p-3 bg-gray-50 rounded-md">
                      <p className="text-sm font-medium text-gray-900">{scheduleForStatusModal.locationName}</p>
                      <p className="text-xs text-gray-500 mt-1 font-mono">{scheduleForStatusModal.scheduleId}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{formatCurrency(scheduleForStatusModal.monthlyAmount)}/month · {scheduleForStatusModal.isActive === false ? 'Cancelled' : 'Active'}</p>
                    </div>
                    <div className="mt-4 space-y-2">
                      <button type="button" onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, true)} disabled={updatingScheduleStatus} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> Mark as active (DB only)
                      </button>
                      <button type="button" onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, false)} disabled={updatingScheduleStatus} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                        <span className="inline-block w-2 h-2 rounded-full bg-gray-400" /> Mark as cancelled (DB only)
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button type="button" onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)} disabled={updatingScheduleStatus} className="w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 sm:ml-3 sm:w-auto sm:text-sm">
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Set up recurring payment modal */}
      {showSetupRecurringModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => !settingUpRecurring && setShowSetupRecurringModal(false)} />
          <div className="flex min-h-full items-center justify-center p-4">
            <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Set up recurring payment</h3>
              <p className="text-sm text-gray-600 mb-4">
                Enter the monthly amount and start date. The start date defaults to the next billing date based on current enrollments.
              </p>
              <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900 mb-4">
                Recurring payment will start on <strong>{setupRecurringStartDate || '—'}</strong>. You can change the date below.
              </div>
              <div className="space-y-3 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                  <input
                    type="date"
                    value={setupRecurringStartDate}
                    onChange={(e) => setSetupRecurringStartDate(e.target.value)}
                    min={new Date().toISOString().slice(0, 10)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monthly amount ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={setupRecurringAmount}
                    onChange={(e) => setSetupRecurringAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={setupRecurringCancelExisting}
                    onChange={(e) => setSetupRecurringCancelExisting(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  <span className="text-sm text-gray-700">
                    Cancel all pre-existing recurring payments (in DIME and our records) before creating this one.
                  </span>
                </label>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !settingUpRecurring && setShowSetupRecurringModal(false)}
                  disabled={settingUpRecurring}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSetupRecurring()}
                  disabled={settingUpRecurring || !setupRecurringAmount || parseFloat(setupRecurringAmount) <= 0 || !setupRecurringStartDate}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:pointer-events-none text-sm font-medium flex items-center gap-2"
                >
                  <Repeat className="h-4 w-4" />
                  {settingUpRecurring ? 'Setting up…' : 'Set up recurring payment'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
