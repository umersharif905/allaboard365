/** Stable id for the implicit single page used when a form has no `pages`. */
export const IMPLICIT_PAGE_ID: 'page_main';

export type VisibilityPage = {
  id: string;
  title?: string;
  defaultHidden?: boolean;
};

export type VisibilityField = {
  name: string;
  pageId?: string;
  defaultHidden?: boolean;
};

export type VisibilityEffect = {
  action: 'show' | 'hide';
  targetType: 'page' | 'field';
  targetId: string;
};

export type VisibilityOption = {
  id: string;
  effects?: VisibilityEffect[];
};

export type VisibilityQuestion = {
  id: string;
  options?: VisibilityOption[];
};

export type VisibilityDefinition = {
  title?: string;
  fields?: VisibilityField[];
  pages?: VisibilityPage[];
  preScreening?: VisibilityQuestion[];
};

/** The form's pages as an always-non-empty list (implicit single page fallback). */
export function effectivePages(def: VisibilityDefinition | null | undefined): VisibilityPage[];

/** The page a field belongs to; missing/unmatched `pageId` falls back to the first page. */
export function pageIdForField(field: VisibilityField, pages: VisibilityPage[]): string;

/** Resolve visible pages/fields from pre-screening answers.
 *  Each answer is one option id (single-select) or an array of ids (multi). */
export function resolveVisibility(
  def: VisibilityDefinition | null | undefined,
  answers: Record<string, string | string[]> | null | undefined
): { visiblePageIds: Set<string>; visibleFieldNames: Set<string> };
