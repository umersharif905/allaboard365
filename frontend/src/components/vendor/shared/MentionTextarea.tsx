import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MentionableUser } from '../../../services/vendorMentions.service';
import { mentionDisplayName } from '../../../services/vendorMentions.service';

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  users: MentionableUser[];
  /** Emits the UserIds currently mentioned in the text. */
  onMentionsChange: (userIds: string[]) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

const MAX_QUERY = 30;
const MAX_SUGGESTIONS = 8;

const baseTextareaClasses =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary';

// Recompute which users are mentioned by scanning for "@First Last" tokens.
// Deletion-safe: there is no separate selection state that can drift.
function computeMentionedIds(text: string, users: MentionableUser[]): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const ids = new Set<string>();
  for (const u of users) {
    const name = mentionDisplayName(u);
    if (name && lower.includes(`@${name.toLowerCase()}`)) {
      ids.add(u.UserId);
    }
  }
  return Array.from(ids);
}

// The "@query" immediately before the caret, if the caret is in a mention
// context (a '@' at line start or after whitespace, no newline in between).
function getActiveQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : '';
      if (i === 0 || /\s/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (query.length > MAX_QUERY || /[\n\r]/.test(query)) return null;
        return { start: i, query };
      }
      return null;
    }
  }
  return null;
}

function matchesQuery(user: MentionableUser, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = mentionDisplayName(user).toLowerCase();
  return (
    name.includes(q) ||
    (user.FirstName || '').toLowerCase().startsWith(q) ||
    (user.LastName || '').toLowerCase().startsWith(q) ||
    (user.Email || '').toLowerCase().startsWith(q)
  );
}

const MentionTextarea: React.FC<MentionTextareaProps> = ({
  value,
  onChange,
  users,
  onMentionsChange,
  rows = 5,
  placeholder,
  className,
  autoFocus,
  disabled
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Keep onMentionsChange out of the effect deps so a new callback identity
  // on every parent render can't retrigger the emit loop.
  const onMentionsChangeRef = useRef(onMentionsChange);
  useEffect(() => {
    onMentionsChangeRef.current = onMentionsChange;
  }, [onMentionsChange]);

  const lastEmitted = useRef<string>('');
  useEffect(() => {
    const ids = computeMentionedIds(value, users);
    const key = ids.slice().sort().join(',');
    if (key !== lastEmitted.current) {
      lastEmitted.current = key;
      onMentionsChangeRef.current(ids);
    }
  }, [value, users]);

  const suggestions = useMemo(() => {
    if (!menu) return [];
    return users
      .filter((u) => matchesQuery(u, menu.query))
      .slice(0, MAX_SUGGESTIONS);
  }, [menu, users]);

  useEffect(() => {
    setActiveIndex(0);
  }, [menu?.query]);

  const syncMenu = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    setMenu(getActiveQuery(value, caret));
  }, [value]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const selectUser = useCallback(
    (user: MentionableUser) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const active = getActiveQuery(value, caret);
      if (!active) return;
      const name = mentionDisplayName(user);
      const before = value.slice(0, active.start);
      const after = value.slice(caret);
      const insert = `@${name} `;
      const next = `${before}${insert}${after}`;
      const newCaret = before.length + insert.length;
      onChange(next);
      setMenu(null);
      window.requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.focus();
          node.setSelectionRange(newCaret, newCaret);
        }
      });
    },
    [onChange, value]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menu || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const chosen = suggestions[activeIndex];
      if (chosen) selectUser(chosen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Defer so selectionStart reflects the post-change caret.
          window.requestAnimationFrame(syncMenu);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncMenu}
        onClick={syncMenu}
        onBlur={() => {
          // Let a suggestion click register before the menu unmounts.
          window.setTimeout(closeMenu, 120);
        }}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        className={className || baseTextareaClasses}
      />
      {menu && suggestions.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-40 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1"
        >
          {suggestions.map((u, idx) => {
            const name = mentionDisplayName(u) || u.Email;
            const isAdmin = (u.roles || []).includes('VendorAdmin');
            return (
              <li key={u.UserId} role="option" aria-selected={idx === activeIndex}>
                <button
                  type="button"
                  // onMouseDown (not onClick) so it fires before textarea blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectUser(u);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-3 ${
                    idx === activeIndex ? 'bg-oe-light' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-gray-900">{name}</span>
                    <span className="text-gray-500"> · {u.Email}</span>
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-gray-500">
                    {isAdmin ? 'Admin' : 'Agent'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default MentionTextarea;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Renders note text with "@First Last" tokens visually emphasized when they
 * match a known teammate name. Parent should keep `whitespace-pre-wrap`.
 */
export function renderNoteWithMentions(
  text: string,
  names: string[]
): React.ReactNode {
  const cleaned = Array.from(
    new Set(names.map((n) => n.trim()).filter(Boolean))
  ).sort((a, b) => b.length - a.length);
  if (cleaned.length === 0 || !text) return text;

  const pattern = new RegExp(`@(${cleaned.map(escapeRegExp).join('|')})`, 'gi');
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(
      <span key={`m${key++}`} className="font-semibold text-oe-primary">
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
