/**
 * Compose missing-recurring payment reminders via tenant message blast (same as Message Blast;
 * messages are handed off to the message service for delivery).
 */
import { AlertCircle, Mail, MessageSquare, Send, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import RichTextEditor from '../common/RichTextEditor';
import { apiService } from '../../services/api.service';
import {
  buildMissingRecurringBlastEmailHtml,
  buildMissingRecurringSmsBody,
  defaultMissingRecurringSubject,
  prependBulkEmailReplyToMetadata,
  stripBulkEmailMetadataPrefix
} from '../../utils/missingRecurringOutreach';

export interface MissingRecurringOutreachModalProps {
  open: boolean;
  onClose: () => void;
  /** SysAdmin: target tenant for /api/me/tenant-admin/message-blast (x-current-tenant-id). */
  tenantIdHeader?: string;
  memberPortalLoginUrl: string;
  /** oe.Tenants.Name — used in subject, sign-off, SMS prefix */
  tenantName?: string | null;
  /** oe.Tenants.ContactEmail — if set, SendGrid Reply-To only (not inserted into body; add contact lines in the editor yourself if needed) */
  supportEmail?: string | null;
  manualEmails: string[];
  manualPhones: string[];
  rowsWithoutEmail: number;
  rowsWithoutPhone: number;
  onSent?: (data: { emailsQueued: number; smsQueued: number; estimatedCost: number; sendBatchId?: string }) => void;
}

export function MissingRecurringOutreachModal({
  open,
  onClose,
  tenantIdHeader,
  memberPortalLoginUrl,
  tenantName,
  supportEmail,
  manualEmails,
  manualPhones,
  rowsWithoutEmail,
  rowsWithoutPhone,
  onSent
}: MissingRecurringOutreachModalProps) {
  const [sendEmail, setSendEmail] = useState(true);
  const [sendSMS, setSendSMS] = useState(false);
  const [subject, setSubject] = useState(() => defaultMissingRecurringSubject(null));
  const [body, setBody] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubject(defaultMissingRecurringSubject(tenantName ?? null));
    setBody(buildMissingRecurringBlastEmailHtml(memberPortalLoginUrl, tenantName ?? null));
    setSmsBody(buildMissingRecurringSmsBody(memberPortalLoginUrl, tenantName ?? null));
    setSendEmail(manualEmails.length > 0);
    setSendSMS(manualPhones.length > 0);
  }, [open, memberPortalLoginUrl, tenantName, manualEmails.length, manualPhones.length]);

  const emailCount = sendEmail ? manualEmails.length : 0;
  const phoneDigitsList = useMemo(() => {
    return manualPhones
      .map((p) => String(p).replace(/\D/g, ''))
      .filter((d) => d.length >= 10);
  }, [manualPhones]);
  const phoneCount = sendSMS ? new Set(phoneDigitsList).size : 0;

  const previewInner =
    body && body.trim()
      ? stripBulkEmailMetadataPrefix(body.trim())
      : '<p style="color:#9ca3af">Enter email content to see preview.</p>';
  const previewHtml =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;margin:0;font-size:14px;line-height:1.5;color:#374151;} a{color:#1d4ed8;text-decoration:underline;}</style></head><body>' +
    previewInner +
    '</body></html>';

  const requestHeaders =
    tenantIdHeader && tenantIdHeader.trim()
      ? { 'x-current-tenant-id': tenantIdHeader.trim() }
      : undefined;

  const handleSend = async () => {
    setError(null);
    if (!sendEmail && !sendSMS) {
      setError('Select at least one delivery method (email or SMS).');
      return;
    }
    if (sendEmail && !body.trim()) {
      setError('Email message body is required.');
      return;
    }
    if (sendSMS && !smsBody.trim()) {
      setError('SMS message is required.');
      return;
    }
    if (sendEmail && manualEmails.length === 0) {
      setError('No email recipients on the current filtered list.');
      return;
    }
    if (sendSMS && phoneDigitsList.length === 0) {
      setError('No SMS recipients on the current filtered list.');
      return;
    }

    const manualPhonesForApi =
      phoneDigitsList.length > 0
        ? [...new Set(phoneDigitsList)].map((d) =>
            d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : '+' + d
          )
        : undefined;

    try {
      setSending(true);
      const dynamicSendTimeoutMs = Math.min(
        15 * 60 * 1000,
        Math.max(30 * 1000, 45 * 1000 + phoneCount * 250 + emailCount * 100)
      );
      const emailBodyForSend =
        sendEmail ? prependBulkEmailReplyToMetadata(body.trim(), supportEmail ?? null) : undefined;

      const res = await apiService.post<{
        success: boolean;
        data?: {
          emailsQueued: number;
          smsQueued: number;
          estimatedCost: number;
          sendBatchId?: string;
          bulkJobMessageId?: string;
        };
        message?: string;
      }>(
        '/api/me/tenant-admin/message-blast/send',
        {
          sendEmail,
          sendSMS,
          subject: subject.trim() || undefined,
          body: emailBodyForSend,
          smsBody: sendSMS ? smsBody.trim() : undefined,
          agentIds: [],
          manualEmails: manualEmails.length ? manualEmails : undefined,
          manualPhones: manualPhonesForApi
        },
        {
          timeout: dynamicSendTimeoutMs,
          headers: requestHeaders
        }
      );
      if (res?.success && res.data) {
        onSent?.(res.data);
        onClose();
      } else {
        setError((res as { message?: string })?.message || 'Failed to send messages');
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      setError(err?.response?.data?.message || err?.message || 'Failed to send messages');
    } finally {
      setSending(false);
    }
  };

  const canSend =
    (sendEmail || sendSMS) &&
    (!sendEmail || body.trim().length > 0) &&
    (!sendSMS || smsBody.trim().length > 0) &&
    (!sendEmail || manualEmails.length > 0) &&
    (!sendSMS || phoneDigitsList.length > 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <button
          type="button"
          className="fixed inset-0 bg-gray-500 bg-opacity-75"
          aria-label="Close"
          onClick={() => !sending && onClose()}
        />
        <div className="relative bg-white rounded-lg shadow-xl max-w-5xl w-full p-6 max-h-[90vh] overflow-y-auto z-10">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Message members — missing recurring payment</h3>
              <p className="mt-1 text-sm text-gray-600">
                Same flow as Message Blast: email and/or SMS are sent through your tenant messaging service. One email
                template goes to all recipients (no per-member first name merge).
              </p>
              {supportEmail && String(supportEmail).trim().includes('@') && (
                <p className="mt-2 text-xs text-gray-500">
                  This tenant has a contact email on file — it will be used only as the email{' '}
                  <span className="font-medium text-gray-600">Reply-To</span> address (not inserted into the body). Add any
                  contact text yourself in the editor if you want it visible.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => !sending && onClose()}
              className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 shrink-0"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1fr,360px] gap-6">
            <div className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
                <p>
                  <strong>{manualEmails.length}</strong> unique email
                  {manualEmails.length === 1 ? '' : 's'}, <strong>{manualPhones.length}</strong> unique phone
                  {manualPhones.length === 1 ? '' : 's'} on the filtered list.
                </p>
                {rowsWithoutEmail > 0 && (
                  <p className="mt-2 text-amber-800">
                    {rowsWithoutEmail} row{rowsWithoutEmail === 1 ? '' : 's'} have no usable email.
                  </p>
                )}
                {rowsWithoutPhone > 0 && (
                  <p className="mt-2 text-amber-800">
                    {rowsWithoutPhone} row{rowsWithoutPhone === 1 ? '' : 's'} have no usable phone.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    disabled={manualEmails.length === 0}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50"
                  />
                  <Mail className="h-4 w-4 text-gray-600" aria-hidden />
                  <span className="text-sm font-medium text-gray-700">Email</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sendSMS}
                    onChange={(e) => setSendSMS(e.target.checked)}
                    disabled={manualPhones.length === 0}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50"
                  />
                  <MessageSquare className="h-4 w-4 text-gray-600" aria-hidden />
                  <span className="text-sm font-medium text-gray-700">SMS</span>
                </label>
              </div>

              {sendEmail && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email message</label>
                    <RichTextEditor
                      value={body}
                      onChange={(value) => setBody(value)}
                      placeholder="Email body…"
                      minHeight={220}
                      allowHtmlSource={true}
                    />
                  </div>
                </>
              )}

              {sendSMS && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">SMS (plain text)</label>
                  <textarea
                    value={smsBody}
                    onChange={(e) => setSmsBody(e.target.value)}
                    rows={6}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Default text explains why a recurring payment method is needed and includes your portal link. Longer
                    messages may use more than one SMS segment; edit as needed.
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
                  <AlertCircle className="h-5 w-5 shrink-0" aria-hidden />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => !sending && onClose()}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
                  disabled={sending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sending || !canSend}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? (
                    <span>Sending…</span>
                  ) : (
                    <>
                      <Send className="h-4 w-4 shrink-0" aria-hidden />
                      Send messages
                    </>
                  )}
                </button>
              </div>
            </div>

            {sendEmail && (
              <div className="lg:sticky lg:top-0 self-start">
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                    <h4 className="text-sm font-medium text-gray-900">Email preview</h4>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">Subject: {subject.trim() || '(No subject)'}</p>
                  </div>
                  <iframe
                    title="Email preview"
                    srcDoc={previewHtml}
                    className="w-full border-0 min-h-[320px]"
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
