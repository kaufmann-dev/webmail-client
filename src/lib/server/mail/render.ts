import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
	...sanitizeHtml.defaults.allowedTags,
	'img',
	'style',
	'font',
	'center',
	'span',
	'del',
	'ins',
	'u',
	's',
	'strike',
	'small',
	'big'
];

const PRESENTATION = [
	'style',
	'class',
	'align',
	'valign',
	'width',
	'height',
	'bgcolor',
	'background',
	'color',
	'face',
	'size',
	'dir',
	'lang',
	'title',
	'border',
	'cellpadding',
	'cellspacing'
];

const OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: ALLOWED_TAGS,
	allowedAttributes: {
		'*': PRESENTATION,
		a: ['href', 'name', 'target', 'rel'],
		img: ['src', 'alt', 'width', 'height'],
		td: ['colspan', 'rowspan', 'nowrap'],
		th: ['colspan', 'rowspan', 'nowrap', 'scope'],
		ol: ['start', 'type'],
		li: ['value']
	},
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	allowedSchemesByTag: { img: ['http', 'https', 'data'] },
	allowProtocolRelative: false,
	// <style> is kept for layout; the rendering iframe has no scripts and a CSP that blocks remote loads.
	allowVulnerableTags: true,
	nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head'],
	transformTags: {
		a: (tagName, attribs) => ({
			tagName,
			attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' }
		})
	}
};

const REMOTE =
	/(?:\bsrc\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|\bbackground\s*=\s*["']?\s*https?:)/i;

/**
 * Email HTML made safe for display: no scripts, forms, frames, or event handlers. Embedded `cid:`
 * images arrive as data URIs from the parser. Remote resources stay in the markup; the iframe's
 * CSP decides whether they load.
 */
export function sanitizeEmailHtml(html: string): { html: string; hasRemoteImages: boolean } {
	const clean = sanitizeHtml(html, OPTIONS);
	return { html: clean, hasRemoteImages: REMOTE.test(clean) };
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Plain-text mail as HTML with clickable links and preserved line breaks. */
export function textToHtml(text: string): string {
	const linked = escapeHtml(text).replace(
		/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
		(url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
	);
	return `<div style="white-space: pre-wrap; overflow-wrap: anywhere">${linked}</div>`;
}
