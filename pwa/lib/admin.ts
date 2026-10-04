/**
 * Shared admin-token decision for the pairing surface (single source so the
 * pair + devices routes cannot drift).
 */
export function adminOk(req: Request): boolean {
  const expected = process.env.BIFROST_ADMIN_TOKEN;
  if (expected) {
    return req.headers.get('authorization') === `Bearer ${expected}`;
  }
  // no admin token configured: pairing rides the declared auth layer
  return process.env.BIFROST_AUTH === 'tailnet';
}
