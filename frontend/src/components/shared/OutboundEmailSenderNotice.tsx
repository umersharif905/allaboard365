// Shown when composing agent-originated email so users see From vs Reply-To clearly.

type OutboundEmailSenderNoticeProps = {
  fromDisplayName: string;
  fromEmail: string;
  replyToName: string;
  replyToEmail: string;
  className?: string;
};

export default function OutboundEmailSenderNotice({
  fromDisplayName,
  fromEmail,
  replyToName,
  replyToEmail,
  className = '',
}: OutboundEmailSenderNoticeProps) {
  return (
    <div
      className={`space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm ${className}`.trim()}
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">From (what recipients see)</p>
        <p className="font-medium text-gray-900">
          {fromDisplayName} &lt;{fromEmail}&gt;
        </p>
        <p className="mt-1 text-xs text-gray-600">
          Your name appears in the inbox; the sending address is your tenant&apos;s verified sender (required by
          email providers).
        </p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Reply-To</p>
        <p className="text-gray-900">
          {replyToName} &lt;{replyToEmail}&gt;
        </p>
        <p className="mt-1 text-xs text-gray-600">When they hit reply, the message comes to you at this address.</p>
      </div>
    </div>
  );
}
