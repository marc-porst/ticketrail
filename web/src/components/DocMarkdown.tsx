import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/** Long documents (skills) read better with a label on each code block. */
const DOC_COMPONENTS: Components = {
  pre({ children }) {
    const code = isValidElement<{ className?: string }>(children) ? children : null;
    const language = /language-([\w+-]+)/.exec(code?.props.className ?? '')?.[1];
    return (
      <div className="pk-code">
        {language && <span className="pk-code-lang">{language}</span>}
        <pre>{children as ReactNode}</pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="pk-table">
        <table>{children}</table>
      </div>
    );
  },
};

/**
 * Markdown for long documents (skills): a roomier type scale, labelled and
 * highlighted code, scrolling tables. Kept apart from `Markdown` so the
 * highlighter only loads with the Skills view.
 */
export function DocMarkdown({ children, empty }: { children: string; empty?: string }) {
  if (!children.trim()) {
    return <p className="text-sm text-zinc-600 italic">{empty ?? 'Nothing here yet.'}</p>;
  }
  return (
    <div className="prose-pk prose-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={DOC_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
