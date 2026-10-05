# Selection clears after checking a message

- Fixed: 2026-10-05 16:46:11 UTC (+0000)
- Commit before the fix: `87337310bda26885fb6121df9ecc0f846033a97e`

## Symptom

Checking a message in the list showed "1 selected", then the checkbox cleared itself a moment
later without any action by the user.

## Root cause

In `src/routes/(app)/mail/[scope]/[...folder]/+page.svelte` the selection was a writable
`$derived` that reset whenever `data.list` changed. The page invalidates `mail:list` on window
`focus`, every 60 seconds, and after every move or delete. Each invalidation reruns the list layout
load, which returns a new (if equal) list object, so the selection reset. Clicking a checkbox right
after returning to the tab, or after focus was inside the message's iframe, fires the window `focus`
event at that click. The list reload that follows clears the checkbox.

Reproduced by compiling the page's exact pattern with the Svelte compiler and running it in Node.
After selecting `a`, the selection survived an unread-count refresh and opening a message
(`data` replaced, `data.list` reused). It was `[]` after a `mail:list` refresh.

## Changes

`src/routes/(app)/mail/[scope]/[...folder]/+page.svelte`:

- The checked refs (`picked`) reset only when scope, folder, filter, or search changes (`listKey`).
- `selected` is derived as the checked refs that are still in the shown list, so messages that
  left the list (moved elsewhere, or past the first page after a refresh) drop out of the count and
  actions.
- Writes (row checkbox, select all, removing acted-on messages) go to `picked`.

The same harness confirmed the fix. The selection survived `mail:list` refreshes, dropped a message
that left the list, and reset when the folder changed.
