/**
 * Seed lister's first tenant and seller accounts (idempotent):
 *   org "Kalin" (slug kalin; an org seeded as "rentus" is renamed in place,
 *   its id and API keys unchanged)
 *   FACEBOOK account "Kalin" (Meta user 100022296936546), liveMode=false,
 *     profile data/profiles/facebook-100022296936546
 *   CRAIGSLIST account "Kalin (Craigslist)", NEEDS_LOGIN, liveMode=false,
 *     profile data/profiles/craigslist-kalin, posting to raleigh/durham with
 *     replies through the CL mail relay
 *
 * Labels and settings are edited later in the console (/app/lister → Edit).
 *
 *   npm run lister:seed
 */
import "@repo/env/load";

import { db } from "@repo/db";

const ORG = { name: "Kalin", slug: "kalin" };
const OLD_SLUGS = ["rentus"];
const FB_USER = "100022296936546";
/** Replaced by the account's email once the owner has logged in. */
const CL_ACCOUNT = "craigslist-kalin";

async function main() {
  const old = await db.organization.findFirst({ where: { slug: { in: OLD_SLUGS } } });
  if (old) {
    await db.organization.update({ where: { id: old.id }, data: ORG });
    console.log(`renamed org ${old.slug} → ${ORG.slug} (id ${old.id} unchanged)`);
  }
  const org = await db.organization.upsert({
    where: { slug: ORG.slug },
    update: {},
    create: ORG,
  });

  await db.sellerAccount.updateMany({
    where: { organizationId: org.id, platform: "FACEBOOK", label: "Rentus / Kalin" },
    data: { label: "Kalin" },
  });
  const fb =
    (await db.sellerAccount.findFirst({
      where: { organizationId: org.id, platform: "FACEBOOK", externalAccountId: FB_USER },
    })) ??
    (await db.sellerAccount.create({
      data: {
        organizationId: org.id,
        platform: "FACEBOOK",
        label: "Kalin",
        externalAccountId: FB_USER,
        liveMode: false,
        status: "NEEDS_LOGIN",
        profileName: `facebook-${FB_USER}`,
      },
    }));

  const cl =
    (await db.sellerAccount.findFirst({ where: { organizationId: org.id, platform: "CRAIGSLIST" } })) ??
    (await db.sellerAccount.create({
      data: {
        organizationId: org.id,
        platform: "CRAIGSLIST",
        label: "Kalin (Craigslist)",
        externalAccountId: CL_ACCOUNT,
        liveMode: false,
        status: "NEEDS_LOGIN",
        profileName: CL_ACCOUNT,
        settings: {
          area: "rdu",
          city: "Durham",
          postal: "27701",
          replyVia: "relay",
          chat: false,
          pacing: { perHour: 1, perDay: 6, renewAfterHours: 48 },
        },
      },
    }));

  console.log(`org ${org.slug} "${org.name}" = ${org.id}`);
  for (const a of [fb, cl])
    console.log(
      `account ${a.platform} "${a.label}" = ${a.id} (${a.status}, liveMode=${a.liveMode}, headless=${a.headless})`,
    );
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
