import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Task } from './types.ts';

/**
 * A card's plan and result as a standalone document in a new tab, laid out for
 * paper and opened straight into the browser's print dialog -- "Save as PDF"
 * there is what produces the file.
 *
 * The document carries its own light stylesheet rather than the board's: the
 * board is dark because it is looked at all day, a page is white because it is
 * printed, and the two sets of rules have almost nothing in common.
 */

/** The accents the drawer uses for these two tabs, dark enough to read on white. */
const PLAN_TONE = '#4338ca';
const RESULT_TONE = '#047857';

interface Section {
  label: string;
  tone: string;
  markdown: string;
}

function sections(task: Task): Section[] {
  const out: Section[] = [];
  if (task.plan?.trim()) out.push({ label: 'Plan', tone: PLAN_TONE, markdown: task.plan });
  if (task.result?.trim()) out.push({ label: 'Result', tone: RESULT_TONE, markdown: task.result });
  return out;
}

/** Whether there is anything worth opening a tab for. */
export function hasPrintableContent(task: Task): boolean {
  return sections(task).length > 0;
}

/**
 * The same markdown pipeline the drawer renders with, so the page cannot drift
 * from what the card shows. react-markdown escapes its input and no raw-HTML
 * plugin is enabled, so the result is safe to drop into the document.
 *
 * The server renderer is a third of the board's bundle and only this one button
 * needs it, so it is fetched on first use instead of shipped with the app.
 */
async function markdownToHtml(markdown: string): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Browsers propose the document title as the filename in the save dialog, so
 * this is the name the PDF gets. Slashes and colons are stripped because some
 * of them turn into path separators on the way to disk.
 */
