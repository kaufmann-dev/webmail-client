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

- All IMAP/SMTP access goes through `src/lib/server/mail/`. Routes and MCP tools never talk to
  `imapflow` or `nodemailer` directly.
  - `imap.ts`: the per-account connection pool (`withClient`, `withMailbox`). It records account
    failures in `mail_account.last_error`.
  - `messages.ts`: listing, search, reading, moving, and threads.
  - `compose.ts`: drafts and sending.
  - `threading.ts`: pure reply and forward header logic.
- Reply and forward headers (`In-Reply-To`, `References`, subject prefixes, recipients) are built
  only by `prepareReply` / `prepareForward` in `compose.ts`, using `threading.ts`. Never accept them
  from MCP input.
- Messages are addressed by opaque refs from `message-ref.ts` (account, path, UIDVALIDITY, UID).
  Resolve them with `resolveRef` / `groupRefs`, which scope accounts to the user.
- Mail is never stored in the database. Credentials are AES-GCM encrypted with `CREDENTIALS_KEY`
  (`crypto.ts`, `credentials.ts`); never return `MailAccount.secret` to the browser (use
  `toSummary`).
- Throw `MailError` for messages that are safe to show users and AI clients.
- Message HTML is sanitized in `render.ts` and rendered only in the sandboxed iframe in
  `message-body.svelte` (no `allow-scripts`, CSP blocks remote loads until allowed). Attachments
  are served with `Content-Disposition: attachment`.

## Auth and MCP

- Construct `auth` only through `initAuth()` in the server `init` hook, after migrations.
- `src/lib/server/csrf.ts` replaces SvelteKit's CSRF check, minus `/api/auth/*`.
  `hooks.server.ts` routes `/.well-known/*` to Better Auth.
- The MCP endpoint (`src/routes/mcp/+server.ts`) requires the single OAuth scope `mail`. Per-account
  access lives in `mcp_account_access` (levels `read` < `organize` < `send`), set on
  `/consent` and in Settings → Connected apps.
- Every MCP tool in `src/lib/server/mcp/tools.ts` must call `access.require` or
  `access.requireRef` with its level before touching mail. Sending tools default to `mode: 'draft'`.

## UI

- Follow the flat, square, motionless defaults enforced in `src/routes/layout.css`. Pure
  `#ffffff` and `#000000` backgrounds.
- Color appears only as account colors (`--account-*`), always next to the account label.
