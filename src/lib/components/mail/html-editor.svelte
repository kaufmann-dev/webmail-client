<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Baseline from '@lucide/svelte/icons/baseline';
	import Bold from '@lucide/svelte/icons/bold';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import Italic from '@lucide/svelte/icons/italic';
	import LinkIcon from '@lucide/svelte/icons/link';
	import List from '@lucide/svelte/icons/list';
	import ListOrdered from '@lucide/svelte/icons/list-ordered';
	import RemoveFormatting from '@lucide/svelte/icons/remove-formatting';
	import Underline from '@lucide/svelte/icons/underline';
	import Unlink from '@lucide/svelte/icons/unlink';
	import TooltipButton from '#lib/components/tooltip-button.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { EMPTY_LINE, mailFontStyle, REMOTE_RESOURCE, type MailFont } from '#lib/html.js';
	import { cleanPastedHtml } from '#lib/paste-html.js';

	let {
		name,
		value,
		label,
		minHeight = 256,
		autofocus = false,
		font = null,
		onchange,
		onescape
	}: {
		/** The form field that always holds the editor's HTML. */
		name: string;
		value: string;
		label: string;
		minHeight?: number;
		autofocus?: boolean;
		/** The sending account's font, shown while writing; null for the recipient's default. */
		font?: MailFont | null;
		onchange?: () => void;
		onescape?: () => void;
	} = $props();

	const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
	const COLORS = [
		['Black', '#000000'],
		['Gray', '#595959'],
		['Red', '#C00000'],
		['Orange', '#C55A11'],
		['Green', '#38761D'],
		['Blue', '#1F4E79'],
		['Purple', '#7030A0']
	] as const;
	const FORMATS = {
		bold: 'bold',
		italic: 'italic',
		underline: 'underline',
		bullets: 'insertUnorderedList',
		numbers: 'insertOrderedList'
	} as const;
	type Format = keyof typeof FORMATS;

	// The editor owns its content after loading.
	const initial = untrack(() => value);
	let html = $state(initial);
	let active = $state<Record<Format, boolean>>({
		bold: false,
		italic: false,
		underline: false,
		bullets: false,
		numbers: false
	});
	let linkOpen = $state(false);
	let linkUrl = $state('');
	let imageInput = $state<HTMLInputElement | null>(null);
	let colorOpen = $state(false);
	let customColor = $state('#C00000');
	const validColor = $derived(/^#[0-9a-f]{6}$/i.test(customColor.trim()));
	const hasRemote = $derived(REMOTE_RESOURCE.test(html));

	let frame: HTMLIFrameElement | null = null;
	let doc: Document | null = null;
	let loaded = $state(false);
	/** The selection inside the editor, kept while toolbar menus and dialogs take focus. */
	let saved: Range | null = null;

	// The document runs no scripts (sandbox without allow-scripts) and loads nothing from the web
	// while editing; remote images stay in the markup and are sent with the message.
	const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:";
	const STYLE = `html{background:#fff}
body{margin:0;padding:12px 14px;color:#111;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;overflow-wrap:anywhere}
body:focus{outline:none}
img{max-width:100%;height:auto}
a{color:#1a56c4}`;
	const srcdoc =
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
		`<meta name="referrer" content="no-referrer"><style>${STYLE}</style></head>` +
		`<body>${initial}</body></html>`;

	function sync() {
		if (!doc) return;
		html = doc.body.innerHTML;
		onchange?.();
	}

	function refresh() {
		if (!doc) return;
		for (const format of Object.keys(FORMATS) as Format[]) {
			active[format] = doc.queryCommandState(FORMATS[format]);
		}
	}

	function remember() {
		const selection = doc?.getSelection();
		if (!doc || !selection?.rangeCount) return;
		const range = selection.getRangeAt(0);
		if (doc.body.contains(range.commonAncestorContainer)) saved = range.cloneRange();
	}

	function restore() {
		if (!doc || !frame) return;
		frame.contentWindow?.focus();
		doc.body.focus();
		const selection = doc.getSelection();
		if (saved && selection) {
			selection.removeAllRanges();
			selection.addRange(saved);
		}
	}

	function run(command: string, argument?: string) {
		if (!doc) return;
		restore();
		doc.execCommand(command, false, argument);
		remember();
		refresh();
		sync();
	}

	/** Places the caret at the start of the message. */
	export function focus() {
		if (!doc || !frame) return;
		frame.contentWindow?.focus();
		doc.body.focus();
		const range = doc.createRange();
		range.setStart(doc.body, 0);
		range.collapse(true);
		const selection = doc.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		remember();
	}

	function isEmptyLine(node: Element | null): node is Element {
		return node?.tagName === 'DIV' && node.innerHTML.trim() === '<br>';
	}

	/** Swaps the signature block (for another sender), adding or removing it as needed. */
	export function setSignature(signature: string | null) {
		if (!doc) return;
		const block = doc.body.querySelector('.wm-signature');
		if (!signature) {
			if (!block) return;
			const before = block.previousElementSibling;
			if (isEmptyLine(before)) before.remove();
			block.remove();
		} else if (block) {
			block.innerHTML = signature;
		} else {
			const fragment = doc
				.createRange()
				.createContextualFragment(`${EMPTY_LINE}<div class="wm-signature">${signature}</div>`);
			const quote = doc.body.querySelector('.wm-quote');
			const anchor =
				quote && isEmptyLine(quote.previousElementSibling) ? quote.previousElementSibling : quote;
			doc.body.insertBefore(fragment, anchor);
		}
		sync();
	}

	function readImage(file: File): Promise<string | null> {
		if (file.size > MAX_IMAGE_BYTES) {
			toast.error(`${file.name} is larger than 5 MB.`);
			return Promise.resolve(null);
		}
		return new Promise((done) => {
			const reader = new FileReader();
			reader.onload = () => done(typeof reader.result === 'string' ? reader.result : null);
			reader.onerror = () => done(null);
			reader.readAsDataURL(file);
		});
	}

	async function insertImages(files: File[]) {
		for (const file of files.filter((f) => f.type.startsWith('image/'))) {
			const url = await readImage(file);
			if (url) run('insertImage', url);
		}
	}

	function onpaste(event: ClipboardEvent) {
		const data = event.clipboardData;
		if (!data) return;
		const images = [...data.files].filter((f) => f.type.startsWith('image/'));
		if (images.length) {
			event.preventDefault();
			insertImages(images);
		} else if (data.types.includes('text/html')) {
			event.preventDefault();
			run('insertHTML', cleanPastedHtml(data.getData('text/html')));
		}
	}

	/** Dropped files would replace the editor's document; images are inserted instead. */
	function ondrop(event: DragEvent) {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (!files.length) return;
		event.preventDefault();
		insertImages(files);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			onescape?.();
		} else if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			openLink();
		}
	}

	/** Clicks below the last line still place the caret in the message. */
	function onmousedown(event: MouseEvent) {
		if (!doc || event.target !== doc.documentElement) return;
		event.preventDefault();
		doc.body.focus();
		const range = doc.createRange();
		range.selectNodeContents(doc.body);
		range.collapse(false);
		const selection = doc.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}

	/** The font is a style on the editor's body, outside the HTML that is sent. */
	function showFont(element: HTMLIFrameElement) {
		const body = loaded ? element.contentDocument?.body : null;
		if (body) body.setAttribute('style', mailFontStyle(font));
	}

	function editor(element: HTMLIFrameElement) {
		let observer: ResizeObserver | undefined;
		const load = () => {
			const d = element.contentDocument;
			if (!d) return;
			frame = element;
			doc = d;
			d.body.contentEditable = 'true';
			d.body.spellcheck = true;
			d.body.setAttribute('role', 'textbox');
			d.body.setAttribute('aria-multiline', 'true');
			d.body.setAttribute('aria-label', label);
			d.execCommand('styleWithCSS', false, 'true');
			d.execCommand('defaultParagraphSeparator', false, 'div');
			d.addEventListener('input', () => {
				remember();
				refresh();
				sync();
			});
			d.addEventListener('selectionchange', () => {
				remember();
				refresh();
			});
			d.addEventListener('paste', onpaste);
			d.addEventListener('dragover', (event) => {
				if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
			});
			d.addEventListener('drop', ondrop);
			d.addEventListener('keydown', onkeydown);
			d.addEventListener('mousedown', onmousedown);
			const resize = () =>
				(element.style.height = `${Math.max(minHeight, Math.ceil(d.body.getBoundingClientRect().height))}px`);
			observer = new ResizeObserver(resize);
			observer.observe(d.body);
			resize();
			loaded = true;
			if (autofocus) focus();
		};
		element.addEventListener('load', load);
		return () => {
			element.removeEventListener('load', load);
			observer?.disconnect();
			loaded = false;
			doc = null;
			frame = null;
		};
	}

	function openLink() {
		const anchor = saved?.commonAncestorContainer;
		const existing = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('a');
		linkUrl = existing?.getAttribute('href') ?? '';
		linkOpen = true;
	}

	function normalizeUrl(input: string): string | null {
		const url = input.trim();
		if (!url) return null;
		if (/^(?:https?:\/\/|mailto:)/i.test(url)) return url;
		if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
		if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
		return `https://${url}`;
	}

	function applyLink(event: SubmitEvent) {
		event.preventDefault();
		const url = normalizeUrl(linkUrl);
		if (!url) {
			toast.error('Enter a web or email address.');
			return;
		}
		linkOpen = false;
		if (!saved || saved.collapsed) {
			const text = url.replace(/^mailto:/i, '');
			const escape = (s: string) =>
				s
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;');
			run('insertHTML', `<a href="${escape(url)}">${escape(text)}</a>`);
		} else {
			run('createLink', url);
		}
	}

	function applyColor(event: SubmitEvent) {
		event.preventDefault();
		if (!validColor) return;
		colorOpen = false;
		run('foreColor', customColor.trim());
	}

	async function chooseImages(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		await insertImages(files);
	}

	/** Toolbar clicks keep the focus (and selection) in the editor. */
	function keepFocus(event: MouseEvent) {
		if ((event.target as Element).closest('button')) event.preventDefault();
	}
