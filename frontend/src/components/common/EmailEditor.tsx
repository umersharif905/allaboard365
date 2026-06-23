import React, { useState, useCallback, useRef } from 'react';
import {
  Type, Image as ImageIcon, Columns, Minus, MousePointer, Square, ChevronUp, ChevronDown,
  Trash2, Copy, Plus, Eye, Code, AlignLeft, AlignCenter, AlignRight, Upload, FileCode, GripVertical, ArrowLeft
} from 'lucide-react';
import { apiService } from '../../services/api.service';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════
type BlockType = 'text' | 'image' | 'button' | 'divider' | 'spacer' | 'columns' | 'html';

interface BaseBlock {
  id: string; type: BlockType; bgColor?: string;
  paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number;
}
interface TextBlock extends BaseBlock { type: 'text'; content: string; fontSize: number; color: string; align: 'left' | 'center' | 'right'; fontWeight: 'normal' | 'bold'; padding: number; }
interface ImageBlock extends BaseBlock { type: 'image'; src: string; alt: string; width: string; align: 'left' | 'center' | 'right'; href: string; padding: number; }
interface ButtonBlock extends BaseBlock { type: 'button'; text: string; href: string; backgroundColor: string; textColor: string; borderRadius: number; align: 'left' | 'center' | 'right'; padding: number; fontSize: number; }
interface DividerBlock extends BaseBlock { type: 'divider'; color: string; thickness: number; padding: number; }
interface SpacerBlock extends BaseBlock { type: 'spacer'; height: number; }
interface ColumnsBlock extends BaseBlock { type: 'columns'; columnCount: 2 | 3; columns: EmailBlock[][]; gap: number; padding: number; columnWidths?: number[]; }
interface HtmlBlock extends BaseBlock { type: 'html'; content: string; padding: number; }
type EmailBlock = TextBlock | ImageBlock | ButtonBlock | DividerBlock | SpacerBlock | ColumnsBlock | HtmlBlock;

interface BlockSelection { blockId: string; columnIndex?: number; innerBlockId?: string; }

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
const uid = () => Math.random().toString(36).substring(2, 10);

const getPad = (b: EmailBlock) => {
  const p = (b as any).padding ?? 16;
  const t = b.paddingTop ?? p;
  const r = b.paddingRight ?? p;
  const bot = b.paddingBottom ?? p;
  const l = b.paddingLeft ?? p;
  return { t, r, b: bot, l, css: `${t}px ${r}px ${bot}px ${l}px`, style: { paddingTop: t, paddingRight: r, paddingBottom: bot, paddingLeft: l } };
};

const createBlock = (type: BlockType): EmailBlock => {
  const id = uid();
  switch (type) {
    case 'text': return { id, type: 'text', content: 'Enter your text here...', fontSize: 16, color: '#333333', align: 'left', fontWeight: 'normal', padding: 16 };
    case 'image': return { id, type: 'image', src: '', alt: 'Image', width: '100%', align: 'center', href: '', padding: 16 };
    case 'button': return { id, type: 'button', text: 'Click Here', href: '#', backgroundColor: '#1f6db0', textColor: '#ffffff', borderRadius: 6, align: 'center', padding: 16, fontSize: 16 };
    case 'divider': return { id, type: 'divider', color: '#e5e7eb', thickness: 1, padding: 16 };
    case 'spacer': return { id, type: 'spacer', height: 32 };
    case 'columns': return { id, type: 'columns', columnCount: 2, columns: [[], []], gap: 16, padding: 16 };
    case 'html': return { id, type: 'html', content: '<div style="padding:16px;">Custom HTML here</div>', padding: 0 };
  }
};

const getBlock = (blocks: EmailBlock[], sel: BlockSelection): EmailBlock | null => {
  const parent = blocks.find(b => b.id === sel.blockId);
  if (!parent) return null;
  if (sel.innerBlockId && parent.type === 'columns' && sel.columnIndex !== undefined) {
    return parent.columns[sel.columnIndex]?.find(b => b.id === sel.innerBlockId) || null;
  }
  return parent;
};

const updateBlockIn = (blocks: EmailBlock[], sel: BlockSelection, updated: EmailBlock): EmailBlock[] => {
  return blocks.map(b => {
    if (b.id !== sel.blockId) return b;
    if (sel.innerBlockId && b.type === 'columns' && sel.columnIndex !== undefined) {
      return { ...b, columns: b.columns.map((col, i) => i === sel.columnIndex ? col.map(ib => ib.id === sel.innerBlockId ? updated : ib) : col) };
    }
    return updated;
  });
};

const deleteBlockIn = (blocks: EmailBlock[], sel: BlockSelection): EmailBlock[] => {
  if (sel.innerBlockId && sel.columnIndex !== undefined) {
    return blocks.map(b => {
      if (b.id !== sel.blockId || b.type !== 'columns') return b;
      return { ...b, columns: b.columns.map((col, i) => i === sel.columnIndex ? col.filter(ib => ib.id !== sel.innerBlockId) : col) };
    });
  }
  return blocks.filter(b => b.id !== sel.blockId);
};

const insertBlockAt = (blocks: EmailBlock[], index: number, newBlock: EmailBlock): EmailBlock[] => {
  const next = [...blocks];
  next.splice(index, 0, newBlock);
  return next;
};

const insertBlockInColumn = (blocks: EmailBlock[], parentId: string, colIndex: number, position: number, newBlock: EmailBlock): EmailBlock[] => {
  return blocks.map(b => {
    if (b.id !== parentId || b.type !== 'columns') return b;
    return { ...b, columns: b.columns.map((col, i) => {
      if (i !== colIndex) return col;
      const next = [...col];
      next.splice(position, 0, newBlock);
      return next;
    })};
  });
};

