import path from 'node:path';

/** Extensions we are willing to derive from a MIME type, and vice versa. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
  yml: 'text/plain',
  yaml: 'text/plain',
  ts: 'text/plain',
  tsx: 'text/plain',
  js: 'text/plain',
  log: 'text/plain',
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function isImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/**
 * The extension to store the file under. Taken from the original name when it
 * looks sane, otherwise derived from the MIME type — a pasted screenshot
 * arrives as "image.png" or with no name at all.
 */
export function safeExtension(name: string, mime: string): string {
  const fromName = path.extname(name).replace(/^\./, '').toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[mime] ?? '';
}

export function mimeForExtension(ext: string): string {
  return MIME_BY_EXT[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A safe label for the file. Only ever used for display and for the name the
 * browser downloads it under — never to build a path, so a hostile name cannot
 * escape the files directory.
 */
export function displayName(name: string, fallback: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : fallback;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
