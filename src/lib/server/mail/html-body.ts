import { convert } from 'html-to-text';
import { EMPTY_LINE, MAIL_FONT } from '../../html';
import { linkify, sanitizeEmailHtml } from './render';

/** Plain text (from AI clients and calendar replies) as editor HTML: one `<div>` per line. */
export function textToComposeHtml(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.trimEnd()
		.split('\n')
		.map((line) => (line ? `<div>${linkify(line)}</div>` : EMPTY_LINE))
		.join('');
}

/** The sent HTML document around the editor's content. */
export function outgoingHtml(html: string): string {
	return (
		'<!doctype html><html><head><meta charset="utf-8"></head>' +
		`<body style="${MAIL_FONT}">${html}</body></html>`
	);
}

/** The plain-text alternative of an HTML message; quotes keep their `> ` prefix. */
export function plainTextOf(html: string): string {
	return convert(html, {
		wordwrap: 78,
		selectors: [
			{ selector: 'img', format: 'skip' },
			{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }
		]
	});
}

/** A signature as stored: sanitized HTML, or null when nothing visible is left. */
export function signatureOrNull(html: string): string | null {
	const clean = sanitizeEmailHtml(html).html.trim();
	const visible = clean
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;|&#160;/g, ' ')
		.trim();
	return visible || /<img\b/i.test(clean) ? clean : null;
}
