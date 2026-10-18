import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children, empty }: { children: string; empty?: string }) {
  if (!children.trim()) {
    return <p className="text-sm text-zinc-600 italic">{empty ?? 'Nothing here yet.'}</p>;
  }
  return (
    <div className="prose-pk">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
