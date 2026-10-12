import sanitizeHtml from 'sanitize-html';
import { REMOTE_RESOURCE } from '../../html';

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

/**
 * The style sheets of the document head moved into the body; sanitize-html drops the head with
 * everything in it. Outlook keeps its paragraph spacing there (`p.MsoNormal { margin: 0 }`), so
 * without them its mails, and replies quoting them, show a gap after every line.
 */
function hoistHeadStyles(html: string): string {
	return html.replace(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i, (_, head: string) =>
		(head.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) ?? []).join('')
	);
}

/**
 * Email HTML made safe for display: no scripts, forms, frames, or event handlers. Embedded `cid:`
 * images arrive as data URIs from the parser. Remote resources stay in the markup; the iframe's
 * CSP decides whether they load.
 */
export function sanitizeEmailHtml(html: string): { html: string; hasRemoteImages: boolean } {
	const clean = sanitizeHtml(hoistHeadStyles(html), OPTIONS);
	return { html: clean, hasRemoteImages: REMOTE_RESOURCE.test(clean) };
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

/** Escapes plain text and turns its web addresses into links. */
export function linkify(text: string): string {
	return escapeHtml(text).replace(
		/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
		(url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
	);
}

/** Plain-text mail as HTML with clickable links and preserved line breaks. */
export function textToHtml(text: string): string {
	return `<div style="white-space: pre-wrap; overflow-wrap: anywhere">${linkify(text)}</div>`;
}
