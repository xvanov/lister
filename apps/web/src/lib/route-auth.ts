/**
 * Session + tenant for the few plain route handlers (file bytes). Resolves the
 * tenant exactly as `orgProcedure` does — same function — including the repair
 * of a brand-new account's first session (no activeOrganizationId) and the
 * check that the user is still a member of the session's active org. The
 * tenant comes from the session, never from the request.
 *
 *   const t = await requireTenant(req);
 *   if (!t.ok) return new Response(null, { status: t.status });
 */
import { resolveOrganizationId } from "@repo/api";
import { auth } from "@repo/auth";
import { db } from "@repo/db";
import { resolveBearer } from "@repo/lister";

export type RouteTenant =
  /** userId is null for an API-key caller. */
  | { ok: true; userId: string | null; organizationId: string }
  /** 401 = not signed in; 403 = signed in, but a member of no organization. */
  | { ok: false; status: 401 | 403 };

export async function requireTenant(req: Request): Promise<RouteTenant> {
  // A calling app's API key (lister's external API): the tenant is the key's.
  if (/^Bearer\s/i.test(req.headers.get("authorization") ?? "")) {
    const caller = await resolveBearer(req.headers);
    if (!caller) return { ok: false, status: 401 };
    return { ok: true, userId: null, organizationId: caller.organizationId };
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return { ok: false, status: 401 };
  const organizationId = await resolveOrganizationId(db, session);
  if (!organizationId) return { ok: false, status: 403 };
  return { ok: true, userId: session.user.id, organizationId };
}
