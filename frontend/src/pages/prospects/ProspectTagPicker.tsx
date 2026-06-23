// frontend/src/pages/prospects/ProspectTagPicker.tsx
// Inline tag manager used inside ProspectDetailModal.
// Shows assigned tags with an × to remove, and an "Add tag" control for
// picking from existing tags or creating a new one.

import { Loader2, Plus, Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
  useAssignProspectTag,
  useCreateTag,
  useDeleteTag,
  useProspectTags,
  useRemoveProspectTag,
} from '../../hooks/useProspects';
import { ProspectTag } from '../../services/prospect.service';
import {
  TAG_COLOR_PALETTE,
  TagColorKey,
  tagChipClass,
  tagSwatchClass,
} from './prospectStatus';

interface Props {
  prospectId: string;
  assignedTags: ProspectTag[];
}

export default function ProspectTagPicker({ prospectId, assignedTags }: Props) {
  const { data: allTags = [], isLoading: loadingTags } = useProspectTags();
  const assignMutation = useAssignProspectTag(prospectId);
  const removeMutation = useRemoveProspectTag(prospectId);
  const createMutation = useCreateTag();
  const deleteMutation = useDeleteTag();

  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColorKey>('blue');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const assignedIds = new Set(assignedTags.map((t) => t.ProspectTagId));
  const unassigned = allTags.filter((t) => !assignedIds.has(t.ProspectTagId));

  const handleAssign = (tagId: string) => {
    assignMutation.mutate(tagId);
    setOpen(false);
  };

  const handleRemove = (tagId: string) => {
    removeMutation.mutate(tagId);
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    createMutation.mutate(
      { name: newName.trim(), color: newColor },
      {
        onSuccess: (tag) => {
          assignMutation.mutate(tag.ProspectTagId);
          setNewName('');
          setNewColor('blue');
          setOpen(false);
        },
      }
    );
  };

  const handleDeleteTag = (tagId: string) => {
    setDeleteError(null);
    deleteMutation.mutate(tagId, {
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Could not delete tag';
        setDeleteError(msg);
      },
    });
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
        Tags
      </label>

      {/* Assigned tag chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {assignedTags.length === 0 && (
          <span className="text-sm text-gray-400 italic">No tags assigned.</span>
        )}
        {assignedTags.map((tag) => (
          <span
            key={tag.ProspectTagId}
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${tagChipClass(tag.Color)}`}
          >
            {tag.Name}
            <button
              onClick={() => handleRemove(tag.ProspectTagId)}
              disabled={removeMutation.isPending}
              className="hover:opacity-70 disabled:opacity-40"
              aria-label={`Remove tag ${tag.Name}`}
            >
              {removeMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <X className="w-3 h-3" />
              )}
            </button>
          </span>
        ))}
      </div>

      {/* Add tag button / popover */}
      <div className="relative inline-block">
        <button
          onClick={() => { setOpen((v) => !v); setDeleteError(null); }}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50 rounded-lg"
        >
          <Plus className="w-3 h-3" /> Add tag
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-gray-200 rounded-lg shadow-lg w-64 p-3 space-y-3">
            {/* Pick existing unassigned tag */}
            {loadingTags ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : unassigned.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                  Add existing
                </p>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                  {unassigned.map((tag) => (
                    <div key={tag.ProspectTagId} className="flex items-center gap-0.5">
                      <button
                        onClick={() => handleAssign(tag.ProspectTagId)}
                        disabled={assignMutation.isPending}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full hover:opacity-80 disabled:opacity-50 ${tagChipClass(tag.Color)}`}
                      >
                        <Tag className="w-2.5 h-2.5" />
                        {tag.Name}
                      </button>
                      <button
                        onClick={() => handleDeleteTag(tag.ProspectTagId)}
                        disabled={deleteMutation.isPending}
                        className="p-0.5 text-gray-400 hover:text-red-600 disabled:opacity-40"
                        aria-label={`Delete tag ${tag.Name}`}
                        title="Delete tag"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {deleteError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                {deleteError}
              </p>
            )}

            {/* Create new tag */}
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                Create new tag
              </p>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tag name"
                maxLength={50}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-oe-primary mb-2"
              />
              {/* Color swatches */}
              <div className="flex flex-wrap gap-1 mb-2">
                {TAG_COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full ${tagSwatchClass(c)} ${newColor === c ? 'ring-2 ring-offset-1 ring-gray-600' : 'opacity-70 hover:opacity-100'}`}
                    aria-label={c}
                    title={c}
                  />
                ))}
              </div>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || createMutation.isPending || assignMutation.isPending}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
              >
                {(createMutation.isPending || assignMutation.isPending) ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Create &amp; assign
              </button>
            </div>

            <button
              onClick={() => setOpen(false)}
              className="text-xs text-gray-400 hover:text-gray-600 w-full text-right"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
