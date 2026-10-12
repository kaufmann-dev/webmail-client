# Repository Instructions

## Build and Verification

```bash
pnpm install
pnpm check             # svelte-kit sync + svelte-check; run after Svelte/TS changes
pnpm lint              # prettier --check + eslint
pnpm format            # prettier --write
pnpm test              # vitest (node environment, src/**/*.spec.ts)
pnpm build             # run after routing, server, or config changes
pnpm db:generate       # after editing src/lib/server/db/schema.ts
```

- Generate migrations with Drizzle Kit only; they live in `drizzle/` and run in the server `init`
  hook. `drizzle-kit generate` needs `DATABASE_URL` set (any value) because of `drizzle.config.ts`.
- Local Postgres is the Podman container `postgres-sveltekit` (database `webmail`). Use `podman`, not
  `docker`.
- Vitest requires an assertion in every test (`expect.requireAssertions`).

## SvelteKit 3 Conventions

- There is no `svelte.config.js`; Kit options live in `sveltekit({...})` in `vite.config.ts`.
- `paths.origin` comes from `ORIGIN` at build time (adapter-node 6 has no runtime `ORIGIN`).
  Better Auth's `baseURL` and the MCP resource URL must match it.
- Declare env vars in `src/env.ts` (pass-through validators keep them optional for builds and
  tests) and read them from `$app/env/private`. Add required ones to `assertEnv()` in
  `src/lib/server/env.ts` and to `.env.example`.
- Import app code through `#lib/...` with `.js` extensions, not `$lib`.
- `resolve()` route IDs include the `(app)` group, e.g. `resolve('/(app)/compose')`.
- `goto` options are `replace` and `reset` (no `replaceState`, `noScroll`, or `keepFocus`).
- Svelte 5 runes only; avoid `$effect`. Remote functions are not used.
- shadcn-svelte components in `src/lib/components/ui` are generated; adding more needs a temporary
  `tsconfig.json` with explicit `$lib` paths, then rewriting their `$lib/` imports to `#lib/`.

## Architecture Rules

- All IMAP/SMTP and Exchange access goes through `src/lib/server/mail/`. Routes and MCP tools never
  talk to `imapflow`, `nodemailer`, or Exchange directly. The public functions in `messages.ts`,
  `folders.ts`, `compose.ts`, and `accounts.ts` branch on `provider === 'exchange'`.
  - `imap.ts`: the per-account connection pool (`withClient`, `withMailbox`). Account failures are
    recorded in `mail_account.last_error` through `account-status.ts`.
  - `ews/`: Exchange accounts over Exchange Web Services (SOAP, Basic authentication, the account's
    `server` and optional `username`), with no IMAP: `client.ts` (requests and errors),
    `requests.ts` (request bodies), `items.ts` (response mapping), `folders.ts`, `messages.ts`, and
    `compose.ts` (drafts and sending as MIME, native meeting responses). Lists page by position.
  - `messages.ts`: listing, search, reading, moving, and threads. Reading fetches only body text,
    calendar parts, and embedded images (`structure.ts`); attachments download on demand. Read
    messages stay in an in-memory cache that `setFlags`, `moveMessages`, and `deleteMessages` keep
    current.
  - `compose.ts`: drafts and sending. Outgoing mail is HTML (`html-body.ts`: the document around
    the editor HTML, in the account's font from `MAIL_FONTS` in `src/lib/html.ts` or none, and its
    `html-to-text` plain-text alternative); `data:` images go out as embedded parts.
  - `threading.ts`: pure reply and forward header logic, the HTML quote and forward block, and
    `composeBody` (text, `wm-signature` block, `wm-quote` block).
  - `invitations.ts`: pure calendar invitation parsing and iMIP replies (ical.js);
    `respondToInvitation` in `compose.ts` sends them.
