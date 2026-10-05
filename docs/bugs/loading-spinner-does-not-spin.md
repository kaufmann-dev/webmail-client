# Loading spinner does not spin

- Fixed: 2026-10-05 16:49:59 UTC (+0000)
- Commit before the fix: `9a0c8649f9128204530001de28b8ec7dd8928e35`

## Symptom

While a folder or message loaded, the spinner next to the list title showed but stood still.

## Root cause

`src/routes/layout.css` turns off every animation except `.animate-spin`. A
`@media (prefers-reduced-motion: reduce)` block then turned off `.animate-spin` too. With the
system's "reduce motion" or "animation effects off" setting, every loading spinner froze.

Reproduced in Chromium with the built app CSS and the `Spinner` markup. The spinner's `transform`
changed between samples normally. With reduced motion emulated, `animation-name` was `none` and the
transform stayed `none`.

## Changes

`src/routes/layout.css`: removed the reduced-motion block, so spinners always turn. A spinner shows
progress, and a stopped one looks broken. All other animations stay off.

Verified with the same harness: with reduced motion emulated, the spinner's transform changes
between samples.
