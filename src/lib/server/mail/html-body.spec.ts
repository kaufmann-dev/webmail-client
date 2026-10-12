import { describe, expect, it } from 'vitest';
import { outgoingHtml, plainTextOf, signatureOrNull, textToComposeHtml } from './html-body';

describe('textToComposeHtml', () => {
	it('puts each line in a div, escapes text, and links addresses', () => {
		expect(textToComposeHtml('Hi <you> & co\r\n\nSee https://example.org.\n\n')).toBe(
			'<div>Hi &lt;you&gt; &amp; co</div><div><br></div>' +
				'<div>See <a href="https://example.org" target="_blank" rel="noopener noreferrer">https://example.org</a>.</div>'
		);
	});
});

describe('outgoingHtml', () => {
	it('wraps the content in a document with the mail font', () => {
		const html = outgoingHtml('<div>Hi</div>');
		expect(html).toMatch(
			/^<!doctype html><html><head><meta charset="utf-8"><\/head><body style="font-family: Arial/
		);
		expect(html).toMatch(/<div>Hi<\/div><\/body><\/html>$/);
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
