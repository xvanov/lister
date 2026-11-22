/**
 * Seed lister's first tenant and seller account (idempotent):
 *   org "Rentus" (slug rentus) + FACEBOOK account "Rentus / Kalin"
 *   (Meta user 100022296936546), liveMode=false, profile
 *   data/profiles/facebook-100022296936546.
 *
 *   npm run lister:seed
 */
import "@repo/env/load";

import { db } from "@repo/db";

const ORG_SLUG = "rentus";
const FB_USER = "100022296936546";

async function main() {
  const org = await db.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: { name: "Rentus", slug: ORG_SLUG },
  });
  const existing = await db.sellerAccount.findFirst({
    where: { organizationId: org.id, platform: "FACEBOOK", externalAccountId: FB_USER },
  });
  const account =
    existing ??
    (await db.sellerAccount.create({
      data: {
        organizationId: org.id,
        platform: "FACEBOOK",
        label: "Rentus / Kalin",
        externalAccountId: FB_USER,
        liveMode: false,
        status: "NEEDS_LOGIN",
        profileName: `facebook-${FB_USER}`,
      },
    }));
  console.log(`org ${org.slug} = ${org.id}`);
  console.log(
    `account "${account.label}" = ${account.id} (${account.status}, liveMode=${account.liveMode}, headless=${account.headless})`,
  );
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
