import { useRef, useState, type ChangeEvent } from 'react';
import type { HeaderImageDef } from '../../../types/publicFormDefinition';
import { useAuth } from '../../../contexts/AuthContext';
import { API_CONFIG } from '../../../config/api';
import { authService } from '../../../services/auth.service';
import { getAuthHeadersWithTenant } from '../../../services/api.service';
import { usePublicFormsContext } from '../../../hooks/usePublicFormsContext';
import { fbHeaderUploadBtn, fbTextDangerBtn } from './formBuilderButtonClasses';

type Props = {
  formTemplateId: string;
  value: HeaderImageDef | undefined;
  onChange: (next: HeaderImageDef | undefined) => void;
};

export function FormHeaderImageControls({ formTemplateId, value, onChange }: Props) {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const { apiBase, canEdit } = usePublicFormsContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const align = value?.align ?? 'center';
  const maxWidth = value?.maxWidth ?? 'md';

  const patch = (partial: Partial<HeaderImageDef>) => {
    if (!value?.url) return;
    onChange({ ...value, ...partial });
  };

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadErr(null);
    setUploading(true);
    try {
      const token = await authService.getAccessToken();
      const fd = new FormData();
      fd.append('file', file);
      const url = `${API_CONFIG.BASE_URL}${apiBase}/templates/${formTemplateId}/header-image`;
      const res = await globalThis.fetch(url, {
        method: 'POST',
        headers: getAuthHeadersWithTenant(token, activeTenantId),
        body: fd
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.message || `Upload failed (${res.status})`);
      }
      const assetUrl = body?.data?.url as string | undefined;
      if (!assetUrl) throw new Error('No URL returned');
      onChange({
        url: assetUrl,
        align: value?.align ?? 'center',
        maxWidth: value?.maxWidth ?? 'md'
      });
    } catch (err: unknown) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2 rounded border border-gray-200 bg-white p-3">
      <p className="text-[11px] text-gray-500">
        Optional image shown above the rich-text header. JPEG, PNG, GIF, or WebP, max 2MB.
      </p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={onPickFile} />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className={fbHeaderUploadBtn}
          >
            {uploading ? 'Uploading…' : value?.url ? 'Replace image' : 'Upload image'}
          </button>
          {value?.url ? (
            <button type="button" onClick={() => onChange(undefined)} className={fbTextDangerBtn}>
              Remove image
            </button>
          ) : null}
        </div>
      )}
      {uploadErr ? <p className="text-xs text-red-600">{uploadErr}</p> : null}
      {value?.url ? (
        <div className="flex flex-wrap gap-4 pt-1">
          <label className="text-xs text-gray-600 flex flex-col gap-1">
            <span>Alignment</span>
            <select
              className="border border-gray-300 rounded px-2 py-1 text-sm"
              value={align}
              onChange={(e) => patch({ align: e.target.value as HeaderImageDef['align'] })}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label className="text-xs text-gray-600 flex flex-col gap-1">
            <span>Display size</span>
            <select
              className="border border-gray-300 rounded px-2 py-1 text-sm"
              value={maxWidth}
              onChange={(e) => patch({ maxWidth: e.target.value as HeaderImageDef['maxWidth'] })}
            >
              <option value="sm">Small</option>
              <option value="md">Medium</option>
              <option value="lg">Large</option>
              <option value="full">Full width</option>
            </select>
          </label>
        </div>
      ) : null}
      {value?.url ? (
        <div className="flex justify-center pt-2">
          <img src={value.url} alt="" className="max-h-24 object-contain rounded border border-gray-200" />
        </div>
      ) : null}
    </div>
  );
}