const removeBlock = (blocks: EmailBlock[], blockId: string, parentId?: string, colIndex?: number): { blocks: EmailBlock[]; removed: EmailBlock | null } => {
  if (parentId && colIndex !== undefined) {
    let removed: EmailBlock | null = null;
    const newBlocks = blocks.map(b => {
      if (b.id !== parentId || b.type !== 'columns') return b;
      return { ...b, columns: b.columns.map((col, i) => {
        if (i !== colIndex) return col;
        return col.filter(ib => { if (ib.id === blockId) { removed = ib; return false; } return true; });
      })};
    });
    return { blocks: newBlocks, removed };
  }
  const removed = blocks.find(b => b.id === blockId) || null;
  return { blocks: blocks.filter(b => b.id !== blockId), removed };
};

// ═══════════════════════════════════════════════════════════════
// HTML EXPORT
// ═══════════════════════════════════════════════════════════════
const blockToHtml = (block: EmailBlock): string => {
  const bg = block.bgColor ? `background-color:${block.bgColor};` : '';
  const pad = getPad(block).css;
  switch (block.type) {
    case 'text': return `<div style="${bg}padding:${pad};text-align:${block.align};font-size:${block.fontSize}px;color:${block.color};font-weight:${block.fontWeight};font-family:Arial,Helvetica,sans-serif;line-height:1.5;">${block.content}</div>`;
    case 'image': {
      const m = block.align === 'center' ? 'margin:0 auto' : block.align === 'right' ? 'margin:0 0 0 auto' : 'margin:0';
      const img = `<img src="${block.src}" alt="${block.alt}" style="max-width:100%;width:${block.width};height:auto;display:block;${m};" />`;
      return `<div style="${bg}padding:${pad};">${block.href ? `<a href="${block.href}" target="_blank" style="display:block;${m};">${img}</a>` : img}</div>`;
    }
    case 'button': return `<div style="${bg}padding:${pad};text-align:${block.align};"><a href="${block.href}" target="_blank" style="display:inline-block;background-color:${block.backgroundColor};color:${block.textColor};padding:12px 28px;border-radius:${block.borderRadius}px;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:${block.fontSize}px;font-weight:bold;">${block.text}</a></div>`;
    case 'divider': return `<div style="${bg}padding:${pad};"><hr style="border:none;border-top:${block.thickness}px solid ${block.color};margin:0;" /></div>`;
    case 'spacer': return `<div style="${bg}height:${block.height}px;"></div>`;
    case 'html': return block.content;
    case 'columns': {
      const defaultW = block.columnCount === 2 ? 50 : 33.33;
      const widths = block.columnWidths || Array(block.columnCount).fill(defaultW);
      const cols = block.columns.slice(0, block.columnCount).map((col, i) => `<td style="width:${widths[i] || defaultW}%;vertical-align:top;padding:0 ${block.gap / 2}px;">${col.map(blockToHtml).join('')}</td>`).join('');
      return `<div style="${bg}padding:${pad};"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cols}</tr></table></div>`;
    }
  }
};

const exportHtml = (blocks: EmailBlock[], bgColor: string): string => {
  const body = blocks.map(blockToHtml).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head><body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 0;"><table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:${bgColor};max-width:600px;width:100%;"><tr><td>${body}</td></tr></table></td></tr></table></body></html>`;
};

// ═══════════════════════════════════════════════════════════════
// TOOLBOX CONFIG
// ═══════════════════════════════════════════════════════════════
const BLOCK_TYPES: { type: BlockType; icon: React.ElementType; label: string }[] = [
  { type: 'text', icon: Type, label: 'Text' },
  { type: 'image', icon: ImageIcon, label: 'Image' },
  { type: 'button', icon: MousePointer, label: 'Button' },
  { type: 'divider', icon: Minus, label: 'Divider' },
  { type: 'spacer', icon: Square, label: 'Spacer' },
  { type: 'columns', icon: Columns, label: 'Columns' },
  { type: 'html', icon: FileCode, label: 'HTML' },
];

// ═══════════════════════════════════════════════════════════════
// SHARED UI
// ═══════════════════════════════════════════════════════════════
const AlignButtons: React.FC<{ value: string; onChange: (v: 'left' | 'center' | 'right') => void }> = ({ value, onChange }) => (
  <div className="flex border border-gray-300 rounded overflow-hidden">
    {(['left', 'center', 'right'] as const).map(a => (
      <button key={a} type="button" onClick={() => onChange(a)} className={`flex-1 p-1.5 ${value === a ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
        {a === 'left' ? <AlignLeft className="h-4 w-4 mx-auto" /> : a === 'center' ? <AlignCenter className="h-4 w-4 mx-auto" /> : <AlignRight className="h-4 w-4 mx-auto" />}
      </button>
    ))}
  </div>
);
const PF: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (<div className="mb-3"><label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>{children}</div>);

