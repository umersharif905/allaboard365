import { RefreshCw } from 'lucide-react';
import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ColumbusTrainingCalloutHandle = {
  resetTurtleScene: () => void;
  animateTurtleOut: () => void;
};

type Props = {
  message?: string;
  buttonLabel?: string;
  showButton?: boolean;
  onButtonClick?: () => void;
  onDismiss?: () => void;
  className?: string;
  /** When true, shows the tuning panel ("Columbus Callout Controls"). Default false. */
  showDevControls?: boolean;
  /** When false, this component does not render its own backdrop blur (parent provides blur). Default true. */
  renderBackdropBlur?: boolean;
  /** Increment to run: wait `introPreDelayMs`, reset scene, then turtle slide-in. Skipped if a sequence is already running. */
  introPlayToken?: number;
  introPreDelayMs?: number;
  /** Faint replay control at bottom-right of the callout stack (e.g. agent training prompt). */
  showReplayButton?: boolean;
};

const COLUMBUS_IMAGE_URL =
  'https://res.cloudinary.com/doi8qjcv6/image/upload/v1776087567/customers/mightywell/porthole-hi-pristine_w7nikx.webp';

/** Default bubble / image translation in SVG user units (restored on full scene reset, e.g. audio play intro). */
const DEFAULT_BUBBLE_TRANSLATE_X = 221;
const DEFAULT_BUBBLE_TRANSLATE_Y = 179;
const DEFAULT_IMAGE_TRANSLATE_X = 48;
const DEFAULT_IMAGE_TRANSLATE_Y = 94;

/** Matches prior hard-coded turtle animation timing. */
const TURTLE_EASE_IN_DEFAULT = 'cubic-bezier(0.34, 1.45, 0.64, 1)';

const TURTLE_EASE_OUT_DEFAULT = 'cubic-bezier(0.4, 0, 0.2, 1)';

type TurtleEasePresetKey =
  | 'default'
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'custom';

function turtleTimingFunction(
  preset: TurtleEasePresetKey,
  direction: 'in' | 'out',
  custom: readonly [number, number, number, number]
): string {
  if (preset === 'custom') {
    return `cubic-bezier(${custom[0]}, ${custom[1]}, ${custom[2]}, ${custom[3]})`;
  }
  if (preset === 'default') {
    return direction === 'in' ? TURTLE_EASE_IN_DEFAULT : TURTLE_EASE_OUT_DEFAULT;
  }
  return preset;
}

