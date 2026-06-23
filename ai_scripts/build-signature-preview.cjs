// Builds a self-contained email-safe ShareWELL signature card preview.
// Reads the brand assets and embeds them as data-URIs (preview only; real
// emails will reference hosted URLs since Outlook strips data-URI <img>).
const fs = require('fs');
const dir = '/app/backend/assets/email-signature';
const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(`${dir}/${f}`).toString('base64');
const logo = b64('sharewell-logo.png');
const ornament = b64('left-ornament.png');
// gray placeholder headshot
const photo = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#cfd8d0"/>' +
  '<circle cx="80" cy="62" r="30" fill="#9fb0a4"/><path d="M30 150c0-30 22-46 50-46s50 16 50 46z" fill="#9fb0a4"/></svg>'
);

const d = {
  name: 'Brittney Bonner', title: 'Member Engagement Operations',
  mainPhone: '800.269.1451', directPhone: '478.508.1561',
  email: 'Brittney@sharewellpartners.com', website: 'www.sharewellhealth.org',
};
const tel = (s) => 'tel:+1' + s.replace(/\D/g, '');
const row = (label, href, text) =>
  `<div style="margin:3px 0;white-space:nowrap;"><span style="color:#bcd0c2;">${label}</span> ` +
  `<a href="${href}" style="color:#f6f4ea;text-decoration:none;">${text}</a></div>`;

const contacts =
  row('m.', tel(d.mainPhone), d.mainPhone) +
  row('d.', tel(d.directPhone), d.directPhone) +
  row('e.', `mailto:${d.email}`, d.email) +
  row('w.', `https://${d.website.replace(/^https?:\/\//, '')}`, d.website);

const BAND = 156;       // green band height; ornament spans it fully
const LEFT = 300;       // left half width
const RIGHT = 297;      // right half width (600 - LEFT - 3px divider)

// Divider colour flips per region (green line on cream top, cream line on green bottom) — matches the original card.
const card = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;border-collapse:collapse;background:#f4f2e8;border:1px solid #18502f;">
  <!-- TOP (cream): name/title | divider | logo -->
  <tr>
    <td width="${LEFT}" style="width:${LEFT}px;padding:16px 22px;border-bottom:2px solid #18502f;vertical-align:middle;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:27px;font-weight:700;color:#18502f;letter-spacing:-1px;line-height:1;">${d.name}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#18502f;letter-spacing:1.5px;text-transform:uppercase;margin-top:6px;">${d.title}</div>
    </td>
    <td width="3" style="width:3px;background:#18502f;border-bottom:2px solid #18502f;font-size:0;line-height:0;">&nbsp;</td>
    <td width="${RIGHT}" style="width:${RIGHT}px;padding:6px 22px;border-bottom:2px solid #18502f;text-align:center;vertical-align:middle;">
      <img src="${logo}" alt="ShareWELL Partners" height="68" style="height:68px;display:inline-block;" />
    </td>
  </tr>
  <!-- BOTTOM (green): ornament+oval photo | divider | contacts -->
  <tr>
    <td width="${LEFT}" style="width:${LEFT}px;background:#18502f;padding:0;height:${BAND}px;line-height:0;white-space:nowrap;vertical-align:middle;">
      <img src="${ornament}" alt="" height="${BAND}" style="height:${BAND}px;display:inline-block;vertical-align:middle;" />
      <img src="${photo}" alt="${d.name}" width="92" height="120" style="width:92px;height:120px;border-radius:50%;object-fit:cover;display:inline-block;vertical-align:middle;margin-left:-30px;border:3px solid #f4f2e8;" />
    </td>
    <td width="3" style="width:3px;background:#f4f2e8;font-size:0;line-height:0;">&nbsp;</td>
    <td width="${RIGHT}" style="width:${RIGHT}px;background:#18502f;vertical-align:middle;text-align:left;padding:0 0 0 28px;font-family:Arial,Helvetica,sans-serif;color:#f6f4ea;font-size:14px;line-height:1.6;">
      ${contacts}
    </td>
  </tr>
</table>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>ShareWELL signature card — email-safe preview</title></head>
<body style="background:#e5e7eb;margin:0;padding:28px;font-family:Arial,Helvetica,sans-serif;">
  <p style="color:#374151;font-size:13px;max-width:600px;">Email-safe ShareWELL signature card — table-based, inline styles, clickable phone/email/website. (Headshot is a placeholder; real emails reference hosted image URLs, not the embedded data-URIs used here for self-contained preview.)</p>
  ${card}
  <p style="color:#6b7280;font-size:12px;margin-top:18px;">Below the card, an outbound email still auto-appends the case ref, e.g.:</p>
  <div style="color:#9ca3af;font-size:11px;">Ref: SR-2026-0123</div>
</body></html>`;

const out = '/app/docs/superpowers/specs/2026-06-02-back-office-email/signature-card-preview.html';
fs.writeFileSync(out, page);
console.log('wrote', out, '(', page.length, 'bytes )');
