import React from 'react';
import { API_CONFIG } from '../../../config/api';
import { parseEmailCard, type EmailCard } from '../../../services/user.service';
import SignatureCardPreview from '../../common/SignatureCardPreview';

/**
 * What an outbound email will actually look like — mirrors the backend's
 * composeBody() light shell + buildFooterHtml() (services/emailSendService.js):
 * a centered 600px column, consistent typography, a clear gap before the
 * signature, then the signature (ShareWELL card or text) + the auto "Ref:" line.
 * Reuses SignatureCardPreview for the card so it matches the sent email exactly.
 */

interface Props {
  bodyText: string;
  senderName: string;
  vendorName?: string | null;
  emailSignature?: string | null;
  emailCard?: EmailCard | string | null;
  userId: string;
  /** SR-/Case number appended as the auto "Ref:" line. */
  refLabel?: string | null;
  /** Replies: note that the prior conversation gets quoted (collapsed) below. */
  showQuoteNote?: boolean;
}

const toParagraphs = (text: string): string[] =>
  text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

const EmailPreview: React.FC<Props> = ({
  bodyText, senderName, vendorName, emailSignature, emailCard, userId, refLabel, showQuoteNote,
}) => {
  const card = parseEmailCard(emailCard);
  const useCard = !!(card && card.enabled && card.compositePath);
  const customSig = emailSignature && emailSignature.trim() ? emailSignature : null;
  const apiBase = API_CONFIG.BASE_URL || '';

  const paragraphs = toParagraphs(bodyText);
  const defaultSig =
    `— ${senderName || 'Your care team'} from ${vendorName ? `the ${vendorName} Care Team` : 'the Care Team'}. ` +
    `This is being handled by a real person — just reply to this email and it comes straight to me.`;
  const sigText = customSig ? customSig : (useCard ? '' : defaultSig);

  const refLine = refLabel
    ? <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 6 }}>Ref: {refLabel}</div>
    : null;
  const sigTextBlock = sigText
    ? <div style={{ whiteSpace: 'pre-wrap' }}>{sigText}</div>
    : null;

  return (
    <div style={{ background: '#f3f4f6', padding: 16, borderRadius: 8 }}>
      <div style={{ maxWidth: 600, margin: '0 auto', background: '#fff', borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px', fontFamily: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif", fontSize: 15, lineHeight: 1.6, color: '#1f2937' }}>
          {paragraphs.length
            ? paragraphs.map((p, i) => (
                <p key={i} style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>{p}</p>
              ))
            : <p style={{ margin: 0, color: '#9ca3af' }}>Your message preview will appear here…</p>}

          {/* gap before the signature (mirrors the 28px backend spacer) */}
          <div style={{ height: 28 }} />

          {useCard ? (
            <div style={{ overflowX: 'auto' }}>
              <SignatureCardPreview
                apiBase={apiBase}
                userId={userId}
                name={senderName || 'Your Name'}
                title={card?.title ?? ''}
                directPhone={card?.directPhone}
                email={card?.email}
                website={card?.website}
                hasComposite={!!card?.compositePath}
              />
              {(sigTextBlock || refLine) && (
                <div style={{ color: '#6b7280', fontSize: 12, marginTop: 10 }}>
                  {sigTextBlock}{refLine}
                </div>
              )}
            </div>
          ) : (
            (sigTextBlock || refLine) && (
              <div style={{ color: '#6b7280', fontSize: 12, borderTop: '1px solid #e5e7eb', marginTop: 16, paddingTop: 8 }}>
                {sigTextBlock}{refLine}
              </div>
            )
          )}

          {showQuoteNote && (
            <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px dashed #e5e7eb', color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
              ↩ The earlier messages in this conversation are quoted below (collapsed in the recipient's inbox).
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EmailPreview;
