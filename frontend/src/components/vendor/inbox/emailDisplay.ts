// Trim quoted history (and our own signature) out of an email body for the
// chat-style bubble view. The thread already shows the conversation as separate
// bubbles, so quoting each message inside the body is redundant + messy.
//
// - Our OUTBOUND messages carry a `data-aab-msg` marker around the new content
//   (added by the backend composeBody), so we extract exactly that — reliable.
// - INBOUND messages are trimmed heuristically: find the first quoted-history
//   container (Gmail/Apple/Outlook patterns) and drop it + everything after.
// The full original is always one toggle away, so nothing is truly hidden.

export interface TrimmedEmail {
  html: string;
  truncated: boolean; // something (quote/signature) was hidden
}

const QUOTE_SELECTOR = 'blockquote, .gmail_quote, #appendonsend, #divRplyFwdMsg, [id^="divRplyFwdMsg"]';

function looksLikeWroteLine(el: Element): boolean {
  const t = (el.textContent || '').trim();
  if (!t || t.length > 200) return false;
  return /^On .+ wrote:$/i.test(t)
    || /^-{2,}\s*Original Message\s*-{2,}/i.test(t)
    || /^_{5,}$/.test(t); // Outlook underscore divider
}

/** Remove `start`, all its following siblings, and the following siblings of each
 *  ancestor up to <body> — i.e. everything from `start` onward in document order,
 *  keeping everything before it. */
function removeFromHere(start: Element, body: HTMLElement): void {
  let node: Node | null = start;
  while (node && node !== body) {
    const parent: Node | null = node.parentNode;
    let sib: Node | null = node.nextSibling;
    while (sib) { const next = sib.nextSibling; parent?.removeChild(sib); sib = next; }
    node = parent;
  }
  start.parentNode?.removeChild(start);
}

export function trimEmailHtml(
  html: string | null | undefined,
  direction: 'inbound' | 'outbound',
): TrimmedEmail {
  if (!html) return { html: '', truncated: false };
  let doc: Document;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); }
  catch { return { html, truncated: false }; }
  const body = doc.body;
  if (!body) return { html, truncated: false };

  // Our own outbound: extract the marked new message (drops signature + quote).
  if (direction === 'outbound') {
    const marked = body.querySelector('[data-aab-msg]') as HTMLElement | null;
    if (marked) {
      const inner = marked.innerHTML.trim();
      return { html: inner, truncated: inner.trim() !== body.innerHTML.trim() };
    }
  }

  // Heuristic: cut at the first quoted-history container.
  const quote = body.querySelector(QUOTE_SELECTOR);
  if (quote) {
    const prev = quote.previousElementSibling;
    if (prev && looksLikeWroteLine(prev)) prev.remove();
    removeFromHere(quote, body);
    return { html: body.innerHTML.trim(), truncated: true };
  }

  // Fallback: cut at a top-level "On … wrote:" / "Original Message" line.
  let removing = false, cut = false;
  for (const el of Array.from(body.children)) {
    if (!removing && looksLikeWroteLine(el)) removing = true;
    if (removing) { el.remove(); cut = true; }
  }
  return { html: body.innerHTML.trim(), truncated: cut };
}
