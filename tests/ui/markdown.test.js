import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeMarkdownUrl } from '../../src/ui/markdown.js';

describe('Markdown renderer link safety', () => {
  it('keeps http, https, mailto, hash, root-relative and dot-relative URLs', () => {
    expect(sanitizeMarkdownUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(sanitizeMarkdownUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(sanitizeMarkdownUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    expect(sanitizeMarkdownUrl('#section')).toBe('#section');
    expect(sanitizeMarkdownUrl('/docs/a')).toBe('/docs/a');
    expect(sanitizeMarkdownUrl('./docs/a')).toBe('./docs/a');
    expect(sanitizeMarkdownUrl('../docs/a')).toBe('../docs/a');
  });

  it('drops active-content URL schemes from model-authored links', () => {
    expect(sanitizeMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(sanitizeMarkdownUrl('//evil.example/a')).toBe('');

    const rendered = renderMarkdown('[run me](javascript:alert(1))');
    expect(rendered.querySelector('a')).toBeNull();
    expect(rendered.textContent).toContain('run me');
  });
});
