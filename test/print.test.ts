import { describe, expect, it } from 'vitest';
import { buildPrintDocument, documentTitle, hasPrintableContent } from '../web/src/lib/print.tsx';
import type { Task } from '../src/core/task.ts';

const card = (fields: Partial<Task>): Task =>
  ({ id: 't_1', number: 7, title: 'Paginate the activity feed', plan: null, result: null, ...fields }) as Task;

describe('printable content', () => {
  it('needs a plan or a result', () => {
    expect(hasPrintableContent(card({}))).toBe(false);
    expect(hasPrintableContent(card({ plan: '## Approach' }))).toBe(true);
    expect(hasPrintableContent(card({ result: 'Shipped it.' }))).toBe(true);
  });

  it('treats a blank section as absent', () => {
    expect(hasPrintableContent(card({ plan: '   \n\n  ' }))).toBe(false);
  });
});

describe('print document', () => {
  it('carries plan and result, in that order', async () => {
    const html = await buildPrintDocument(card({ plan: 'The plan.', result: 'The result.' }));
    expect(html).toContain('The plan.');
    expect(html).toContain('The result.');
    expect(html.indexOf('>Plan<')).toBeLessThan(html.indexOf('>Result<'));
  });

  it('leaves out a section the card does not have', async () => {
    const html = await buildPrintDocument(card({ result: 'Shipped it.' }));
    expect(html).not.toContain('>Plan<');
    expect(html).toContain('>Result<');
  });

  it('renders markdown rather than printing it raw', async () => {
    const html = await buildPrintDocument(card({ plan: '## Approach\n\n- one\n- two\n\n```\nnpm test\n```' }));
    expect(html).toContain('<h2>Approach</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<pre><code>npm test');
    expect(html).not.toContain('## Approach');
  });

  it('names the document after the card, which is the filename the browser offers', () => {
    expect(documentTitle(card({}))).toBe('#7 Paginate the activity feed');
    // Path separators would follow the name onto disk.
    expect(documentTitle(card({ title: 'Fix auth/session bug' }))).toBe('#7 Fix auth session bug');
  });

  it('keeps the title out of the markup', async () => {
    // Angle brackets are illegal in a filename, so they are gone before escaping.
    const tags = await buildPrintDocument(card({ title: 'Kill the <script> tag', plan: 'x' }));
    expect(tags).toContain('<title>#7 Kill the script tag</title>');
    // An ampersand is a legal filename character and has to survive as an entity.
    const amp = await buildPrintDocument(card({ title: 'Auth & session', plan: 'x' }));
    expect(amp).toContain('<title>#7 Auth &amp; session</title>');
  });

  it('opens the print dialog by itself', async () => {
    expect(await buildPrintDocument(card({ plan: 'x' }))).toContain('window.print()');
  });
});
