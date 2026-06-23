// Builds the front+back ID-card PDF as base64 from the rendered IDCard DOM.
// Shared between SendIDCardModal (email) and SendIDCardSmsModal (text-with-link).
//
// Why this is fiddly: the card logo is an Azure blob <img> served without CORS
// headers. It displays in the browser, but html2canvas (allowTaint:false)
// cannot draw a cross-origin image onto its canvas, so it silently disappears
// from the captured PDF. We therefore proxy every external image through the
// backend, inline it as a data URL, and pin both the data URL AND an explicit
// pixel size onto the *cloned* nodes inside html2canvas's onclone hook. The
// onclone step is what makes this deterministic: it is immune to React
// re-renders reverting an imperatively-set src, and it stops html2canvas from
// collapsing the auto-sized (width/height:auto, object-fit:contain) logo to
// zero — a well-known html2canvas 1.4.1 bug.

import { API_CONFIG } from '../../../config/api';
import { tokenManager } from '../../../services/tokenManager';

const FIXED_CARD_WIDTH_PX = 340;
const LOGO_ALT = 'Company Logo';

// The image-proxy must hit the API host, not the SPA origin. In production the
// frontend (allaboard365.com) and API (api.allaboard365.com) are different
// hosts; a bare "/api/..." path would resolve to the SPA and return index.html,
// leaving the logo blank in the captured PDF.
const imageProxyUrl = (absoluteSrc: string): string => {
  const base = (API_CONFIG.BASE_URL || '').replace(/\/+$/, '');
  return `${base}/api/uploads/image-proxy?url=${encodeURIComponent(absoluteSrc)}`;
};

