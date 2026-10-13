# Send fails silently after a full page load

- Fixed: 2026-10-13 09:14:51 UTC (+0000)
- Commit before the fix: `ed819d9ff2c8d17e7dd4c2ef1cfaceaf39b1894f`

## Symptom

A photo was attached to a draft and Send clicked. The editor closed, but no message went out and
no toast appeared, neither "Sending…" nor an error. The draft stayed in Drafts without the photo,
so sending it again sent it without the attachment.

## Root cause

Sending closes the editor at once with `leave()` in
`src/lib/components/mail/compose-form.svelte` and finishes in the background (`outbox.ts`).
`leave()` called `history.back()` whenever `history.length > 1`. When the editor had been opened
by a full page load (a direct URL, a reload, a new tab, a login redirect), the entry before it
belonged to another document. Going back then unloaded the page, the browser cancelled the
in-flight `?/send` POST, and the toast went away with the page. Nothing was sent, and only the
browser had the attachment.

Reproduced against the built app (adapter-node, local Postgres, seeded session) in Chromium.
Inbox opened, then `/compose` opened by full load, a 977 KB file attached, Send clicked: the page
was a new document afterwards (a marker set on `window` was gone) and no toast showed. Opening
`/compose` by client-side navigation showed the error toast.

The send failed in the first place because production runs without `BODY_SIZE_LIMIT`, so
adapter-node rejects request bodies over 512 KB. A 700 KB probe to `/api/auth` returned 500 both
on production and locally with the default limit, where the server logged 413 Payload Too Large.

## Changes

`src/lib/components/mail/compose-form.svelte`: `afterNavigate` records whether the editor was
reached by in-app navigation (`from !== null`). Only then do `leave()` and `close()` use
`history.back()`. Otherwise they navigate client-side to the fallback folder, and `leave()`
replaces the editor's history entry. The page stays loaded, so the send finishes and its toast
shows.

`AGENTS.md` (UI) states that closing the editor never leaves the page load.

Verified with the same harness: opened by full load or by client-side navigation, the page stayed
the same document and showed "Content-length of 1001265 exceeds limit of 524288 bytes." with
Edit, which reopened the editor with the recipient and the attachment.

Production still needs `BODY_SIZE_LIMIT=30M` in Coolify for attachments over 512 KB.
