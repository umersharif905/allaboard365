// frontend/src/components/common/RichTextEditor.tsx
import React, { useMemo, useRef, useImperativeHandle, forwardRef, useState, useEffect } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { Code, Eye, Bold, Italic, Underline, Link, List, ListOrdered, Image } from 'lucide-react';

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
  className?: string;
  /** Show toolbar toggle for HTML/source editing (default true). When true, Visual mode uses contentEditable to preserve pasted/styled HTML. */
  allowHtmlSource?: boolean;
}

export interface RichTextEditorRef {
  insertText: (text: string) => void;
}

const RichTextEditor = forwardRef<RichTextEditorRef, RichTextEditorProps>(({
  value,
  onChange,
  placeholder = 'Enter your message here...',
  minHeight = 200,
  disabled = false,
  className = '',
  allowHtmlSource = true,
}, ref) => {
  const quillRef = useRef<ReactQuill>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef<string>(value);
  const isInternalChangeRef = useRef(false);
  const [isHtmlMode, setIsHtmlMode] = useState(false);
  const prevHtmlModeRef = useRef(false);
  const hasSeededVisualRef = useRef(false);

  const modules = useMemo(
    () => ({
      toolbar: {
        container: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image'],
          ['clean'],
        ],
      },
    }),
    []
  );

  const formats = [
    'header',
    'bold',
    'italic',
    'underline',
    'list',
    'bullet',
    'link',
    'image',
  ];

  const editorMinHeight = Math.max(minHeight, 200);

  // When allowHtmlSource is true, Visual mode uses contentEditable so pasted HTML isn't stripped.
  // Sync contentEditable innerHTML: set from value when entering Visual or when value changed externally.
  useEffect(() => {
    if (!allowHtmlSource || isHtmlMode) return;
    const el = editableRef.current;
    if (!el) return;
    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false;
      return;
    }
    if (value !== lastValueRef.current) {
      lastValueRef.current = value;
      const html = value || '';
      if (el.innerHTML !== html) el.innerHTML = html;
    }
  }, [value, isHtmlMode, allowHtmlSource]);

  // Seed contentEditable: on first mount in Visual, or when switching from HTML to Visual
  useEffect(() => {
    const wasHtmlMode = prevHtmlModeRef.current;
    prevHtmlModeRef.current = isHtmlMode;
    if (isHtmlMode) {
      hasSeededVisualRef.current = false;
      return;
    }
    if (!allowHtmlSource) return;
    const el = editableRef.current;
    if (!el) return;
    const justSwitchedToVisual = wasHtmlMode && !isHtmlMode;
    if (justSwitchedToVisual || !hasSeededVisualRef.current) {
      const html = value || '';
      lastValueRef.current = html;
      el.innerHTML = html;
      hasSeededVisualRef.current = true;
    }
  }, [isHtmlMode, value]);

  const handleEditableInput = () => {
    const el = editableRef.current;
    if (!el) return;
    isInternalChangeRef.current = true;
    lastValueRef.current = el.innerHTML;
    onChange(el.innerHTML);
  };

  const execCommand = (cmd: string, valueArg?: string) => {
    document.execCommand(cmd, false, valueArg);
    editableRef.current?.focus();
    const el = editableRef.current;
    if (el) {
      isInternalChangeRef.current = true;
      lastValueRef.current = el.innerHTML;
      onChange(el.innerHTML);
    }
  };

  const insertText = (text: string) => {
    if (isHtmlMode) return;
    if (allowHtmlSource && editableRef.current) {
      editableRef.current.focus();
      document.execCommand('insertText', false, text);
      const el = editableRef.current;
      if (el) {
        isInternalChangeRef.current = true;
        lastValueRef.current = el.innerHTML;
        onChange(el.innerHTML);
      }
      return;
    }
    const quill = quillRef.current?.getEditor();
    if (quill) {
      const range = quill.getSelection();
      const index = range ? range.index : quill.getLength();
      quill.insertText(index, text);
      quill.setSelection({ index: index + text.length, length: 0 });
      onChange(quill.root.innerHTML);
    }
  };

  useImperativeHandle(ref, () => ({ insertText }), []);

  const visualContent = allowHtmlSource ? (
    <>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-gray-200 bg-gray-50 px-2 py-1 rounded-t-lg">
        <button type="button" onClick={() => execCommand('bold')} className="p-1.5 rounded hover:bg-gray-200" title="Bold"><Bold className="h-4 w-4" /></button>
        <button type="button" onClick={() => execCommand('italic')} className="p-1.5 rounded hover:bg-gray-200" title="Italic"><Italic className="h-4 w-4" /></button>
        <button type="button" onClick={() => execCommand('underline')} className="p-1.5 rounded hover:bg-gray-200" title="Underline"><Underline className="h-4 w-4" /></button>
        <span className="w-px h-5 bg-gray-300 mx-0.5" />
        <button type="button" onClick={() => { const url = prompt('URL:'); if (url) execCommand('createLink', url); }} className="p-1.5 rounded hover:bg-gray-200" title="Link"><Link className="h-4 w-4" /></button>
        <button type="button" onClick={() => execCommand('insertUnorderedList')} className="p-1.5 rounded hover:bg-gray-200" title="Bullet list"><List className="h-4 w-4" /></button>
        <button type="button" onClick={() => execCommand('insertOrderedList')} className="p-1.5 rounded hover:bg-gray-200" title="Numbered list"><ListOrdered className="h-4 w-4" /></button>
        <button type="button" onClick={() => { const url = prompt('Image URL:'); if (url) execCommand('insertImage', url); }} className="p-1.5 rounded hover:bg-gray-200" title="Image"><Image className="h-4 w-4" /></button>
      </div>
      <div
        ref={editableRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleEditableInput}
        data-placeholder={placeholder}
        className="min-h-[200px] p-3 text-sm text-gray-800 focus:outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400 overflow-y-auto [&_a]:text-[#1f8dbf] [&_a]:underline"
        style={{ minHeight: `${editorMinHeight - (allowHtmlSource ? 80 : 0)}px` }}
      />
    </>
  ) : (
    <ReactQuill
      ref={quillRef}
      theme="snow"
      value={value}
      onChange={onChange}
      modules={modules}
      formats={formats}
      placeholder={placeholder}
      readOnly={disabled}
    />
  );

  return (
    <div
      className={[
        'rounded-lg border border-gray-300 focus-within:ring-2 focus-within:ring-[#1f8dbf] focus-within:border-[#1f8dbf]',
        !allowHtmlSource && '[&_.ql-toolbar]:rounded-t-lg [&_.ql-toolbar]:border-0 [&_.ql-toolbar]:border-b [&_.ql-toolbar]:border-gray-200 [&_.ql-toolbar]:bg-gray-50',
        !allowHtmlSource && '[&_.ql-container]:rounded-b-lg [&_.ql-container]:border-0 [&_.ql-container]:text-sm',
        !allowHtmlSource && '[&_.ql-editor]:min-h-[200px]',
        !allowHtmlSource && '[&_.ql-editor.ql-blank]:before:text-gray-400',
        !allowHtmlSource && '[&_.ql-editor_a]:text-[#1f8dbf] [&_.ql-editor_a]:underline',
        className,
      ].filter(Boolean).join(' ')}
      style={{ minHeight: `${editorMinHeight}px` }}
    >
      {allowHtmlSource && (
        <div className="flex justify-end border-b border-gray-200 bg-gray-50 px-2 py-1.5 rounded-t-lg">
          <button
            type="button"
            onClick={() => setIsHtmlMode(!isHtmlMode)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title={isHtmlMode ? 'Switch to visual editor' : 'Edit HTML source'}
          >
            {isHtmlMode ? (
              <>
                <Eye className="h-3.5 w-3.5" />
                Visual editor
              </>
            ) : (
              <>
                <Code className="h-3.5 w-3.5" />
                HTML
              </>
            )}
          </button>
        </div>
      )}
      {isHtmlMode ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          className="w-full p-3 text-sm font-mono text-gray-800 border-0 rounded-b-lg focus:ring-0 focus:outline-none resize-y bg-white"
          style={{ minHeight: `${editorMinHeight - (allowHtmlSource ? 40 : 0)}px` }}
          spellCheck={false}
        />
      ) : (
        visualContent
      )}
    </div>
  );
});

RichTextEditor.displayName = 'RichTextEditor';

export default RichTextEditor;