const isHttpImage = (src: string) => {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
  try {
    const parsed = new URL(src, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string) || '');
    reader.onerror = () => reject(new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch one external image through the proxy and return a data URL, or a
// human-readable reason it failed (so a blank logo becomes a real error
// instead of a silently-sent empty card).
const fetchAsDataUrl = async (
  absoluteSrc: string,
  authToken: string | null,
): Promise<{ dataUrl: string } | { error: string }> => {
  try {
    // /api/uploads/image-proxy sits behind authenticateMiddleware (uploads are
    // auth-only to prevent anonymous abuse). A bare fetch() does NOT get the
    // axios Bearer interceptor, so the JWT must be attached explicitly or the
    // proxy 401s and the logo silently never embeds. credentials:'omit'
    // because auth is the Bearer header, not a cookie.
    const resp = await fetch(imageProxyUrl(absoluteSrc), {
      method: 'GET',
      credentials: 'omit',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    });
    if (!resp.ok) return { error: `proxy responded ${resp.status}` };
    const blob = await resp.blob();
    // Guard against non-image responses (e.g. an SPA index.html fallback)
    // so we never inline broken/HTML "images" into the card.
    if (blob.type && !blob.type.startsWith('image/')) {
      return { error: `proxy returned non-image content (${blob.type})` };
    }
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return { error: 'proxy returned unreadable image data' };
    }
    return { dataUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'network error' };
  }
};

const renderSideToCanvas = async (
  enrollmentId: string,
  side: 'front' | 'back',
): Promise<HTMLCanvasElement | null> => {
  const container = document.querySelector(
    `[data-id-card-enrollment="${enrollmentId}"]`,
  ) as HTMLElement | null;
  if (!container) return null;
  const cardElement = container.querySelector(
    `[data-id-card-side="${side}"]`,
  ) as HTMLElement | null;
  if (!cardElement) return null;

  const wrapper = cardElement.parentElement as HTMLElement | null;
  const originalCardStyle = {
    display: cardElement.style.display,
    visibility: cardElement.style.visibility,
    position: cardElement.style.position,
    left: cardElement.style.left,
    top: cardElement.style.top,
    zIndex: cardElement.style.zIndex,
    opacity: cardElement.style.opacity,
    pointerEvents: cardElement.style.pointerEvents,
    width: cardElement.style.width,
    minWidth: cardElement.style.minWidth,
    maxWidth: cardElement.style.maxWidth,
  };
  const originalWrapperStyle = wrapper
    ? {
        display: wrapper.style.display,
        visibility: wrapper.style.visibility,
        position: wrapper.style.position,
        left: wrapper.style.left,
        top: wrapper.style.top,
      }
    : null;

  const images = Array.from(cardElement.querySelectorAll('img')) as HTMLImageElement[];
  const originalImageSrc = new Map<HTMLImageElement, string>();
  // Per-image capture data, indexed the same as `images` (clone preserves order).
  const dataUrlByIndex = new Array<string | null>(images.length).fill(null);
  const sizeByIndex = new Array<{ w: number; h: number } | null>(images.length).fill(null);

  try {
    if (wrapper) {
      wrapper.style.display = 'block';
      wrapper.style.visibility = 'visible';
      wrapper.style.position = 'relative';
      wrapper.style.left = 'auto';
      wrapper.style.top = 'auto';
    }
    cardElement.style.display = 'block';
    cardElement.style.visibility = 'visible';
    cardElement.style.position = 'relative';
    cardElement.style.left = '0px';
    cardElement.style.top = '0px';
    cardElement.style.zIndex = '9999';
    cardElement.style.opacity = '1';
    cardElement.style.pointerEvents = 'none';
    cardElement.style.width = `${FIXED_CARD_WIDTH_PX}px`;
    cardElement.style.minWidth = `${FIXED_CARD_WIDTH_PX}px`;
    cardElement.style.maxWidth = `${FIXED_CARD_WIDTH_PX}px`;

    await wait(50);

    // Resolve the JWT once (handles refresh) and reuse for every image so
    // concurrent fetches don't each trigger a token refresh.
    const authToken = await tokenManager.getAccessToken().catch(() => null);

    await Promise.all(
      images.map(async (img, index) => {
        const originalSrc = img.getAttribute('src') || '';
        originalImageSrc.set(img, originalSrc);
        if (!originalSrc) return;
        const absoluteSrc = new URL(originalSrc, window.location.origin).toString();

        if (isHttpImage(absoluteSrc)) {
          const result = await fetchAsDataUrl(absoluteSrc, authToken);
          if ('dataUrl' in result) {
            dataUrlByIndex[index] = result.dataUrl;
            // Mirror onto the live element too: keeps the on-screen card and
            // the html2canvas fallback path consistent.
            img.src = result.dataUrl;
            if (typeof img.decode === 'function') {
              try {
                await img.decode();
              } catch {
                /* ignore */
              }
            }
          } else {
            const isLogo = (img.getAttribute('alt') || '') === LOGO_ALT;
            console.warn(
              `[id-card-pdf] ${isLogo ? 'LOGO' : 'image'} could not be embedded (${absoluteSrc}): ${result.error}`,
            );
          }
        }

        // Measure the rendered box once the (possibly swapped) image is laid
        // out, so html2canvas draws it at a definite size instead of
        // collapsing the auto-sized logo to zero.
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          sizeByIndex[index] = {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          };
        }
      }),
    );

    // If the FRONT logo specifically could not be embedded, fail loudly rather
    // than silently emailing a card with an empty logo box.
    const logoIndex = images.findIndex(
      (img) => (img.getAttribute('alt') || '') === LOGO_ALT,
    );
    if (side === 'front' && logoIndex !== -1) {
      const logoSrc = originalImageSrc.get(images[logoIndex]) || '';
      const logoIsExternal = isHttpImage(
        new URL(logoSrc || ' ', window.location.origin).toString(),
      );
      if (logoSrc && logoIsExternal && !dataUrlByIndex[logoIndex]) {
        throw new Error(
          'The ID card logo could not be loaded for the email (image proxy failed). ' +
            'The email was not sent. Please check the product logo URL / image proxy and try again.',
        );
      }
    }

    await wait(120);

    const html2canvasModule = await import('html2canvas');
    const html2canvas = html2canvasModule.default;
    const canvas = await html2canvas(cardElement, {
      backgroundColor: '#ffffff',
      scale: 2,
      logging: false,
      useCORS: true,
      allowTaint: false,
      imageTimeout: 15000,
      removeContainer: false,
      width: FIXED_CARD_WIDTH_PX,
      windowWidth: FIXED_CARD_WIDTH_PX,
      onclone: (_clonedDoc, clonedRef) => {
        // Authoritative fix: operate on the nodes html2canvas will actually
        // rasterize. Pin the inlined data URL and an explicit pixel size so
        // neither cross-origin taint nor auto-size collapse can drop the logo.
        const clonedImgs = Array.from(
          clonedRef.querySelectorAll('img'),
        ) as HTMLImageElement[];
        clonedImgs.forEach((clonedImg, index) => {
          const dataUrl = dataUrlByIndex[index];
          if (dataUrl) {
            clonedImg.removeAttribute('crossorigin');
            clonedImg.removeAttribute('loading');
            clonedImg.src = dataUrl;
          }
          const size = sizeByIndex[index];
          if (size) {
            clonedImg.style.width = `${size.w}px`;
            clonedImg.style.height = `${size.h}px`;
            clonedImg.style.maxWidth = 'none';
            clonedImg.style.maxHeight = 'none';
            clonedImg.style.minWidth = '0';
            clonedImg.style.minHeight = '0';
            clonedImg.style.objectFit = 'contain';
            clonedImg.style.display = 'block';
          }
        });
      },
    });
    return canvas;
  } finally {
    images.forEach((img) => {
      const src = originalImageSrc.get(img);
      if (src != null) img.src = src;
    });
    cardElement.style.display = originalCardStyle.display;
    cardElement.style.visibility = originalCardStyle.visibility;
    cardElement.style.position = originalCardStyle.position;
    cardElement.style.left = originalCardStyle.left;
    cardElement.style.top = originalCardStyle.top;
    cardElement.style.zIndex = originalCardStyle.zIndex;
    cardElement.style.opacity = originalCardStyle.opacity;
    cardElement.style.pointerEvents = originalCardStyle.pointerEvents;
    cardElement.style.width = originalCardStyle.width;
    cardElement.style.minWidth = originalCardStyle.minWidth;
    cardElement.style.maxWidth = originalCardStyle.maxWidth;
    if (wrapper && originalWrapperStyle) {
      wrapper.style.display = originalWrapperStyle.display;
      wrapper.style.visibility = originalWrapperStyle.visibility;
      wrapper.style.position = originalWrapperStyle.position;
      wrapper.style.left = originalWrapperStyle.left;
      wrapper.style.top = originalWrapperStyle.top;
    }
  }
};