const PaddingControl: React.FC<{ block: EmailBlock; onChange: (f: Partial<EmailBlock>) => void }> = ({ block, onChange }) => {
  const p = getPad(block);
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-gray-600 mb-1">Padding</label>
      <div className="grid grid-cols-4 gap-1">
        <div>
          <span className="text-[9px] text-gray-400 block text-center">Top</span>
          <input type="number" value={p.t} onChange={e => onChange({ paddingTop: +e.target.value } as any)} min={0} max={64} className="w-full px-1 py-1 text-xs text-center border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary" />
        </div>
        <div>
          <span className="text-[9px] text-gray-400 block text-center">Right</span>
          <input type="number" value={p.r} onChange={e => onChange({ paddingRight: +e.target.value } as any)} min={0} max={64} className="w-full px-1 py-1 text-xs text-center border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary" />
        </div>
        <div>
          <span className="text-[9px] text-gray-400 block text-center">Bottom</span>
          <input type="number" value={p.b} onChange={e => onChange({ paddingBottom: +e.target.value } as any)} min={0} max={64} className="w-full px-1 py-1 text-xs text-center border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary" />
        </div>
        <div>
          <span className="text-[9px] text-gray-400 block text-center">Left</span>
          <input type="number" value={p.l} onChange={e => onChange({ paddingLeft: +e.target.value } as any)} min={0} max={64} className="w-full px-1 py-1 text-xs text-center border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary" />
        </div>
      </div>
    </div>
  );
};
const ic = "w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary";

// ═══════════════════════════════════════════════════════════════
// IMAGE UPLOAD
// ═══════════════════════════════════════════════════════════════
const uploadImage = async (file: File): Promise<string> => {
  const fd = new FormData(); fd.append('files', file); fd.append('uploadType', 'logos'); fd.append('category', 'email-images');
  const r: any = await apiService.post('/api/uploads', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  if (r.success) { let u = r.data?.[0]?.url || r.url || ''; if (u.includes('?')) u = u.split('?')[0]; return u; }
  throw new Error('Upload failed');
};

const ImageDropZone: React.FC<{ onUpload: (url: string) => void }> = ({ onUpload }) => {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const handle = async (files: FileList) => {
    const f = files[0]; if (!f?.type.startsWith('image/')) return;
    setUploading(true); try { onUpload(await uploadImage(f)); } catch {} finally { setUploading(false); }
  };
  return (
    <div onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragOver(false); handle(e.dataTransfer.files); }}
      onClick={e => { e.stopPropagation(); ref.current?.click(); }}
      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-oe-primary bg-blue-50' : 'border-gray-300 bg-gray-50 hover:border-gray-400'}`}>
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={e => e.target.files && handle(e.target.files)} />
      {uploading ? <><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto mb-1" /><span className="text-xs text-gray-500">Uploading...</span></>
        : <><Upload className="h-6 w-6 text-gray-400 mx-auto mb-1" /><p className="text-xs text-gray-500">Drop image or click to upload</p></>}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// DROP ZONE INDICATOR
// ═══════════════════════════════════════════════════════════════
interface DropZoneProps {
  isActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}
const DropZone: React.FC<DropZoneProps> = ({ isActive, onDragOver, onDragLeave, onDrop }) => (
  <div className={`transition-all ${isActive ? 'h-1 bg-blue-500 rounded-full my-1' : 'h-0'}`}
    onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} />
);

