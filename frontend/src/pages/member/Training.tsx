import {
  BookOpen,
  CheckCircle,
  ChevronRight,
  ExternalLink,
  Loader2,
  XCircle
} from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { apiService } from '../../services/api.service';

interface MemberTrainingProduct {
  ProductId: string;
  Name: string;
  ProductType?: string;
  Description?: string;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  memberTraining: {
    modulesCount: number;
    questionsCount: number;
  };
  lastCompletion: { attemptNumber: number; scorePercent: number; completedAt: string } | null;
}

interface TrainingModule {
  id: string;
  type: 'video' | 'image' | 'text' | 'link';
  title: string;
  order: number;
  url?: string;
  text?: string;
  label?: string;
}

interface TrainingQuestion {
  id: string;
  question: string;
  fieldType: string;
  options?: { key: string; label: string }[];
  correctResponseKey: string;
}

interface MemberTrainingConfig {
  modules: TrainingModule[];
  questions: TrainingQuestion[];
  passingScorePercent?: number;
}

export default function MemberTraining() {
  const [products, setProducts] = useState<MemberTrainingProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [config, setConfig] = useState<{ Name: string; memberTraining: MemberTrainingConfig } | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ scorePercent: number; passed: boolean; attemptNumber: number } | null>(null);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<{ success: boolean; data?: MemberTrainingProduct[] }>('/api/me/member/training/products');
      if (res?.success && Array.isArray(res.data)) {
        setProducts(res.data);
      } else {
        setProducts([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load training products');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const openProduct = async (productId: string) => {
    setSelectedProductId(productId);
    setConfig(null);
    setResult(null);
    setAnswers({});
    setConfigLoading(true);
    try {
      const res = await apiService.get<{ success: boolean; data?: { Name: string; memberTraining: MemberTrainingConfig } }>(
        `/api/me/member/training/products/${productId}`
      );
      if (res?.success && res.data) {
        setConfig(res.data);
      } else {
        setConfig(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load training');
      setConfig(null);
    } finally {
      setConfigLoading(false);
    }
  };

  const closeProduct = () => {
    setSelectedProductId(null);
    setConfig(null);
    setResult(null);
    setAnswers({});
    fetchProducts();
  };

  const submitCompletion = async () => {
    if (!selectedProductId || !config?.memberTraining?.questions?.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const answersPayload = config.memberTraining.questions.map(q => ({
        questionId: q.id,
        chosenKey: answers[q.id] ?? ''
      }));
      const res = await apiService.post<{ success: boolean; data?: { scorePercent: number; passed: boolean; attemptNumber: number } }>(
        `/api/me/member/training/products/${selectedProductId}/complete`,
        { answers: answersPayload }
      );
      if (res?.success && res.data) {
        setResult(res.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const sortedModules = config?.memberTraining?.modules ? [...config.memberTraining.modules].sort((a, b) => a.order - b.order) : [];
  const questions = config?.memberTraining?.questions || [];
  const allAnswered = questions.length > 0 && questions.every(q => answers[q.id] != null && answers[q.id] !== '');

  if (selectedProductId && (config || configLoading)) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Training: {config?.Name || 'Loading…'}</h1>
          <button
            type="button"
            onClick={closeProduct}
            className="text-gray-600 hover:text-gray-900 flex items-center gap-1"
          >
            <XCircle className="h-5 w-5" /> Back to list
          </button>
        </div>
        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg">
            {error}
          </div>
        )}
        {configLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          </div>
        ) : result ? (
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Result</h2>
            <p className="text-gray-700">
              Score: <strong>{result.scorePercent}%</strong> — {result.passed ? (
                <span className="text-green-700 flex items-center gap-1"><CheckCircle className="h-5 w-5" /> Passed</span>
              ) : (
                <span className="text-amber-700">Not passed. You may retry.</span>
              )}
            </p>
            <p className="text-sm text-gray-500 mt-2">Attempt #{result.attemptNumber}</p>
            <button type="button" onClick={closeProduct} className="mt-4 btn-primary">
              Back to training list
            </button>
          </div>
        ) : config ? (
          <div className="space-y-8">
            {sortedModules.map(mod => (
              <div key={mod.id} className="bg-white rounded-lg border border-gray-200 p-4">
                {mod.title && <h3 className="font-medium text-gray-900 mb-2">{mod.title}</h3>}
                {mod.type === 'video' && mod.url && (
                  <video src={mod.url} controls className="w-full max-h-96 rounded" />
                )}
                {mod.type === 'image' && mod.url && (
                  <img src={mod.url} alt={mod.title} className="max-w-full rounded" />
                )}
                {mod.type === 'text' && <div className="prose text-gray-700 whitespace-pre-wrap">{mod.text}</div>}
                {mod.type === 'link' && mod.url && (
                  <a href={mod.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 flex items-center gap-1">
                    {mod.label || mod.url} <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))}
            {questions.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Questions</h3>
                <ul className="space-y-4">
                  {questions.map(q => (
                    <li key={q.id}>
                      <p className="font-medium text-gray-800 mb-2">{q.question}</p>
                      <div className="flex flex-col gap-2">
                        {(q.options || []).map(opt => (
                          <label key={opt.key} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name={q.id}
                              checked={answers[q.id] === opt.key}
                              onChange={() => setAnswers(prev => ({ ...prev, [q.id]: opt.key }))}
                              className="text-blue-600 border-gray-300"
                            />
                            <span>{opt.label}</span>
                          </label>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={submitCompletion}
                  disabled={submitting || !allAnswered}
                  className="mt-6 btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Submit answers
                </button>
              </div>
            )}
            {questions.length === 0 && (
              <p className="text-gray-500">No questions configured for this training.</p>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <BookOpen className="h-7 w-7" />
          Product Training
        </h1>
        <p className="text-gray-600 mt-1">
          View and complete training for products you are enrolled in.
        </p>
      </div>
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      ) : products.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No training available for your enrolled products right now.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
          {products.map(p => (
            <li key={p.ProductId}>
              <button
                type="button"
                onClick={() => openProduct(p.ProductId)}
                className="w-full text-left bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 hover:shadow flex items-center justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900 truncate">{p.Name}</span>
                    {p.lastCompletion && (
                      <span className="text-xs px-2 py-0.5 bg-green-100 text-green-800 rounded flex items-center gap-1">
                        <CheckCircle className="h-3 w-3" /> {p.lastCompletion.scorePercent}%
                      </span>
                    )}
                  </div>
                  {p.ProductType && <p className="text-sm text-gray-500 mt-0.5">{p.ProductType}</p>}
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400 flex-shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
