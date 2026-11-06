import type { WikiPageMeta } from '@org/contracts';

const SPECIAL_PAGES = new Set(['_sidebar', '_footer', '_header']);

export function isWikiMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith('.md')) {
    return false;
  }
  const base = lower.split('/').pop() ?? lower;
  return !SPECIAL_PAGES.has(base.replace(/\.md$/, ''));
}

export function pageSlug(path: string): string {
  return path.replace(/\\/g, '/').replace(/\.md$/i, '');
}

export function pagePath(slug: string): string {
  return `${slug}.md`;
}

export function pageTitle(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  if (heading) {
    return heading[1].trim();
  }
  return fallback;
}

export function sortPages(pages: WikiPageMeta[]): WikiPageMeta[] {
  return [...pages].sort((a, b) => {
    const aHome = a.slug.toLowerCase() === 'home';
    const bHome = b.slug.toLowerCase() === 'home';
    if (aHome !== bHome) {
      return aHome ? -1 : 1;
    }
    return a.slug.localeCompare(b.slug);
  });
}