// ═══════════════════════════════════════════════════════════════
// BLOCK PROPERTIES SIDEBAR
// ═══════════════════════════════════════════════════════════════
const BlockProperties: React.FC<{
  block: EmailBlock; onChange: (u: EmailBlock) => void;
  variables?: { group: string; variables: { name: string; label: string }[] }[];
  editableRef: React.RefObject<HTMLDivElement | null>;
}> = ({ block, onChange, variables, editableRef }) => {
  const up = (f: Partial<EmailBlock>) => onChange({ ...block, ...f } as EmailBlock);

  const bgColorField = (
    <PF label="Block Background">
      <div className="flex items-center gap-2">
        <input type="color" value={block.bgColor || '#ffffff'} onChange={e => up({ bgColor: e.target.value === '#ffffff' ? undefined : e.target.value } as any)} className="h-8 w-12 cursor-pointer rounded border border-gray-300" />
        <span className="text-xs text-gray-500">{block.bgColor || 'None'}</span>
        {block.bgColor && <button onClick={() => up({ bgColor: undefined } as any)} className="text-xs text-red-500 hover:text-red-700">Clear</button>}
      </div>
    </PF>
  );

  const insertVar = (tag: string) => {
    const el = editableRef.current;
    if (el) {
      el.focus();
      const sel = window.getSelection();
      if (sel?.rangeCount && el.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(tag)); r.collapse(false); }
      else { el.innerHTML += tag; }
      up({ content: el.innerHTML } as any);
    } else { up({ content: (block as TextBlock).content + tag } as any); }
  };

  const varSection = variables && variables.length > 0 && (block.type === 'text' || block.type === 'html') && (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="text-xs font-semibold text-gray-700 mb-2">Insert Variable</div>
      <div className="space-y-2">
        {variables.map(g => (
          <div key={g.group}>
            <div className="text-xs font-medium text-gray-500 mb-1">{g.group}</div>
            <div className="flex flex-wrap gap-1">
              {g.variables.map(v => (
                <button key={v.name} type="button" onClick={() => insertVar(`{[${v.name}]}`)}
                  className="text-xs px-2 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded border border-blue-200 transition-colors">{v.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  switch (block.type) {
    case 'text': return (<>
      <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">Click text on canvas to edit directly</div>
      <PF label="Content (HTML)"><textarea value={block.content} onChange={e => up({ content: e.target.value })} rows={4} className={ic} /></PF>
      <PF label="Font Size"><input type="number" value={block.fontSize} onChange={e => up({ fontSize: +e.target.value })} min={10} max={72} className={ic} /></PF>
      <PF label="Color"><input type="color" value={block.color} onChange={e => up({ color: e.target.value })} className="h-8 w-full cursor-pointer rounded" /></PF>
      <PF label="Weight"><select value={block.fontWeight} onChange={e => up({ fontWeight: e.target.value as any })} className={ic}><option value="normal">Normal</option><option value="bold">Bold</option></select></PF>
      <PF label="Alignment"><AlignButtons value={block.align} onChange={align => up({ align })} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
      {varSection}
    </>);
    case 'image': return (<>
      <PF label="Image">{block.src ? <div className="mb-2"><img src={block.src} alt={block.alt} className="max-h-20 rounded border mb-1" /><button onClick={() => up({ src: '' })} className="text-xs text-red-600">Remove</button></div> : null}<ImageDropZone onUpload={url => up({ src: url })} /></PF>
      <PF label="Or paste URL"><input type="url" value={block.src} onChange={e => up({ src: e.target.value })} placeholder="https://..." className={ic} /></PF>
      <PF label="Alt Text"><input type="text" value={block.alt} onChange={e => up({ alt: e.target.value })} className={ic} /></PF>
      <PF label="Width"><input type="text" value={block.width} onChange={e => up({ width: e.target.value })} placeholder="100% or 300px" className={ic} /></PF>
      <PF label="Link URL"><input type="url" value={block.href} onChange={e => up({ href: e.target.value })} placeholder="Optional" className={ic} /></PF>
      <PF label="Alignment"><AlignButtons value={block.align} onChange={align => up({ align })} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
    </>);
    case 'button': return (<>
      <PF label="Button Text"><input type="text" value={block.text} onChange={e => up({ text: e.target.value })} className={ic} /></PF>
      <PF label="Link URL"><input type="url" value={block.href} onChange={e => up({ href: e.target.value })} className={ic} /></PF>
      <PF label="Background"><input type="color" value={block.backgroundColor} onChange={e => up({ backgroundColor: e.target.value })} className="h-8 w-full cursor-pointer rounded" /></PF>
      <PF label="Text Color"><input type="color" value={block.textColor} onChange={e => up({ textColor: e.target.value })} className="h-8 w-full cursor-pointer rounded" /></PF>
      <PF label="Font Size"><input type="number" value={block.fontSize} onChange={e => up({ fontSize: +e.target.value })} min={10} max={36} className={ic} /></PF>
      <PF label="Border Radius"><input type="number" value={block.borderRadius} onChange={e => up({ borderRadius: +e.target.value })} min={0} max={50} className={ic} /></PF>
      <PF label="Alignment"><AlignButtons value={block.align} onChange={align => up({ align })} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
    </>);
    case 'divider': return (<>
      <PF label="Color"><input type="color" value={block.color} onChange={e => up({ color: e.target.value })} className="h-8 w-full cursor-pointer rounded" /></PF>
      <PF label="Thickness"><input type="number" value={block.thickness} onChange={e => up({ thickness: +e.target.value })} min={1} max={10} className={ic} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
    </>);
    case 'spacer': return (<><PF label="Height (px)"><input type="number" value={block.height} onChange={e => up({ height: +e.target.value })} min={8} max={200} className={ic} /></PF>{bgColorField}</>);
    case 'html': return (<>
      <div className="mb-3 p-2 bg-purple-50 border border-purple-200 rounded text-xs text-purple-700">Paste any HTML — rendered as-is in the email</div>
      <PF label="HTML Content"><textarea value={block.content} onChange={e => up({ content: e.target.value })} rows={12} className={`${ic} font-mono text-xs`} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
      {varSection}
    </>);
    case 'columns': {
      const defaultW = block.columnCount === 2 ? 50 : 33.33;
      const widths = block.columnWidths || Array(block.columnCount).fill(defaultW);
      return (<>
      <PF label="Columns"><select value={block.columnCount} onChange={e => { const c = +e.target.value as 2|3; const cols = [...block.columns]; while(cols.length<c) cols.push([]); up({ columnCount: c, columns: cols, columnWidths: Array(c).fill(c === 2 ? 50 : 33.33) }); }} className={ic}><option value={2}>2 Columns</option><option value={3}>3 Columns</option></select></PF>
      <PF label="Column Widths (%)">
        <div className="space-y-2">
          {Array.from({ length: block.columnCount }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-12">Col {i + 1}</span>
              <input type="range" min={15} max={85} value={widths[i] || defaultW}
                onChange={e => {
                  const newVal = +e.target.value;
                  const newWidths = [...widths];
                  newWidths[i] = newVal;
                  // Auto-adjust other columns to total 100%
                  if (block.columnCount === 2) {
                    newWidths[1 - i] = 100 - newVal;
                  } else {
                    const remaining = 100 - newVal;
                    const others = newWidths.filter((_, j) => j !== i);
                    const othersTotal = others.reduce((a, b) => a + b, 0);
                    for (let j = 0; j < newWidths.length; j++) {
                      if (j !== i) newWidths[j] = othersTotal > 0 ? Math.round(remaining * (newWidths[j] / othersTotal)) : Math.round(remaining / (block.columnCount - 1));
                    }
                  }
                  up({ columnWidths: newWidths });
                }}
                className="flex-1" />
              <span className="text-xs text-gray-700 w-10 text-right">{Math.round(widths[i] || defaultW)}%</span>
            </div>
          ))}
        </div>
      </PF>
      <PF label="Gap"><input type="number" value={block.gap} onChange={e => up({ gap: +e.target.value })} min={0} max={48} className={ic} /></PF>
      <PaddingControl block={block} onChange={up} />
      {bgColorField}
    </>);
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// MAIN EDITOR
// ═══════════════════════════════════════════════════════════════
interface EmailEditorProps {
  initialHtml?: string;
  initialDesign?: string;
  onSave: (html: string, designJson: string) => void;
  onCancel: () => void;
  variables?: { group: string; variables: { name: string; label: string }[] }[];
  /** When true, renders inline (no fixed overlay, no top bar) — for embedding inside a modal */
  inline?: boolean;
}

// Extract design JSON from HTML body comment if present
const extractDesignFromHtml = (html?: string): string | null => {
  if (!html) return null;
  const match = html.match(/<!-- DESIGN_JSON:(.*?) -->/s);
  return match?.[1] || null;
};

const EmailEditor: React.FC<EmailEditorProps> = ({ initialDesign, initialHtml, onSave, onCancel, variables, inline }) => {
  const [blocks, setBlocks] = useState<EmailBlock[]>(() => {
    // Try explicit design JSON first
    if (initialDesign) { try { return JSON.parse(initialDesign); } catch {} }
    // Try extracting from HTML body
    const embedded = extractDesignFromHtml(initialHtml);
    if (embedded) { try { return JSON.parse(embedded); } catch {} }
    // Fallback: no design JSON. Import the existing body so legacy and
    // plain-text (merge-token) templates are visible and editable instead of
    // opening blank — which would otherwise silently wipe content on save.
    const existing = (initialHtml || '').replace(/\n?<!-- DESIGN_JSON:.*? -->/s, '').trim();
    if (!existing) return [];
    // Already-HTML bodies: keep verbatim in one source block so markup isn't
    // mangled. Plain text: one editable text block per blank-line paragraph
    // (intra-paragraph newlines preserved as <br>) so it reads cleanly.
    const looksHtml = /<[a-z][\s\S]*?>/i.test(existing);
    if (looksHtml) {
      return [{ id: uid(), type: 'html' as const, content: existing, padding: 0 }];
    }
    const paragraphs = existing.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const textBlocks: EmailBlock[] = paragraphs.map((p) => ({
      id: uid(), type: 'text' as const, content: p.replace(/\n/g, '<br>'),
      fontSize: 14, color: '#333333', align: 'left' as const, fontWeight: 'normal' as const, padding: 12,
    }));
    return textBlocks.length ? textBlocks : [{ id: uid(), type: 'html' as const, content: existing, padding: 0 }];
  });
  const [selection, setSelection] = useState<BlockSelection | null>(null);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [showPreview, setShowPreview] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ index: number; parentId?: string; colIndex?: number } | null>(null);
  const [dragging, setDragging] = useState<{ blockType?: BlockType; blockId?: string; parentId?: string; colIndex?: number } | null>(null);
  const editableRef = useRef<HTMLDivElement | null>(null);

  const selectedBlock = selection ? getBlock(blocks, selection) : null;
  const isInnerSelected = !!(selection?.innerBlockId);

  // ── Block operations ──
  const handleUpdateBlock = useCallback((updated: EmailBlock) => {
    if (!selection) return;
    setBlocks(prev => updateBlockIn(prev, selection, updated));
  }, [selection]);

  const handleDelete = useCallback((sel: BlockSelection) => {
    setBlocks(prev => deleteBlockIn(prev, sel));
    if (selection?.blockId === sel.blockId && selection?.innerBlockId === sel.innerBlockId) setSelection(null);
  }, [selection]);

  const handleDuplicate = useCallback((sel: BlockSelection) => {
    setBlocks(prev => {
      const block = getBlock(prev, sel);
      if (!block) return prev;
      const clone: EmailBlock = { ...JSON.parse(JSON.stringify(block)), id: uid() };
      if (sel.innerBlockId && sel.columnIndex !== undefined) {
        return prev.map(b => {
          if (b.id !== sel.blockId || b.type !== 'columns') return b;
          return { ...b, columns: b.columns.map((col, i) => {
            if (i !== sel.columnIndex) return col;
            const idx = col.findIndex(ib => ib.id === sel.innerBlockId);
            const next = [...col]; next.splice(idx + 1, 0, clone); return next;
          })};
        });
      }
      const idx = prev.findIndex(b => b.id === sel.blockId);
      const next = [...prev]; next.splice(idx + 1, 0, clone); return next;
    });
  }, []);

  const handleMove = useCallback((sel: BlockSelection, dir: -1 | 1) => {
    setBlocks(prev => {
      if (sel.innerBlockId && sel.columnIndex !== undefined) {
        return prev.map(b => {
          if (b.id !== sel.blockId || b.type !== 'columns') return b;
          return { ...b, columns: b.columns.map((col, i) => {
            if (i !== sel.columnIndex) return col;
            const idx = col.findIndex(ib => ib.id === sel.innerBlockId);
            const t = idx + dir; if (t < 0 || t >= col.length) return col;
            const next = [...col]; [next[idx], next[t]] = [next[t], next[idx]]; return next;
          })};
        });
      }
      const idx = prev.findIndex(b => b.id === sel.blockId);
      const t = idx + dir; if (t < 0 || t >= prev.length) return prev;
      const next = [...prev]; [next[idx], next[t]] = [next[t], next[idx]]; return next;
    });
  }, []);

  // ── Drag and Drop ──
  const handleDragStart = (e: React.DragEvent, data: typeof dragging) => {
    e.dataTransfer.effectAllowed = data?.blockType ? 'copy' : 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(data));
    setDragging(data);
  };

  const handleDragOver = (e: React.DragEvent, target: typeof dropTarget) => {
    e.preventDefault();
    e.stopPropagation();
    // Don't allow dropping columns inside columns
    if (target?.parentId && dragging?.blockType === 'columns') return;
    setDropTarget(target);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dropTarget || !dragging) { setDragging(null); setDropTarget(null); return; }

    setBlocks(prev => {
      let newBlocks = [...prev];
      let blockToInsert: EmailBlock;

      if (dragging.blockType) {
        // Dragging from toolbox — create new block
        blockToInsert = createBlock(dragging.blockType);
      } else if (dragging.blockId) {
        // Dragging existing block — remove from old position first
        const result = removeBlock(newBlocks, dragging.blockId, dragging.parentId, dragging.colIndex);
        newBlocks = result.blocks;
        if (!result.removed) return prev;
        blockToInsert = result.removed;
      } else return prev;

      // Insert at target
      if (dropTarget.parentId && dropTarget.colIndex !== undefined) {
        // Dropping into a column
        newBlocks = insertBlockInColumn(newBlocks, dropTarget.parentId, dropTarget.colIndex, dropTarget.index, blockToInsert);
      } else {
        // Dropping at top level
        newBlocks = insertBlockAt(newBlocks, dropTarget.index, blockToInsert);
      }

      setSelection({ blockId: dropTarget.parentId || blockToInsert.id, columnIndex: dropTarget.colIndex, innerBlockId: dropTarget.parentId ? blockToInsert.id : undefined });
      return newBlocks;
    });

    setDragging(null);
    setDropTarget(null);
  };

  const clearDrag = () => { setDragging(null); setDropTarget(null); };

  // ── Content change for inline editing ──
  const handleContentChange = useCallback((sel: BlockSelection, content: string) => {
    setBlocks(prev => {
      const block = getBlock(prev, sel);
      if (!block) return prev;
      if (block.type === 'text' || block.type === 'html') return updateBlockIn(prev, sel, { ...block, content });
      if (block.type === 'image') return updateBlockIn(prev, sel, { ...block, src: content });
      return prev;
    });
  }, []);

  // ── Render a single block on canvas ──
  const renderBlock = (block: EmailBlock, sel: BlockSelection, isSelected: boolean) => {
    const blockStyle: React.CSSProperties = block.bgColor ? { backgroundColor: block.bgColor } : {};
    const renderInner = () => {
      switch (block.type) {
        case 'text': return (
          <div style={getPad(block).style}>
            <div ref={el => { if (isSelected && el) editableRef.current = el; }}
              contentEditable={isSelected} suppressContentEditableWarning
              onBlur={e => handleContentChange(sel, e.currentTarget.innerHTML)}
              onFocus={e => { editableRef.current = e.currentTarget; }}
              style={{ textAlign: block.align, fontSize: block.fontSize, color: block.color, fontWeight: block.fontWeight, lineHeight: 1.5, outline: 'none', minHeight: '1.5em' }}
              dangerouslySetInnerHTML={{ __html: block.content }} />
          </div>
        );
        case 'image': return (
          <div style={getPad(block).style}>
            {block.src ? <img src={block.src} alt={block.alt} style={{ maxWidth: '100%', width: block.width, height: 'auto', display: 'block', margin: block.align === 'center' ? '0 auto' : block.align === 'right' ? '0 0 0 auto' : '0' }} />
              : <ImageDropZone onUpload={url => handleContentChange(sel, url)} />}
          </div>
        );
        case 'button': return (
          <div style={{ ...getPad(block).style, textAlign: block.align }}>
            <span style={{ display: 'inline-block', backgroundColor: block.backgroundColor, color: block.textColor, padding: '12px 28px', borderRadius: block.borderRadius, fontWeight: 'bold', fontSize: block.fontSize }}>{block.text}</span>
          </div>
        );
        case 'divider': return <div style={{ padding: `${block.padding}px 0` }}><hr style={{ border: 'none', borderTop: `${block.thickness}px solid ${block.color}`, margin: 0 }} /></div>;
        case 'spacer': return <div style={{ height: block.height }} className="bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center"><span className="text-xs text-gray-400">{block.height}px</span></div>;
        case 'html': return <div style={getPad(block).style} dangerouslySetInnerHTML={{ __html: block.content }} />;
        case 'columns': return (
          <div style={{ ...getPad(block).style, display: 'flex', gap: block.gap }}>
            {block.columns.slice(0, block.columnCount).map((col, ci) => {
              const isColActive = isSelected || (selection?.blockId === block.id);
              const defaultW = block.columnCount === 2 ? 50 : 33.33;
              const colWidth = block.columnWidths?.[ci] || defaultW;
              return (
                <div key={ci} style={{ width: `${colWidth}%`, flexShrink: 0 }}
                  className={`border border-dashed rounded min-h-[60px] p-1 transition-colors ${isColActive ? 'border-blue-300 bg-blue-50/20' : 'border-gray-200 bg-gray-50'}`}
                  onDragOver={e => {
                    if (dragging?.blockType === 'columns') return;
                    handleDragOver(e, { index: col.length, parentId: block.id, colIndex: ci });
                  }}
                  onDrop={handleDrop}>
                  {col.map((ib, ibi) => {
                    const innerSel: BlockSelection = { blockId: block.id, columnIndex: ci, innerBlockId: ib.id };
                    const innerSelected = selection?.blockId === block.id && selection?.columnIndex === ci && selection?.innerBlockId === ib.id;
                    return (
                      <React.Fragment key={ib.id}>
                        {/* Drop zone between inner blocks */}
                        <DropZone
                          isActive={!!dropTarget && dropTarget.parentId === block.id && dropTarget.colIndex === ci && dropTarget.index === ibi}
                          onDragOver={e => handleDragOver(e, { index: ibi, parentId: block.id, colIndex: ci })}
                          onDragLeave={() => setDropTarget(null)} onDrop={handleDrop} />
                        <div className={`group relative rounded transition-all ${innerSelected ? 'ring-2 ring-blue-500' : 'ring-1 ring-transparent hover:ring-gray-300'}`}
                          onClick={e => { e.stopPropagation(); setSelection(innerSel); }}
                          draggable onDragStart={e => { e.stopPropagation(); handleDragStart(e, { blockId: ib.id, parentId: block.id, colIndex: ci }); }} onDragEnd={clearDrag}>
                          {renderBlock(ib, innerSel, innerSelected)}
                          {/* Inner block hover actions */}
                          <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 z-10">
                            <button onClick={e => { e.stopPropagation(); handleMove(innerSel, -1); }} className="p-0.5 bg-white rounded shadow text-gray-500 hover:text-gray-900"><ChevronUp className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleMove(innerSel, 1); }} className="p-0.5 bg-white rounded shadow text-gray-500 hover:text-gray-900"><ChevronDown className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleDuplicate(innerSel); }} className="p-0.5 bg-white rounded shadow text-gray-500 hover:text-gray-900"><Copy className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleDelete(innerSel); }} className="p-0.5 bg-white rounded shadow text-red-500 hover:text-red-700"><Trash2 className="h-3 w-3" /></button>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {/* Drop zone at end of column */}
                  <DropZone
                    isActive={!!dropTarget && dropTarget.parentId === block.id && dropTarget.colIndex === ci && dropTarget.index === col.length}
                    onDragOver={e => handleDragOver(e, { index: col.length, parentId: block.id, colIndex: ci })}
                    onDragLeave={() => setDropTarget(null)} onDrop={handleDrop} />
                  {col.length === 0 && !dropTarget && (
                    <div className="text-xs text-gray-400 flex items-center justify-center h-full py-4">
                      {dragging ? 'Drop here' : `Column ${ci + 1}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      }
    };
    return <div style={blockStyle}>{renderInner()}</div>;
  };

  const previewHtml = exportHtml(blocks, bgColor);

  // Embed design JSON as an HTML comment in the body so it persists through save/load
  const buildOutput = useCallback(() => {
    const html = exportHtml(blocks, bgColor);
    const design = JSON.stringify(blocks);
    // Append design JSON as invisible comment — stripped by email clients, preserved in DB
    return { html: html + `\n<!-- DESIGN_JSON:${design} -->`, design };
  }, [blocks, bgColor]);

  // Auto-save for inline mode — update parent whenever blocks change
  React.useEffect(() => {
    if (inline && blocks.length >= 0) {
      const { html, design } = buildOutput();
      onSave(html, design);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, bgColor, inline]);

  return (
    <div className={inline ? "flex flex-col h-full bg-gray-100" : "fixed inset-0 z-50 flex flex-col bg-gray-100"}>
      {/* ── Top Bar ── */}
      <div className="bg-white border-b border-gray-200 px-4 py-1.5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          {!inline && <h2 className="text-lg font-semibold text-gray-900">Email Editor</h2>}
          <span className="text-xs text-gray-500">{blocks.length} block{blocks.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowPreview(!showPreview); setShowHtml(false); }} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${showPreview ? 'bg-oe-primary text-white' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'}`}><Eye className="h-3.5 w-3.5" /> Preview</button>
          <button onClick={() => { setShowHtml(!showHtml); setShowPreview(false); }} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${showHtml ? 'bg-oe-primary text-white' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'}`}><Code className="h-3.5 w-3.5" /> HTML</button>
          {!inline && <>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <button onClick={onCancel} className="px-3 py-1 rounded text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</button>
            <button onClick={() => { const o = buildOutput(); onSave(o.html, o.design); }} className="px-3 py-1 rounded text-xs font-medium bg-oe-primary text-white hover:bg-oe-primary/90">Save Template</button>
          </>}
        </div>
      </div>

      {/* ── Preview / HTML ── */}
      {(showPreview || showHtml) && (
        <div className="flex-1 overflow-auto p-6 bg-gray-200 min-h-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">{showPreview ? 'Email Preview' : 'HTML Source'}</h3>
              <button onClick={() => { setShowPreview(false); setShowHtml(false); }} className="text-sm text-gray-600 hover:text-gray-900">Back to Editor</button>
            </div>
            {showPreview ? <div className="bg-white rounded-lg shadow-lg overflow-hidden"><iframe srcDoc={previewHtml} className="w-full border-0" style={{ height: '80vh' }} title="Preview" /></div>
              : <pre className="bg-white rounded-lg shadow-lg p-4 text-xs overflow-auto whitespace-pre-wrap font-mono" style={{ maxHeight: '80vh' }}>{previewHtml}</pre>}
          </div>
        </div>
      )}

      {/* ── Editor ── */}
      {!showPreview && !showHtml && (
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Toolbox */}
          <div className="w-16 bg-white border-r border-gray-200 flex flex-col items-center py-3 gap-1.5 flex-shrink-0 overflow-y-auto">
            <span className="text-xs font-medium text-gray-500 mb-1">Blocks</span>
            {BLOCK_TYPES.map(({ type, icon: Icon, label }) => (
              <button key={type} title={label}
                draggable onDragStart={e => handleDragStart(e, { blockType: type })} onDragEnd={clearDrag}
                onClick={() => { const b = createBlock(type); setBlocks(prev => [...prev, b]); setSelection({ blockId: b.id }); }}
                className="w-12 h-12 rounded-lg border border-gray-200 hover:border-oe-primary hover:bg-blue-50 flex flex-col items-center justify-center gap-0.5 transition-colors cursor-grab active:cursor-grabbing">
                <Icon className="h-4 w-4 text-gray-600" />
                <span className="text-[9px] text-gray-500 leading-tight">{label}</span>
              </button>
            ))}
          </div>

          {/* Canvas */}
          <div className="flex-1 overflow-auto p-3 min-h-0" onClick={() => setSelection(null)} onDragOver={e => { e.preventDefault(); if (!dropTarget) setDropTarget({ index: blocks.length }); }} onDrop={handleDrop}>
            <div className="max-w-[600px] mx-auto bg-white rounded-lg shadow-sm border border-gray-200 min-h-[400px]" style={{ backgroundColor: bgColor }} onClick={e => e.stopPropagation()}>
              {blocks.length === 0 && !dragging ? (
                <div className="flex flex-col items-center justify-center h-96 text-gray-400">
                  <Plus className="h-12 w-12 mb-3" /><p className="text-lg font-medium">Start building your email</p><p className="text-sm mt-1">Drag a block from the left or click to add</p>
                </div>
              ) : (
                <div>
                  {blocks.map((block, idx) => {
                    const sel: BlockSelection = { blockId: block.id };
                    const isSelected = selection?.blockId === block.id && !selection?.innerBlockId;
                    return (
                      <React.Fragment key={block.id}>
                        {/* Drop zone before block */}
                        <DropZone isActive={!!dropTarget && !dropTarget.parentId && dropTarget.index === idx}
                          onDragOver={e => handleDragOver(e, { index: idx })} onDragLeave={() => setDropTarget(null)} onDrop={handleDrop} />
                        <div className={`group relative rounded transition-all ${isSelected ? 'ring-2 ring-blue-500' : selection?.blockId === block.id ? 'ring-2 ring-blue-300' : 'ring-1 ring-transparent hover:ring-gray-300'} ${dragging?.blockId === block.id ? 'opacity-40' : ''}`}
                          onClick={e => { e.stopPropagation(); setSelection(sel); }}>
                          {/* Drag handle + hover actions */}
                          <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 z-10">
                            <div draggable onDragStart={e => { e.stopPropagation(); handleDragStart(e, { blockId: block.id }); }} onDragEnd={clearDrag}
                              className="p-1 bg-white rounded shadow text-gray-400 hover:text-gray-700 cursor-grab active:cursor-grabbing"><GripVertical className="h-3 w-3" /></div>
                            <button onClick={e => { e.stopPropagation(); handleMove(sel, -1); }} disabled={idx === 0} className="p-1 bg-white rounded shadow text-gray-500 hover:text-gray-900 disabled:opacity-30"><ChevronUp className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleMove(sel, 1); }} disabled={idx === blocks.length - 1} className="p-1 bg-white rounded shadow text-gray-500 hover:text-gray-900 disabled:opacity-30"><ChevronDown className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleDuplicate(sel); }} className="p-1 bg-white rounded shadow text-gray-500 hover:text-gray-900"><Copy className="h-3 w-3" /></button>
                            <button onClick={e => { e.stopPropagation(); handleDelete(sel); }} className="p-1 bg-white rounded shadow text-red-500 hover:text-red-700"><Trash2 className="h-3 w-3" /></button>
                          </div>
                          {isSelected && <div className="absolute top-0 right-0 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded-bl font-medium capitalize z-10">{block.type}</div>}
                          {renderBlock(block, sel, isSelected)}
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {/* Drop zone after last block */}
                  <DropZone isActive={!!dropTarget && !dropTarget.parentId && dropTarget.index === blocks.length}
                    onDragOver={e => handleDragOver(e, { index: blocks.length })} onDragLeave={() => setDropTarget(null)} onDrop={handleDrop} />
                  {dragging && <div className="h-16" />}
                </div>
              )}
              {/* Empty canvas drop target when dragging */}
              {blocks.length === 0 && dragging && (
                <div className="h-96 flex items-center justify-center" onDragOver={e => handleDragOver(e, { index: 0 })} onDrop={handleDrop}>
                  <div className="text-center text-gray-400"><p className="text-lg font-medium">Drop here</p></div>
                </div>
              )}
            </div>
          </div>

          {/* Properties Sidebar */}
          <div className="w-60 bg-white border-l border-gray-200 flex flex-col flex-shrink-0 overflow-y-auto min-h-0">
            {selectedBlock ? (
              <div className="p-4">
                {isInnerSelected && (
                  <button onClick={() => setSelection({ blockId: selection!.blockId })} className="flex items-center gap-1 text-xs text-oe-primary hover:underline mb-3">
                    <ArrowLeft className="h-3 w-3" /> Back to Column Settings
                  </button>
                )}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900 capitalize">{selectedBlock.type} Properties</h3>
                  <button onClick={() => handleDelete(selection!)} className="text-red-500 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
                </div>
                <BlockProperties block={selectedBlock} onChange={handleUpdateBlock} variables={variables} editableRef={editableRef} />
              </div>
            ) : (
              <div className="p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Email Settings</h3>
                <PF label="Background Color"><input type="color" value={bgColor} onChange={e => setBgColor(e.target.value)} className="h-8 w-full cursor-pointer rounded" /></PF>
                <p className="text-xs text-gray-400 mt-4">Select a block to edit its properties</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailEditor;
export type { EmailBlock, EmailEditorProps };
