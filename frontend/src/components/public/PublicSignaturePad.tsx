import { useEffect, useRef } from 'react';

type Props = {
  id: string;
  value: string;
  onChange: (dataUrl: string) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Captures a PNG data URL for HIPAA-style form signatures. Audit metadata is added server-side on submit.
 */
export function PublicSignaturePad({ id, value, onChange, disabled, className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const drawLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const emitChange = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(canvas.toDataURL('image/png'));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = getPos(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || !drawing.current || !last.current) return;
    const pos = getPos(e);
    drawLine(last.current, pos);
    last.current = pos;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current) {
      drawing.current = false;
      last.current = null;
      emitChange();
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    if (value !== '') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [value]);

  return (
    <div className={className}>
      <canvas
        id={id}
        width={600}
        height={180}
        className={`w-full max-w-full touch-none rounded border border-gray-300 bg-white ${
          disabled ? 'opacity-50 pointer-events-none' : 'cursor-crosshair'
        }`}
        style={{ height: 'clamp(7rem, 28vw, 11rem)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        ref={canvasRef}
      />
      {!disabled ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={clear}
            className="text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 px-3 py-1.5 rounded"
          >
            Clear signature
          </button>
        </div>
      ) : null}
    </div>
  );
}
