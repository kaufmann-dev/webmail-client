# Mail

[Local Development](#local-development) · [Environment Variables](#environment-variables) ·
[Mail Accounts](#mail-accounts) · [MCP Server](#mcp-server) ·
[Authentication Setup](#authentication-setup) · [Coolify Deployment](#coolify-deployment)

A private webmail client for Gmail, Purelymail, and Microsoft 365 accounts, served at
`mail.kaufmann.dev`. It shows every account on its own and also as one unified "All accounts" view.
The same server hosts a remote MCP server. AI apps such as Claude or ChatGPT connect to it once,
and on the consent screen you choose which mail accounts each app may use and at what level.

- **Mail:** a unified inbox (and Drafts, Sent, Archive, Spam, Trash) across accounts, per-account
  folders, search (Gmail search syntax for Gmail), unread and starred filters, multi-select actions,
  moving messages by dragging them onto a folder, keyboard shortcuts (`?` lists them), and a
  conversation view.
- **Reading:** HTML mail renders in a sandboxed frame with no scripts. Remote images stay blocked
  until you load them.
- **Writing:** reply, reply all, forward (attachments included), drafts, attachments, and a
  signature per account. Replies keep `In-Reply-To` and `References`, so they stay in the
  conversation.
- **Live IMAP/SMTP:** mail is never copied into the database. The database stores only the app's
  own data: accounts with encrypted credentials, signatures, and MCP grants.

Stack: SvelteKit 3 (adapter-node) with Svelte 5, Tailwind and shadcn-svelte, Drizzle and PostgreSQL,
Better Auth (Pocket ID sign-in and the MCP OAuth server), the MCP TypeScript SDK v2, imapflow,
nodemailer, mailparser, and Vitest.

## Local Development

Requirements: Node 24 and pnpm 11. For the database, create `webmail` in the local Podman
PostgreSQL container `postgres-sveltekit`.

```bash
pnpm install
cp .env.example .env   # fill in the values; see Environment Variables
pnpm dev               # http://localhost:5173
```

The server applies pending migrations on startup. Other commands:

```bash
pnpm check             # svelte-check
pnpm lint              # prettier + eslint
pnpm test              # vitest
pnpm build && pnpm start
pnpm db:generate       # create a migration after changing src/lib/server/db/schema.ts
```

Better Auth tables live in `src/lib/server/db/auth-schema.ts`. The app's own tables are in
`src/lib/server/db/schema.ts`.

## Environment Variables

| Variable                  | Required | Purpose                                                                                                                                   |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Yes      | PostgreSQL connection string                                                                                                              |
| `ORIGIN`                  | Yes      | Public URL, e.g. `https://mail.kaufmann.dev`. Needed at build time (adapter-node `paths.origin`) and at runtime                           |
| `BETTER_AUTH_SECRET`      | Yes      | Session and token signing secret (`openssl rand -base64 32`)                                                                              |
| `POCKET_ID_ISSUER`        | Yes      | Pocket ID issuer URL                                                                                                                      |
| `POCKET_ID_CLIENT_ID`     | Yes      | Pocket ID OIDC client ID                                                                                                                  |
| `POCKET_ID_CLIENT_SECRET` | Yes      | Pocket ID OIDC client secret                                                                                                              |
| `CREDENTIALS_KEY`         | Yes      | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored mail passwords and tokens; changing it means re-adding every account |
| `MICROSOFT_CLIENT_ID`     | No       | Entra app client ID; without it, Microsoft 365 accounts cannot be added                                                                   |
| `MICROSOFT_CLIENT_SECRET` | No       | Entra app client secret                                                                                                                   |
| `BODY_SIZE_LIMIT`         | No       | adapter-node request body limit (default `512K`). Set `30M` so attachments up to about 25 MB can be sent                                  |

## Mail Accounts

Add accounts under **Settings → Mail accounts → Add account**. The app tests IMAP and SMTP before it
saves an account.

- **Gmail:** enable 2-Step Verification, then create an app password (Google Account → Security →
  App passwords) and use it instead of the Google password. IMAP is always on for personal Gmail.
- **Purelymail:** the account password, or an app password if two-factor authentication is on.
- **Microsoft 365** (for example a university account): sign in with Microsoft. This needs an Entra
  app registration:
  1. Register an app with supported account types "Accounts in any organizational directory".
  2. Add a **Web** redirect URI `https://mail.kaufmann.dev/accounts/microsoft/callback`, plus
     `http://localhost:5173/accounts/microsoft/callback` for development.
  3. Under API permissions, add the delegated permissions `offline_access`, and from Office 365
     Exchange Online `IMAP.AccessAsUser.All` and `SMTP.Send`.
  4. Create a client secret, then set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

  If the organization blocks user consent, ask its IT department to approve the app. The mailbox
  must also have IMAP and authenticated SMTP enabled. If not, the connection test reports the
  rejected login.

## MCP Server

The app is a remote MCP server at `https://mail.kaufmann.dev/mcp` (Streamable HTTP). It is also its
own OAuth 2.1 authorization server, so MCP clients connect with just the URL:

```bash
claude mcp add --transport http mail https://mail.kaufmann.dev/mcp   # then /mcp → Authenticate
codex mcp add mail --url https://mail.kaufmann.dev/mcp && codex mcp login mail
```

In Claude or ChatGPT on the web, add the same URL as a custom connector. Settings → Connected apps
shows these steps with copyable commands for the deployed URL.

- **Consent:** after you sign in with Pocket ID, the consent screen lists your mail accounts. For
  each one, choose No access, **Read only**, **Read & organize** (flags, moving, archiving, trash,
  drafts), or **Full** (also sending).
- **Changing access:** Settings → Connected apps edits these choices at any time. Changes take effect
  on the app's next request. Revoking an app deletes its consent, grants, and refresh tokens.
- **Tokens:** access tokens are 15-minute JWTs bound to `/mcp`, with rotating refresh tokens. The
  only OAuth scope is `mail`; account access is checked on every tool call.
- **Discovery:**
  - `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and
    `/.well-known/oauth-authorization-server/api/auth` (RFC 8414).
  - Client ID Metadata Documents and Dynamic Client Registration.
  - PKCE (S256).

| Tool                  | Level            | Purpose                                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `list_accounts`       | Read             | Granted accounts and their access levels                                          |
| `list_folders`        | Read             | An account's folders, with roles (inbox, drafts, sent, archive, spam, trash)      |
| `list_messages`       | Read             | A folder across one or all granted accounts, newest first, with paging            |
| `search_messages`     | Read             | Search by text, sender, recipient, subject, date, unread, or starred              |
| `get_message`         | Read             | Headers, plain-text body, and attachment list; does not mark the message read     |
| `get_thread`          | Read             | Other messages of the same conversation, sent ones included                       |
| `get_attachment`      | Read             | An attachment as text, image, or base64 (up to 10 MB)                             |
| `update_messages`     | Read & organize  | Mark read/unread, star, archive, trash, spam, or move                             |
| `reply_to_message`    | Organize or Full | Threaded reply or reply-all with the quote; `mode` is `draft` (default) or `send` |
| `forward_message`     | Organize or Full | Forward with the original headers and attachments                                 |
| `compose_new_message` | Organize or Full | New conversations only; rejects `Re:` subjects                                    |
| `send_draft`          | Full             | Send a draft from the Drafts folder                                               |

Messages are addressed by an opaque `message_ref`. The reply and forward tools derive the subject,
recipients, and threading headers from the original message, so "reply to this email" always
stays in the conversation. Sending tools save a draft unless the request explicitly says to send.

## Authentication Setup

The app shows its own login screen and signs in with Pocket ID (OIDC authorization code with PKCE)
through Better Auth. Sessions last seven days and are not extended. Logout also ends the Pocket ID
session. Admission is controlled by the Pocket ID client's allowed users or groups.

- Public Client: Off
- Callback URL: `/api/auth/callback/pocket-id`
- Logout Callback URL: `/login`
- Environment variables: `BETTER_AUTH_SECRET`, `POCKET_ID_ISSUER`, `POCKET_ID_CLIENT_ID`,
  `POCKET_ID_CLIENT_SECRET`, and `ORIGIN` (all required); see
  [Environment Variables](#environment-variables).

## Coolify Deployment

- **Build Pack:** Nixpacks. `nixpacks.toml` runs the pinned pnpm 11 and starts with `node build`.
- **Base Directory:** `/`
- **Database:** a Coolify PostgreSQL resource; set its internal URL as `DATABASE_URL`. Migrations
  run when the app starts, so no deployment commands are needed.
- **Environment Variables:**
  - **Required:** every variable marked required in [Environment Variables](#environment-variables).
    Mark `ORIGIN` as available at build time too.
  - **Optional:** `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` (Microsoft 365 accounts);
    `BODY_SIZE_LIMIT=30M` (default `512K`) for attachments.