const ColumbusTrainingCallout = React.forwardRef<ColumbusTrainingCalloutHandle, Props>(function ColumbusTrainingCallout(
  {
    message = "Don't forget to complete your agent training!",
    buttonLabel = 'Ok',
    showButton = false,
    onButtonClick,
    onDismiss,
    className = '',
    showDevControls = false,
    renderBackdropBlur = true,
    introPlayToken = 0,
    introPreDelayMs = 400,
    showReplayButton = false
  },
  ref
) {
  const [sizePercent, setSizePercent] = useState<number>(52);
  const [tailOffsetFromRight, setTailOffsetFromRight] = useState<number>(201);
  const [fontScale, setFontScale] = useState<number>(0.71);
  const [bubbleWidthPercent, setBubbleWidthPercent] = useState<number>(78);
  const [bubbleHeightPercent, setBubbleHeightPercent] = useState<number>(76);
  const [bubbleTranslateX, setBubbleTranslateX] = useState<number>(DEFAULT_BUBBLE_TRANSLATE_X);
  const [bubbleTranslateY, setBubbleTranslateY] = useState<number>(DEFAULT_BUBBLE_TRANSLATE_Y);
  const [imageTranslateX, setImageTranslateX] = useState<number>(DEFAULT_IMAGE_TRANSLATE_X);
  const [imageTranslateY, setImageTranslateY] = useState<number>(DEFAULT_IMAGE_TRANSLATE_Y);
  const [imageScale, setImageScale] = useState<number>(1);
  const [rightOffset, setRightOffset] = useState<number>(16);
  const [bottomOffset, setBottomOffset] = useState<number>(16);
  const [blurRestOfApp, setBlurRestOfApp] = useState<boolean>(false);
  /** CSS backdrop-filter blur radius in px (Tailwind `backdrop-blur-md` = 12px). */
  const [backdropBlurPx, setBackdropBlurPx] = useState<number>(2);
  /** Start in reset pose (off-screen turtle, hidden bubble) to avoid mount flash before intro / dev controls. */
  const [turtleAtOut, setTurtleAtOut] = useState<boolean>(true);
  const [turtleAnimationMode, setTurtleAnimationMode] = useState<'none' | 'in' | 'out'>('none');
  const [turtleAnimationCycle, setTurtleAnimationCycle] = useState<number>(0);
  const [bubbleOpacity, setBubbleOpacity] = useState<number>(0);
  const [bubbleFadeActive, setBubbleFadeActive] = useState<boolean>(false);
  const [bubbleFadeCycle, setBubbleFadeCycle] = useState<number>(0);
  const [bubbleExitActive, setBubbleExitActive] = useState<boolean>(false);
  const [bubbleExitCycle, setBubbleExitCycle] = useState<number>(0);
  const [controlsMinimized, setControlsMinimized] = useState<boolean>(false);
  const [turtleEaseInPreset, setTurtleEaseInPreset] = useState<TurtleEasePresetKey>('default');
  const [turtleEaseOutPreset, setTurtleEaseOutPreset] = useState<TurtleEasePresetKey>('default');
  const [turtleEaseInCustom, setTurtleEaseInCustom] = useState<[number, number, number, number]>([
    0.34, 1.45, 0.64, 1
  ]);
  const [turtleEaseOutCustom, setTurtleEaseOutCustom] = useState<[number, number, number, number]>([
    0.4, 0, 0.2, 1
  ]);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(false);
  const [portalReady, setPortalReady] = useState<boolean>(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const bubbleFadeCompleteTimeoutRef = useRef<number | null>(null);
  const bubbleExitCompleteTimeoutRef = useRef<number | null>(null);
  const turtleOutCompleteTimeoutRef = useRef<number | null>(null);
  const introStartTimeoutRef = useRef<number | null>(null);
  const TURTLE_ANIMATION_MS = 680;
  const BUBBLE_FADE_DELAY_MS = Math.round(TURTLE_ANIMATION_MS * 0.38);
  const BUBBLE_FADE_MS = 280;
  const BUBBLE_EXIT_MS = 360;

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setPrefersReducedMotion(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    return () => {
      if (bubbleFadeCompleteTimeoutRef.current) {
        window.clearTimeout(bubbleFadeCompleteTimeoutRef.current);
      }
      if (bubbleExitCompleteTimeoutRef.current) {
        window.clearTimeout(bubbleExitCompleteTimeoutRef.current);
      }
      if (turtleOutCompleteTimeoutRef.current) {
        window.clearTimeout(turtleOutCompleteTimeoutRef.current);
      }
      if (introStartTimeoutRef.current) {
        window.clearTimeout(introStartTimeoutRef.current);
      }
    };
  }, []);
  const bubbleDragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const bubbleOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const imageDragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const imageOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const words = message.trim().split(/\s+/);

  const perLine = Math.max(3, Math.ceil(words.length / 2));

  const lineOne = words.slice(0, perLine).join(' ');

  const lineTwo = words.slice(perLine).join(' ');

  const fontSize = Math.round(54 * fontScale);
  const lineGap = Math.round(fontSize * 1.2);
  const signatureFontSize = Math.max(18, Math.round(fontSize * 0.72));
  const signatureGap = Math.round(signatureFontSize * 1.25);
  const componentWidthPx = Math.round(980 * (sizePercent / 100));

  const bubbleLeft = 20;
  const bubbleTop = 64;
  const baseBubbleRight = 730;
  const baseBubbleWidth = baseBubbleRight - bubbleLeft;
  const baseBubbleBottom = 364;
  const baseBubbleHeight = baseBubbleBottom - bubbleTop;
  const bubbleWidth = Math.round(baseBubbleWidth * (bubbleWidthPercent / 100));
  const bubbleHeight = Math.round(baseBubbleHeight * (bubbleHeightPercent / 100));
  const bubbleRight = bubbleLeft + bubbleWidth;
  const bubbleBottom = bubbleTop + bubbleHeight;
  const textX = Math.round(bubbleLeft + bubbleWidth * 0.48);
  const textCenterY = Math.round(bubbleTop + bubbleHeight * 0.5);
  const textTopMarginPx = 3;
  const firstLineY = Math.round(textCenterY - (lineGap + signatureGap) / 2) + textTopMarginPx;
  const secondLineY = firstLineY + lineGap;
  const signatureY = secondLineY + signatureGap;
  const tailTipY = bubbleBottom + 88;
  const imageBaseRight = 950;
  const imageBaseBottom = 622;
  const imageSize = Math.round(300 * imageScale);
  const imageX = imageBaseRight - imageSize;
  const imageY = imageBaseBottom - imageSize;

  const turtleBaseTransform = turtleAtOut ? 'translateX(110vw)' : 'translateX(0)';

  const turtleEaseInFn = useMemo(
    () => turtleTimingFunction(turtleEaseInPreset, 'in', turtleEaseInCustom),
    [turtleEaseInCustom, turtleEaseInPreset]
  );

  const turtleEaseOutFn = useMemo(
    () => turtleTimingFunction(turtleEaseOutPreset, 'out', turtleEaseOutCustom),
    [turtleEaseOutCustom, turtleEaseOutPreset]
  );

  const cancelPendingIntroSequence = (): void => {
    if (introStartTimeoutRef.current) {
      window.clearTimeout(introStartTimeoutRef.current);
      introStartTimeoutRef.current = null;
    }
    if (introReleaseTimeoutRef.current) {
      window.clearTimeout(introReleaseTimeoutRef.current);
      introReleaseTimeoutRef.current = null;
    }
    introSequencePlayingRef.current = false;
  };

  const resetTurtleScene = (): void => {
    cancelPendingIntroSequence();
    if (bubbleFadeCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleFadeCompleteTimeoutRef.current);
      bubbleFadeCompleteTimeoutRef.current = null;
    }
    if (bubbleExitCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleExitCompleteTimeoutRef.current);
      bubbleExitCompleteTimeoutRef.current = null;
    }
    if (turtleOutCompleteTimeoutRef.current) {
      window.clearTimeout(turtleOutCompleteTimeoutRef.current);
      turtleOutCompleteTimeoutRef.current = null;
    }
    setBubbleFadeActive(false);
    setBubbleExitActive(false);
    setBubbleOpacity(0);
    setBubbleTranslateX(DEFAULT_BUBBLE_TRANSLATE_X);
    setBubbleTranslateY(DEFAULT_BUBBLE_TRANSLATE_Y);
    setImageTranslateX(DEFAULT_IMAGE_TRANSLATE_X);
    setImageTranslateY(DEFAULT_IMAGE_TRANSLATE_Y);
    setTurtleAtOut(true);
    /** Use 'none' so we do not run slide-out keyframes (they start at translateX(0) and flash on-screen). */
    setTurtleAnimationMode('none');
    setTurtleAnimationCycle(previous => previous + 1);
  };

  const animateTurtleIn = (): void => {
    if (bubbleFadeCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleFadeCompleteTimeoutRef.current);
      bubbleFadeCompleteTimeoutRef.current = null;
    }
    if (bubbleExitCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleExitCompleteTimeoutRef.current);
      bubbleExitCompleteTimeoutRef.current = null;
    }
    if (turtleOutCompleteTimeoutRef.current) {
      window.clearTimeout(turtleOutCompleteTimeoutRef.current);
      turtleOutCompleteTimeoutRef.current = null;
    }
    setBubbleExitActive(false);
    setBubbleOpacity(0);
    setBubbleFadeActive(true);
    setBubbleFadeCycle(previous => previous + 1);
    setTurtleAtOut(false);
    setTurtleAnimationMode('in');
    setTurtleAnimationCycle(previous => previous + 1);
    bubbleFadeCompleteTimeoutRef.current = window.setTimeout(() => {
      setBubbleFadeActive(false);
      setBubbleOpacity(1);
      bubbleFadeCompleteTimeoutRef.current = null;
    }, BUBBLE_FADE_DELAY_MS + BUBBLE_FADE_MS + 40);
  };

  const animateTurtleOut = (): void => {
    cancelPendingIntroSequence();
    if (prefersReducedMotion) {
      resetTurtleScene();
      return;
    }
    if (bubbleFadeCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleFadeCompleteTimeoutRef.current);
      bubbleFadeCompleteTimeoutRef.current = null;
    }
    if (bubbleExitCompleteTimeoutRef.current) {
      window.clearTimeout(bubbleExitCompleteTimeoutRef.current);
      bubbleExitCompleteTimeoutRef.current = null;
    }
    if (turtleOutCompleteTimeoutRef.current) {
      window.clearTimeout(turtleOutCompleteTimeoutRef.current);
      turtleOutCompleteTimeoutRef.current = null;
    }
    setBubbleFadeActive(false);
    setBubbleExitActive(true);
    setBubbleExitCycle(previous => previous + 1);
    bubbleExitCompleteTimeoutRef.current = window.setTimeout(() => {
      setBubbleExitActive(false);
      setBubbleOpacity(0);
      bubbleExitCompleteTimeoutRef.current = null;
    }, BUBBLE_EXIT_MS + 40);
    setTurtleAtOut(false);
    setTurtleAnimationMode('out');
    setTurtleAnimationCycle(previous => previous + 1);
    turtleOutCompleteTimeoutRef.current = window.setTimeout(() => {
      setTurtleAtOut(true);
      setTurtleAnimationMode('none');
      setTurtleAnimationCycle(previous => previous + 1);
      turtleOutCompleteTimeoutRef.current = null;
    }, TURTLE_ANIMATION_MS + 40);
  };

  const resetTurtleSceneRef = useRef(resetTurtleScene);
  resetTurtleSceneRef.current = resetTurtleScene;

  const animateTurtleInRef = useRef(animateTurtleIn);
  animateTurtleInRef.current = animateTurtleIn;

  const animateTurtleOutRef = useRef(animateTurtleOut);
  animateTurtleOutRef.current = animateTurtleOut;

  useImperativeHandle(
    ref,
    () => ({
      resetTurtleScene: () => {
        resetTurtleSceneRef.current();
      },
      animateTurtleOut: () => {
        animateTurtleOutRef.current();
      }
    }),
    []
  );

  const introSequencePlayingRef = useRef(false);
  const introReleaseTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!introPlayToken || introPlayToken < 1) {
      return;
    }
    if (introSequencePlayingRef.current) {
      return;
    }
    introSequencePlayingRef.current = true;
    const delayMs = Math.max(0, introPreDelayMs);
    const settleMs = TURTLE_ANIMATION_MS + BUBBLE_FADE_DELAY_MS + BUBBLE_FADE_MS + 120;

    introStartTimeoutRef.current = window.setTimeout(() => {
      resetTurtleSceneRef.current();
      window.requestAnimationFrame(() => {
        animateTurtleInRef.current();
      });
      if (introReleaseTimeoutRef.current) {
        window.clearTimeout(introReleaseTimeoutRef.current);
      }
      introReleaseTimeoutRef.current = window.setTimeout(() => {
        introSequencePlayingRef.current = false;
        introReleaseTimeoutRef.current = null;
      }, settleMs);
    }, delayMs);

    return () => {
      cancelPendingIntroSequence();
    };
  }, [introPlayToken, introPreDelayMs]);

  const getSvgPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }
    const matrix = svg.getScreenCTM();
    if (!matrix) {
      return null;
    }
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const startBubbleDrag = (event: React.MouseEvent<SVGGElement>): void => {
    event.preventDefault();
    const startPoint = getSvgPoint(event.clientX, event.clientY);
    if (!startPoint) {
      return;
    }
    bubbleDragStartRef.current = startPoint;
    bubbleOriginRef.current = { x: bubbleTranslateX, y: bubbleTranslateY };

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const movePoint = getSvgPoint(moveEvent.clientX, moveEvent.clientY);
      if (!movePoint) {
        return;
      }
      const deltaX = movePoint.x - bubbleDragStartRef.current.x;
      const deltaY = movePoint.y - bubbleDragStartRef.current.y;
      const nextX = Math.round(bubbleOriginRef.current.x + deltaX);
      const nextY = Math.round(bubbleOriginRef.current.y + deltaY);
      setBubbleTranslateX(nextX);
      setBubbleTranslateY(nextY);
    };

    const handleMouseUp = (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const IMAGE_DRAG_THRESHOLD_PX = 5;

  const startImageDrag = (event: React.MouseEvent<SVGImageElement>): void => {
    event.preventDefault();
    const startPoint = getSvgPoint(event.clientX, event.clientY);
    if (!startPoint) {
      return;
    }
    imageDragStartRef.current = startPoint;
    imageOriginRef.current = { x: imageTranslateX, y: imageTranslateY };
    let dragMovedBeyondThreshold = false;

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const movePoint = getSvgPoint(moveEvent.clientX, moveEvent.clientY);
      if (!movePoint) {
        return;
      }
      const deltaX = movePoint.x - imageDragStartRef.current.x;
      const deltaY = movePoint.y - imageDragStartRef.current.y;
      if (!dragMovedBeyondThreshold) {
        if (Math.hypot(deltaX, deltaY) <= IMAGE_DRAG_THRESHOLD_PX) {
          return;
        }
        dragMovedBeyondThreshold = true;
      }
      const nextX = Math.round(imageOriginRef.current.x + deltaX);
      const nextY = Math.round(imageOriginRef.current.y + deltaY);
      setImageTranslateX(nextX);
      setImageTranslateY(nextY);
    };

    const handleMouseUp = (): void => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (!dragMovedBeyondThreshold) {
        onDismiss?.();
        animateTurtleOut();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const bubblePath = useMemo(() => {
    const x0 = bubbleLeft;
    const y0 = bubbleTop;
    const x1 = bubbleRight;
    const y1 = bubbleBottom;
    const r = Math.min(
      32,
      Math.max(14, Math.round(Math.min(bubbleWidth, bubbleHeight) * 0.09))
    );
    const minTailX = bubbleLeft + 240;
    const maxTailX = bubbleRight - 12;
    const computedTailX = bubbleRight - tailOffsetFromRight;
    let tailRightX = Math.min(Math.max(computedTailX, minTailX), maxTailX);
    tailRightX = Math.min(tailRightX, x1 - r - 4);
    const tailTipX = Math.min(930, tailRightX + 180);
    let tailLeftX = tailRightX - 70;
    tailLeftX = Math.max(tailLeftX, x0 + r + 4);
    if (tailLeftX >= tailRightX - 8) {
      tailLeftX = tailRightX - 40;
    }

    return [
      `M ${x0 + r} ${y0}`,
      `L ${x1 - r} ${y0}`,
      `A ${r} ${r} 0 0 1 ${x1} ${y0 + r}`,
      `L ${x1} ${y1 - r}`,
      `A ${r} ${r} 0 0 1 ${x1 - r} ${y1}`,
      `L ${tailRightX} ${y1}`,
      `L ${tailTipX} ${tailTipY}`,
      `L ${tailLeftX} ${y1}`,
      `L ${x0 + r} ${y1}`,
      `A ${r} ${r} 0 0 1 ${x0} ${y1 - r}`,
      `L ${x0} ${y0 + r}`,
      `A ${r} ${r} 0 0 1 ${x0 + r} ${y0}`,
      'Z'
    ].join(' ');
  }, [bubbleBottom, bubbleLeft, bubbleRight, bubbleTop, bubbleWidth, bubbleHeight, tailOffsetFromRight, tailTipY]);

  const replayAnimation = (): void => {
    resetTurtleScene();
    window.requestAnimationFrame(() => {
      animateTurtleIn();
    });
  };

  const calloutUi = (
    <div
      className={`fixed z-[10000] pointer-events-none overflow-visible ${className}`}
      style={{ right: `${rightOffset}px`, bottom: `${bottomOffset}px` }}
    >
      <div className="relative pointer-events-none overflow-visible">
        <style>
          {`
            @keyframes columbusTurtleSlideOut {
              0% { transform: translateX(0); }
              100% { transform: translateX(110vw); }
            }

            @keyframes columbusTurtleSlideInBounce {
              0% { transform: translateX(110vw); }
              58% { transform: translateX(-18px); }
              72% { transform: translateX(8px); }
              84% { transform: translateX(-3px); }
              92% { transform: translateX(1px); }
              100% { transform: translateX(0); }
            }

            @keyframes columbusBubbleFadeIn {
              0% { opacity: 0; }
              100% { opacity: 1; }
            }

            @keyframes columbusBubbleSlideOut {
              0% { transform: translateX(0); }
              100% { transform: translateX(110vw); }
            }
          `}
        </style>

        <div className="pointer-events-auto absolute right-0 bottom-full mb-3 w-[min(820px,calc(100vw-8px))]">
          {showDevControls || false ? (
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-700">
                Columbus Callout Controls
              </p>
              <button
                type="button"
                onClick={() => setControlsMinimized(previous => !previous)}
                className="rounded border border-slate-400 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                {controlsMinimized ? 'Maximize' : 'Minimize'}
              </button>
            </div>

            {!controlsMinimized ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Component width ({sizePercent}%)</span>
                <input
                  type="range"
                  min={45}
                  max={100}
                  step={1}
                  value={sizePercent}
                  onChange={event => setSizePercent(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">
                  Tail offset from right ({tailOffsetFromRight}px)
                </span>
                <input
                  type="range"
                  min={0}
                  max={420}
                  step={1}
                  value={tailOffsetFromRight}
                  onChange={event => setTailOffsetFromRight(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Font scale ({fontScale.toFixed(2)}x)</span>
                <input
                  type="range"
                  min={0.6}
                  max={1.25}
                  step={0.01}
                  value={fontScale}
                  onChange={event => setFontScale(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Bubble width ({bubbleWidthPercent}%)</span>
                <input
                  type="range"
                  min={60}
                  max={100}
                  step={1}
                  value={bubbleWidthPercent}
                  onChange={event => setBubbleWidthPercent(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Bubble height ({bubbleHeightPercent}%)</span>
                <input
                  type="range"
                  min={70}
                  max={140}
                  step={1}
                  value={bubbleHeightPercent}
                  onChange={event => setBubbleHeightPercent(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Image scale ({imageScale.toFixed(2)}x)</span>
                <input
                  type="range"
                  min={0.6}
                  max={1.4}
                  step={0.01}
                  value={imageScale}
                  onChange={event => setImageScale(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Right offset ({rightOffset}px)</span>
                <input
                  type="range"
                  min={0}
                  max={240}
                  step={1}
                  value={rightOffset}
                  onChange={event => setRightOffset(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Bottom offset ({bottomOffset}px)</span>
                <input
                  type="range"
                  min={0}
                  max={240}
                  step={1}
                  value={bottomOffset}
                  onChange={event => setBottomOffset(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <div className="rounded border border-gray-300 bg-white px-2 py-2 text-xs text-gray-700">
                <p className="font-semibold uppercase tracking-wide text-[10px] text-gray-600">
                  Bubble Drag Offset
                </p>
                <p className="mt-1 tabular-nums">
                  X: {bubbleTranslateX}px | Y: {bubbleTranslateY}px
                </p>
              </div>

              <div className="rounded border border-gray-300 bg-white px-2 py-2 text-xs text-gray-700">
                <p className="font-semibold uppercase tracking-wide text-[10px] text-gray-600">
                  Image Drag Offset
                </p>
                <p className="mt-1 tabular-nums">
                  X: {imageTranslateX}px | Y: {imageTranslateY}px
                </p>
              </div>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Turtle ease — slide in</span>
                <select
                  value={turtleEaseInPreset}
                  onChange={event => setTurtleEaseInPreset(event.target.value as TurtleEasePresetKey)}
                  className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800"
                >
                  <option value="default">Default (bounce)</option>
                  <option value="linear">linear</option>
                  <option value="ease">ease</option>
                  <option value="ease-in">ease-in</option>
                  <option value="ease-out">ease-out</option>
                  <option value="ease-in-out">ease-in-out</option>
                  <option value="custom">Custom cubic-bezier</option>
                </select>
                <p className="mt-1 text-[10px] text-gray-500 tabular-nums break-all">{turtleEaseInFn}</p>
              </label>

              <label className="block min-w-0">
                <span className="text-xs font-medium text-gray-700">Turtle ease — slide out</span>
                <select
                  value={turtleEaseOutPreset}
                  onChange={event => setTurtleEaseOutPreset(event.target.value as TurtleEasePresetKey)}
                  className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800"
                >
                  <option value="default">Default (smooth)</option>
                  <option value="linear">linear</option>
                  <option value="ease">ease</option>
                  <option value="ease-in">ease-in</option>
                  <option value="ease-out">ease-out</option>
                  <option value="ease-in-out">ease-in-out</option>
                  <option value="custom">Custom cubic-bezier</option>
                </select>
                <p className="mt-1 text-[10px] text-gray-500 tabular-nums break-all">{turtleEaseOutFn}</p>
              </label>

              {turtleEaseInPreset === 'custom' ? (
                <div className="rounded border border-violet-200 bg-violet-50/80 p-2 sm:col-span-2 lg:col-span-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-900">
                    Custom ease — slide in (x1 y1 x2 y2)
                  </p>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {([0, 1, 2, 3] as const).map(index => (
                      <label key={`in-${index}`} className="block min-w-0 text-[10px] text-violet-950">
                        {['x1', 'y1', 'x2', 'y2'][index]}
                        <input
                          type="range"
                          min={index % 2 === 0 ? 0 : -1}
                          max={index % 2 === 0 ? 1 : 2.5}
                          step={0.01}
                          value={turtleEaseInCustom[index]}
                          onChange={event => {
                            const next = [...turtleEaseInCustom] as [number, number, number, number];
                            next[index] = Number(event.target.value);
                            setTurtleEaseInCustom(next);
                          }}
                          className="mt-0.5 w-full"
                        />
                        <span className="tabular-nums">{turtleEaseInCustom[index].toFixed(2)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {turtleEaseOutPreset === 'custom' ? (
                <div className="rounded border border-violet-200 bg-violet-50/80 p-2 sm:col-span-2 lg:col-span-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-900">
                    Custom ease — slide out (x1 y1 x2 y2)
                  </p>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {([0, 1, 2, 3] as const).map(index => (
                      <label key={`out-${index}`} className="block min-w-0 text-[10px] text-violet-950">
                        {['x1', 'y1', 'x2', 'y2'][index]}
                        <input
                          type="range"
                          min={index % 2 === 0 ? 0 : -1}
                          max={index % 2 === 0 ? 1 : 2.5}
                          step={0.01}
                          value={turtleEaseOutCustom[index]}
                          onChange={event => {
                            const next = [...turtleEaseOutCustom] as [number, number, number, number];
                            next[index] = Number(event.target.value);
                            setTurtleEaseOutCustom(next);
                          }}
                          className="mt-0.5 w-full"
                        />
                        <span className="tabular-nums">{turtleEaseOutCustom[index].toFixed(2)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              <label className="block min-w-0 sm:col-span-2 lg:col-span-2">
                <span className="text-xs font-medium text-gray-700">
                  Backdrop blur ({backdropBlurPx}px) — Tailwind &quot;md&quot; is 12px
                </span>
                <input
                  type="range"
                  min={0}
                  max={32}
                  step={1}
                  value={backdropBlurPx}
                  onChange={event => setBackdropBlurPx(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>

              <div className="sm:col-span-2 lg:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={resetTurtleScene}
                  className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 shadow-sm hover:bg-amber-100"
                >
                  Reset scene
                </button>
                <button
                  type="button"
                  onClick={animateTurtleIn}
                  className="rounded-md border border-emerald-500 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-950 shadow-sm hover:bg-emerald-100"
                >
                  Animate turtle
                </button>
                <button
                  type="button"
                  onClick={() => setBlurRestOfApp(previous => !previous)}
                  className="rounded-md border border-slate-400 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
                >
                  {blurRestOfApp ? 'Unblur app' : 'Blur rest of app'}
                </button>
              </div>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>

        <div
          className="pointer-events-none relative ml-auto overflow-visible"
          style={{ width: `min(${componentWidthPx}px, calc(100vw - 8px))` }}
        >
          <svg
            ref={svgRef}
            viewBox="0 0 980 700"
            role="img"
            aria-label={`Columbus reminder: ${message}`}
            className="w-full h-auto"
            style={{ overflow: 'visible', pointerEvents: 'none' }}
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <filter
                id="columbusCalloutShadow"
                filterUnits="objectBoundingBox"
                x="-25%"
                y="-25%"
                width="150%"
                height="150%"
              >
                <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#0F172A" floodOpacity="0.22" />
              </filter>
              <filter
                id="columbusImageShadow"
                filterUnits="objectBoundingBox"
                x="-25%"
                y="-25%"
                width="150%"
                height="150%"
              >
                <feDropShadow dx="0" dy="10" stdDeviation="9" floodColor="#0F172A" floodOpacity="0.30" />
              </filter>
            </defs>

            <g
              transform={`translate(${imageTranslateX} ${imageTranslateY})`}
              style={{ pointerEvents: 'none' }}
            >
              <g
                key={`turtle-motion-${turtleAnimationMode}-${turtleAnimationCycle}`}
                style={{
                  transform: turtleBaseTransform,
                  animation:
                    prefersReducedMotion || turtleAnimationMode === 'none'
                      ? 'none'
                      : turtleAnimationMode === 'in'
                        ? `columbusTurtleSlideInBounce ${TURTLE_ANIMATION_MS}ms ${turtleEaseInFn} forwards`
                        : `columbusTurtleSlideOut ${TURTLE_ANIMATION_MS}ms ${turtleEaseOutFn} forwards`,
                  transformBox: 'view-box',
                  transformOrigin: 'center center',
                  willChange: 'transform'
                }}
              >
                <image
                  onMouseDown={startImageDrag}
                  href={COLUMBUS_IMAGE_URL}
                  x={imageX}
                  y={imageY}
                  width={imageSize}
                  height={imageSize}
                  preserveAspectRatio="xMidYMid meet"
                  filter="url(#columbusImageShadow)"
                  style={{
                    cursor: 'grab',
                    pointerEvents:
                      turtleAtOut || turtleAnimationMode === 'out' ? 'none' : 'auto'
                  }}
                />
              </g>
            </g>

            <g
              key={`bubble-exit-${bubbleExitCycle}`}
              style={{
                transform: 'translateX(0)',
                animation: bubbleExitActive ? `columbusBubbleSlideOut ${BUBBLE_EXIT_MS}ms ease-in forwards` : 'none',
                transformBox: 'view-box',
                transformOrigin: 'center center',
                pointerEvents: 'none',
                willChange: bubbleExitActive ? 'transform' : undefined
              }}
            >
              <g
                onMouseDown={showDevControls ? startBubbleDrag : undefined}
                transform={`translate(${bubbleTranslateX} ${bubbleTranslateY})`}
                key={`bubble-fade-${bubbleFadeCycle}`}
                style={{
                  cursor: showDevControls && !bubbleExitActive ? 'grab' : 'default',
                  pointerEvents:
                    showDevControls &&
                    !bubbleExitActive &&
                    (bubbleFadeActive || bubbleOpacity > 0)
                      ? 'auto'
                      : 'none',
                  opacity: bubbleFadeActive ? 0 : bubbleOpacity,
                  animation: bubbleExitActive
                    ? 'none'
                    : bubbleFadeActive
                      ? `columbusBubbleFadeIn ${BUBBLE_FADE_MS}ms ease forwards`
                      : 'none',
                  animationDelay: bubbleExitActive
                    ? '0ms'
                    : bubbleFadeActive
                      ? `${BUBBLE_FADE_DELAY_MS}ms`
                      : '0ms',
                  willChange: bubbleExitActive ? undefined : bubbleFadeActive ? 'opacity' : undefined
                }}
              >
                <path
                  d={bubblePath}
                  fill="#F8FAFC"
                  stroke="#1E6A93"
                  strokeWidth="3"
                  filter="url(#columbusCalloutShadow)"
                />

                <text
                  x={textX}
                  y={firstLineY}
                  textAnchor="middle"
                  fontSize={fontSize}
                  fontWeight="500"
                  fill="#111827"
                  style={{ fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', userSelect: 'none' }}
                >
                  <tspan x={textX} dy="0">
                    "{lineOne}
                  </tspan>
                  <tspan x={textX} y={secondLineY}>
                    {lineTwo}"
                  </tspan>
                  <tspan
                    x={textX}
                    y={signatureY}
                    fontSize={signatureFontSize}
                    fontStyle="italic"
                    fill="#6B7280"
                    fontWeight="400"
                  >
                    - Columbus
                  </tspan>
                </text>
              </g>
            </g>
          </svg>

          {showButton ? (
            <button
              type="button"
              onClick={onButtonClick}
              className="pointer-events-auto absolute left-1/2 -translate-x-1/2 bottom-[72px] min-w-[112px] rounded-lg border border-[#0D4E74] bg-[#1E6A93] px-4 py-1.5 text-base font-medium text-white shadow hover:bg-[#165C80] focus:outline-none focus:ring-2 focus:ring-[#1E6A93]/50"
            >
              {buttonLabel}
            </button>
          ) : null}
        </div>
      </div>

      {showReplayButton ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            replayAnimation();
          }}
          className="pointer-events-auto absolute right-0 bottom-0 rounded-full border border-slate-400/35 bg-white/45 p-1.5 text-slate-500 opacity-45 shadow-sm hover:bg-white/70 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-slate-400/40"
          title="Replay animation"
          aria-label="Replay Columbus animation"
        >
          <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );

  if (!portalReady) {
    return null;
  }

  return createPortal(
    <>
      {renderBackdropBlur && blurRestOfApp ? (
        <div
          className="fixed inset-0 z-[9997] bg-slate-900/25"
          style={{
            pointerEvents: 'none',
            backdropFilter: backdropBlurPx > 0 ? `blur(${backdropBlurPx}px)` : 'none',
            WebkitBackdropFilter: backdropBlurPx > 0 ? `blur(${backdropBlurPx}px)` : 'none'
          }}
          aria-hidden
        />
      ) : null}
      {calloutUi}
    </>,
    document.body
  );
});

ColumbusTrainingCallout.displayName = 'ColumbusTrainingCallout';

export default ColumbusTrainingCallout;