- Reply and forward headers (`In-Reply-To`, `References`, subject prefixes, recipients) are built
  only by `prepareReply` / `prepareForward` in `compose.ts`, using `threading.ts`. Never accept them
  from MCP input.
- Messages are addressed by opaque refs from `message-ref.ts`: account, path, UIDVALIDITY, and UID
  over IMAP; account, folder path, and EWS item ID on Exchange. Resolve them with `resolveRef` /
  `groupRefs`, which scope accounts to the user; `imapLocator` / `ewsLocator` reject a ref of the
  wrong kind.
- Mail is never stored in the database. Credentials are AES-GCM encrypted with `CREDENTIALS_KEY`
  (`crypto.ts`, `credentials.ts`); never return `MailAccount.secret` to the browser (use
  `toSummary`).
- Throw `MailError` for messages that are safe to show users and AI clients.
- Message HTML is sanitized in `render.ts` and rendered only in the sandboxed iframe in
  `message-body.svelte` (no `allow-scripts`, no referrer; the CSP blocks remote loads in Spam until
  allowed). Attachments are served with `Content-Disposition: attachment`.
- Editor HTML and signatures (sanitized HTML in `mail_account.signature`) come from the browser and
  are always sanitized again on the server with `sanitizeEmailHtml` before they are saved or sent.
  The editor (`html-editor.svelte`) is a `contentEditable` document in an iframe without
  `allow-scripts`, driven from the parent; its CSP blocks remote images while editing.

## Auth and MCP

- Construct `auth` only through `initAuth()` in the server `init` hook, after migrations.
- `src/lib/server/csrf.ts` replaces SvelteKit's CSRF check, minus `/api/auth/*`.
  `hooks.server.ts` routes `/.well-known/*` to Better Auth.
- The MCP endpoint (`src/routes/mcp/+server.ts`) requires the single OAuth scope `mail`. Per-account
  access lives in `mcp_account_access`, set on `/consent` and in Settings → Connected apps (both
  through `access-grant-fields.svelte` and `grantsFromForm`): a level (`read` < `organize` <
  `send`), an optional time window (`max_age_days`: 7, 30, or 90; null for any age, compared with
  the received date `MessageSummary.date`), and `allow_attachments`.
- Every MCP tool in `src/lib/server/mcp/tools.ts` checks access in `access.ts` before touching mail,
  so the limits hold for IMAP and Exchange alike:
  - Account-level tools call `access.require` with their level.
  - Tools that use an existing message go through `access.requireMessage` (level, attachment rule
    with `attachments: true`, then the time window on the cached `getMessage`); bulk actions go
    through `access.requireMessages`, which checks dates with `receivedDates` without reading.
  - Lists pass `access.notBefore(accounts)` to `listMessages`, and threads pass through
    `access.visible`.
  - Without attachments, `get_message` leaves out the attachment list (file names included).
- Sending tools default to `mode: 'draft'`, except `respond_to_invitation`, which always sends (a
  saved draft would lose its calendar part).

## UI

- Follow the flat (no shadows), lightly rounded (`--radius`), motionless defaults enforced in
  `src/routes/layout.css`. Monochrome: a white light background and a soft near-black dark one.
- Color appears only as account colors (`--account-*`), always next to the account label.
- Icon buttons explain themselves on hover with `TooltipButton` (`src/lib/components/tooltip-button.svelte`,
  `shortcut` for a keyboard key), not `title`. They still need an `sr-only` or `aria-label` name.
- User actions show their result at once and finish in the background (`postAction` in
  `src/lib/form-action.ts`); a failure undoes the change and shows a toast. Sending continues after
  the editor closes (`src/lib/outbox.ts`).
- The open message streams from the page load, which must stay free of side effects because links
  preload on hover. The page marks a message read once it is shown.
- Every `overflow-y-auto` scroll area is also `relative`. Otherwise `sr-only` labels inside it
  (absolutely positioned) are placed against the page and stretch it past the `h-dvh` shell.
