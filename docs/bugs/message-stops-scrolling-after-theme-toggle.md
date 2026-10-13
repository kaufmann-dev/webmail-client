# Message stops scrolling after toggling the theme

- Fixed: 2026-10-13 14:26:31 UTC (+0000)
- Commit before the fix: `a8c48684fe8f42be6a52d3b14b0dd3c05609aa85`

## Symptom

With a message open, choosing Account menu → Toggle theme left the message body unscrollable with
the mouse wheel. Opening another message and coming back fixed it, and so did selecting text inside
the message.

## Root cause

The message body is a sandboxed `srcdoc` iframe (`message-body.svelte`). It shrinks to the reader
pane as a flex item, so the message scrolls inside the frame. The frame inherits its used
`color-scheme` from the page.

The theme toggle is a bits-ui `DropdownMenu` item. While the menu is open, bits-ui sets
`pointer-events: none` on `<body>`. mode-watcher's `toggleMode` runs during that time and sets
`color-scheme` on `<html>`. When `color-scheme` changes while the body has `pointer-events: none`,
Chromium updates the frame and keeps it unable to take wheel scrolling after `pointer-events` is
restored. Only replacing the frame (another message) or an interaction inside it brings scrolling
back.

Reproduced in Chromium against the dev server, with a temporary public route rendering the real
`AppHeader` and `MessageBody` inside the reader layout. Wheel events were sent over CDP at the
frame, and the frame's `scrollY` was compared before and after:

| Step before the wheel                                         | Frame scrolls |
| ------------------------------------------------------------- | ------------- |
| Account menu → Toggle theme                                   | no            |
| Account menu → Escape (no theme change)                       | yes           |
| Class and `color-scheme` toggled without the menu             | yes           |
| `dark` class toggled while body `pointer-events: none`        | yes           |
| `color-scheme` toggled while body `pointer-events: none`      | no            |
| Same, with `color-scheme: light` on the iframe element        | yes           |
| Account menu → Toggle theme, with `scheme-light` on the frame | yes           |

## Changes

- `src/lib/components/mail/message-body.svelte`: the message iframe has `scheme-light`
  (`color-scheme: light`). The message is always shown on white, so the page's theme never
  reaches the frame. A comment explains why.
- `src/lib/components/mail/html-editor.svelte`: the compose editor iframe (also always white, and
  open while the same header menu can toggle the theme) has `scheme-light` too.

Verified with the same harness: Account menu → Toggle theme keeps the frame scrollable in both
directions (light to dark and dark to light).
