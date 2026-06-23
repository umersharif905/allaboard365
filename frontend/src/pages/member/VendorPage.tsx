import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMemberVendorNavigation } from '../../hooks/member/useMemberVendorNavigation';
import { VendorNavigationPage } from '../../services/member/member-vendor-navigation.service';

const vendorComponentRegistry: Record<string, React.FC> = {
  // Example: 'sharewellCareTeam': SharewellCareTeamComponent
};

const VendorPage: React.FC = () => {
  const { vendorId, pageKey } = useParams<{ vendorId: string; pageKey: string }>();
  const { data: vendorGroups, isLoading, isError, error, refetch } = useMemberVendorNavigation();
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const page = useMemo(() => {
    if (!Array.isArray(vendorGroups) || !vendorId || !pageKey) {
      return undefined;
    }

    for (const group of vendorGroups) {
      if (group.vendorId !== vendorId) continue;
      const match = group.pages.find((p) => p.routeKey === pageKey);
      if (match) {
        return { group, page: match };
      }
    }

    return undefined;
  }, [vendorGroups, vendorId, pageKey]);

  useEffect(() => {
    const loadContent = async (page?: VendorNavigationPage) => {
      if (!page) {
        setContent(null);
        setContentError(null);
        return;
      }

      if (page.contentType === 'markdown' || page.contentType === 'static_html') {
        if (!page.contentRef) {
          setContent(null);
          setContentError('No content reference provided for this page.');
          return;
        }

        try {
          setContentLoading(true);
          setContentError(null);

          const response = await fetch(page.contentRef, {
            credentials: 'include'
          });

          if (!response.ok) {
            throw new Error(`Failed to load content (${response.status})`);
          }

          const text = await response.text();
          setContent(text);
        } catch (fetchError: any) {
          console.error('Failed to load vendor page content:', fetchError);
          setContentError(fetchError?.message || 'Failed to load page content.');
          setContent(null);
        } finally {
          setContentLoading(false);
        }
      } else {
        setContent(null);
        setContentError(null);
      }
    };

    loadContent(page?.page);
  }, [page]);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-center py-12 text-gray-500">
          Loading vendor resources...
        </div>
      </div>
    );
  }

  if (isError || error) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-red-200 p-6">
        <h2 className="text-lg font-semibold text-red-700 mb-2">Unable to load vendor pages</h2>
        <p className="text-red-600 text-sm mb-4">
          {(error as Error)?.message || 'An unexpected error occurred while loading vendor navigation data.'}
        </p>
        <button
          onClick={() => refetch()}
          className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Page not available</h2>
        <p className="text-gray-600">
          We couldn&apos;t find the vendor page you were looking for. It may have been unpublished or is no longer
          available.
        </p>
      </div>
    );
  }

  const { group, page: pageData } = page;
  const ComponentOverride = pageData.contentType === 'component'
    ? vendorComponentRegistry[pageData.contentRef]
    : undefined;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <p className="text-sm text-oe-primary font-semibold uppercase tracking-wide">{group.vendorName}</p>
            <h1 className="text-2xl font-semibold text-gray-900 mt-1">{pageData.label}</h1>
            {pageData.description && (
              <p className="text-gray-600 mt-2 max-w-3xl">{pageData.description}</p>
            )}
          </div>
          <div className="text-sm text-gray-500">
            {pageData.tenantScoped ? 'Tenant-specific resource' : 'Vendor resource'}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        {pageData.contentType === 'iframe' && pageData.contentRef ? (
          <iframe
            title={pageData.label}
            src={pageData.contentRef}
            className="w-full min-h-[600px] border border-gray-200 rounded-lg"
          />
        ) : ComponentOverride ? (
          <ComponentOverride />
        ) : pageData.contentType === 'markdown' || pageData.contentType === 'static_html' ? (
          contentLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-500">
              Loading page content...
            </div>
          ) : contentError ? (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-4">
              {contentError}
            </div>
          ) : content ? (
            <div
              className="prose max-w-none"
              dangerouslySetInnerHTML={{ __html: content }}
            />
          ) : (
            <div className="text-gray-500">
              No content available for this page yet.
            </div>
          )
        ) : (
          <div className="text-gray-500">
            This resource is not yet available in the portal. Please check back later or contact support for help.
          </div>
        )}
      </div>
    </div>
  );
};

export default VendorPage;










