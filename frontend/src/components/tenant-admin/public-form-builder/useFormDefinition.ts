import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DropResult } from '@hello-pangea/dnd';
import type {
  FieldDef,
  FormDefinition,
  FormPage,
  PaletteFieldType,
  PreScreenQuestion
} from '../../../types/publicFormDefinition';
import {
  effectivePages,
  newFieldFromPalette,
  newFormPage,
  newPreScreenQuestion,
  pageIdForField,
  parseFormDefinition,
  stringifyFormDefinition,
  uniqueFieldName
} from '../../../types/publicFormDefinition';
import type { MemberFieldPreset } from './memberFieldPresets';

function reorderList<T>(list: T[], startIndex: number, endIndex: number): T[] {
  const next = [...list];
  const [removed] = next.splice(startIndex, 1);
  next.splice(endIndex, 0, removed);
  return next;
}

export type FormDefinitionController = ReturnType<typeof useFormDefinition>;

/**
 * Owns the parsed form definition plus every mutation handler. Lifted out of
 * PublicFormBuilder so the tabbed editor can drive the form-structure toggles
 * from the Setup tab while the builder renders on the Build tab — both
 * working off one shared definition.
 *
 * `initialJson` / `onChange` bind it to the editor page's definition-JSON
 * state; the editor page is the single source of truth.
 */
