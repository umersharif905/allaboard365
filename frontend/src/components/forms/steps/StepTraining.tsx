import {
  BookOpen,
  GripVertical,
  Image as ImageIcon,
  Link as LinkIcon,
  Plus,
  Trash2,
  Type,
  Video,
  Users,
  UserCircle
} from 'lucide-react';
import { useRef, useState } from 'react';
import { apiService } from '../../../services/api.service';
import type {
  AudienceTrainingConfig,
  StepProps,
  TrainingConfig,
  TrainingModule,
  TrainingQuestion
} from '../../../types/sysadmin/addproductswizard.types';

const defaultAudienceConfig = (): AudienceTrainingConfig => ({
  modules: [],
  questions: [],
  requiredForSell: false,
  passingScorePercent: 80
});

function getTrainingConfig(formData: { trainingConfig?: TrainingConfig }): TrainingConfig {
  return {
    agentTraining: formData.trainingConfig?.agentTraining ?? defaultAudienceConfig(),
    memberTraining: formData.trainingConfig?.memberTraining ?? defaultAudienceConfig()
  };
}

type AudienceKey = 'agentTraining' | 'memberTraining';

export default function StepTraining({ formData, updateFormData }: StepProps) {
  const config = getTrainingConfig(formData);
  const [activeTab, setActiveTab] = useState<AudienceKey>('agentTraining');
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingModuleId = useRef<string | null>(null);

  const updateConfig = (updates: Partial<TrainingConfig>) => {
    updateFormData({
      trainingConfig: { ...getTrainingConfig(formData), ...updates }
    });
  };

  const audience = config[activeTab]!;
  const isAgent = activeTab === 'agentTraining';

  const setAudience = (key: AudienceKey, value: AudienceTrainingConfig) => {
    updateConfig({ [key]: value });
  };

  const addModule = (type: TrainingModule['type']) => {
    const modules = [...audience.modules];
    const order = modules.length ? Math.max(...modules.map((m) => m.order), 0) + 1 : 1;
    const newModule: TrainingModule = {
      id: Date.now().toString(),
      type,
      title: '',
      order,
      url: '',
      text: '',
      label: ''
    };
    setAudience(activeTab, { ...audience, modules: [...modules, newModule] });
  };

  const updateModule = (moduleId: string, updates: Partial<TrainingModule>) => {
    const modules = audience.modules.map((m) =>
      m.id === moduleId ? { ...m, ...updates } : m
    );
    setAudience(activeTab, { ...audience, modules });
  };

  const removeModule = (moduleId: string) => {
    const modules = audience.modules.filter((m) => m.id !== moduleId);
    setAudience(activeTab, { ...audience, modules });
  };

  const reorderModule = (moduleId: string, direction: 'up' | 'down') => {
    const modules = [...audience.modules];
    const idx = modules.findIndex((m) => m.id === moduleId);
    if (idx < 0) return;
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= modules.length) return;
    [modules[idx]!.order, modules[swap]!.order] = [modules[swap]!.order, modules[idx]!.order];
    modules.sort((a, b) => a.order - b.order);
    setAudience(activeTab, { ...audience, modules });
  };

  const handleFileSelect = (moduleId: string, type: 'video' | 'image') => {
    pendingModuleId.current = moduleId;
    fileInputRef.current?.setAttribute('accept', type === 'video' ? 'video/*' : 'image/*');
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const moduleId = pendingModuleId.current;
    if (!file || !moduleId) return;
    e.target.value = '';
    pendingModuleId.current = null;
    setUploadingId(moduleId);
    try {
      const formDataUpload = new FormData();
      formDataUpload.append('files', file);
      formDataUpload.append('uploadType', 'training');
      const res = await apiService.post<{ success: boolean; data?: { url?: string }[] }>(
        '/api/uploads',
        formDataUpload,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      const url = res?.data?.[0]?.url;
      if (url) {
        updateModule(moduleId, { url, title: audience.modules.find((m) => m.id === moduleId)?.title || file.name });
      }
    } catch (err) {
      console.error('Training file upload failed:', err);
    } finally {
      setUploadingId(null);
    }
  };

  const addQuestion = () => {
    const questions = [...audience.questions];
    const newQ: TrainingQuestion = {
      id: Date.now().toString(),
      question: '',
      fieldType: 'multiple_choice',
      options: [{ key: 'a', label: '' }, { key: 'b', label: '' }],
      correctResponseKey: 'a'
    };
    setAudience(activeTab, { ...audience, questions: [...questions, newQ] });
  };

  const updateQuestion = (questionId: string, updates: Partial<TrainingQuestion>) => {
    const questions = audience.questions.map((q) =>
      q.id === questionId ? { ...q, ...updates } : q
    );
    setAudience(activeTab, { ...audience, questions });
  };

  const removeQuestion = (questionId: string) => {
    const questions = audience.questions.filter((q) => q.id !== questionId);
    setAudience(activeTab, { ...audience, questions });
  };

  const sortedModules = [...audience.modules].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-bold text-oe-text flex items-center gap-2">
          <BookOpen className="h-5 w-5" />
          Training
        </h3>
        <p className="text-sm text-gray-600 mt-1">
          Configure training materials for agents and/or members. Add videos, images, text, and links; then add questions to track completion and scores.
        </p>
      </div>

      {/* Tabs: Agent / Member */}
      <div className="flex gap-2 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setActiveTab('agentTraining')}
          className={`px-4 py-2 rounded-t-lg font-medium flex items-center gap-2 ${
            activeTab === 'agentTraining'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <UserCircle className="h-4 w-4" />
          Agent Training
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('memberTraining')}
          className={`px-4 py-2 rounded-t-lg font-medium flex items-center gap-2 ${
            activeTab === 'memberTraining'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <Users className="h-4 w-4" />
          Member Training
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />

      {isAgent && (
        <div className="bg-oe-light bg-opacity-20 border border-oe-primary rounded-lg p-4 flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={audience.requiredForSell ?? false}
              onChange={(e) =>
                setAudience(activeTab, { ...audience, requiredForSell: e.target.checked })
              }
              className="h-4 w-4 text-oe-primary rounded border-gray-300"
            />
            <span className="font-medium text-gray-900">Required to sell this product</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Passing score %</span>
            <input
              type="number"
              min={0}
              max={100}
              value={audience.passingScorePercent ?? 80}
              onChange={(e) =>
                setAudience(activeTab, {
                  ...audience,
                  passingScorePercent: Math.min(100, Math.max(0, Number(e.target.value)))
                })
              }
              className="w-20 px-2 py-1 border border-gray-300 rounded-md"
            />
          </label>
        </div>
      )}

      {/* Modules */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <h4 className="font-semibold text-gray-900">Content modules</h4>
          <div className="flex gap-2">
            <button type="button" onClick={() => addModule('video')} className="btn-secondary flex items-center gap-1 text-sm">
              <Video className="h-4 w-4" /> Video
            </button>
            <button type="button" onClick={() => addModule('image')} className="btn-secondary flex items-center gap-1 text-sm">
              <ImageIcon className="h-4 w-4" /> Image
            </button>
            <button type="button" onClick={() => addModule('text')} className="btn-secondary flex items-center gap-1 text-sm">
              <Type className="h-4 w-4" /> Text
            </button>
            <button type="button" onClick={() => addModule('link')} className="btn-secondary flex items-center gap-1 text-sm">
              <LinkIcon className="h-4 w-4" /> Link
            </button>
          </div>
        </div>
        {sortedModules.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">No modules yet. Add video, image, text, or link.</p>
        ) : (
          <ul className="space-y-3">
            {sortedModules.map((mod, idx) => (
              <li key={mod.id} className="border border-gray-200 rounded-lg p-4 bg-white">
                <div className="flex items-start gap-2">
                  <div className="flex flex-col gap-0.5">
                    <button type="button" onClick={() => reorderModule(mod.id, 'up')} disabled={idx === 0} className="p-0.5 text-gray-500 disabled:opacity-30">
                      <GripVertical className="h-4 w-4 rotate-90" />
                    </button>
                    <button type="button" onClick={() => reorderModule(mod.id, 'down')} disabled={idx === sortedModules.length - 1} className="p-0.5 text-gray-500 disabled:opacity-30">
                      <GripVertical className="h-4 w-4 -rotate-90" />
                    </button>
                  </div>
                  <div className="flex-1 space-y-2">
                    <input
                      type="text"
                      placeholder="Title"
                      value={mod.title}
                      onChange={(e) => updateModule(mod.id, { title: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    />
                    {(mod.type === 'video' || mod.type === 'image') && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleFileSelect(mod.id, mod.type as 'video' | 'image')}
                          disabled={uploadingId === mod.id}
                          className="btn-secondary text-sm"
                        >
                          {uploadingId === mod.id ? 'Uploading…' : mod.url ? 'Replace file' : 'Upload file'}
                        </button>
                        {mod.url && <span className="text-xs text-gray-500 truncate max-w-[200px]">{mod.url}</span>}
                      </div>
                    )}
                    {mod.type === 'text' && (
                      <textarea
                        placeholder="Text content"
                        value={mod.text ?? ''}
                        onChange={(e) => updateModule(mod.id, { text: e.target.value })}
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      />
                    )}
                    {mod.type === 'link' && (
                      <>
                        <input
                          type="text"
                          placeholder="Label"
                          value={mod.label ?? ''}
                          onChange={(e) => updateModule(mod.id, { label: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                        />
                        <input
                          type="url"
                          placeholder="URL"
                          value={mod.url ?? ''}
                          onChange={(e) => updateModule(mod.id, { url: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                        />
                      </>
                    )}
                  </div>
                  <button type="button" onClick={() => removeModule(mod.id)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Questions */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <h4 className="font-semibold text-gray-900">Questions (for scoring)</h4>
          <button type="button" onClick={addQuestion} className="btn-primary flex items-center gap-1 text-sm">
            <Plus className="h-4 w-4" /> Add question
          </button>
        </div>
        {audience.questions.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">No questions. Add questions to track scores.</p>
        ) : (
          <ul className="space-y-4">
            {audience.questions.map((q) => (
              <li key={q.id} className="border border-gray-200 rounded-lg p-4 bg-white">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-medium text-gray-700">Question</span>
                  <button type="button" onClick={() => removeQuestion(q.id)} className="text-red-600 hover:bg-red-50 p-1 rounded">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <textarea
                  value={q.question}
                  onChange={(e) => updateQuestion(q.id, { question: e.target.value })}
                  placeholder="Question text"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm mb-3"
                />
                <div className="flex gap-4 mb-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`ft-${q.id}`}
                      checked={q.fieldType === 'multiple_choice'}
                      onChange={() => updateQuestion(q.id, {
                        fieldType: 'multiple_choice',
                        options: q.fieldType === 'multiple_choice' && q.options?.length
                          ? q.options
                          : [{ key: 'a', label: '' }, { key: 'b', label: '' }]
                      })}
                    />
                    <span className="text-sm">Multiple choice</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`ft-${q.id}`}
                      checked={q.fieldType === 'true_false'}
                      onChange={() => updateQuestion(q.id, { fieldType: 'true_false', options: [{ key: 'true', label: 'True' }, { key: 'false', label: 'False' }] })}
                    />
                    <span className="text-sm">True / False</span>
                  </label>
                </div>
                {q.options?.map((opt, i) => (
                  <div key={opt.key} className="flex items-center gap-2 mb-1">
                    <input
                      type="text"
                      value={opt.label}
                      onChange={(e) => {
                        const options = [...(q.options || [])];
                        options[i] = { ...opt, label: e.target.value };
                        updateQuestion(q.id, { options });
                      }}
                      className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                      placeholder={`Option ${opt.key}`}
                    />
                    <label className="flex items-center gap-1 text-sm">
                      <input
                        type="radio"
                        name={`correct-${q.id}`}
                        checked={q.correctResponseKey === opt.key}
                        onChange={() => updateQuestion(q.id, { correctResponseKey: opt.key })}
                      />
                      Correct
                    </label>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
