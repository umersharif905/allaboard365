// pages/vendor/VendorRequestTypeSettings.tsx
// VendorAdmin screen for managing the per-vendor share request type list.

import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { vendorRequestTypesService } from '../../services/vendorRequestTypes.service';
import type { VendorRequestType } from '../../types/shareRequest.types';

interface DependentsConfirm {
  typeId: string;
  name: string;
  dependentCount: number;
}

const VendorRequestTypeSettings = () => {
  const [types, setTypes] = useState<VendorRequestType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [busyReorderId, setBusyReorderId] = useState<string | null>(null);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DependentsConfirm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await vendorRequestTypesService.list();
      setTypes(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load request types');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      await vendorRequestTypesService.create(name);
      setNewName('');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to add type');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (t: VendorRequestType) => {
    setEditingId(t.TypeId);
    setEditName(t.Name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const saveEdit = async (t: VendorRequestType) => {
    const name = editName.trim();
    if (!name || name === t.Name) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      await vendorRequestTypesService.update(t.TypeId, { name });
      cancelEdit();
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSavingEdit(false);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const target = types[index];
    const swap = types[index + direction];
    if (!target || !swap) return;

    setBusyReorderId(target.TypeId);
    setError(null);
    try {
      await vendorRequestTypesService.update(target.TypeId, { sortOrder: swap.SortOrder });
      await vendorRequestTypesService.update(swap.TypeId, { sortOrder: target.SortOrder });
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to reorder');
    } finally {
      setBusyReorderId(null);
    }
  };

  const attemptDelete = async (t: VendorRequestType) => {
    setBusyDeleteId(t.TypeId);
    setError(null);
    try {
      const result = await vendorRequestTypesService.remove(t.TypeId, false);
      if (result.status === 'has-dependents') {
        setConfirm({ typeId: t.TypeId, name: t.Name, dependentCount: result.dependentCount });
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete');
    } finally {
      setBusyDeleteId(null);
    }
  };

  const confirmForceDelete = async () => {
    if (!confirm) return;
    setBusyDeleteId(confirm.typeId);
    setError(null);
    try {
      await vendorRequestTypesService.remove(confirm.typeId, true);
      setConfirm(null);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete');
    } finally {
      setBusyDeleteId(null);
    }
  };

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Share Request Types</h1>
        <p className="text-sm text-gray-600 mt-1">
          Manage the request types your team can pick when creating share requests. Each request also gets a free-text sub-type for the specific surgery, procedure, or treatment.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          <CircleAlert className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="mb-6 flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={100}
          placeholder="Add a new type (e.g. Surgery - Inpatient)"
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
        />
        <button
          type="submit"
          disabled={adding || !newName.trim()}
          className="px-3 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-gray-500">Loading…</div>
        ) : types.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">No types yet. Add one above.</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {types.map((t, index) => {
              const isEditing = editingId === t.TypeId;
              const isBusy =
                busyReorderId === t.TypeId ||
                busyDeleteId === t.TypeId ||
                (savingEdit && isEditing);
              return (
                <li key={t.TypeId} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || isBusy}
                      aria-label="Move up"
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === types.length - 1 || isBusy}
                      aria-label="Move down"
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex-1">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={100}
                        autoFocus
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-oe-primary"
                      />
                    ) : (
                      <span className="text-sm text-gray-900">{t.Name}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveEdit(t)}
                          disabled={savingEdit}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded inline-flex items-center gap-1"
                        >
                          <X className="h-3.5 w-3.5" />
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(t)}
                          disabled={isBusy}
                          className="px-2.5 py-1 text-xs text-gray-700 border border-gray-300 hover:bg-gray-50 rounded inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => attemptDelete(t)}
                          disabled={isBusy}
                          className="px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 rounded inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg border border-gray-200 shadow-lg max-w-md w-full p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 p-2 rounded-full bg-red-50">
                <CircleAlert className="h-5 w-5 text-red-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-gray-900">Delete &ldquo;{confirm.name}&rdquo;?</h3>
                <p className="mt-1 text-sm text-gray-600">
                  {confirm.dependentCount === 1
                    ? '1 share request currently uses this type.'
                    : `${confirm.dependentCount} share requests currently use this type.`}{' '}
                  After delete, those requests will show no type (&mdash;). This can&rsquo;t be undone.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmForceDelete}
                disabled={busyDeleteId === confirm.typeId}
                className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
              >
                {busyDeleteId === confirm.typeId ? 'Deleting…' : 'Delete anyway'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorRequestTypeSettings;
