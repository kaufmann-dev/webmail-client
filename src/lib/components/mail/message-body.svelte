<script lang="ts">
	let { html, allowRemote }: { html: string; allowRemote: boolean } = $props();

	// No scripts ever run: the sandbox omits allow-scripts and the CSP has no script-src. Remote
	// images, fonts, and CSS backgrounds load only after the user allows them.
	const csp = $derived(
		[
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			`img-src data:${allowRemote ? ' https: http:' : ''}`,
			`font-src data:${allowRemote ? ' https:' : ''}`,
			"form-action 'none'"
		].join('; ')
	);

	const BASE_STYLE = `html,body{margin:0;background:#fff;color:#1f2328}
body{padding:20px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}
img{max-width:100%;height:auto}pre{white-space:pre-wrap}a{color:#1d5fd1}
blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:3px solid #d0d7de;color:#57606a}`;

	const srcdoc = $derived(
		`<!doctype html><html><head><meta charset="utf-8">` +
			`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
			`<base target="_blank"><style>${BASE_STYLE}</style></head><body>${html}</body></html>`
	);

	let observer: ResizeObserver | undefined;

	/** Same-origin access (allow-same-origin, no scripts) lets the parent size the frame to its content. */
	function fit(event: Event) {
		const frame = event.currentTarget as HTMLIFrameElement;
		const doc = frame.contentDocument;
		if (!doc) return;
		const resize = () => (frame.style.height = `${doc.documentElement.scrollHeight}px`);
		observer?.disconnect();
		observer = new ResizeObserver(resize);
		observer.observe(doc.documentElement);
		resize();
	}
</script>

<iframe
	title="Message content"
	sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
	{srcdoc}
	onload={fit}
	class="block min-h-24 w-full rounded-lg border bg-white"
></iframe>
