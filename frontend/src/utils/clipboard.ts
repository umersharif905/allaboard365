/**
 * Best-effort clipboard write. Tries `navigator.clipboard.writeText()`
 * first; falls back to a hidden-textarea + `document.execCommand('copy')`
 * trick when the modern API fails or isn't available (common when the
 * write happens after an async `await` and the user-activation window
 * has closed, or when the page isn't on HTTPS).
 *
 * Returns `true` on success, `false` on failure. Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-10000px';
  ta.style.left = '-10000px';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  try {
    ta.select();
    const ok = document.execCommand('copy');
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
