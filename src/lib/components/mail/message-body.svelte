<script lang="ts">
	import ImageViewer from '#lib/components/mail/image-viewer.svelte';

	let { html, allowRemote }: { html: string; allowRemote: boolean } = $props();

	// No scripts ever run: the sandbox omits allow-scripts and the CSP has no script-src. Remote
	// images, fonts, and CSS backgrounds load only with `allowRemote`, and never send a referrer.
	const csp = $derived(
		[
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			`img-src data:${allowRemote ? ' https: http:' : ''}`,
			`font-src data:${allowRemote ? ' https:' : ''}`,
			"form-action 'none'"
		].join('; ')
	);

	const BASE_STYLE = `html,body{margin:0;background:#fff;color:#111}
body{padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
pre{white-space:pre-wrap}
img{cursor:zoom-in}a img{cursor:pointer}
blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:2px solid #ccc}`;

	// The frame takes the document's height, so the document must take its content's height. Emails
	// often set `html, body { height: 100% }` (sometimes with `overflow: hidden`), which ties the
	// document to the frame instead: the frame stays at its default height or grows without end.
	// The frame never scrolls vertically: its viewport snaps to whole pixels and can fall a fraction
	// short of the content, and a vertical scrollbar would narrow the document, resize it, and toggle
	// on and off with every measurement in `fit`. Wide content still scrolls horizontally; the body
	// keeps its overflow visible, since the root's overflow no longer passes the body's to the frame.
	// Images shrink to the frame's width and keep their proportions, even where the message fixes
	// their height (Outlook sets both in inline styles), which would otherwise squeeze them.
	// This comes after the message so it wins over the message's own `!important` rules.
	const FIT_STYLE =
		`<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}` +
		`html{overflow-x:auto!important;overflow-y:hidden!important}body{overflow:visible!important}` +
		`img{max-width:100%!important;height:auto!important}</style>`;

	const srcdoc = $derived(
		`<!doctype html><html><head><meta charset="utf-8">` +
			`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
			`<meta name="referrer" content="no-referrer">` +
			`<base target="_blank"><style>${BASE_STYLE}</style></head><body>${html}${FIT_STYLE}</body></html>`
	);

	let observer: ResizeObserver | undefined;
	let viewing = $state<{ src: string; alt: string } | null>(null);

	/**
	 * A click on an image opens it large outside the frame. Linked images keep their link, and images
	 * that did not load (blocked by the frame's CSP) stay closed, so the viewer loads nothing new.
	 */
	function open(event: MouseEvent) {
		const img = (event.target as Element).closest('img');
		if (!img || img.closest('a') || !img.complete || img.naturalWidth === 0) return;
		event.preventDefault();
		viewing = { src: img.currentSrc || img.src, alt: img.alt };
	}

	/** Same-origin access (allow-same-origin, no scripts) lets the parent size the frame to its content. */
	function fit(event: Event) {
		const frame = event.currentTarget as HTMLIFrameElement;
		const doc = frame.contentDocument;
		if (!doc) return;
		// The content's own height, rounded up: `scrollHeight` rounds fractional heights (11pt fonts)
		// down, cutting off content, and never drops below the frame, so the frame would not shrink.
		// The frame's border and any horizontal scrollbar come on top.
		const resize = () => {
			const content = Math.ceil(doc.documentElement.getBoundingClientRect().height);
			frame.style.height = `${content + frame.offsetHeight - doc.documentElement.clientHeight}px`;
		};
		observer?.disconnect();
		observer = new ResizeObserver(resize);
		observer.observe(doc.documentElement);
		resize();
		doc.addEventListener('click', open);
	}
</script>

<!-- `scheme-light`: the message is always on white. It also keeps theme changes out of the frame,
     which Chromium would otherwise leave unscrollable when the theme changes while an open menu
     sets `pointer-events: none` on the body. -->
<iframe
	title="Message content"
	sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
	{srcdoc}
	onload={fit}
	class="block min-h-24 w-full rounded-lg border bg-white scheme-light"
></iframe>

{#if viewing}
	<ImageViewer {...viewing} onclose={() => (viewing = null)} />
{/if}
