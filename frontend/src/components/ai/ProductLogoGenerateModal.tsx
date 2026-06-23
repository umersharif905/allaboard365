import { Loader2, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiService } from '../../services/api.service';

export interface ProductLogoGenerateContext {
  productName?: string;
  productType?: string;
  description?: string;
}

interface ProductLogoGenerateModalProps {
  open: boolean;
  onClose: () => void;
  context: ProductLogoGenerateContext;
  onApply: (file: File) => void;
}

function base64ToFile(base64: string, filename: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], filename, { type: mimeType });
}

export default function ProductLogoGenerateModal({
  open,
  onClose,
  context,
  onApply,
}: ProductLogoGenerateModalProps) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [generatedFile, setGeneratedFile] = useState<File | null>(null);
  const initForOpenRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);

  const revokePreviewUrl = useCallback(() => {
    if (previewUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = null;
    setPreviewUrl(null);
  }, []);

  const resetGenerated = useCallback(() => {
    revokePreviewUrl();
    setGeneratedFile(null);
    setError(null);
  }, [revokePreviewUrl]);

  const resetAll = useCallback(() => {
    resetGenerated();
    setPrompt('');
    setGenerating(false);
    setCheckingStatus(false);
    initForOpenRef.current = false;
  }, [resetGenerated]);

  useEffect(() => {
    if (!open) {
      resetAll();
      return;
    }

    if (initForOpenRef.current) return;
    initForOpenRef.current = true;

    const defaultPrompt = context.productName?.trim()
      ? `Professional logo icon for "${context.productName.trim()}"`
      : 'Professional logo icon for a healthcare or benefits product';
    setPrompt(defaultPrompt);

    setCheckingStatus(true);
    apiService
      .get<{ success: boolean; available: boolean }>('/api/ai/generate-product-logo/status')
      .then((res) => setAiAvailable(Boolean(res.available)))
      .catch(() => setAiAvailable(false))
      .finally(() => setCheckingStatus(false));
  }, [open, context.productName, resetAll]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Enter a prompt describing the logo you want.');
      return;
    }

    setGenerating(true);
    setError(null);
    resetGenerated();

    try {
      const result = await apiService.post<{
        success: boolean;
        imageBase64?: string;
        filename?: string;
        mimeType?: string;
        message?: string;
      }>(
        '/api/ai/generate-product-logo',
        {
          prompt: prompt.trim(),
          productName: context.productName || '',
          productType: context.productType || '',
          description: context.description || '',
        },
        { timeout: 120000 }
      );

      if (!result.success || !result.imageBase64) {
        throw new Error(result.message || 'Failed to generate logo');
      }

      const mimeType = result.mimeType || 'image/png';
      const filename = result.filename || 'ai-generated-logo.png';
      const file = base64ToFile(result.imageBase64, filename, mimeType);
      const blobUrl = URL.createObjectURL(file);

      previewUrlRef.current = blobUrl;
      setPreviewUrl(blobUrl);
      setGeneratedFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate logo. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = () => {
    if (!generatedFile) return;
    onApply(generatedFile);
    onClose();
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black bg-opacity-50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !generating) onClose();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="logo-ai-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
          <div className="flex items-center gap-2 text-white">
            <Sparkles className="w-5 h-5" />
            <h3 id="logo-ai-title" className="text-lg font-semibold">
              Generate Logo with AI
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="text-white hover:bg-white hover:bg-opacity-20 p-1.5 rounded-lg transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {checkingStatus ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking AI availability…
            </div>
          ) : !aiAvailable ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              AI image generation is not available right now. Upload an image instead.
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Describe the logo you want. We&apos;ll keep designs simple and professional. The image is applied to
                the wizard only — save the product when you&apos;re ready to upload it.
              </p>

              <div>
                <label htmlFor="logo-ai-prompt" className="form-label">
                  Prompt
                </label>
                <textarea
                  id="logo-ai-prompt"
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={generating}
                  placeholder="e.g. Minimal shield icon with a heart, blue and teal colors"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                />
              </div>

              {generating && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  Generating image… this can take up to a minute.
                </div>
              )}

              {previewUrl && !generating && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <p className="text-xs text-gray-500 mb-2">Generated preview</p>
                  <div className="w-full h-48 flex items-center justify-center bg-white rounded-lg overflow-hidden border border-gray-100">
                    <img
                      src={previewUrl}
                      alt="Generated logo preview"
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            disabled={generating}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          {aiAvailable && !checkingStatus && (
            <>
              {generatedFile ? (
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={generating || !prompt.trim()}
                  className="btn-secondary text-sm disabled:opacity-50"
                >
                  Regenerate
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => (generatedFile ? handleApply() : void handleGenerate())}
                disabled={generating || !prompt.trim()}
                className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating…
                  </>
                ) : generatedFile ? (
                  'Apply'
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
