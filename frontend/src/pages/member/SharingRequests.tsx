// pages/member/SharingRequests.tsx
// Member portal — Medical Needs Request (links from enrolled products)

import { ExternalLink, Loader2, Stethoscope } from 'lucide-react';

import { useMemberMedicalNeedsRequests } from '../../hooks/member/useMemberMedicalNeedsRequests';
import { useMemberSharingRequests } from '../../hooks/member/useMemberSharingRequests';
import ShareRequestCard from '../../components/member/ShareRequestCard';
import {
  isMedicalNeedsHexColor,
  medicalNeedsButtonPresetClasses
} from '../../utils/medicalNeedsLinkColors';

const ShareRequestNew = () => {
  const { data: sections = [], isLoading, error, isError } = useMemberMedicalNeedsRequests();
  const { data: sharingRequests = [] } = useMemberSharingRequests();

  const visibleSharingRequests = sharingRequests.filter((sr) =>
    Boolean(sr.ShowShareRequestStatusToMembers)
  );

  const sharingRequestsSection = visibleSharingRequests.length > 0 && (
    <section className="mt-10">
      <h2 className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-3">Your sharing requests</h2>
      <div className="space-y-4">
        {visibleSharingRequests.map((sr) => (
          <ShareRequestCard key={sr.ShareRequestId} sr={sr} />
        ))}
      </div>
    </section>
  );

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[40vh] gap-2 text-gray-600">
        <Loader2 className="h-6 w-6 animate-spin shrink-0" />
        <span>Loading medical needs requests…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error instanceof Error ? error.message : 'Could not load medical needs requests.'}
        </div>
        {sharingRequestsSection}
      </div>
    );
  }

  if (!sections.length) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-3">
            <Stethoscope className="h-12 w-12 text-oe-primary" aria-hidden />
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Medical Needs Request</h1>
          <p className="text-gray-600 text-sm">
            No medical needs request links are configured for your current plans. If you expected to see options here,
            contact support.
          </p>
        </div>
        {sharingRequestsSection}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-3">
          <Stethoscope className="h-12 w-12 text-oe-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold text-oe-primary mb-2">Medical Needs Request</h1>
        <p className="text-sm text-gray-600 max-w-md mx-auto">
          Submit medical needs requests with the forms below.
        </p>
      </div>

      <div className="space-y-10">
        {sections.map((sec) => (
          <section key={sec.productId}>
            <h2 className="text-xs font-bold uppercase tracking-wide text-gray-600 mb-3">{sec.categoryTitle}</h2>
            <div className="space-y-3">
              {sec.links.map((link, idx) => {
                const hex = isMedicalNeedsHexColor(link.buttonColor);
                const cls = hex ? 'text-white shadow-sm' : `${medicalNeedsButtonPresetClasses(link.buttonColor)} shadow-sm`;
                return (
                  <a
                    key={`${link.href}-${idx}`}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-4 py-4 text-left font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2 ${cls}`}
                    style={hex ? { backgroundColor: link.buttonColor } : undefined}
                  >
                    <span>{link.label}</span>
                    <ExternalLink className="h-5 w-5 shrink-0 opacity-95" aria-hidden />
                  </a>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {sharingRequestsSection}
    </div>
  );
};

export default ShareRequestNew;
