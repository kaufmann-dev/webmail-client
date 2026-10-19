import { randomUUID } from 'node:crypto';
import { convert } from 'html-to-text';
import { EMPTY_LINE, mailFontStyle, type MailFont } from '../../html';
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

/**
 * The sent HTML document around the editor's content. The account's font goes on a wrapping
 * `<div>`, since some mail programs (Gmail among them) drop styles on `<body>`.
 */
export function outgoingHtml(html: string, font: MailFont | null): string {
	const style = mailFontStyle(font);
	const body = style ? `<div style="${style}">${html}</div>` : html;
	return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

export interface EmbeddedImage {
	filename: string;
	contentType: string;
	content: Buffer;
	cid: string;
}

const DATA_IMAGE = /(<img\b[^>]*?\ssrc\s*=\s*["']?)data:([\w.+-]+\/[\w.+-]+);base64,([^"'\s>]+)/gi;

/** The HTML without its `data:` images, for Exchange calendar items, which cannot carry them. */
export function withoutDataImages(html: string): string {
	return html.replace(/<img\b[^>]*?\ssrc\s*=\s*["']?data:[^>]*>/gi, '');
}

/**
 * `data:` images (pasted, signature, and quoted ones) as inline parts referenced by `cid:`. Mail
 * programs and Exchange drop `data:` sources; nodemailer's `attachDataUrls` only works in its
 * transport, not in `MailComposer`. Repeated images share one part.
 */
export function embedDataImages(
	html: string,
	domain: string
): { html: string; images: EmbeddedImage[] } {
	const byUri = new Map<string, EmbeddedImage>();
	const out = html.replace(DATA_IMAGE, (_, prefix: string, contentType: string, data: string) => {
		const uri = `${contentType}:${data}`;
		let image = byUri.get(uri);
		if (!image) {
			const extension = contentType.split('/')[1].replace(/\+.*$/, '');
			image = {
				filename: `image-${byUri.size + 1}.${extension}`,
				contentType,
				content: Buffer.from(data, 'base64'),
				cid: `${randomUUID()}@${domain}`
			};
			byUri.set(uri, image);
		}
		return `${prefix}cid:${image.cid}`;
	});
	return { html: out, images: [...byUri.values()] };
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
