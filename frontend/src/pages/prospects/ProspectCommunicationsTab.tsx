// frontend/src/pages/prospects/ProspectCommunicationsTab.tsx
// Past email/SMS with a prospect (matched by ProspectId or email/phone) + a composer to
// send a new message. Mirrors the member MemberCommunicationsTab layout.

import { Loader2, Mail, MessageSquare, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import OutboundEmailSenderNotice from '../../components/shared/OutboundEmailSenderNotice';
import {
  useProspectCommunications,
  useSendProspectCommunication,
} from '../../hooks/useProspects';
import { apiService } from '../../services/api.service';
import { Prospect } from '../../services/prospect.service';

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (['delivered', 'sent', 'opened', 'clicked'].includes(s)) return 'bg-green-100 text-green-800';
  if (['failed', 'bounced', 'undelivered'].includes(s)) return 'bg-red-100 text-red-700';
  return 'bg-yellow-100 text-yellow-800';
}

export default function ProspectCommunicationsTab({ prospect }: { prospect: Prospect }) {
  const { data: messages = [], isLoading } = useProspectCommunications(prospect.ProspectId);
  const sendMutation = useSendProspectCommunication(prospect.ProspectId);

  const [channel, setChannel] = useState<'email' | 'sms'>(prospect.Email ? 'email' : 'sms');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailSender, setEmailSender] = useState<{
    fromDisplayName: string;
    fromEmail: string;
    replyToName: string;
    replyToEmail: string;
  } | null>(null);
  const [emailSenderLoading, setEmailSenderLoading] = useState(false);

  useEffect(() => {
    if (channel !== 'email') return;
    let cancelled = false;
    setEmailSenderLoading(true);
    apiService
      .get<{
        success: boolean;
        data?: {
          fromDisplayName: string;
          fromEmail: string;
          replyToName: string;
          replyToEmail: string;
        };
      }>('/api/me/agent/outbound-email-sender')
      .then((res) => {
        if (!cancelled && res?.success && res.data) setEmailSender(res.data);
      })
      .catch(() => {
        if (!cancelled) setEmailSender(null);
      })
      .finally(() => {
        if (!cancelled) setEmailSenderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const canEmail = !!prospect.Email;
  const canSms = !!prospect.Phone;

  const handleSend = () => {
    setError(null);
    if (!body.trim()) { setError('Enter a message.'); return; }
    sendMutation.mutate(
      { channel, subject: channel === 'email' ? subject || undefined : undefined, body },
      {
        onSuccess: () => { setBody(''); setSubject(''); },
        onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Failed to send'),
      }
    );
  };

  return (
    <div className="space-y-6">
      {/* Composer */}
      <div className="border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setChannel('email')}
            disabled={!canEmail}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border ${
              channel === 'email' ? 'bg-oe-primary text-white border-oe-primary' : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            } disabled:opacity-40`}
          >
            <Mail className="w-4 h-4" /> Email
          </button>
          <button
            onClick={() => setChannel('sms')}
            disabled={!canSms}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border ${
              channel === 'sms' ? 'bg-oe-primary text-white border-oe-primary' : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            } disabled:opacity-40`}
          >
            <MessageSquare className="w-4 h-4" /> SMS
          </button>
          <span className="text-xs text-gray-400 ml-auto">
            {channel === 'email' ? prospect.Email : prospect.Phone}
          </span>
        </div>

        {channel === 'email' && (
          <>
            {emailSenderLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading sender details…
              </div>
            ) : null}
            {emailSender ? (
              <OutboundEmailSenderNotice
                fromDisplayName={emailSender.fromDisplayName}
                fromEmail={emailSender.fromEmail}
                replyToName={emailSender.replyToName}
                replyToEmail={emailSender.replyToEmail}
              />
            ) : null}
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </>
        )}
        {channel === 'sms' && (
          <p className="text-xs text-gray-500">
            Paste links in your message on their own line so they stay tappable. Proposal and quote texts add the PDF
            link on a separate line automatically.
          </p>
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder={`Write a ${channel === 'email' ? 'email' : 'text message'}…`}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <button
            onClick={handleSend}
            disabled={sendMutation.isPending || (!canEmail && !canSms)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
          >
            {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send
          </button>
        </div>
      </div>

      {/* History */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 mb-2">History</h3>
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-gray-500">No communications yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {messages.map((m) => (
              <li key={m.messageId} className="px-3 py-2 flex items-start gap-3 text-sm">
                {m.messageType === 'Email' ? (
                  <Mail className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <MessageSquare className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-gray-900 truncate">{m.subject || (m.messageType === 'SMS' ? 'SMS' : 'No subject')}</p>
                  <p className="text-xs text-gray-400">
                    {m.sentDate ? new Date(m.sentDate).toLocaleString() : ''} · {m.recipientAddress}
                  </p>
                </div>
                <span className={`px-2 py-0.5 text-xs font-medium rounded ${statusClass(m.status)}`}>{m.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
