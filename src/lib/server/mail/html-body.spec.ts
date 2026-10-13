import MailComposer from 'nodemailer/lib/mail-composer';
import { describe, expect, it } from 'vitest';
import {
	embedDataImages,
	outgoingHtml,
	plainTextOf,
	signatureOrNull,
	textToComposeHtml
} from './html-body';

describe('textToComposeHtml', () => {
	it('puts each line in a div, escapes text, and links addresses', () => {
		expect(textToComposeHtml('Hi <you> & co\r\n\nSee https://example.org.\n\n')).toBe(
			'<div>Hi &lt;you&gt; &amp; co</div><div><br></div>' +
				'<div>See <a href="https://example.org" target="_blank" rel="noopener noreferrer">https://example.org</a>.</div>'
		);
	});
});

describe('outgoingHtml', () => {
	it('wraps the content in a document in the account font', () => {
		expect(outgoingHtml('<div>Hi</div>', 'calibri')).toBe(
			'<!doctype html><html><head><meta charset="utf-8"></head>' +
				'<body><div style="font-family: Calibri, Carlito, \'Segoe UI\', Arial, sans-serif; font-size: 11pt">' +
				'<div>Hi</div></div></body></html>'
		);
	});

	it('names no font without one', () => {
		expect(outgoingHtml('<div>Hi</div>', null)).toBe(
			'<!doctype html><html><head><meta charset="utf-8"></head><body><div>Hi</div></body></html>'
		);
	});
});

describe('embedDataImages', () => {
	const png = 'iVBORw0KGgo=';

	it('turns data images into cid parts, one per distinct image', () => {
		const { html, images } = embedDataImages(
			`<img width="600" src="data:image/png;base64,${png}"><p>x</p>` +
				`<img src='data:image/png;base64,${png}'><img src="data:image/svg+xml;base64,PHN2Zy8+">` +
				'<img src="https://example.org/a.png">',
			'example.com'
		);
		expect(images.map((i) => [i.filename, i.contentType])).toEqual([
			['image-1.png', 'image/png'],
			['image-2.svg', 'image/svg+xml']
		]);
		expect(images[0].content).toEqual(Buffer.from(png, 'base64'));
		expect(images[0].cid).toMatch(/@example\.com$/);
		expect(html).toBe(
			`<img width="600" src="cid:${images[0].cid}"><p>x</p>` +
				`<img src='cid:${images[0].cid}'><img src="cid:${images[1].cid}">` +
				'<img src="https://example.org/a.png">'
		);
	});

	it('yields MIME with an inline image part and no data URI', async () => {
		const { html, images } = embedDataImages(`<img src="data:image/png;base64,${png}">`, 'b.c');
		const mime = (
			await new MailComposer({ from: 'a@b.c', html, attachments: images }).compile().build()
		).toString();
		expect(mime).toContain(`Content-ID: <${images[0].cid}>`);
		expect(mime).toContain('Content-Disposition: inline');
		expect(mime).not.toContain('data:image');
	});
});

describe('plainTextOf', () => {
	it('keeps quotes prefixed, drops images, and shows link targets once', () => {
		const text = plainTextOf(
			'<div>Thanks</div><img src="data:image/png;base64,AA==" alt="logo">' +
				'<div><a href="https://example.org">https://example.org</a> <a href="https://example.org/docs">docs</a></div>' +
				'<blockquote><div>Earlier</div></blockquote>'
		);
		expect(text).toBe('Thanks\nhttps://example.org docs [https://example.org/docs]\n> Earlier');
	});
});

describe('signatureOrNull', () => {
	it('keeps formatted signatures and images', () => {
		expect(signatureOrNull('<div><b style="color:#C00000">Example Org</b></div>')).toBe(
			'<div><b style="color:#C00000">Example Org</b></div>'
		);
		expect(signatureOrNull('<img src="data:image/png;base64,AA==">')).toBe(
			'<img src="data:image/png;base64,AA==" />'
		);
	});

	it('drops scripts and returns null when nothing visible is left', () => {
		expect(signatureOrNull('')).toBeNull();
		expect(signatureOrNull('<div><br></div><div>&nbsp; </div>')).toBeNull();
		expect(signatureOrNull('<script>alert(1)</script>')).toBeNull();
		expect(signatureOrNull('<div>Me<script>alert(1)</script></div>')).toBe('<div>Me</div>');
	});
});
