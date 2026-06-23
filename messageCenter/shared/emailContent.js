/**
 * Strip <!-- METADATA:{...}--> prefix from queue body; parse replyTo / from overrides.
 */
function stripEmailMetadataPrefix(rawBody) {
  let body = (rawBody || '').trimStart();
  const metadata = { replyToEmail: null, fromName: null, fromEmail: null, listUnsubscribeUrl: null };
  const metadataPrefix = '<!-- METADATA:';
  const metadataEnd = ' -->';
  const startIdx = body.indexOf(metadataPrefix);
  if (startIdx !== -1 && startIdx < 500) {
    const jsonStart = startIdx + metadataPrefix.length;
    const endIdx = body.indexOf(metadataEnd, jsonStart);
    if (endIdx !== -1) {
      try {
        const jsonStr = body.slice(jsonStart, endIdx).trim();
        const md = JSON.parse(jsonStr);
        metadata.replyToEmail = md.replyToEmail || null;
        metadata.fromName = md.fromName || null;
        metadata.fromEmail = md.fromEmail || null;
        metadata.listUnsubscribeUrl = md.listUnsubscribeUrl || null;
        const stripEnd = endIdx + metadataEnd.length;
        body = (body.slice(0, startIdx) + body.slice(stripEnd)).replace(/^\s*\n+/, '').trimStart();
      } catch (e) {
        /* keep body */
      }
    }
  }
  return { body, metadata };
}

/**
 * Build HTML/text and reply-to for SendGrid from queue body (same rules as MessageProcessor).
 */
function buildEmailHtmlParts(body, context) {
  const stripped = stripEmailMetadataPrefix(body);
  let rawBody = stripped.body;
  const metaFromQueue = stripped.metadata;

  let emailText = '';
  let emailHtml = '';

  if (rawBody.includes('<!-- HTML VERSION -->')) {
    const htmlMarkerIndex = rawBody.indexOf('<!-- HTML VERSION -->');
    const htmlStartIndex = htmlMarkerIndex + '<!-- HTML VERSION -->'.length;
    const textPart = rawBody.substring(0, htmlMarkerIndex)
      .replace(/<!-- TEXT VERSION -->/g, '')
      .trim();
    emailText = textPart;
    emailHtml = rawBody.substring(htmlStartIndex).trim();
    if (!emailHtml || (!emailHtml.includes('<!DOCTYPE') && !emailHtml.includes('<html') && !emailHtml.includes('<HTML') && !emailHtml.includes('<'))) {
      if (context && context.log) {
        context.log('WARNING: Extracted content after HTML VERSION marker may not be HTML');
      }
    }
  } else if (rawBody.includes('<!DOCTYPE') || rawBody.includes('<html') || rawBody.includes('<HTML') || rawBody.includes('<p>') || rawBody.includes('<div>')) {
    emailHtml = rawBody.trim();
    emailText = '';
  } else {
    emailText = rawBody;
    emailHtml = rawBody.replace(/\n/g, '<br>');
  }

  if (!emailHtml || emailHtml.trim().length === 0) {
    emailHtml = emailText.replace(/\n/g, '<br>');
  }
  if (!emailHtml.includes('<') && emailText) {
    emailHtml = emailText.replace(/\n/g, '<br>');
  }

  emailHtml = emailHtml.replace(/<!-- METADATA:\s*\{[\s\S]*?\}\s*-->\s*\n?/g, '').trim();

  let replyToParam = null;
  const replyToEmail = metaFromQueue.replyToEmail || null;
  if (replyToEmail && typeof replyToEmail === 'string') {
    const trimmed = replyToEmail.trim();
    const angleMatch = trimmed.match(/\s*<([^>]+)>$/);
    if (angleMatch) {
      const email = angleMatch[1].trim();
      const namePart = trimmed.slice(0, trimmed.indexOf('<')).trim();
      if (email && email.includes('@')) {
        replyToParam = namePart ? { email, name: namePart } : { email };
      }
    } else if (trimmed.includes('@')) {
      replyToParam = { email: trimmed };
    }
  }

  let listUnsubscribeHeaders = null;
  const lu = metaFromQueue.listUnsubscribeUrl;
  if (lu && typeof lu === 'string' && lu.startsWith('http')) {
    listUnsubscribeHeaders = {
      'List-Unsubscribe': `<${lu}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    };
  }

  return { emailText, emailHtml, replyToParam, metaFromQueue, listUnsubscribeHeaders };
}

module.exports = {
  stripEmailMetadataPrefix,
  buildEmailHtmlParts
};
