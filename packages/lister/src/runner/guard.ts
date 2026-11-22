/**
 * The click guard. Every click a browser adapter makes passes through here
 * first (ported from rental-media's guardClick, tightened for listings).
 *
 *   - Spending / promotion buttons (pay, buy, boost, promote, ...) are refused
 *     ALWAYS, live or not.
 *   - On a non-live run (account.liveMode=false) anything that publishes,
 *     posts, submits or changes a listing's state is refused too. A dry run
 *     walks the form and stops before that click.
 *   - On a live run the publishing labels are allowed only when the adapter
 *     names them explicitly as the action's final step (`finalStep`).
 */

const ALWAYS_REFUSED =
  /\b(pay|buy|purchase|checkout|boost|promote|promotion|sponsor|advertis\w*|ad budget)\b|confirm payment/i;
const LIVE_ONLY =
  /\b(publish|submit|send|post|delete|remove|mark as (sold|rented|available)|update|renew|relist)\b/i;

export interface ClickVerdict {
  allowed: boolean;
  reason: string;
}

export function guardClick(
  label: string,
  opts: { live: boolean; finalStep?: RegExp },
): ClickVerdict {
  const text = (label ?? "").trim();
  if (!text) return { allowed: false, reason: "refusing to click an unlabelled control" };
  if (ALWAYS_REFUSED.test(text)) {
    return { allowed: false, reason: `spending/promotion button refused: "${text}"` };
  }
  if (LIVE_ONLY.test(text)) {
    if (!opts.live) {
      return { allowed: false, reason: `dry run: "${text}" is not clicked` };
    }
    if (!opts.finalStep || !opts.finalStep.test(text)) {
      return { allowed: false, reason: `"${text}" is not this action's final step` };
    }
  }
  return { allowed: true, reason: "ok" };
}

/** Wording that means a money step (boost, fee, payment) on a page we are about to submit. */
const MONEY_STEP =
  /\b(boost (your )?listing|promote (your )?listing|ad budget|daily budget|payment method|checkout|listing fee|pay now)\b/i;

export function findMoneyStep(text: string): string | null {
  const m = MONEY_STEP.exec(text ?? "");
  return m ? m[0] : null;
}
