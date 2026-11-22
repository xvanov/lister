/**
 * Import boundaries that every workspace must respect, as ESLint rules so a
 * violation is a red squiggle in the editor and a failed `make lint`, not a
 * surprise in review.
 *
 * Every outbound message goes through the outbound guard (docs/guide.md rule 8),
 * so each provider is reachable from exactly one file, its channel's transport:
 *   mail  nodemailer / resend / ...      packages/email/src/transport.ts
 *         (and RESEND_API_KEY)
 *   push  the ntfy URL and token         packages/notify/src/ntfy.ts
 * Used by the root eslint.config.mjs (all packages + the worker) and by
 * apps/web's own config.
 */
const MAIL_SDKS = [
  "nodemailer",
  "nodemailer/*",
  "@sendgrid/*",
  "resend",
  "postmark",
  "mailgun.js",
  "mailgun-js",
  "@aws-sdk/client-ses",
  "@aws-sdk/client-sesv2",
];
const MAIL_MESSAGE =
  "Outbound messages go through the guard: use sendMail from @repo/email (docs/guide.md rule 8). Only packages/email/src/transport.ts may import a mail library.";
const MAIL_RE =
  "/^(nodemailer|@sendgrid\\u002F|resend$|postmark$|mailgun|@aws-sdk\\u002Fclient-ses)/";

const NTFY_MESSAGE =
  "Pushes go through the guard: use notifyOperator from @repo/notify (docs/guide.md rule 8). Only packages/notify/src/ntfy.ts may read NTFY_URL / NTFY_TOKEN.";
const NTFY_RE = "/^NTFY_(URL|TOKEN)$/";
const RESEND_KEY_MESSAGE =
  "Only packages/email/src/transport.ts may read RESEND_API_KEY (docs/guide.md rule 8).";
const RESEND_KEY_RE = "/^RESEND_API_KEY$/";


const dynamicImport = (re, message) => [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${re}]`,
    message,
  },
  { selector: `ImportExpression[source.value=${re}]`, message },
];
// Reading a credential (env().X, e["X"], process.env.X) is how a bypass starts.
const reads = (re, message) => [
  { selector: `MemberExpression[property.name=${re}]`, message },
  { selector: `MemberExpression[property.value=${re}]`, message },
];

const mailSyntax = [
  ...dynamicImport(MAIL_RE, MAIL_MESSAGE),
  ...reads(RESEND_KEY_RE, RESEND_KEY_MESSAGE),
];
const pushSyntax = reads(NTFY_RE, NTFY_MESSAGE);
const mailImports = { group: MAIL_SDKS, message: MAIL_MESSAGE };



/** Every channel's restricted imports and syntax, by channel. */
const IMPORTS = {
  mail: mailImports,
};
const SYNTAX = {
  mail: mailSyntax,
  push: pushSyntax,
};
/** The imports / syntax of every channel except `skip`. */
const importsExcept = (...skip) =>
  Object.entries(IMPORTS)
    .filter(([k]) => !skip.includes(k))
    .map(([, v]) => v);
const syntaxExcept = (...skip) =>
  Object.entries(SYNTAX)
    .filter(([k]) => !skip.includes(k))
    .flatMap(([, v]) => v);

/** A transport and its own tests (which point it at a fake). */
const withTests = (file) => [file, file.replace(/\.ts$/, ".test.ts")];

/**
 * @param {Record<string, string>} transports  the one file allowed to reach
 *   each provider (mail, push, sms, mobilePush), relative to the config's
 *   directory ("__none__" = none)
 */
export function outboundBoundary(transports) {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
      rules: {
        "no-restricted-imports": ["error", { patterns: importsExcept() }],
        "no-restricted-syntax": ["error", ...syntaxExcept()],
      },
    },
    {
      files: withTests(transports.mail),
      rules: {
        "no-restricted-imports": ["error", { patterns: importsExcept("mail") }],
        "no-restricted-syntax": ["error", ...syntaxExcept("mail")],
      },
    },
    {
      files: withTests(transports.push),
      rules: { "no-restricted-syntax": ["error", ...syntaxExcept("push")] },
    },
  ];
}
