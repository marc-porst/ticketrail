import { useEffect, useRef, useState } from 'react';
import { cx, relativeTime } from '../lib/ui.ts';
import { formatBytes, isImage, type Attachment, type Task } from '../lib/types.ts';
import { fileUrl } from '../lib/api.ts';

export function Attachments({
  task,
  projectId,
  onUpload,
  onRemove,
}: {
  task: Task;
  projectId: string;
  onUpload: (files: File[]) => Promise<void>;
  onRemove: (fileId: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy((n) => n + files.length);
    try {
      await onUpload(files);
    } finally {
      setBusy(0);
    }
  };

  // Paste a screenshot straight onto the card — the whole point of this feature.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      void send(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  return (
    <div
      className="p-5"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void send(Array.from(e.dataTransfer.files));
      }}
    >
      {task.column === 'in-progress' && (
        <p className="mb-3 rounded-md bg-emerald-500/10 px-3 py-2 text-[11.5px] text-emerald-200/90">
          Claude is working on this card. Files you add now are handed to it at its next check-in.
        </p>
      )}
      {task.attachments.length > 0 && (
        <ul className="mb-4 space-y-2">
          {task.attachments.map((file) => (
            <li
              key={file.id}
              className="group flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2"
            >
              {isImage(file.mime) ? (
                <button
                  onClick={() => setPreview(file)}
                  className="size-11 shrink-0 overflow-hidden rounded-md border border-zinc-700"
                  title="Open"
                >
                  <img src={fileUrl(projectId, file.id)} alt={file.name} className="size-full object-cover" />
                </button>
              ) : (
                <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-[var(--color-surface-3)] text-[9px] font-semibold tracking-wide text-zinc-400 uppercase">
                  {file.name.split('.').pop()?.slice(0, 4) ?? 'file'}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-zinc-200">{file.name}</p>
                <p className="text-[10.5px] text-zinc-600">
                  {formatBytes(file.size)} · {file.addedBy === 'claude' ? 'from Claude' : 'you'} ·{' '}
                  {relativeTime(file.addedAt)}
                </p>
              </div>

              <a
                href={fileUrl(projectId, file.id, true)}
                download={file.name}
                className="rounded-md px-2 py-1 text-[11px] text-zinc-500 opacity-0 transition hover:bg-white/5 hover:text-zinc-200 group-hover:opacity-100"
              >
                Download
              </a>
              <button
                onClick={() => onRemove(file.id)}
                className="rounded-md px-2 py-1 text-[11px] text-zinc-500 opacity-0 transition hover:bg-white/5 hover:text-red-400 group-hover:opacity-100"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={() => input.current?.click()}
        className={cx(
          'flex w-full flex-col items-center gap-1 rounded-xl border border-dashed py-6 text-center transition',
          dragging ? 'border-sky-500 bg-sky-500/10' : 'border-zinc-800 hover:border-zinc-600',
        )}
      >
        <span className="text-[12.5px] text-zinc-400">
          {busy ? `Uploading ${busy} file${busy > 1 ? 's' : ''}…` : 'Drop files here, paste a screenshot, or click'}
        </span>
        <span className="text-[11px] text-zinc-600">Claude opens these before it starts · 25 MB each</span>
      </button>

      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void send(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
          onClick={() => setPreview(null)}
        >
          <img
            src={fileUrl(projectId, preview.id)}
            alt={preview.name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </div>
  );
}
