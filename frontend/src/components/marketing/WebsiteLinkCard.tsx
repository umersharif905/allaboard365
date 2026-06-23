import { useState } from 'react';
import { Copy, Check, ExternalLink, Link as LinkIcon } from 'lucide-react';

interface MarketingLink {
  label: string;
  url: string;
}

interface WebsiteLinkCardProps {
  links?: MarketingLink[];
  idParam?: string | null;
  agentCode?: string | null;
}

const buildFullUrl = (rawUrl: string, idParam: string, agentCode: string): string => {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(idParam, agentCode);
    return u.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}${idParam}=${encodeURIComponent(agentCode)}`;
  }
};

const LinkRow: React.FC<{ label: string; url: string }> = ({ label, url }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <div className="border border-gray-200 rounded-md p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-900">{label || 'Untitled link'}</span>
      </div>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          readOnly
          value={url}
          onClick={(e) => (e.target as HTMLInputElement).select()}
          className="flex-1 bg-gray-50 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-[var(--oe-primary)]"
        />
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
            copied
              ? 'bg-green-50 text-oe-success border-green-200'
              : 'bg-oe-primary hover:bg-oe-dark text-white border-transparent'
          }`}
          aria-live="polite"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              Copy
            </>
          )}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
          title="Open in new tab"
        >
          <ExternalLink className="h-4 w-4" />
          Open
        </a>
      </div>
    </div>
  );
};

const WebsiteLinkCard: React.FC<WebsiteLinkCardProps> = ({
  links,
  idParam,
  agentCode
}) => {
  const safeIdParam = idParam || 'id';
  const safeLinks = Array.isArray(links) ? links : [];
  const hasAgentCode = !!agentCode;
  const hasLinks = safeLinks.length > 0;

  return (
    <div className="bg-white rounded-lg border border-[var(--color-border)] p-6 mt-6">
      <div className="flex items-center gap-2 mb-1">
        <LinkIcon className="h-5 w-5 text-[var(--oe-primary)]" />
        <h2 className="text-lg font-semibold text-gray-900">Your Website Links</h2>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        Share these URLs on social media, email, or anywhere else. Quote requests from
        these links will be attributed to you (
        <span className="font-mono">?{safeIdParam}={agentCode || '—'}</span>).
      </p>

      {!hasAgentCode && (
        <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-md p-3">
          We couldn&apos;t find your Agent Code. Please contact your administrator.
        </div>
      )}

      {hasAgentCode && !hasLinks && (
        <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-md p-3">
          No marketing links are configured yet. Ask a tenant admin to add one or more
          links in <span className="font-medium">Tenant Settings</span> (Marketing Links).
        </div>
      )}

      {hasAgentCode && hasLinks && (
        <div className="space-y-3">
          {safeLinks.map((link, idx) => (
            <LinkRow
              key={`${link.label}-${idx}`}
              label={link.label}
              url={buildFullUrl(link.url, safeIdParam, agentCode!)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default WebsiteLinkCard;
