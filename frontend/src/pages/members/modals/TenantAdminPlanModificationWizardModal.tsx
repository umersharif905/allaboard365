import { X } from 'lucide-react';
import React from 'react';
import { GroupedEnrollment, MemberEnrollment } from '../../../services/member/member-enrollments.service';
import { Member } from '../../../types/member.types';
import TenantAdminPlanModificationWizard from '../wizards/TenantAdminPlanModificationWizard';

interface Props {
  member: Member;
  enrollments: MemberEnrollment[];
  groupedEnrollments: GroupedEnrollment[];
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

export default function TenantAdminPlanModificationWizardModal({
  member,
  enrollments,
  groupedEnrollments,
  onClose,
  onApplied
}: Props) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-6xl max-h-[95vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-gray-900 mb-1">
              Modify plans for {member.FirstName} {member.LastName}
            </h2>
            <p className="text-gray-600 truncate">{member.Email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <TenantAdminPlanModificationWizard
            member={member}
            enrollments={enrollments}
            groupedEnrollments={groupedEnrollments}
            onCancel={onClose}
            onApplied={onApplied}
          />
        </div>
      </div>
    </div>
  );
}