export const buildIDCardPdfBase64 = async (
  enrollmentId: string,
  productName: string,
): Promise<{ pdfBase64: string; fileName: string }> => {
  const { default: jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const renderCanvasOntoPage = (canvas: HTMLCanvasElement, isFirst: boolean) => {
    if (!isFirst) pdf.addPage();
    const imgData = canvas.toDataURL('image/png');
    const targetWidth = Math.min(pageWidth - 80, 380);
    const ratio = canvas.height / canvas.width;
    const targetHeight = targetWidth * ratio;
    const x = (pageWidth - targetWidth) / 2;
    const y = Math.max(60, (pageHeight - targetHeight) / 2);
    pdf.addImage(imgData, 'PNG', x, y, targetWidth, targetHeight);
  };

  const front = await renderSideToCanvas(enrollmentId, 'front');
  if (!front) throw new Error('Could not capture the front of the ID card.');
  renderCanvasOntoPage(front, true);

  const back = await renderSideToCanvas(enrollmentId, 'back');
  if (back) renderCanvasOntoPage(back, false);

  const dataUri = pdf.output('datauristring');
  const base64 = dataUri.split(',')[1] || dataUri;
  const safe = productName.replace(/[^\w\-]+/g, '_') || 'id-card';
  return { pdfBase64: base64, fileName: `${safe}-id-card.pdf` };
};
