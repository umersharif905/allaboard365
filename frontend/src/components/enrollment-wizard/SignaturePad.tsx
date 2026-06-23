import { CheckCircle, RotateCcw, XCircle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

interface SignaturePadProps {
  onSignatureChange: (signature: string | null) => void;
  isRequired?: boolean;
  label?: string;
  placeholder?: string;
}

const SignaturePad: React.FC<SignaturePadProps> = ({
  onSignatureChange,
  isRequired = true,
  label = 'Digital Signature',
  placeholder = 'Click and drag to sign, or type your name below'
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [typedSignature, setTypedSignature] = useState('');
  const [useTypedSignature, setUseTypedSignature] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const setupCanvas = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Set canvas size to match display size
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      
      // Scale the context to match device pixel ratio
      ctx.scale(dpr, dpr);
      
      // Set canvas display size
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';

      // Set drawing style
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    };

    // Setup canvas initially
    setupCanvas();

    // Handle window resize
    const handleResize = () => {
      setupCanvas();
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (useTypedSignature) return;
    
    e.preventDefault();
    setIsDrawing(true);
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    let x, y;
    
    if (e.type === 'touchstart') {
      const touch = (e as React.TouchEvent).touches[0];
      x = touch.clientX - rect.left;
      y = touch.clientY - rect.top;
    } else {
      const mouse = e as React.MouseEvent;
      x = mouse.clientX - rect.left;
      y = mouse.clientY - rect.top;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || useTypedSignature) return;

    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    let x, y;
    
    if (e.type === 'touchmove') {
      const touch = (e as React.TouchEvent).touches[0];
      x = touch.clientX - rect.left;
      y = touch.clientY - rect.top;
    } else {
      const mouse = e as React.MouseEvent;
      x = mouse.clientX - rect.left;
      y = mouse.clientY - rect.top;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Check if there's actually a signature
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hasData = imageData.data.some(channel => channel !== 0);
    
    if (hasData) {
      setHasSignature(true);
      onSignatureChange(canvas.toDataURL());
    } else {
      setHasSignature(false);
      onSignatureChange(null);
    }
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    onSignatureChange(null);
  };

  const handleTypedSignatureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTypedSignature(value);
    
    if (value.trim()) {
      setHasSignature(true);
      onSignatureChange(value);
    } else {
      setHasSignature(false);
      onSignatureChange(null);
    }
  };



  const isValid = !isRequired || hasSignature;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">
          {label} {isRequired && <span className="text-red-500">*</span>}
        </label>
        
        <div className="flex items-center space-x-2">
          {/* Signature Type Toggle - Much clearer */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setUseTypedSignature(false)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                !useTypedSignature
                  ? 'bg-white text-oe-primary-dark shadow-sm border border-gray-200'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              ✏️ Draw Signature
            </button>
            <button
              type="button"
              onClick={() => setUseTypedSignature(true)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                useTypedSignature
                  ? 'bg-white text-oe-primary-dark shadow-sm border border-gray-200'
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              ⌨️ Type Name
            </button>
          </div>
          
          {hasSignature && (
            <button
              type="button"
              onClick={clearSignature}
              className="flex items-center space-x-1 px-2 py-1 text-gray-400 hover:text-gray-600 transition-colors"
              title="Clear signature"
            >
              <RotateCcw className="h-4 w-4" />
              <span className="text-xs">Undo</span>
            </button>
          )}
        </div>
      </div>

      {useTypedSignature ? (
        <div className="space-y-2">
          <div className="flex items-center space-x-2 mb-2">
            <span className="text-xs font-medium text-oe-primary bg-blue-50 px-2 py-1 rounded-full">⌨️ Typing Mode</span>
          </div>
          <input
            type="text"
            value={typedSignature}
            onChange={handleTypedSignatureChange}
            placeholder="Type your full name as your signature"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          />
          <p className="text-xs text-gray-500">
            Type your full name exactly as it appears on your legal documents
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center space-x-2 mb-2">
            <span className="text-xs font-medium text-oe-primary bg-blue-50 px-2 py-1 rounded-full">✏️ Drawing Mode</span>
          </div>
          <div 
            className="border-2 border-gray-300 rounded-lg overflow-hidden"
            style={{ 
              userSelect: 'none',
              WebkitUserSelect: 'none',
              MozUserSelect: 'none',
              msUserSelect: 'none'
            }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              className="w-full h-32 cursor-crosshair bg-white"
              style={{ 
                touchAction: 'none',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                MozUserSelect: 'none',
                msUserSelect: 'none'
              }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {placeholder}
          </p>
        </div>
      )}

      {/* Validation Status */}
      <div className="flex items-center space-x-2">
        {isValid ? (
          <div className="flex items-center text-green-600">
            <CheckCircle className="h-4 w-4 mr-1" />
            <span className="text-sm">Signature provided</span>
          </div>
        ) : (
          <div className="flex items-center text-red-600">
            <XCircle className="h-4 w-4 mr-1" />
            <span className="text-sm">Signature required</span>
          </div>
        )}
      </div>


    </div>
  );
};

export default SignaturePad;
