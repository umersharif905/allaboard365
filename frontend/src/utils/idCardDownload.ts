export type IDCardSide = 'front' | 'back';

interface DownloadIDCardImageOptions {
  enrollmentId: string;
  side: IDCardSide;
  fileNameBase: string;
}

const FIXED_CARD_WIDTH_PX = 340;

const isHttpImage = (src: string) => {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
  try {
    const parsed = new URL(src, window.location.origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return true;
  } catch {
    return false;
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string) || '');
    reader.onerror = () => reject(new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });

export const downloadIDCardImage = async ({ enrollmentId, side, fileNameBase }: DownloadIDCardImageOptions) => {
  const cardContainer = document.querySelector(`[data-id-card-enrollment="${enrollmentId}"]`) as HTMLElement | null;
  if (!cardContainer) {
    throw new Error('Card element not found. Please try again.');
  }

  const cardElement = cardContainer.querySelector(`[data-id-card-side="${side}"]`) as HTMLElement | null;
  if (!cardElement) {
    throw new Error('Card side not found. Please try again.');
  }

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

    const imagePromises = images.map((img) => {
      const originalSrc = img.getAttribute('src') || '';
      originalImageSrc.set(img, originalSrc);

      return new Promise<void>((resolve) => {
        if (!originalSrc) {
          resolve();
          return;
        }

        const loadCurrentImg = () => {
          if (img.complete && img.naturalHeight !== 0) {
            resolve();
            return;
          }

          const timeout = window.setTimeout(() => resolve(), 5000);
          img.onload = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          img.onerror = () => {
            window.clearTimeout(timeout);
            resolve();
          };
        };

        const absoluteSrc = new URL(originalSrc, window.location.origin).toString();
        if (!isHttpImage(absoluteSrc)) {
          loadCurrentImg();
          return;
        }

        const proxiedUrl = `/api/uploads/image-proxy?url=${encodeURIComponent(absoluteSrc)}`;

        fetch(proxiedUrl, { method: 'GET', credentials: 'include' })
          .then(async (response) => {
            if (!response.ok) {
              loadCurrentImg();
              return;
            }

            const imageBlob = await response.blob();
            const dataUrl = await blobToDataUrl(imageBlob);
            if (!dataUrl) {
              loadCurrentImg();
              return;
            }

            img.src = dataUrl;

            if (typeof img.decode === 'function') {
              try {
                await img.decode();
                resolve();
                return;
              } catch {
                loadCurrentImg();
                return;
              }
            }

            loadCurrentImg();
          })
          .catch(() => loadCurrentImg());
      });
    });

    if (imagePromises.length > 0) {
      await Promise.all(imagePromises);
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
    });

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });

    if (!blob) {
      throw new Error('Failed to create ID card image.');
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${fileNameBase}-${side}.png`;
    link.href = objectUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  } finally {
    images.forEach((img) => {
      const src = originalImageSrc.get(img);
      if (src != null) {
        img.src = src;
      }
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
