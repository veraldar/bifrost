/** Canonical slug used for rooms, routes and opencode session matching. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 60) || 'session'
  );
}
