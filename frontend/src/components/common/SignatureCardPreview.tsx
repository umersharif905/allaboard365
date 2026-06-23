import React from 'react';

/**
 * Live preview of the ShareWELL "business card" email signature. Mirrors the
 * backend's renderCardHtml (services/emailSignatureCardService.js) so what the
 * user sees here is what lands in the sent email — an email-safe <table> with the
 * server-composited left block (ornament + oval photo) as one image, the logo,
 * and clickable contacts. Images use fixed/`auto` dimensions so nothing stretches.
 */

const GREEN = '#18502f';
const CREAM = '#f4f2e8';
const WHITE_TEXT = '#f6f4ea';
const LABEL = '#bcd0c2';

const LEFT = 300;
const BAND = 156;
const RIGHT = 297;

// Mirror backend defaults (services/emailSignatureCardService.js).
const MAIN_PHONE = '800.269.1451';
const DEFAULT_WEBSITE = 'www.sharewellhealth.org';

export interface SignatureCardPreviewProps {
  apiBase: string;
  userId: string;
  name: string;
  title: string;
  directPhone?: string | null;
  email?: string | null;
  website?: string | null;
  /** Whether a composited left-block image exists yet (photo uploaded). */
  hasComposite: boolean;
  /** Bumped after a successful upload to bust the image cache. */
  cacheBuster?: number;
}

const tel = (s: string) => 'tel:+1' + String(s || '').replace(/\D/g, '');

const ContactRow: React.FC<{ label: string; href: string; text: string }> = ({ label, href, text }) => (
  <div style={{ margin: '3px 0', whiteSpace: 'nowrap' }}>
    <span style={{ color: LABEL }}>{label}</span>{' '}
    <a href={href} style={{ color: WHITE_TEXT, textDecoration: 'none' }} target="_blank" rel="noreferrer">
      {text}
    </a>
  </div>
);

const SignatureCardPreview: React.FC<SignatureCardPreviewProps> = ({
  apiBase,
  userId,
  name,
  title,
  directPhone,
  email,
  website,
  hasComposite,
  cacheBuster = 0,
}) => {
  const base = (apiBase || '').replace(/\/$/, '');
  const site = (website || DEFAULT_WEBSITE).replace(/^https?:\/\//, '');
  // cacheBuster also dodges any stale cached copy of the logo from before the
  // Cross-Origin-Resource-Policy fix (when the image 200'd but was render-blocked).
  const logoUrl = `${base}/api/public/email-assets/sharewell-logo.png?v=${cacheBuster}`;
  const leftBlockUrl = `${base}/api/public/email-signature/${userId}/card.png?v=${cacheBuster}`;

  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ width: 600, borderCollapse: 'collapse', background: CREAM, border: `1px solid ${GREEN}` }}
    >
      <tbody>
        <tr>
          <td
            width={LEFT}
            style={{ width: LEFT, padding: '16px 22px', borderBottom: `2px solid ${GREEN}`, verticalAlign: 'middle' }}
          >
            <div
              style={{
                fontFamily: "Georgia,'Times New Roman',serif",
                fontSize: 27,
                fontWeight: 700,
                color: GREEN,
                letterSpacing: '-1px',
                lineHeight: 1,
              }}
            >
              {name || 'Your Name'}
            </div>
            <div
              style={{
                fontFamily: 'Arial,Helvetica,sans-serif',
                fontSize: 11,
                fontWeight: 600,
                color: GREEN,
                letterSpacing: '1.5px',
                textTransform: 'uppercase',
                marginTop: 6,
              }}
            >
              {title || 'Your Title'}
            </div>
          </td>
          <td
            width={3}
            style={{ width: 3, background: GREEN, borderBottom: `2px solid ${GREEN}`, fontSize: 0, lineHeight: 0 }}
          >
            &nbsp;
          </td>
          <td
            width={RIGHT}
            style={{
              width: RIGHT,
              padding: '6px 22px',
              borderBottom: `2px solid ${GREEN}`,
              textAlign: 'center',
              verticalAlign: 'middle',
            }}
          >
            <img
              src={logoUrl}
              alt="ShareWELL Partners"
              height={68}
              style={{ height: 68, width: 'auto', display: 'inline-block' }}
            />
          </td>
        </tr>
        <tr>
          <td
            width={LEFT}
            style={{ width: LEFT, background: GREEN, padding: 0, lineHeight: 0, fontSize: 0 }}
          >
            {hasComposite ? (
              <img
                src={leftBlockUrl}
                alt=""
                width={LEFT}
                height={BAND}
                style={{ width: LEFT, height: BAND, display: 'block' }}
              />
            ) : (
              <div
                style={{
                  width: LEFT,
                  height: BAND,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: WHITE_TEXT,
                  fontFamily: 'Arial,Helvetica,sans-serif',
                  fontSize: 12,
                  textAlign: 'center',
                  padding: '0 16px',
                  lineHeight: 1.4,
                }}
              >
                Upload a headshot to complete your card
              </div>
            )}
          </td>
          <td width={3} style={{ width: 3, background: CREAM, fontSize: 0, lineHeight: 0 }}>
            &nbsp;
          </td>
          <td
            width={RIGHT}
            style={{
              width: RIGHT,
              background: GREEN,
              verticalAlign: 'middle',
              textAlign: 'left',
              padding: '0 0 0 28px',
              fontFamily: 'Arial,Helvetica,sans-serif',
              color: WHITE_TEXT,
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            <ContactRow label="m." href={tel(MAIN_PHONE)} text={MAIN_PHONE} />
            {directPhone ? <ContactRow label="d." href={tel(directPhone)} text={directPhone} /> : null}
            {email ? <ContactRow label="e." href={`mailto:${email}`} text={email} /> : null}
            <ContactRow label="w." href={`https://${site}`} text={site} />
          </td>
        </tr>
      </tbody>
    </table>
  );
};

export default SignatureCardPreview;
