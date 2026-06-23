const ua = navigator.userAgent;

export const isIOS = /iPad|iPhone|iPod/.test(ua);
export const isAndroid = /Android/.test(ua);
export const isMobile = isIOS || isAndroid || /Mobi/.test(ua);
