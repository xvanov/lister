/**
 * Dev probe: open the account's profile on the create-item form and dump the
 * form's controls (role, aria, label text). Never clicks Next or Publish.
 *   node --import tsx apps/worker/src/cli/fb-probe.ts <accountId> [photo]
 */
import "@repo/env/load";
import { db } from "@repo/db";
import { launchAccount } from "@repo/lister/runner";

const [id, photo] = process.argv.slice(2);
const a = await db.sellerAccount.findUniqueOrThrow({ where: { id: id! } });
const ctx = await launchAccount(a);
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  await page.goto("https://www.facebook.com/marketplace/create/item", { waitUntil: "commit", timeout: 60000 });
  await page.waitForTimeout(7000);
  if (photo) {
    await page.locator('input[type=file][accept^="image/"]').first().setInputFiles([photo]);
    await page.waitForTimeout(4000);
  }
  const dump = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("label, [role=combobox], [role=button], input, textarea"))
      .filter((e) => e.closest("[role=main], form, [aria-label]") && e.offsetParent !== null)
      .map((e) => [e.tagName.toLowerCase(), e.getAttribute("role"), e.getAttribute("aria-label"), e.getAttribute("aria-labelledby"), (e.innerText || (e as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 50), e.getAttribute("type")].join(" | "))
      .slice(0, 150),
  );
  console.log(dump.join("\n"));
} finally {
  await ctx.close();
  await db.$disconnect();
}
