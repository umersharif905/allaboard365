import type { CSSProperties } from 'react';

export type IdCardHeaderImagePlacement = 'Center' | 'Left' | 'Right';

export const ID_CARD_HEADER_IMAGE_PLACEMENTS: IdCardHeaderImagePlacement[] = [
  'Center',
  'Left',
  'Right',
];

/** Missing or unknown values default to Center (legacy cards). */
export function normalizeHeaderImagePlacement(raw: unknown): IdCardHeaderImagePlacement {
  const v = String(raw ?? '').trim();
  if (v === 'Left' || v === 'Right') return v;
  return 'Center';
}

export const cardFrontHeaderImageStyle: CSSProperties = {
  maxHeight: '50px',
  maxWidth: '100%',
  width: 'auto',
  height: 'auto',
  objectFit: 'contain',
  flexShrink: 0,
};

export const cardFrontHeaderTextStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: '#111',
  lineHeight: 1.35,
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-line',
};

export function cardFrontHeaderSideTextStyle(
  placement: IdCardHeaderImagePlacement
): CSSProperties {
  return {
    ...cardFrontHeaderTextStyle,
    flex: 1,
    minWidth: 0,
    textAlign: placement === 'Left' ? 'right' : 'left',
  };
}

/** Outer banner for the card front header (image + optional text). */
export function getCardFrontHeaderZoneStyle(
  placement: IdCardHeaderImagePlacement,
  hasImage: boolean,
  hasText: boolean
): CSSProperties {
  const sideBySide = hasImage && hasText && placement !== 'Center';

  if (sideBySide) {
    return {
      padding: '16px 20px',
      borderBottom: '1px solid black',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: '12px',
    };
  }

  if (hasImage && !hasText && placement !== 'Center') {
    return {
      padding: '20px',
      borderBottom: '1px solid black',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: placement === 'Left' ? 'flex-start' : 'flex-end',
    };
  }

  return {
    padding: '20px',
    borderBottom: '1px solid black',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: hasImage && hasText ? '8px' : undefined,
    textAlign: 'center',
  };
}

/** @deprecated Use getCardFrontHeaderZoneStyle */
export function getHeaderImageContainerStyle(
  placement: IdCardHeaderImagePlacement
): CSSProperties {
  return getCardFrontHeaderZoneStyle(placement, true, false);
}

export type CardFrontHeaderBlock = 'image' | 'text';

/** Order of blocks in the header banner for a given placement. */
export function getCardFrontHeaderBlockOrder(
  placement: IdCardHeaderImagePlacement,
  hasImage: boolean,
  hasText: boolean
): CardFrontHeaderBlock[] {
  if (hasImage && hasText) {
    if (placement === 'Right') return ['text', 'image'];
    return ['image', 'text'];
  }
  if (hasText) return ['text'];
  return ['image'];
}
