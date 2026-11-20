/** Chat has no URL base: a bare path is copyable, never a browser destination. */
export function classifyMarkdownLink(href: string | undefined) {
  if (!href) return null;
  if (/^https:\/\/[^/\\]/i.test(href)) {
    try {
      const url = new URL(href);
      if (!url.username && !url.password) return { kind: 'web', href: url.href } as const;
    } catch {
      // Malformed URL.
    }
    return null;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i.test(href)) return null;
  return { kind: 'host-path', path: href } as const;
}
