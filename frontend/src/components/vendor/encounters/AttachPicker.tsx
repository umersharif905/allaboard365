// AttachPicker.tsx — shared attach-to-case / attach-to-share-request picker
// components.  Extracted from VendorCallCenter.tsx so the encounter detail card
// can also use them.

import { useEffect, useState } from 'react';
import {
  attachEncounterToCase,
  attachEncounterToShareRequest,
  getMemberCases,
  getMemberShareRequests,
  searchAllCases,
  searchAllShareRequests,
} from '../../../services/vendorCallCenter.service';

// --------------------------------------------------------------------------
// AttachToCase
// --------------------------------------------------------------------------
export function AttachToCase({ encounterId, memberId, currentCaseId, onAttached }: {
  encounterId: string;
  memberId: string | null;
  currentCaseId: string | null;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [memberOptions, setMemberOptions] = useState<Array<{ CaseId: string; CaseNumber: string; Title: string; Status: string }>>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ CaseId: string; CaseNumber: string; Title: string | null; Status: string }>>([]);

  useEffect(() => {
    if (open && memberId) {
      getMemberCases(memberId).then(setMemberOptions).catch(() => setMemberOptions([]));
    }
    if (!open) {
      setSearchQ('');
      setSearchResults([]);
    }
  }, [open, memberId]);

  useEffect(() => {
    if (!open || searchQ.length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchAllCases(searchQ).then(setSearchResults).catch(() => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [open, searchQ]);

  if (currentCaseId) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Case:</span>
        <span className="font-medium">{currentCaseId}</span>
        <button
          onClick={async () => { await attachEncounterToCase(encounterId, null); onAttached(); }}
          className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
        >
          Unlink
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-oe-primary hover:text-oe-dark"
      >
        + Attach to Case
      </button>
      {open && (
        <div className="space-y-2 border border-gray-200 rounded p-2 bg-white">
          {memberId && memberOptions.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Quick: this member's cases</div>
              <select
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                defaultValue=""
                onChange={async (e) => {
                  if (e.target.value) {
                    await attachEncounterToCase(encounterId, e.target.value);
                    onAttached();
                    setOpen(false);
                  }
                }}
              >
                <option value="">Choose…</option>
                {memberOptions.map(c => (
                  <option key={c.CaseId} value={c.CaseId}>
                    {c.CaseNumber} — {c.Title} ({c.Status})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <div className="text-xs text-gray-500 mb-1">Search any case</div>
            <input
              type="text"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Case # or title…"
              className="border border-gray-300 rounded px-2 py-1 text-sm w-full focus:outline-none focus:border-oe-primary focus:ring-1 focus:ring-oe-primary"
            />
            {searchResults.length > 0 && (
              <ul className="mt-1 max-h-48 overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100">
                {searchResults.slice(0, 10).map(c => (
                  <li key={c.CaseId}>
                    <button
                      type="button"
                      onClick={async () => { await attachEncounterToCase(encounterId, c.CaseId); onAttached(); setOpen(false); }}
                      className="w-full text-left px-2 py-1 text-sm hover:bg-oe-light"
                    >
                      <span className="font-medium">{c.CaseNumber}</span>
                      {c.Title && <span className="text-gray-600"> — {c.Title}</span>}
                      <span className="text-gray-400 text-xs ml-1">({c.Status})</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// AttachToShareRequest
// --------------------------------------------------------------------------
const memberFullName = (first?: string | null, last?: string | null): string =>
  `${first || ''} ${last || ''}`.trim();

export function AttachToShareRequest({ encounterId, memberId, currentShareRequestId, onAttached }: {
  encounterId: string;
  memberId: string | null;
  currentShareRequestId: string | null;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [memberOptions, setMemberOptions] = useState<Array<{ ShareRequestId: string; RequestNumber: string; Status: string }>>([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ ShareRequestId: string; RequestNumber: string; Status: string; MemberFirstName?: string | null; MemberLastName?: string | null }>>([]);

  useEffect(() => {
    if (open && memberId) {
      getMemberShareRequests(memberId).then(setMemberOptions).catch(() => setMemberOptions([]));
    }
    if (!open) {
      setSearchQ('');
      setSearchResults([]);
    }
  }, [open, memberId]);

  useEffect(() => {
    if (!open || searchQ.length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchAllShareRequests(searchQ).then(setSearchResults).catch(() => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [open, searchQ]);

  if (currentShareRequestId) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-600">Share Request:</span>
        <span className="font-medium">{currentShareRequestId}</span>
        <button
          onClick={async () => { await attachEncounterToShareRequest(encounterId, null); onAttached(); }}
          className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
        >
          Unlink
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm text-oe-primary hover:text-oe-dark"
      >
        + Attach to Share Request
      </button>
      {open && (
        <div className="space-y-2 border border-gray-200 rounded p-2 bg-white">
          {memberId && memberOptions.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Quick: this member's share requests</div>
              <select
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                defaultValue=""
                onChange={async (e) => {
                  if (e.target.value) {
                    await attachEncounterToShareRequest(encounterId, e.target.value);
                    onAttached();
                    setOpen(false);
                  }
                }}
              >
                <option value="">Choose…</option>
                {memberOptions.map(sr => (
                  <option key={sr.ShareRequestId} value={sr.ShareRequestId}>
                    {sr.RequestNumber} ({sr.Status})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <div className="text-xs text-gray-500 mb-1">Search any share request</div>
            <input
              type="text"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Request # or member name…"
              className="border border-gray-300 rounded px-2 py-1 text-sm w-full focus:outline-none focus:border-oe-primary focus:ring-1 focus:ring-oe-primary"
            />
            {searchResults.length > 0 && (
              <ul className="mt-1 max-h-48 overflow-y-auto border border-gray-200 rounded divide-y divide-gray-100">
                {searchResults.slice(0, 10).map(sr => (
                  <li key={sr.ShareRequestId}>
                    <button
                      type="button"
                      onClick={async () => { await attachEncounterToShareRequest(encounterId, sr.ShareRequestId); onAttached(); setOpen(false); }}
                      className="w-full text-left px-2 py-1 text-sm hover:bg-oe-light"
                    >
                      <span className="font-medium">{sr.RequestNumber}</span>
                      {(sr.MemberFirstName || sr.MemberLastName) && (
                        <span className="text-gray-600"> — {memberFullName(sr.MemberFirstName, sr.MemberLastName)}</span>
                      )}
                      <span className="text-gray-400 text-xs ml-1">({sr.Status})</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