</script>

{#snippet toggle(format: Format, tooltip: string, shortcut?: string)}
	<TooltipButton
		variant="ghost"
		size="icon-sm"
		{tooltip}
		{shortcut}
		aria-pressed={active[format]}
		class={active[format] ? 'bg-selected text-selected-foreground' : ''}
		onclick={() => run(FORMATS[format])}
	>
		{#if format === 'bold'}<Bold />{:else if format === 'italic'}<Italic
			/>{:else if format === 'underline'}<Underline />{:else if format === 'bullets'}<List
			/>{:else}<ListOrdered />{/if}
		<span class="sr-only">{tooltip}</span>
	</TooltipButton>
{/snippet}

<div class="overflow-hidden rounded-md border">
	<div
		role="toolbar"
		aria-label="Formatting"
		tabindex="-1"
		class="flex flex-wrap items-center gap-0.5 border-b bg-background p-1"
		onmousedown={keepFocus}
	>
		{@render toggle('bold', 'Bold', 'Ctrl B')}
		{@render toggle('italic', 'Italic', 'Ctrl I')}
		{@render toggle('underline', 'Underline', 'Ctrl U')}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<TooltipButton {...props} variant="ghost" size="icon-sm" tooltip="Text color">
						<Baseline />
						<span class="sr-only">Text color</span>
					</TooltipButton>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
				{#each COLORS as [colorName, color] (color)}
					<DropdownMenu.Item onSelect={() => run('foreColor', color)}>
						<span class="size-3.5 rounded-sm border" style:background-color={color}></span>
						{colorName}
					</DropdownMenu.Item>
				{/each}
				<DropdownMenu.Separator />
				<DropdownMenu.Item onSelect={() => (colorOpen = true)}>Custom…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
		{@render toggle('bullets', 'Bulleted list')}
		{@render toggle('numbers', 'Numbered list')}
		<span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
		<TooltipButton
			variant="ghost"
			size="icon-sm"
			tooltip="Link"
			shortcut="Ctrl K"
			onclick={openLink}
		>
			<LinkIcon />
			<span class="sr-only">Link</span>
		</TooltipButton>
		<TooltipButton
			variant="ghost"
			size="icon-sm"
			tooltip="Remove link"
			onclick={() => run('unlink')}
		>
			<Unlink />
			<span class="sr-only">Remove link</span>
		</TooltipButton>
		<TooltipButton
			variant="ghost"
			size="icon-sm"
			tooltip="Insert image"
			onclick={() => imageInput?.click()}
		>
			<ImagePlus />
			<span class="sr-only">Insert image</span>
		</TooltipButton>
		<TooltipButton
			variant="ghost"
			size="icon-sm"
			tooltip="Clear formatting"
			onclick={() => run('removeFormat')}
		>
			<RemoveFormatting />
			<span class="sr-only">Clear formatting</span>
		</TooltipButton>
	</div>
	<iframe
		title={label}
		sandbox="allow-same-origin"
		{srcdoc}
		{@attach editor}
		{@attach showFont}
		class="block w-full bg-white scheme-light"
		style:height="{minHeight}px"
	></iframe>
</div>
{#if hasRemote}
	<p class="mt-1.5 text-xs text-muted-foreground">
		External images are hidden while editing and are still sent.
	</p>
{/if}

<input type="hidden" {name} value={html} />
<input
	bind:this={imageInput}
	type="file"
	accept="image/*"
	multiple
	class="sr-only"
	tabindex="-1"
	onchange={chooseImages}
/>

<Dialog.Root bind:open={colorOpen}>
	<Dialog.Content class="sm:max-w-sm" onCloseAutoFocus={(event) => event.preventDefault()}>
		<Dialog.Header>
			<Dialog.Title>Text color</Dialog.Title>
		</Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={applyColor}>
			<div class="flex items-center gap-2">
				<input
					type="color"
					value={validColor ? customColor.trim() : '#000000'}
					oninput={(event) => (customColor = event.currentTarget.value.toUpperCase())}
					class="h-8 w-10 shrink-0 cursor-pointer rounded-md border bg-background p-0.5"
					aria-label="Pick a color"
				/>
				<Input bind:value={customColor} placeholder="#C00000" aria-label="Hex color" />
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (colorOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={!validColor}>Apply</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={linkOpen}>
	<Dialog.Content class="sm:max-w-md" onCloseAutoFocus={(event) => event.preventDefault()}>
		<Dialog.Header>
			<Dialog.Title>Link</Dialog.Title>
		</Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={applyLink}>
			<Input
				bind:value={linkUrl}
				placeholder="https://example.org or name@example.org"
				aria-label="Address"
			/>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (linkOpen = false)}>Cancel</Button>
				<Button type="submit">Apply</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
