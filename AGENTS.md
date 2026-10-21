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
  - `folders.ts`: listing (cached) and creating, renaming, and deleting folders. Role folders
    cannot be renamed or deleted; deleting is permanent and includes subfolders (IMAP deletes them
    deepest first, Exchange uses `HardDelete`). With `onlyEmpty` (MCP), a folder whose subtree
    still holds messages is refused.
  - `imap.ts`: the per-account connection pool (`withClient`, `withMailbox`). Account failures are
    recorded in `mail_account.last_error` through `account-status.ts`.
  - `ews/`: Exchange accounts over Exchange Web Services (SOAP, Basic authentication, the account's
    `server` and optional `username`), with no IMAP: `client.ts` (requests and errors),
    `requests.ts` (request bodies), `items.ts` (response mapping), `folders.ts`, `messages.ts`,
    `compose.ts` (drafts and sending as MIME, meetings as calendar items, their updates and
    cancellations, native meeting responses), and `calendar.ts` (free/busy through
    `GetUserAvailability`, which `ewsOperation` calls because it has no response messages and
    which needs a UTC zone with two distinct transitions; sent meetings found by UID in a calendar
    view of their time). Lists page by position. Reading fetches the
    calendar part of meeting messages and of messages carrying a calendar part (meeting drafts).
  - `messages.ts`: listing, search, reading, moving, and threads. Reading fetches only body text,
    calendar parts, and embedded images (`structure.ts`); attachments download on demand. Read
    messages stay in an in-memory cache that `setFlags`, `moveMessages`, and `deleteMessages` keep
    current.
  - `compose.ts`: drafts and sending. Outgoing mail is HTML (`html-body.ts`: the document around
    the editor HTML, in the account's font from `MAIL_FONTS` in `src/lib/html.ts` or none, and its
    `html-to-text` plain-text alternative); `data:` images go out as embedded parts.
    `Draft.meeting` makes a message a meeting invitation (`to` required, `cc` optional attendees,
    no Bcc or attachments): drafts are ordinary Drafts messages with an iMIP request part, which
    `meetingOf` reads back; sending creates an Exchange calendar item, or mails the request over
    SMTP (it does not enter the user's calendar there). `updateMeeting` and `cancelMeeting` change
    a sent, non-recurring meeting from its invitation: Exchange updates or cancels the calendar
    item, SMTP sends the request again with a higher `SEQUENCE` (and a CANCEL to removed
    attendees) or an iMIP CANCEL.
  - `body-text.ts`: bodies as plain text for AI clients (`ReadMessage.detail.text`) from the HTML
    when there is one: decoded entities, Markdown data tables, `[image: name]`, and the new text
    without quoted messages (`ReadMessage.newText`, by quote containers first, then text patterns;
    forwards keep everything), plus list previews. `messagePreviews` reads only the start of the
    IMAP text part, or Exchange's `item:Preview` (plain text; quote headers cut even where
    Exchange's 255-character cut left them incomplete).
  - `conversations.ts`: groups a listed page by conversation (the provider's conversation ID where
    there is one, else Message-ID / In-Reply-To / References). The other members come from
    `conversationMembers` in `messages.ts`, which searches the same sources as `getThread`, so
    counts and `last_from_me` agree with `get_thread`.
  - `threading.ts`: pure reply and forward header logic, the HTML quote and forward block, and
    `composeBody` (text, `wm-signature` block, `wm-quote` block).
  - `invitations.ts`: pure calendar invitation parsing, iMIP replies, and meeting requests
    (ical.js, in UTC); `respondToInvitation` in `compose.ts` sends replies. `time-zones.ts` converts
    wall-clock times in IANA zones with `Intl` only.
  - `availability.ts`: free times for a meeting (`freeTimes`, pure: weekdays, working hours,
    tentative counts as busy) from Exchange free/busy; served to the compose form by
    `/api/availability` and to MCP by `find_meeting_times`. Exchange only.
- Reply and forward headers (`In-Reply-To`, `References`, subject prefixes, recipients) are built
  only by `prepareReply` / `prepareForward` in `compose.ts`, using `threading.ts`. Never accept them
  from MCP input.
- Messages are addressed by opaque refs from `message-ref.ts`: account, path, UIDVALIDITY, and UID
  over IMAP; account, folder path, and EWS item ID on Exchange. Resolve them with `resolveRef` /
  `groupRefs`, which scope accounts to the user; `imapLocator` / `ewsLocator` reject a ref of the
  wrong kind. MCP clients never see these refs: `mcp/refs.ts` maps them to 10-character refs in
  `mcp_message_ref`. `moveMessages` returns the new refs of moved messages so short refs follow
  them, and `withMessage` in `tools.ts` finds a message moved elsewhere by its Message-ID.
- Mail is never stored in the database (`mcp_message_ref` holds identifiers only). Credentials are AES-GCM encrypted with `CREDENTIALS_KEY`
  (`crypto.ts`, `credentials.ts`); never return `MailAccount.secret` to the browser (use
  `toSummary`).
- Throw `MailError` for messages that are safe to show users and AI clients.
- Message HTML is sanitized in `render.ts` (style sheets from `<head>` are kept, since Outlook sets
  its paragraph spacing there) and rendered only in the sandboxed iframe in
  `message-body.svelte` (no `allow-scripts`, no referrer; the CSP blocks remote loads in Spam until
  allowed). A click on a loaded, unlinked image opens it in `image-viewer.svelte` outside the frame,
  without a referrer. Attachments are served with `Content-Disposition: attachment`.
- Editor HTML and signatures (sanitized HTML in `mail_account.signature`) come from the browser and
  are always sanitized again on the server with `sanitizeEmailHtml` before they are saved or sent.
  The editor (`html-editor.svelte`) is a `contentEditable` document in an iframe without
  `allow-scripts`, driven from the parent; its CSP blocks remote images while editing.

## Auth and MCP

- Construct `auth` only through `initAuth()` in the server `init` hook, after migrations.
- `src/lib/server/csrf.ts` replaces SvelteKit's CSRF check, minus `/api/auth/*` and
  `/mcp/uploads/*`. `hooks.server.ts` routes `/.well-known/*` to Better Auth.
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
  - `create_meeting` needs `organize` for drafts and `send` to send, like `compose_new_message`;
    `find_meeting_times` needs `read`. `update_meeting` and `cancel_meeting` need `send`.
  - Folder tools need `organize`. `delete_folder` deletes only empty folders, since a full delete
    would also destroy messages outside the time window. `rename_folder` rewrites the short refs
    of messages in the renamed subtree (`McpRefs.folderRenamed`).
- Tool results are compact JSON that leave out defaults: boolean flags only when true, `account`
  only when results span several accounts, `to` in lists only when it is not just the account.
- Attachment bytes never pass through tool calls. `get_attachment` returns readable content
  (`mail/attachment-text.ts`: text files, and documents as Markdown via `officeparser`) and a
  download link; `create_attachment_upload` returns an upload link, and sending tools take
  `{upload_id}` or `{message_ref, part_id}`. The links (`mcp/transfers.ts`, routes
  `/mcp/files/[token]` and `/mcp/uploads/[token]`) live in memory only, are authenticated by their
  token alone, and are bound to the user and OAuth client; downloads check access again when
  fetched.
- Sending tools default to `mode: 'draft'`, except `respond_to_invitation` (a saved draft would
  lose its calendar part), `update_meeting`, and `cancel_meeting`, which always send.

## UI

- Follow the flat (no shadows), lightly rounded (`--radius`), motionless defaults enforced in
  `src/routes/layout.css`. Monochrome surfaces: a white light background and a soft near-black
  dark one.
- Gray fills come only from three tokens, without opacity modifiers: `muted` for hover and quiet
  strips (date group headers, banners), `accent` for form fields and menu focus, and `input` for
  checkboxes. Lines use `border`.
- Blue (`primary`, `selected`, `selected-foreground`) means only selected, active, primary action,
  or focus: the open message, current folder, active filter and tabs, primary buttons, checked
  checkboxes, and the focus outline. Nothing else is blue.
- Other color appears only as account colors (`--account-*`), always next to the account label.
- Icon buttons explain themselves on hover with `TooltipButton` (`src/lib/components/tooltip-button.svelte`,
  `shortcut` for a keyboard key), not `title`. They still need an `sr-only` or `aria-label` name.
- User actions show their result at once and finish in the background (`postAction` in
  `src/lib/form-action.ts`); a failure undoes the change and shows a toast. Sending continues after
  the editor closes (`src/lib/outbox.ts`), so closing it never leaves the page load: going back past
  it would unload the document and cancel the send. Drafts being sent or discarded leave lists at
  once (`leavingDrafts`) and come back if that fails.
- The open message streams from the page load, which must stay free of side effects because links
  preload on tap (not hover, which would queue reads ahead of the click) and the next message
  preloads after one opens. The page marks a message read once it is shown.
- The first document load also streams the message list, folders, and unread counts (`streamed` in
  `src/lib/streamed.svelte.ts`), so the shell shows at once. Data requests (navigations and
  refreshes) await them instead, keeping the current view until the next one is ready.
- Every `overflow-y-auto` scroll area is also `relative`. Otherwise `sr-only` labels inside it
  (absolutely positioned) are placed against the page and stretch it past the `h-dvh` shell.
