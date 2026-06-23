const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PKPass } = require('passkit-generator');
const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../../config/database');

const CERTS_DIR = path.resolve(__dirname, '../../../certs/wallet');
const PASSES_DIR = path.resolve(__dirname, '../../../assets/wallet-passes');

const GOOGLE_WALLET_ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000023152400';
const GOOGLE_WALLET_KEY_FILE = path.join(CERTS_DIR, 'google-wallet-key.json');

const BRAND_CONFIG = {
  mightywell: {
    passTypeIdentifier: 'pass.com.allaboard365.mightywell',
    teamIdentifier: 'YFRWYTZHTS',
    orgName: 'MightyWELL Health',
    cert: path.join(CERTS_DIR, 'mightywell-pass.pem'),
    model: path.join(PASSES_DIR, 'mightywell.pass'),
    googleClassId: GOOGLE_WALLET_ISSUER_ID + '.MightyWELL_IDCard',
  },
  sharewell: {
    passTypeIdentifier: 'pass.com.allaboard365.sharewell',
    teamIdentifier: '78K2X2AV9Y',
    orgName: 'ShareWELL Partners',
    cert: path.join(CERTS_DIR, 'sharewell-pass.pem'),
    model: path.join(PASSES_DIR, 'sharewell.pass'),
    googleClassId: GOOGLE_WALLET_ISSUER_ID + '.ShareWELL_IDCard',
  },
};

const SIGNER_KEY = fs.readFileSync(path.join(CERTS_DIR, 'pass-key.pem'));
const WWDR = fs.readFileSync(path.join(CERTS_DIR, 'wwdr.pem'));

// In-memory cache for generated passes (short-lived, one-time download tokens)
const passCache = new Map();

function detectBrand(tenantName) {
  if (!tenantName) return 'mightywell';
  const lower = tenantName.toLowerCase();
  if (lower.includes('sharewell')) return 'sharewell';
  return 'mightywell';
}

