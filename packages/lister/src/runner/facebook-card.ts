/**
 * Mark sold / delete on Facebook's "Your listings" page, the clicking part.
 * Kept free of the DB and storage so it runs against saved HTML fixtures
 * (test/facebook-card.test.ts) as well as the real page.
 *
 * Dry run (account.liveMode=false) walks as far as is safe and stops BEFORE
 * the click that changes the listing:
 *   - remove: opens the card's "More options" menu, clicks "Delete listing"
 *     (which only opens Facebook's "Delete listing?" confirmation), screenshots
 *     the dialog with its Delete button, then presses Cancel / Escape.
 *   - markSold: the card's "Mark as sold" button acts immediately on Facebook
 *     (there is no confirmation before it), so the dry run screenshots the
 *     card with that button and stops there.
 * Every click passes guardClick. Buttons are found by role + accessible name
 * (Facebook names them "<verb> <listing title>"), never by class names.
 */
import type { Locator, Page } from "playwright";

import { guardClick } from "./guard";
import type { RunResult } from "./types";

export interface Shooter {
  shot(page: Page, name: string): Promise<void>;
}

export interface CardAction {
  action: "markSold" | "remove";
  id: string;
  title: string;
  live: boolean;
  rec: Shooter;
  log: (m: string) => void;
  /** ms to wait for Facebook to react (tests pass small values). */
  pause?: number;
}

const MARK_SOLD = /^mark as (sold|rented)$/i;
const DELETE_ITEM = /^delete( listing)?$/i;
const DELETE_CONFIRM = /^delete$/i;

async function guarded(
  el: Locator,
  label: string,
  opts: { live: boolean; finalStep?: RegExp; opensConfirm?: RegExp },
) {
  const v = guardClick(label, opts);
  if (!v.allowed) throw new Error(`click refused: ${v.reason}`);
  await el.click();
}

/**
 * Click through mark-sold / delete for one card. Returns the dry-run result
 * (status unchanged = LIVE, with a note) or null after a live click; the
 * caller then reads the page back to confirm the new state.
 */
export async function actOnCard(page: Page, a: CardAction): Promise<RunResult | null> {
  const wait = (ms: number) => page.waitForTimeout(a.pause ?? ms);

  if (a.action === "markSold") {
    let btn: Locator | null = null;
    let label = "";
    for (const verb of ["Mark as sold", "Mark as rented"]) {
      const loc = page.getByRole("button", { name: `${verb} ${a.title}`, exact: true });
      const n = await loc.count();
      if (n > 1) throw new Error(`${n} "${verb}" buttons for "${a.title}"; refusing to pick one`);
      if (n === 1) {
        btn = loc;
        label = verb;
        break;
      }
    }
    if (!btn) throw new Error(`no "Mark as sold" button for listing ${a.id}; nothing clicked`);
    if (!a.live) {
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      await a.rec.shot(page, "dry-run-stopped-before-mark-sold");
      a.log(`[facebook] dry run: found "${label}" for listing ${a.id}; not clicked`);
      return { status: "LIVE", lastError: `dry run: stopped before "${label}" (account is not live)` };
    }
    await guarded(btn, label, { live: true, finalStep: MARK_SOLD });
    await wait(2500);
    // Facebook may follow up with "Who bought it?" / a rating prompt. Never
    // pick a buyer; close it.
    for (let i = 0; i < 3; i++) {
      const dlg = page.getByRole("dialog").last();
      if ((await dlg.count()) === 0) break;
      const confirm = dlg.getByRole("button", { name: MARK_SOLD }).first();
      const dismiss = dlg
        .getByRole("button", { name: /^(close|not now|skip|cancel|done|someone else|no one)$/i })
        .first();
      if ((await confirm.count()) > 0) {
        await guarded(confirm, (await confirm.innerText().catch(() => "")) || "Mark as sold", {
          live: true,
          finalStep: MARK_SOLD,
        });
      } else if ((await dismiss.count()) > 0) {
        await dismiss.click();
      } else break;
      await wait(1500);
    }
    return null;
  }

  // remove: "More options for <title>" → "Delete listing" → dialog "Delete".
  const more = page.getByRole("button", { name: `More options for ${a.title}`, exact: true });
  const n = await more.count();
  if (n !== 1) throw new Error(`expected one menu button for listing ${a.id}, found ${n}; nothing clicked`);
  // Guarded on "More options" alone: the title could contain a word the guard refuses.
  await guarded(more, "More options", { live: a.live });
  await wait(1500);
  const del = page.getByRole("menuitem", { name: DELETE_ITEM }).first();
  if ((await del.count()) === 0) throw new Error('no "Delete listing" in the card menu; nothing clicked');
  await a.rec.shot(page, "remove-menu-open");
  // "Delete listing" in the menu only opens the confirmation dialog, so a dry
  // run may click it; the dialog's own Delete button is the final step.
  await guarded(del, "Delete listing", { live: a.live, opensConfirm: DELETE_ITEM, finalStep: DELETE_ITEM });
  await wait(2000);
  const dlg = page.getByRole("dialog").last();
  const confirm = dlg.getByRole("button", { name: DELETE_CONFIRM }).first();
  if ((await confirm.count()) === 0) {
    await a.rec.shot(page, "remove-no-confirm");
    throw new Error('no "Delete" confirm button in the dialog; nothing more clicked');
  }
  if (!a.live) {
    await a.rec.shot(page, "dry-run-stopped-before-delete-confirm");
    const cancel = dlg.getByRole("button", { name: /^(cancel|close)$/i }).first();
    if ((await cancel.count()) > 0) await cancel.click();
    else await page.keyboard.press("Escape").catch(() => undefined);
    await wait(800);
    a.log(`[facebook] dry run: reached the "Delete" confirmation for listing ${a.id}; cancelled`);
    return { status: "LIVE", lastError: 'dry run: stopped at the "Delete" confirmation (account is not live)' };
  }
  await guarded(confirm, "Delete", { live: true, finalStep: DELETE_CONFIRM });
  await wait(3000);
  return null;
}
