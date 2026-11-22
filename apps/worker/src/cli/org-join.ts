/**
 * Give a signed-up console user the seeded organization (where the seller
 * accounts, API keys and listings live), as owner, and make it their default
 * workspace. Sign-up creates a personal org; the console shows ONE org per
 * session (the first membership), so the new membership is dated just before
 * the personal one and every open session is switched to it.
 *
 *   npm run org:join -- <email> [orgSlug=kalin]
 */
import "@repo/env/load";

import { db } from "@repo/db";

async function main() {
  const [email, slug = "kalin"] = process.argv.slice(2);
  if (!email) throw new Error("usage: npm run org:join -- <email> [orgSlug]");
  const user = await db.user.findFirst({ where: { email: email.toLowerCase() }, select: { id: true } });
  if (!user) throw new Error(`no user ${email}: sign up at /sign-up first (and confirm the email)`);
  const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!org) throw new Error(`no organization "${slug}" (npm run lister:seed)`);
  const first = await db.member.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, organizationId: true },
  });
  const createdAt = first ? new Date(first.createdAt.getTime() - 1000) : new Date();
  await db.member.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: "owner", createdAt },
    create: { organizationId: org.id, userId: user.id, role: "owner", createdAt },
  });
  const { count } = await db.session.updateMany({
    where: { userId: user.id },
    data: { activeOrganizationId: org.id },
  });
  console.log(`${email} is now an owner of "${org.name}" (default workspace; ${count} open session(s) switched)`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
