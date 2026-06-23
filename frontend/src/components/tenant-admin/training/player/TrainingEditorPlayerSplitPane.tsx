import React, { useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  leftPane: React.ReactNode;
  rightPane: React.ReactNode;
  initialLeftPercent?: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
};

const TrainingEditorPlayerSplitPane: React.FC<Props> = ({
  leftPane,
  rightPane,
  initialLeftPercent = 52,
  minLeftPercent = 35,
  maxLeftPercent = 70
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftPercent, setLeftPercent] = useState(initialLeftPercent);
  const [isDragging, setIsDragging] = useState(false);
  const [splitEnabled, setSplitEnabled] = useState(
    typeof window === 'undefined' ? true : window.innerWidth >= 1280
  );

  useEffect(() => {
    const onResize = () => {
      setSplitEnabled(window.innerWidth >= 1280);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      if (!containerRef.current) {
        return;
      }
      const bounds = containerRef.current.getBoundingClientRect();
      const rawPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
      const clampedPercent = Math.min(maxLeftPercent, Math.max(minLeftPercent, rawPercent));
      setLeftPercent(clampedPercent);
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging, maxLeftPercent, minLeftPercent]);

  const templateColumns = useMemo(
    () => `${leftPercent}% 10px ${100 - leftPercent}%`,
    [leftPercent]
  );

  if (!splitEnabled) {
    return <div className="space-y-4">{leftPane}{rightPane}</div>;
  }

  return (
    <div
      ref={containerRef}
      className="grid min-h-[880px] items-stretch rounded-lg"
      style={{
        gridTemplateColumns: templateColumns,
        userSelect: isDragging ? 'none' : 'auto'
      }}
    >
      <div className="min-w-0 pr-2">{leftPane}</div>

      <button
        type="button"
        aria-label="Resize editor and player panels"
        onMouseDown={() => setIsDragging(true)}
        className={`h-full w-full rounded bg-gradient-to-b ${
          isDragging ? 'from-blue-400 to-blue-500' : 'from-gray-300 to-gray-400'
        } cursor-col-resize border border-gray-400`}
      />

      <div className="min-w-0 pl-2">{rightPane}</div>
    </div>
  );
};

export default TrainingEditorPlayerSplitPane;
