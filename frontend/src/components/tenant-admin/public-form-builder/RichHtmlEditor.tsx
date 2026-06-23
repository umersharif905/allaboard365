import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const modules = {
  toolbar: [
    [{ header: [1, 2, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ align: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
    ['blockquote'],
    ['link'],
    ['clean']
  ]
};

const formats = [
  'header',
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'background',
  'align',
  'list',
  'bullet',
  'indent',
  'blockquote',
  'link'
];

export function RichHtmlEditor({
  value,
  onChange,
  className = '',
  compact = false
}: {
  value: string;
  onChange: (html: string) => void;
  className?: string;
  /** Shorter editor body — for tight layouts like the form-header card. */
  compact?: boolean;
}) {
  const heightCls = compact
    ? '[&_.ql-container]:min-h-[72px] [&_.ql-editor]:min-h-[56px]'
    : '[&_.ql-container]:min-h-[120px] [&_.ql-editor]:min-h-[100px]';
  return (
    <div className={`public-form-rich-editor ${className}`}>
      <ReactQuill
        theme="snow"
        value={value}
        onChange={onChange}
        modules={modules}
        formats={formats}
        className={`bg-white rounded border border-gray-200 ${heightCls} text-sm`}
      />
    </div>
  );
}
