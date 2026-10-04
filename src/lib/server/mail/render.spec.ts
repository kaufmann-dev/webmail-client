import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, textToHtml } from './render';

describe('sanitizeEmailHtml', () => {
	it('removes scripts, handlers, forms, and frames', () => {
		const { html } = sanitizeEmailHtml(
			'<p onclick="x()">Hi<script>alert(1)</script></p><form action="/x"><input></form><iframe src="https://e.test"></iframe><a href="javascript:alert(1)">x</a>'
		);
		expect(html).not.toMatch(/script|onclick|<form|<input|<iframe|javascript:/i);
		expect(html).toContain('<p>Hi</p>');
	});

	it('keeps layout markup and opens links in a new tab', () => {
		const { html } = sanitizeEmailHtml(
			'<table width="600"><tr><td style="color:red">x</td></tr></table><a href="https://example.com">l</a>'
		);
		expect(html).toContain('<td style="color:red">');
		expect(html).toContain('target="_blank" rel="noopener noreferrer"');
	});

	it('reports remote images but not inline data images', () => {
		expect(sanitizeEmailHtml('<img src="https://t.test/p.gif">').hasRemoteImages).toBe(true);
		expect(
			sanitizeEmailHtml('<div style="background:url(https://t.test/b.png)">x</div>').hasRemoteImages
		).toBe(true);
		const inline = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
		expect(inline.hasRemoteImages).toBe(false);
		expect(inline.html).toContain('data:image/png');
	});
});

describe('textToHtml', () => {
	it('escapes markup and links URLs', () => {
		const html = textToHtml('<b>hi</b> see https://example.com/a?b=1.');
		expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
		expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank"');
	});
});
