import React, { useMemo } from 'react';

const BRAND_FG = '#1f3a5f';

type Props = {
  score: number;
  total: number;
  /** Radial ticks along the arc (default 31). */
  tickCount?: number;
};

/**
 * Semi-circular score gauge with gradient-filled ticks (magenta → green) and grey remainder.
 * Center shows percentage and “out of 100”.
 */
const QuizCompletionScoreGauge: React.FC<Props> = ({ score, total, tickCount = 31 }) => {
  const percent = total > 0 ? Math.round((score / total) * 100) : 0;
  const fillRatio = Math.min(100, Math.max(0, percent)) / 100;

  const gauge = useMemo(() => {
    const w = 280;
    const h = 152;
    const cx = w / 2;
    const cy = h - 10;
    const outerR = 108;
    const innerR = outerR - 22;
    const n = Math.max(2, tickCount);

    const ticks: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = [];

    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const theta = Math.PI * (1 - t);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const x1 = cx + innerR * cos;
      const y1 = cy - innerR * sin;
      const x2 = cx + outerR * cos;
      const y2 = cy - outerR * sin;

      const isFilled = t <= fillRatio + 0.0001;
      const hue = 300 - 180 * t;
      const color = isFilled ? `hsl(${hue}, 88%, 52%)` : '#d4d4d8';

      ticks.push({ x1, y1, x2, y2, color });
    }

    const labelY = cy - 10;

    return { ticks, viewBox: `0 0 ${w} ${h}`, cx, labelY, percent };
  }, [fillRatio, tickCount]);

  return (
    <div className="flex flex-col items-center">
      <svg
        className="mx-auto block w-full max-w-[280px]"
        viewBox={gauge.viewBox}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={`Score ${gauge.percent}%`}
      >
        {gauge.ticks.map((tick, i) => (
          <line
            key={i}
            x1={tick.x1}
            y1={tick.y1}
            x2={tick.x2}
            y2={tick.y2}
            stroke={tick.color}
            strokeWidth={2.25}
            strokeLinecap="round"
          />
        ))}

        <text
          x={gauge.cx}
          y={gauge.labelY}
          textAnchor="middle"
          fill={BRAND_FG}
          style={{
            fontSize: '38px',
            fontWeight: 700,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif'
          }}
        >
          {gauge.percent}%
        </text>
      </svg>

      <p className="mt-3 text-center text-sm font-semibold text-slate-700">
        {score} of {total} question{total === 1 ? '' : 's'} correct
      </p>
    </div>
  );
};

export default QuizCompletionScoreGauge;
