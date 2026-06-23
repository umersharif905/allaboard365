import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import './ColumbusWidget.css';

interface ColumbusFabProps {
  onClick: () => void;
  isOnline: boolean | null;
  isOpen: boolean;
  isMinimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
}

export default function ColumbusFab({
  onClick,
  isOnline,
  isOpen,
  isMinimized,
  onMinimize,
  onRestore,
}: ColumbusFabProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen || isMinimized) {
      setShowTooltip(false);
      return;
    }
    const timer = setTimeout(() => {
      if (!isOpen && !isMinimized) setShowTooltip(true);
    }, 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isOpen || isMinimized) setShowTooltip(false);
  }, [isOpen, isMinimized]);

  useEffect(() => {
    if (!showTooltip) return;
    const timer = setTimeout(() => setShowTooltip(false), 8000);
    return () => clearTimeout(timer);
  }, [showTooltip]);

  if (!mounted) return null;

  const handleClick = () => {
    setShowTooltip(false);
    onClick();
  };

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowTooltip(false);
    onMinimize();
  };

  const fabClasses = [
    'columbus-fab',
    isOpen ? 'columbus-fab--active' : '',
    isMinimized ? 'columbus-fab--minimized' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div className="columbus-widget">
      {showTooltip && !isOpen && !isMinimized && (
        <div className="columbus-tooltip">
          <span>Have questions? Ask Columbus!</span>
          <button
            className="columbus-tooltip__close"
            onClick={() => setShowTooltip(false)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <button
        className={fabClasses}
        onClick={handleClick}
        aria-label={isOpen ? 'Close Columbus chat' : 'Open Columbus chat'}
        style={isOnline === false ? { borderColor: '#9ca3af' } : undefined}
      >
        <img
          src="/images/columbus.webp"
          alt="Columbus"
          className="columbus-fab__avatar"
        />
        {isOnline !== false && <span className="columbus-fab__pulse" />}
      </button>

      {!isOpen && !isMinimized && (
        <button
          type="button"
          className="columbus-fab__close"
          onClick={handleMinimize}
          aria-label="Hide Columbus"
          title="Hide Columbus"
        >
          ×
        </button>
      )}

      <button
        type="button"
        className={`columbus-peek-tab ${isMinimized ? 'columbus-peek-tab--visible' : ''}`}
        onClick={onRestore}
        aria-label="Show Columbus"
        title="Show Columbus"
        aria-hidden={!isMinimized}
        tabIndex={isMinimized ? 0 : -1}
      >
        <ChevronLeft className="columbus-peek-tab__icon" aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