function formatDate(d) {
  if (!d) return 'N/A';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function buildBackContent(idCardData) {
  const lines = [];
  const back = idCardData?.Card_Back;
  if (!back) return 'Contact your plan administrator for details.';

  for (const section of ['Top_Left', 'Top_Right', 'Middle', 'Bottom_Left', 'Bottom_Right']) {
    const q = back[section];
    if (!q) continue;
    if (q.Header) lines.push(`** ${q.Header} **`);
    if (q.Text1) lines.push(q.Text1);
    if (q.Link_Name1) {
      const url1 = q.URL1 || '';
      if (url1.startsWith('mailto:') || url1.startsWith('tel:')) {
        lines.push(q.Link_Name1);
      } else if (url1) {
        lines.push(`${q.Link_Name1}: ${url1}`);
      } else {
        lines.push(q.Link_Name1);
      }
    }
    if (q.Link_Name2) {
      const url2 = q.URL2 || '';
      if (url2.startsWith('mailto:') || url2.startsWith('tel:')) {
        lines.push(q.Link_Name2);
      } else if (url2) {
        lines.push(`${q.Link_Name2}: ${url2}`);
      } else {
        lines.push(q.Link_Name2);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim() || 'Contact your plan administrator for details.';
}

/**
 * POST /api/me/member/wallet/pass
 * Generate a .pkpass file and return it as a downloadable response.
 * The mobile app opens the URL with Linking.openURL — iOS handles .pkpass natively.
 */
router.post('/pass', async (req, res) => {
  try {
    const userId = req.user?.UserId || req.user?.userId;
    const { enrollmentId, platform } = req.body;

    if (!platform || !['apple', 'google'].includes(platform)) {
      return res.status(400).json({
        success: false,
        message: 'platform must be "apple" or "google"',
        code: 'INVALID_PLATFORM',
      });
    }

    console.log('🎫 POST /api/me/member/wallet/pass -', { userId, enrollmentId, platform });

    const pool = await getPool();

    const memberReq = pool.request();
    memberReq.input('userId', sql.UniqueIdentifier, userId);
    const memberResult = await memberReq.query(`
      SELECT m.MemberId, m.Status as MemberStatus, m.HouseholdMemberId,
             u.FirstName, u.LastName, u.Email,
             t.Name as TenantName, t.MemberIDPrefix, t.IndividualMemberIDPrefix
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      JOIN oe.Tenants t ON u.TenantId = t.TenantId
      WHERE u.UserId = @userId
    `);

    if (memberResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Member not found', code: 'MEMBER_NOT_FOUND' });
    }

    const member = memberResult.recordset[0];

    if (member.MemberStatus !== 'Active' && member.MemberStatus !== 'Terminated') {
      return res.status(403).json({ success: false, message: 'Member account is inactive', code: 'MEMBER_INACTIVE' });
    }

    const enrollReq = pool.request();
    enrollReq.input('memberId', sql.NVarChar, member.MemberId);
    let enrollmentFilter = '';
    if (enrollmentId) {
      enrollReq.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      enrollmentFilter = 'AND e.EnrollmentId = @enrollmentId';
    }

    const enrollResult = await enrollReq.query(`
      SELECT TOP 1
        e.EnrollmentId, e.MemberId, e.Status, e.EffectiveDate, e.TerminationDate,
        p.Name as ProductName, p.ProductLogoUrl, p.ProductImageUrl, p.IDCardData,
        p.EligibilityIndividualVendorGroupId as StaticGroupId,
        u.FirstName + ' ' + u.LastName as MemberName,
        m.HouseholdMemberID,
        m.DateOfBirth,
        ISNULL(mt.MemberIDPrefix, '') AS MemberTenantMemberIdPrefix
      FROM oe.Enrollments e
      JOIN oe.Members m ON e.MemberId = m.MemberId
      JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
      LEFT JOIN oe.Tenants mt ON u.TenantId = mt.TenantId
      WHERE e.MemberId = @memberId
        AND e.Status = 'Active'
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
        ${enrollmentFilter}
      ORDER BY e.EffectiveDate DESC
    `);

    if (enrollResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'No active enrollment found', code: 'NO_ACTIVE_ENROLLMENTS' });
    }

    const enrollment = enrollResult.recordset[0];

    let idCardData = null;
    try {
      idCardData = typeof enrollment.IDCardData === 'string' ? JSON.parse(enrollment.IDCardData) : enrollment.IDCardData;
    } catch { /* ignore */ }

    if (!idCardData || idCardData.DisableIDCard) {
      return res.status(404).json({ success: false, message: 'ID card not available', code: 'ID_CARD_DISABLED' });
    }

    const memberName = enrollment.MemberName || `${member.FirstName} ${member.LastName}`;
    // Use HouseholdMemberID (e.g. MW15990739) — same as what the app displays. Never show GUIDs.
    const displayMemberId = enrollment.HouseholdMemberID || member.HouseholdMemberId || 'N/A';
    const dob = enrollment.DateOfBirth ? formatDate(enrollment.DateOfBirth) : null;

    // Get household dependents via HouseholdId (same as /api/me/member/household endpoint)
    let dependentsText = '';
    try {
      const hhReq = pool.request();
      hhReq.input('memberId', sql.UniqueIdentifier, enrollment.MemberId);
      const hhResult = await hhReq.query(`
        SELECT u.FirstName, u.LastName, m.DateOfBirth, m.RelationshipType
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.HouseholdId = (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId)
          AND m.RelationshipType != 'P'
          AND m.Status = 'Active'
        ORDER BY m.RelationshipType, u.FirstName
      `);
      if (hhResult.recordset.length > 0) {
        const deps = hhResult.recordset.map(d => {
          const dobStr = d.DateOfBirth ? ` — DoB: ${formatDate(d.DateOfBirth)}` : '';
          const rel = d.RelationshipType === 'S' ? 'Spouse' : 'Dependent';
          return `${d.FirstName} ${d.LastName} (${rel})${dobStr}`;
        });
        dependentsText = deps.join('\n');
      }
    } catch (hhErr) {
      console.warn('⚠️ Could not load household for wallet pass:', hhErr.message);
    }

    if (platform === 'google') {
      const brand = detectBrand(member.TenantName);
      const config = BRAND_CONFIG[brand];

      // Parse Rx from card back
      const rxBack = (() => {
        const back = idCardData.Card_Back;
        if (!back) return {};
        for (const section of ['Middle', 'Top_Left', 'Top_Right', 'Bottom_Left', 'Bottom_Right']) {
          const text = back[section]?.Text1 || '';
          if (/Rx\s*BIN/i.test(text)) {
            return {
              bin: text.match(/Rx\s*BIN[:\s]*(\S+)/i)?.[1] || '',
              pcn: text.match(/Rx\s*PCN[:\s]*(\S+)/i)?.[1] || '',
              group: text.match(/Rx\s*Group[:\s]*(\S+)/i)?.[1] || '',
            };
          }
        }
        return {};
      })();

      // Build the Google Wallet pass object
      const objectId = `${GOOGLE_WALLET_ISSUER_ID}.member_${enrollment.MemberId.replace(/-/g, '')}_${Date.now()}`;
      const headerImage = (idCardData.Card_Front?.Header?.Image || '').trim();
      const rawLogoUrl = enrollment.ProductLogoUrl || enrollment.ProductImageUrl || '';

      // Google Wallet needs a square logo for the circle icon
      // Dynamically crop the left portion of any wide product logo into a square
      let logoUrl = rawLogoUrl;
      if (rawLogoUrl) {
        try {
          const { BlobServiceClient } = require('@azure/storage-blob');
          const logoResp = await axios.get(rawLogoUrl, { responseType: 'arraybuffer', timeout: 5000 });
          const logoBuf = Buffer.from(logoResp.data);
          const meta = await sharp(logoBuf).metadata();

          if (meta.width && meta.height && meta.width > meta.height * 1.5) {
            const squareSize = meta.height;
            const cropped = await sharp(logoBuf)
              .extract({ left: 0, top: 0, width: squareSize, height: squareSize })
              .resize(512, 512)
              .png()
              .toBuffer();

            // Upload to blob storage with a deterministic name based on source URL
            const crypto = require('crypto');
            const hash = crypto.createHash('md5').update(rawLogoUrl).digest('hex');
            const blobName = `wallet-square-logo-${hash}.png`;
            const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
            if (connStr) {
              const blobClient = BlobServiceClient.fromConnectionString(connStr);
              const container = blobClient.getContainerClient('logos');
              const blockBlob = container.getBlockBlobClient(blobName);
              await blockBlob.upload(cropped, cropped.length, { blobHTTPHeaders: { blobContentType: 'image/png' } });
              logoUrl = blockBlob.url;
            }
          }
        } catch (cropErr) {
          console.warn('⚠️ Logo square crop failed:', cropErr.message);
        }
      }

      const passObject = {
        id: objectId,
        classId: config.googleClassId,
        genericType: 'GENERIC_TYPE_UNSPECIFIED',
        cardTitle: { defaultValue: { language: 'en', value: enrollment.ProductName } },
        header: { defaultValue: { language: 'en', value: memberName } },
        subheader: { defaultValue: { language: 'en', value: displayMemberId } },
        logo: logoUrl ? { sourceUri: { uri: logoUrl }, contentDescription: { defaultValue: { language: 'en', value: config.orgName } } } : undefined,
        heroImage: headerImage.startsWith('http') ? { sourceUri: { uri: headerImage }, contentDescription: { defaultValue: { language: 'en', value: config.orgName } } } : undefined,
        hexBackgroundColor: '#FFFFFF',
        textModulesData: [
          { id: 'memberId', header: 'MEMBER ID', body: displayMemberId },
          { id: 'groupId', header: 'GROUP ID', body: enrollment.StaticGroupId || 'N/A' },
          { id: 'dob', header: 'DOB', body: dob || 'N/A' },
          { id: 'effective', header: 'EFFECTIVE', body: formatDate(enrollment.EffectiveDate) },
          ...(rxBack.bin ? [{ id: 'rxBin', header: 'Rx BIN', body: rxBack.bin }] : []),
          ...(rxBack.pcn ? [{ id: 'rxPcn', header: 'Rx PCN', body: rxBack.pcn }] : []),
          ...(rxBack.group ? [{ id: 'rxGroup', header: 'Rx GROUP', body: rxBack.group }] : []),
        ],
      };

      // Sign JWT with service account credentials
      const keyData = JSON.parse(fs.readFileSync(GOOGLE_WALLET_KEY_FILE, 'utf8'));
      const token = jwt.sign({
        iss: keyData.client_email,
        aud: 'google',
        typ: 'savetowallet',
        origins: [],
        payload: { genericObjects: [passObject] },
      }, keyData.private_key, { algorithm: 'RS256' });

      const saveUrl = `https://pay.google.com/gp/v/save/${token}`;
      console.log('🎫 Google Wallet pass generated:', { brand, member: memberName, objectId });

      return res.json({ success: true, data: { saveUrl } });
    }

    // Apple Wallet — generate .pkpass
    const brand = detectBrand(member.TenantName);
    const config = BRAND_CONFIG[brand];
    const signerCert = fs.readFileSync(config.cert);

    // Load model files (icon.png is REQUIRED by Apple)
    const modelDir = config.model;
    const modelBuffers = {};
    for (const file of fs.readdirSync(modelDir)) {
      if (file === 'pass.json') continue;
      modelBuffers[file] = fs.readFileSync(path.join(modelDir, file));
    }

    const pass = new PKPass(modelBuffers, {
      wwdr: WWDR,
      signerCert,
      signerKey: SIGNER_KEY,
    }, {
      serialNumber: `${enrollment.EnrollmentId}-${Date.now()}`,
      description: `${config.orgName} ID Card`,
      organizationName: config.orgName,
      passTypeIdentifier: config.passTypeIdentifier,
      teamIdentifier: config.teamIdentifier,
      foregroundColor: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      labelColor: 'rgb(120, 120, 120)',
    });

    pass.type = 'generic';

    // Front of card — optimized for provider use
    // Header: plan name (top-right, next to logo)
    pass.headerFields.push({ key: 'plan', label: 'PLAN', value: enrollment.ProductName });

    // Primary: member name (large, center)
    pass.primaryFields.push({ key: 'memberName', label: 'MEMBER', value: memberName });

    // Secondary: provider essentials — Member ID + Group ID (or effective date)
    const secondaryFields = [
      { key: 'memberId', label: 'MEMBER ID', value: displayMemberId },
    ];
    if (enrollment.StaticGroupId) {
      secondaryFields.push({ key: 'groupId', label: 'GROUP ID', value: enrollment.StaticGroupId });
    } else {
      secondaryFields.push({ key: 'effectiveDate', label: 'EFFECTIVE', value: formatDate(enrollment.EffectiveDate) });
    }
    for (const f of secondaryFields) pass.secondaryFields.push(f);

    // Auxiliary: DOB, effective date, then Rx IDs (if available) or phone
    if (dob) pass.auxiliaryFields.push({ key: 'dob', label: 'DOB', value: dob });
    if (enrollment.StaticGroupId) {
      pass.auxiliaryFields.push({ key: 'effectiveDate', label: 'EFFECTIVE', value: formatDate(enrollment.EffectiveDate) });
    }

    // Parse Rx IDs from card back
    const rxFront = (() => {
      const back = idCardData.Card_Back;
      if (!back) return null;
      for (const section of ['Middle', 'Top_Left', 'Top_Right', 'Bottom_Left', 'Bottom_Right']) {
        const text = back[section]?.Text1 || '';
        if (/Rx\s*BIN/i.test(text)) {
          const bin = text.match(/Rx\s*BIN[:\s]*(\S+)/i)?.[1] || '';
          const pcn = text.match(/Rx\s*PCN[:\s]*(\S+)/i)?.[1] || '';
          const group = text.match(/Rx\s*Group[:\s]*(\S+)/i)?.[1] || '';
          return { bin, pcn, group };
        }
      }
      return null;
    })();

    if (rxFront) {
      const rxParts = [rxFront.bin, rxFront.pcn, rxFront.group].filter(Boolean).join(' / ');
      pass.auxiliaryFields.push({ key: 'rx', label: 'Rx BIN / PCN / GROUP', value: rxParts });
    } else {
      // No Rx info — show phone number instead
      const footer = idCardData.Card_Front?.Footer;
      const phoneText = footer?.Text2 || '';
      const phoneLabelText = footer?.Text1 || footer?.Header || 'CALL';
      if (phoneText) {
        const digits = phoneText.replace(/\D/g, '');
        const phoneField = { key: 'phone', label: phoneLabelText, value: phoneText };
        if (digits.length >= 7) {
          phoneField.attributedValue = `<a href="tel:${digits}">${phoneText}</a>`;
        }
        pass.auxiliaryFields.push(phoneField);
      }
    }
    const footer = idCardData.Card_Front?.Footer;

    // Back of card — Rx info FIRST (most needed at pharmacy)
    // Extract Rx info from card back (usually Middle section)
    const rxText = (() => {
      const back = idCardData.Card_Back;
      if (!back) return null;
      for (const section of ['Middle', 'Top_Left', 'Top_Right', 'Bottom_Left', 'Bottom_Right']) {
        const text = back[section]?.Text1 || '';
        if (/Rx\s*BIN/i.test(text) || /Rx\s*PCN/i.test(text)) {
          const bin = text.match(/Rx\s*BIN[:\s]*(\S+)/i)?.[1] || '';
          const pcn = text.match(/Rx\s*PCN[:\s]*(\S+)/i)?.[1] || '';
          const group = text.match(/Rx\s*Group[:\s]*(\S+)/i)?.[1] || '';
          const helpDesk = text.match(/Help\s*Desk[:\s]*([\d\-\(\)\s]+)/i)?.[1]?.trim() || '';
          const coverage = text.match(/Coverage[:\s]*(.+)/i)?.[1]?.trim() || '';
          const lines = [];
          if (bin) lines.push(`Rx BIN: ${bin}`);
          if (pcn) lines.push(`Rx PCN: ${pcn}`);
          if (group) lines.push(`Rx Group: ${group}`);
          if (helpDesk) lines.push(`Help Desk: ${helpDesk}`);
          if (coverage) lines.push(`Coverage: ${coverage}`);
          return lines.join('\n');
        }
      }
      return null;
    })();

    if (rxText) {
      pass.backFields.push({ key: 'rxInfo', label: 'Prescription (Rx) Information', value: rxText });
    }

    // Member Details
    const frontDetails = [
      `Member: ${memberName}`,
      `Member ID: ${displayMemberId}`,
      dob ? `Date of Birth: ${dob}` : null,
      `Plan: ${enrollment.ProductName}`,
      `Effective Date: ${formatDate(enrollment.EffectiveDate)}`,
    ].filter(Boolean).join('\n');

    pass.backFields.push({ key: 'memberDetails', label: 'Member Details', value: frontDetails });

    // Household / Dependents
    if (dependentsText) {
      pass.backFields.push({ key: 'household', label: 'Household Members', value: dependentsText });
    }

    // Card Back sections from IDCardData
    pass.backFields.push({
      key: 'cardBack',
      label: 'Card Information',
      value: buildBackContent(idCardData),
    });

    // Footer contact info
    if (footer?.Header || footer?.Text1 || footer?.Text2) {
      const footerLines = [footer?.Header, footer?.Text1, footer?.Text2].filter(Boolean).join('\n');
      pass.backFields.push({ key: 'contact', label: 'Contact', value: footerLines });
    }

    // Images + Rx strip
    const axios = require('axios');
    const sharp = require('sharp');

    // Use the IDCardData header image as the main logo (matches allaboard platform)
    const idCardHeaderImage = (idCardData.Card_Front?.Header?.Image || '').trim();
    const brandLogoUrl = idCardHeaderImage.startsWith('http') ? idCardHeaderImage : (enrollment.ProductLogoUrl || enrollment.ProductImageUrl);

    // Find network logo from back quadrants (PHCS, etc.) — skip the brand logo
    const allImageUrls = [
      idCardData.Card_Back?.Top_Left?.Image,
      idCardData.Card_Back?.Top_Right?.Image,
      idCardData.Card_Back?.Bottom_Left?.Image,
      idCardData.Card_Back?.Bottom_Right?.Image,
    ];
    const networkLogoUrl = (() => {
      for (const url of allImageUrls) {
        const trimmed = (url || '').trim();
        if (trimmed && trimmed.startsWith('http') && trimmed !== brandLogoUrl) return trimmed;
      }
      return '';
    })();

    async function downloadImage(url) {
      if (!url || !url.startsWith('http')) return null;
      try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
        return Buffer.from(r.data);
      } catch { return null; }
    }

    try {
      const brandLogoBuf = await downloadImage(brandLogoUrl);
      const networkLogoBuf = await downloadImage(networkLogoUrl);

      // Brand logo → logo.png (top-left, matches allaboard platform)
      if (brandLogoBuf) {
        const logo = await sharp(brandLogoBuf).resize({ width: 320, height: 100, fit: 'inside' }).png().toBuffer();
        pass.addBuffer('logo.png', logo);
        pass.addBuffer('logo@2x.png', logo);
      }

      // Network logo → thumbnail.png (top-right, 90x90pt @2x = 180x180)
      if (networkLogoBuf) {
        const thumb = await sharp(networkLogoBuf)
          .resize({ width: 180, height: 180, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .png()
          .toBuffer();
        pass.addBuffer('thumbnail.png', thumb);
        pass.addBuffer('thumbnail@2x.png', thumb);
      }

      // Note: strip.png and thumbnail.png are mutually exclusive on generic passes.
      // We use thumbnail for network logo (PHCS), so Rx info goes on the back instead.
    } catch (imgErr) {
      console.warn('⚠️ Image processing failed:', imgErr.message);
    }

    const buf = pass.getAsBuffer();

    console.log('🎫 .pkpass generated:', { brand, member: memberName, bytes: buf.length });

    // Store the pass temporarily in memory with a one-time download token
    const crypto = require('crypto');
    const downloadToken = crypto.randomBytes(32).toString('hex');
    passCache.set(downloadToken, { buf, brand, createdAt: Date.now() });

    // Clean up old entries (> 5 min)
    for (const [key, val] of passCache.entries()) {
      if (Date.now() - val.createdAt > 5 * 60 * 1000) passCache.delete(key);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const passUrl = `${baseUrl}/api/me/member/wallet/download/${downloadToken}`;

    res.json({
      success: true,
      data: { passUrl },
    });
  } catch (err) {
    console.error('❌ Wallet pass error:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to generate wallet pass',
      code: 'WALLET_PASS_ERROR',
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
  }
});

// Public download router (mounted WITHOUT auth in app.js)
const walletDownloadRouter = express.Router();
walletDownloadRouter.get('/download/:token', (req, res) => {
  const entry = passCache.get(req.params.token);
  if (!entry) {
    return res.status(404).json({ success: false, message: 'Pass expired or not found' });
  }
  passCache.delete(req.params.token);

  res.set({
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Disposition': `attachment; filename="${entry.brand}-idcard.pkpass"`,
    'Content-Length': entry.buf.length,
  });
  res.send(entry.buf);
});

module.exports = router;
module.exports.walletDownloadRouter = walletDownloadRouter;
