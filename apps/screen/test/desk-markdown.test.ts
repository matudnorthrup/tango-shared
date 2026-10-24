import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { promptLike, renderMarkdown } from '../public/desk/md.js';

// The Conversation view renders agent replies in full: the markdown shapes agents write, and nothing unsafe.

describe('renderMarkdown', () => {
  it('escapes HTML before anything else', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> and <script>bad()</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('links only http(s) URLs, opening in a new tab', () => {
    expect(renderMarkdown('[ACM-1](https://example.com/a)')).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">ACM-1</a>');
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
    expect(renderMarkdown('see https://example.com/b.')).toContain('<a href="https://example.com/b"');
  });

  it('headings, paragraphs, bold, italic and code', () => {
    const out = renderMarkdown('## Next idea\n\nThe **problem** is *small* and `cheap`.\nSecond line.');
    expect(out).toContain('<h3>Next idea</h3>');
    expect(out).toContain('<p>The <strong>problem</strong> is <em>small</em> and <code>cheap</code>.<br>Second line.</p>');
  });

  it('bullet and numbered lists, with one level of nesting', () => {
    const out = renderMarkdown('- one\n- two\n  - two a\n1. first\n2. second');
    expect(out).toContain('<ul><li>one</li><li>two<ul><li>two a</li></ul></li></ul>');
    expect(out).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('pipe tables', () => {
    const out = renderMarkdown('| Trigger | Share |\n|---|---|\n| Search | **74%** |');
    expect(out).toContain('<th>Trigger</th>');
    expect(out).toContain('<td><strong>74%</strong></td>');
  });

  it('fenced code is left as text, with Wrap and Copy buttons', () => {
    const out = renderMarkdown('```\n**not bold** <b>\n```');
    expect(out).toContain('<pre><code>**not bold** &lt;b&gt;</code></pre>');
    expect(out).toContain('data-code="wrap"');
    expect(out).toContain('data-code="copy"');
  });

  it('a block that reads like a prompt gets Start; code and one-liners do not', () => {
    const prompt = 'In tango, add a Start button to code blocks that opens Start work with the block as the prompt.';
    expect(renderMarkdown(`\`\`\`\n${prompt}\n\`\`\``)).toContain('data-code="start"');
    expect(renderMarkdown(`\`\`\`markdown\n${prompt}\n\`\`\``)).toContain('data-code="start"');
    expect(renderMarkdown(`\`\`\`\n${prompt}\n\`\`\``)).toContain('<div class="md-code wrap">'); // prose starts wrapped
    expect(renderMarkdown('```\nDon\'t merge it yet; the "quiet window" isn\'t until eleven, so wait for it and then restart.\n```')).toContain('data-code="start"');
    expect(renderMarkdown(`\`\`\`bash\n${prompt}\n\`\`\``)).not.toContain('data-code="start"');
    expect(renderMarkdown('```\nnpm test\n```')).not.toContain('data-code="start"');
    expect(promptLike('TEXT', prompt)).toBe(true);
    expect(promptLike('ts', prompt)).toBe(false);
    const command = 'npm run migrate -- --apply --database ./data/dev.db --table desk_items --batch-size 500\nrewrote 1,284 rows in 3 batches; 0 skipped; indexes rebuilt (desk_items_by_state, desk_items_by_activity)';
    expect(promptLike('', command)).toBe(false);
  });

  it('a longer fence holds a shorter one, so a prompt can carry its own code block', () => {
    const out = renderMarkdown('````\nRun this first:\n```bash\nnpm test\n```\nThen fix what fails.\n````\nafter');
    expect(out).toContain('<code>Run this first:\n```bash\nnpm test\n```\nThen fix what fails.</code>');
    expect(out).toContain('<p>after</p>');
  });

  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});