export function useFormDefinition(initialJson: string, onChange: (json: string) => void) {
  const [def, setDef] = useState<FormDefinition>(() => parseFormDefinition(initialJson));
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string>(
    () => parseFormDefinition(initialJson).pages?.[0]?.id ?? ''
  );

  /** Latest definition for handlers (avoids stale closure when Quill fires onChange late). */
  const defRef = useRef(def);
  defRef.current = def;
  /** JSON last emitted — when the parent echoes it back as initialJson, skip re-parsing. */
  const lastEmittedJsonRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialJson === lastEmittedJsonRef.current) return;
    lastEmittedJsonRef.current = initialJson;
    setDef(parseFormDefinition(initialJson));
  }, [initialJson]);

  const pages = useMemo(() => effectivePages(def), [def]);

  // Keep activePageId pointing at a real page when multi-page mode / the page
  // list changes (toggled on, page removed, definition reloaded).
  useEffect(() => {
    if (!def.multiPage) return;
    const ids = (def.pages ?? []).map((p) => p.id);
    if (ids.length === 0) return;
    if (!ids.includes(activePageId)) setActivePageId(ids[0]);
  }, [def.multiPage, def.pages, activePageId]);

  const pushChange = useCallback(
    (next: FormDefinition) => {
      const json = stringifyFormDefinition(next);
      lastEmittedJsonRef.current = json;
      setDef(next);
      onChange(json);
    },
    [onChange]
  );

  /** Shallow-merge a patch onto the definition (title, header, intro, submissionPdf, …). */
  const patchDef = useCallback(
    (patch: Partial<FormDefinition>) => pushChange({ ...defRef.current, ...patch }),
    [pushChange]
  );

  // --- field handlers -------------------------------------------------------

  const handleAdd = useCallback(
    (type: PaletteFieldType) => {
      const current = defRef.current;
      const used = new Set(current.fields.map((f) => f.name));
      const field = newFieldFromPalette(type, used);
      if (current.multiPage && activePageId) field.pageId = activePageId;
      pushChange({ ...current, fields: [...current.fields, field] });
      setSelectedName(field.name);
    },
    [pushChange, activePageId]
  );

  const handleAddMemberField = useCallback(
    (preset: MemberFieldPreset) => {
      const current = defRef.current;
      const used = new Set(current.fields.map((f) => f.name));
      // Use the canonical key as-is when free; only de-dupe on a real collision
      // (so the field still autofills under its canonical key in the common case).
      const name = used.has(preset.field.name)
        ? uniqueFieldName(preset.field.name, used)
        : preset.field.name;
      const field: FieldDef = { ...preset.field, name };
      if (current.multiPage && activePageId) field.pageId = activePageId;
      pushChange({ ...current, fields: [...current.fields, field] });
      setSelectedName(field.name);
    },
    [pushChange, activePageId]
  );

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      const dest = result.destination;
      if (!dest) return;
      const current = defRef.current;
      if (current.multiPage) {
        const currentPages = effectivePages(current);
        const onPage = (f: FieldDef) => pageIdForField(f, currentPages) === activePageId;
        const pageFields = current.fields.filter(onPage);
        const reordered = reorderList(pageFields, result.source.index, dest.index);
        let k = 0;
        const fields = current.fields.map((f) => (onPage(f) ? reordered[k++] : f));
        pushChange({ ...current, fields });
      } else {
        const fields = reorderList(current.fields, result.source.index, dest.index);
        pushChange({ ...current, fields });
      }
    },
    [pushChange, activePageId]
  );

  const updateSelected = useCallback(
    (patch: Partial<FieldDef>) => {
      if (!selectedName) return;
      const current = defRef.current;
      const fields = current.fields.map((f) => (f.name === selectedName ? { ...f, ...patch } : f));
      pushChange({ ...current, fields });
      if (patch.name && patch.name !== selectedName) setSelectedName(patch.name);
    },
    [pushChange, selectedName]
  );

  const removeSelected = useCallback(() => {
    if (!selectedName) return;
    const current = defRef.current;
    const fields = current.fields.filter((f) => f.name !== selectedName);
    pushChange({ ...current, fields });
    setSelectedName(null);
  }, [pushChange, selectedName]);

  // --- form-structure toggles ----------------------------------------------

  const toggleMultiPage = useCallback(
    (on: boolean) => {
      const current = defRef.current;
      if (on) {
        const nextPages =
          current.pages && current.pages.length > 0 ? current.pages : [newFormPage('Page 1')];
        pushChange({ ...current, multiPage: true, pages: nextPages });
        setActivePageId(nextPages[0].id);
      } else {
        const pageCount = (current.pages ?? []).length;
        if (pageCount > 1) {
          const ok = window.confirm(
            `Switch to a single-page form? The ${pageCount} pages will be merged into one — ` +
              `all fields are kept, but page names, descriptions, and the page layout are discarded.`
          );
          if (!ok) return;
        }
        pushChange({
          ...current,
          multiPage: undefined,
          pages: undefined,
          fields: current.fields.map((f) => (f.pageId ? { ...f, pageId: undefined } : f))
        });
      }
    },
    [pushChange]
  );

  const togglePreScreening = useCallback(
    (on: boolean) => {
      const current = defRef.current;
      if (on) {
        const preScreening =
          current.preScreening && current.preScreening.length > 0
            ? current.preScreening
            : [newPreScreenQuestion()];
        pushChange({ ...current, preScreeningEnabled: true, preScreening });
      } else {
        const qCount = (current.preScreening ?? []).length;
        if (qCount > 0) {
          const ok = window.confirm(
            `Turn off pre-screening? The ${qCount} pre-screening question${qCount === 1 ? '' : 's'} ` +
              `will be removed. Fields and pages marked "hidden by default" stay hidden — clear that ` +
              `flag on anything you want shown.`
          );
          if (!ok) return;
        }
        pushChange({ ...current, preScreeningEnabled: undefined, preScreening: undefined });
      }
    },
    [pushChange]
  );

  const toggleSuggestSignIn = useCallback(
    (on: boolean) => {
      const current = defRef.current;
      // Opt-out flag: undefined/true = offered, explicit false = off.
      pushChange({ ...current, suggestSignIn: on ? undefined : false });
    },
    [pushChange]
  );

  const setPreScreening = useCallback(
    (preScreening: PreScreenQuestion[]) => patchDef({ preScreening }),
    [patchDef]
  );

  // --- page handlers --------------------------------------------------------

  const addPage = useCallback(() => {
    const current = defRef.current;
    const list = current.pages ?? [];
    const page = newFormPage(`Page ${list.length + 1}`);
    pushChange({ ...current, pages: [...list, page] });
    setActivePageId(page.id);
  }, [pushChange]);

  const updatePage = useCallback(
    (id: string, patch: Partial<FormPage>) => {
      const current = defRef.current;
      pushChange({
        ...current,
        pages: (current.pages ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p))
      });
    },
    [pushChange]
  );

  const removePage = useCallback(
    (id: string) => {
      const current = defRef.current;
      const list = current.pages ?? [];
      if (list.length <= 1) return;
      const currentPages = effectivePages(current);
      const page = list.find((p) => p.id === id);
      const count = current.fields.filter((f) => pageIdForField(f, currentPages) === id).length;
      if (count > 0) {
        const ok = window.confirm(
          `Delete "${page?.title?.trim() || 'this page'}"? Its ${count} field` +
            `${count === 1 ? '' : 's'} will move to the first page.`
        );
        if (!ok) return;
      }
      const remaining = list.filter((p) => p.id !== id);
      const fields = current.fields.map((f) => (f.pageId === id ? { ...f, pageId: undefined } : f));
      pushChange({ ...current, pages: remaining, fields });
      if (activePageId === id) setActivePageId(remaining[0].id);
    },
    [pushChange, activePageId]
  );

  const movePage = useCallback(
    (id: string, dir: -1 | 1) => {
      const current = defRef.current;
      const list = [...(current.pages ?? [])];
      const i = list.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      pushChange({ ...current, pages: list });
    },
    [pushChange]
  );

  // --- derived view state ---------------------------------------------------

  const canvasFields = useMemo(() => {
    if (!def.multiPage) return def.fields;
    return def.fields.filter((f) => pageIdForField(f, pages) === activePageId);
  }, [def, pages, activePageId]);

  const fieldCountByPage = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of pages) counts[p.id] = 0;
    for (const f of def.fields) {
      const pid = pageIdForField(f, pages);
      counts[pid] = (counts[pid] ?? 0) + 1;
    }
    return counts;
  }, [def.fields, pages]);

  const selectedField = selectedName
    ? def.fields.find((f) => f.name === selectedName) ?? null
    : null;
  const nameDuplicate =
    !!selectedField && def.fields.filter((f) => f.name === selectedField.name).length > 1;

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;

  return {
    def,
    pages,
    activePage,
    pushChange,
    patchDef,
    selectedName,
    setSelectedName,
    selectedField,
    nameDuplicate,
    activePageId,
    setActivePageId,
    canvasFields,
    fieldCountByPage,
    handleAdd,
    handleAddMemberField,
    handleDragEnd,
    updateSelected,
    removeSelected,
    toggleMultiPage,
    togglePreScreening,
    toggleSuggestSignIn,
    setPreScreening,
    addPage,
    updatePage,
    removePage,
    movePage
  };
}
