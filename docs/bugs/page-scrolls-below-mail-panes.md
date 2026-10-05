# Page scrolls below the mail panes

- Fixed: 2026-10-05 16:28:43 UTC (+0000)
- Commit before the fix: `aa06f3a270e2d48d0f370f71da75cbc13f65df7a`

## Symptom

On the mail page, the whole window could be scrolled down past the three panes, leaving a blank
area below them, although the app shell is exactly one viewport tall (`h-dvh`).

## Root cause

Unread rows in the message list carry a `<span class="sr-only">Unread.</span>` label. Tailwind's
`sr-only` is `position: absolute`. No ancestor of the list was positioned, so the label's
containing block was the page, not the scrolling list. The label sat at its in-flow position far
down the (unclipped) list and stretched the page's scrollable height to the last unread row.

Reproduced in Chromium with a minimal page using the same structure (50 rows, an unread label in
row 31). The document was 2258px tall in a 633px viewport. With `position: relative` on the scroll
container it was 633px.

## Changes

`relative` added to every app scroll area, so absolutely positioned content inside them is clipped
and scrolls with them:

- `src/routes/(app)/mail/[scope]/[...folder]/+page.svelte`: the sidebar `<aside>` and the message
  list container.
- `src/lib/components/mail/message-reader.svelte`: the reader body.
- `src/lib/components/mail/compose-form.svelte`: the editor container (holds an `sr-only` input).
- `src/routes/(app)/settings/+layout.svelte`: the settings content.

`AGENTS.md` (UI) now states that every `overflow-y-auto` scroll area is also `relative`.