export function documentTitle(task: Task): string {
  const title = task.title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return `#${task.number}${title ? ` ${title}` : ''}`;
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    background: #eceef1;
    color: #1b1f27;
    font: 400 15px/1.7 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* Screen only: a way back into the dialog once it has been dismissed. */
  .pk-bar {
    position: sticky; top: 0; z-index: 2;
    display: flex; justify-content: center;
    padding: 0.7rem; background: rgba(255, 255, 255, 0.88);
    border-bottom: 1px solid #dfe3e8; backdrop-filter: blur(6px);
  }
  .pk-bar button {
    font: inherit; font-size: 13px; font-weight: 500;
    padding: 0.4rem 0.95rem; cursor: pointer;
    background: #fff; color: #1b1f27;
    border: 1px solid #c8cdd5; border-radius: 6px;
  }
  .pk-bar button:hover { border-color: #6b7280; }

  .pk-page {
    max-width: 44rem; margin: 2.5rem auto 4rem; padding: 3.25rem 3.5rem;
    background: #fff; border: 1px solid #e1e5ea; border-radius: 4px;
    box-shadow: 0 1px 3px rgba(16, 20, 28, 0.06), 0 12px 32px rgba(16, 20, 28, 0.07);
  }
  .pk-section + .pk-section { margin-top: 2.75rem; }
  .pk-label {
    margin: 0 0 1.15rem; padding-bottom: 0.55rem;
    border-bottom: 1px solid #e4e7ec;
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
    /* Never let a section start at the very bottom of a page. */
    break-after: avoid; page-break-after: avoid;
  }

  .pk-md > :first-child { margin-top: 0; }
  .pk-md > * + * { margin-top: 0.85em; }
  .pk-md h1, .pk-md h2, .pk-md h3, .pk-md h4 {
    color: #11151c; font-weight: 600; line-height: 1.3; margin-top: 1.8em;
    break-after: avoid; page-break-after: avoid;
  }
  .pk-md h1 { font-size: 1.35rem; }
  .pk-md h2 { font-size: 1.15rem; }
  .pk-md h3 { font-size: 1.02rem; }
  .pk-md h4 { font-size: 0.95rem; }
  .pk-md ul, .pk-md ol { padding-left: 1.4rem; }
  .pk-md ul { list-style: disc; }
  .pk-md ol { list-style: decimal; }
  .pk-md li + li { margin-top: 0.3em; }
  .pk-md li { break-inside: avoid; page-break-inside: avoid; }
  .pk-md code {
    background: #f4f5f7; border: 1px solid #e4e7ec; border-radius: 4px;
    padding: 0.1em 0.35em; font-size: 0.86em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .pk-md pre {
    background: #f7f8fa; border: 1px solid #e4e7ec; border-radius: 8px;
    padding: 0.8rem 1rem;
    /* Paper has no horizontal scrollbar, so long lines have to wrap instead. */
    white-space: pre-wrap; word-break: break-word;
    break-inside: avoid; page-break-inside: avoid;
  }
  .pk-md pre code { background: none; border: 0; padding: 0; font-size: 0.85em; }
  .pk-md a { color: #1d4ed8; }
  .pk-md blockquote {
    margin-left: 0; border-left: 3px solid #dfe3e8; padding-left: 1rem; color: #4b5563;
  }
  .pk-md table {
    width: 100%; border-collapse: collapse; font-size: 0.9em;
    break-inside: avoid; page-break-inside: avoid;
  }
  .pk-md th, .pk-md td {
    border: 1px solid #e0e4e9; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top;
  }
  .pk-md th { background: #f6f7f9; font-weight: 600; }
  .pk-md hr { border: 0; border-top: 1px solid #e4e7ec; margin: 1.6em 0; }
  .pk-md img { max-width: 100%; }

  @page { margin: 18mm 16mm; }
  @media print {
    body { background: #fff; }
    .pk-bar { display: none; }
    .pk-page {
      max-width: none; margin: 0; padding: 0;
      border: 0; border-radius: 0; box-shadow: none;
    }
    /* A link is not clickable on paper, so it has to say where it goes. */
    .pk-md a[href^="http"]::after {
      content: " (" attr(href) ")";
      font-size: 0.85em; color: #6b7280; word-break: break-all;
    }
  }
`;

/**
 * Opens the dialog once the document is on screen. The listener is registered
 * while the page is still parsing, so it also catches the load that document
 * .close() fires; the readyState check covers a browser that got there first.
 */
const AUTO_PRINT = `
  (function () {
    function print() {
      try { window.focus(); } catch (e) {}
      window.print();
    }
    if (document.readyState === 'complete') setTimeout(print, 60);
    else window.addEventListener('load', function () { setTimeout(print, 60); });
  })();
`;

/** The whole page as one string. Exported so it can be tested without a browser. */
export async function buildPrintDocument(task: Task): Promise<string> {
  const rendered = await Promise.all(
    sections(task).map(async (s) => ({ ...s, html: await markdownToHtml(s.markdown) })),
  );
  const body = rendered
    .map(
      (s) =>
        `<section class="pk-section">` +
        `<h1 class="pk-label" style="color: ${s.tone}">${s.label}</h1>` +
        `<div class="pk-md">${s.html}</div>` +
        `</section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle(task))}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="pk-bar"><button type="button" onclick="window.print()">Save as PDF</button></div>
<main class="pk-page">${body}</main>
<script>${AUTO_PRINT}</script>
</body>
</html>`;
}

/**
 * Writes the document into a new tab. The tab is opened first and filled once
 * the renderer has loaded: opening it straight from the click is what keeps it
 * out of the pop-up blocker, and anything after an await would be caught by it.
 * Returns false when it was blocked anyway -- the one failure worth reporting.
 */
export function openPrintView(task: Task): boolean {
  const tab = window.open('', '_blank');
  if (!tab) return false;

  void buildPrintDocument(task).then((html) => {
    // The tab is the user's; they may well have closed it again by now.
    if (tab.closed) return;
    try {
      tab.document.open();
      tab.document.write(html);
      tab.document.close();
    } catch {
      /* closed or navigated away mid-write */
    }
  });

  return true;
}
