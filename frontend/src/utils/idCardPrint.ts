interface OpenIDCardPrintViewOptions {
  memberId?: string;
  enrollmentId?: string;
  productId?: string;
}

export const buildIDCardPrintUrl = ({ memberId, enrollmentId, productId }: OpenIDCardPrintViewOptions = {}) => {
  const pathname = enrollmentId ? `/print-id-cards/${encodeURIComponent(enrollmentId)}` : '/print-id-cards';
  const url = new URL(pathname, window.location.origin);

  if (memberId) {
    url.searchParams.set('memberId', memberId);
  }
  if (productId) {
    url.searchParams.set('productId', productId);
  }

  return url.toString();
};

export const openIDCardPrintView = (options: OpenIDCardPrintViewOptions = {}) => {
  const printUrl = buildIDCardPrintUrl(options);
  window.open(printUrl, '_blank', 'noopener,noreferrer');
};

