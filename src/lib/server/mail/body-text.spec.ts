import { describe, expect, it } from 'vitest';
import {
	bodyText,
	markdownTable,
	normalizeText,
	previewOf,
	previewOfCollapsed,
	quoteIndex
} from './body-text';

/** Outlook desktop (Word HTML): a German reply chain with three quoted levels. */
const OUTLOOK_CHAIN = `<html><head><style>p.MsoNormal{margin:0cm;font-size:11.0pt}</style></head>
<body lang="DE-AT"><div class="WordSection1">
<p class="MsoNormal">Hallo Frau Berger,<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">passt, ich bringe die Unterlagen am Donnerstag mit.<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<p class="MsoNormal">LG Max<o:p></o:p></p>
<p class="MsoNormal"><o:p>&nbsp;</o:p></p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
<p class="MsoNormal"><b>Von:</b> Berger Anna &lt;anna.berger@example.org&gt; <br>
<b>Gesendet:</b> Montag, 12. Oktober 2026 09:14<br>
<b>An:</b> MUSTER Max &lt;max.muster@example.org&gt;<br>
<b>Betreff:</b> AW: AW: Termin Elternabend<o:p></o:p></p></div>
<p class="MsoNormal">Lieber Herr Muster,<o:p></o:p></p>
<p class="MsoNormal">können Sie die Anwesenheitsliste mitbringen?<o:p></o:p></p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
<p class="MsoNormal"><b>Von:</b> MUSTER Max &lt;max.muster@example.org&gt; <br>
<b>Gesendet:</b> Freitag, 9. Oktober 2026 16:02<br>
<b>An:</b> Berger Anna &lt;anna.berger@example.org&gt;<br>
<b>Betreff:</b> AW: Termin Elternabend<o:p></o:p></p></div>
<p class="MsoNormal">Donnerstag 18 Uhr geht bei mir.<o:p></o:p></p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
<p class="MsoNormal"><b>Von:</b> Berger Anna &lt;anna.berger@example.org&gt; <br>
<b>Gesendet:</b> Freitag, 9. Oktober 2026 11:40<br>
<b>An:</b> MUSTER Max &lt;max.muster@example.org&gt;<br>
<b>Betreff:</b> Termin Elternabend<o:p></o:p></p></div>
<p class="MsoNormal">Wann passt Ihnen der Elternabend?<o:p></o:p></p>
</div></body></html>`;

/** Outlook on the web: the quote sits in #divRplyFwdMsg after a rule. */
const OWA_REPLY = `<div dir="ltr">Danke, erledigt!</div>
<div id="appendonsend"></div>
<hr style="display:inline-block;width:98%" tabindex="-1">
<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif"><b>Von:</b> Berger Anna<br>
<b>Gesendet:</b> Montag, 12. Oktober 2026 09:14<br><b>An:</b> MUSTER Max<br>
<b>Betreff:</b> Liste</font><div>&nbsp;</div></div>
<div>Bitte die Liste schicken.</div>`;

const GMAIL_REPLY = `<div dir="ltr">Sounds good, see you Thursday.<div><br></div><div>Max</div></div><br>
<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 9:14 AM Anna Berger &lt;<a href="mailto:anna@example.com">anna@example.com</a>&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">
<div dir="ltr">Does Thursday work for you?</div></blockquote></div>`;

const TABLE_MAIL = `<p>Die Termine f&uuml;r n&auml;chste Woche &amp; die R&auml;ume:</p>
<table><tr><th>Tag</th><th>Raum</th></tr>
<tr><td>Montag</td><td>A&nbsp;1.04</td></tr>
<tr><td>Dienstag</td><td>B | 2</td></tr></table>
<p>Plan: <img src="cid:image002.png@01DD54C5.2B076BA0" width="200"></p>
<p>Fragen an <a href="mailto:office@example.com">office@example.com</a> &lt;bitte bis Freitag&gt;.</p>
<img src="https://tracker.example.com/open.gif" width="1" height="1">`;

describe('bodyText', () => {
	it('keeps only the new text of a German Outlook chain with three quoted levels', () => {
		const body = bodyText({
			html: OUTLOOK_CHAIN,
			text: '',
			subject: 'AW: AW: AW: Termin Elternabend'
		});
		expect(body.newText).toBe(
			'Hallo Frau Berger,\n\npasst, ich bringe die Unterlagen am Donnerstag mit.\n\nLG Max'
		);
		expect(body.text).toContain('Von: Berger Anna <anna.berger@example.org>');
		expect(body.text).toContain('Wann passt Ihnen der Elternabend?');
		expect(body.text).not.toMatch(/&lt;|&gt;|&nbsp;/);
	});

	it('cuts Outlook on the web replies at their quote container', () => {
		const body = bodyText({ html: OWA_REPLY, text: '', subject: 'AW: Liste' });
		expect(body.newText).toBe('Danke, erledigt!');
		expect(body.text).toContain('Bitte die Liste schicken.');
	});

	it('cuts Gmail replies at gmail_quote, attribution included', () => {
		const body = bodyText({ html: GMAIL_REPLY, text: '', subject: 'Re: Thursday' });
		expect(body.newText).toBe('Sounds good, see you Thursday.\n\nMax');
		expect(body.text).toContain('> Does Thursday work for you?');
	});

	it('converts tables, entities, and inline images', () => {
		const body = bodyText({
			html: TABLE_MAIL,
			text: '',
			subject: 'Termine',
			images: new Map([['image002.png@01DD54C5.2B076BA0', 'raumplan.png']])
		});
		expect(body.newText).toBeNull();
		expect(body.text).toBe(
			[
				'Die Termine für nächste Woche & die Räume:',
				'',
				'| Tag | Raum |',
				'| --- | --- |',
				'| Montag | A 1.04 |',
				'| Dienstag | B \\| 2 |',
				'',
				'Plan: [image: raumplan.png]',
				'',
				'Fragen an office@example.com <bitte bis Freitag>.'
			].join('\n')
		);
	});

	it('decodes entities once, as mail programs show them', () => {
		const html = '<blockquote>Von MUSTER Max &amp;lt;max@example.org&amp;gt;:</blockquote>';
		expect(bodyText({ html, text: '', subject: '' }).text).toBe(
			'> Von MUSTER Max &lt;max@example.org&gt;:'
		);
	});

	it('names embedded images by their Content-ID without a file name', () => {
		const body = bodyText({
			html: '<p><img src="cid:image001.jpg@01DD0000.1"></p>',
			text: '',
			subject: ''
		});
		expect(body.text).toBe('[image: image001.jpg]');
	});

	it('flattens layout tables instead of making Markdown of them', () => {
		const html =
			'<table role="presentation"><tr><td>Logo</td><td>Max Muster<br>Office</td></tr>' +
			'<tr><td></td><td>+43 1 234</td></tr></table>';
		const body = bodyText({ html, text: '', subject: '' });
		expect(body.text).not.toContain('|');
		expect(body.text).toBe('Logo\nMax Muster\nOffice\n+43 1 234');
	});

	it('keeps forwarded content of forwards', () => {
		const body = bodyText({ html: OWA_REPLY, text: '', subject: 'WG: Liste' });
		expect(body.newText).toBeNull();
		expect(body.text).toContain('Bitte die Liste schicken.');
	});

	it('cuts plain-text replies at the attribution and leaves interleaved quotes alone', () => {
		const reply =
			'Ja, gerne.\r\n\r\n\r\n\r\nAm 12.10.2026 um 09:14 schrieb Anna Berger <anna@example.com>:\r\n> Kommst du?\r\n>\r\n> Anna\r\n';
		expect(bodyText({ html: null, text: reply, subject: 'Re: Treffen' })).toEqual({
			text: 'Ja, gerne.\n\nAm 12.10.2026 um 09:14 schrieb Anna Berger <anna@example.com>:\n> Kommst du?\n>\n> Anna',
			newText: 'Ja, gerne.'
		});
		const inline = '> Kommst du?\nJa.\n> Um 10?\nPasst.';
		expect(bodyText({ html: null, text: inline, subject: 'Re: Treffen' }).newText).toBeNull();
	});

	it('does not decode entities that plain-text mail really contains', () => {
		expect(bodyText({ html: null, text: 'if (a &lt; b)', subject: '' }).text).toBe('if (a &lt; b)');
	});
});

describe('quoteIndex', () => {
	it('finds the usual separators', () => {
		for (const quote of [
			'-----Ursprüngliche Nachricht-----\nVon: x',
			'-----Original Message-----\nFrom: x',
			'From: Anna <a@example.com>\nSent: Monday, October 12, 2026 9:14 AM\nTo: Max',
			'On Mon, Oct 12, 2026 at 9:14 AM Anna <\na@example.com> wrote:\n> hi',
			'________________________________\nVon: Anna'
		]) {
			expect(quoteIndex(`Neu.\n\n${quote}`)).toBe(6);
		}
	});

	it('ignores sentences that only look like attributions', () => {
		expect(quoteIndex('Am Montag schrieb er mir:\ndas passt.')).toBe(-1);
		expect(quoteIndex('From: the team, with thanks')).toBe(-1);
	});
});

describe('previews', () => {
	it('shows only the new text of a reply, on one line', () => {
		const body = bodyText({ html: OUTLOOK_CHAIN, text: '', subject: 'AW: Termin' });
		expect(previewOf(body)).toBe(
			'Hallo Frau Berger, passt, ich bringe die Unterlagen am Donnerstag mit. LG Max'
		);
	});

	it('cuts long text at 200 characters with an ellipsis', () => {
		const preview = previewOf({ text: 'Wort '.repeat(100), newText: null });
		expect(preview.length).toBeLessThanOrEqual(200);
		expect(preview.endsWith('…')).toBe(true);
	});

	it('cuts Exchange previews at quote headers the 255-character cut left incomplete', () => {
		const lead =
			'Hallo Max, ich hoffe, du bist gut zurück! Gibt es schon Neuigkeiten zum Angebot? Du wolltest ' +
			'ja beim Lieferanten wegen der offenen Positionen nachfragen. Liebe Grüße, Anna';
		const cut = `${lead} Von: MUSTER Max &lt;max.muster@example.org&gt; Gesendet: Montag`.slice(
			0,
			255
		);
		expect(previewOfCollapsed(cut, 'AW: Angebot')).toBe(lead);
		const ticket =
			'Hallo Max, der alte Eintrag hatte noch eine Referenz auf ein anderes Konto. Diese habe ich ' +
			'entfernt – kannst du es bitte erneut versuchen? LG Tom Am Montag, 12. Oktober 2026 ' +
			'um 12:39:27, schrieb Support Beispiel GmbH via Helpdesk Beispiel GmbH <support@example.com>';
		expect(previewOfCollapsed(ticket.slice(0, 255), 'RE: Eintrag')).toMatch(/LG Tom$/);
		const long = 'Am 15. Oktober findet die Sitzung statt. '.repeat(7).slice(0, 255);
		expect(previewOfCollapsed(long, 'Sitzung').startsWith('Am 15. Oktober')).toBe(true);
	});

	it('keeps Exchange previews as the plain text they are', () => {
		expect(previewOfCollapsed('Preis &lt; 100', 'Angebot')).toBe('Preis &lt; 100');
	});

	it('converts HTML sent as plain text', () => {
		const text = '<html><body><p>Ihr Kontoauszug<br />ist bereit.</p></body></html>';
		expect(previewOf(bodyText({ html: null, text, subject: 'Statement' }))).toBe(
			'Ihr Kontoauszug ist bereit.'
		);
	});

	it('cuts collapsed Exchange previews at the quote', () => {
		expect(
			previewOfCollapsed(
				'Danke, passt! ________________________________ Von: Anna Berger Gesendet: Montag, 12. Oktober',
				'AW: Termin'
			)
		).toBe('Danke, passt!');
		expect(
			previewOfCollapsed(
				'Danke! Von: Anna Berger <a@b.at> Gesendet: Montag, 12. Oktober 2026 An: Max',
				'AW: x'
			)
		).toBe('Danke!');
	});
});

describe('markdownTable', () => {
	it('fills spanned cells and drops empty rows', () => {
		expect(
			markdownTable([
				[
					{ text: 'A', colspan: 2, rowspan: 1 },
					{ text: 'B', colspan: 1, rowspan: 2 }
				],
				[
					{ text: 'c', colspan: 1, rowspan: 1 },
					{ text: 'd', colspan: 1, rowspan: 1 }
				],
				[{ text: '', colspan: 3, rowspan: 1 }]
			])
		).toBe('| A |  | B |\n| --- | --- | --- |\n| c | d |  |');
	});
});

describe('normalizeText', () => {
	it('normalizes line ends, invisible characters, and empty lines', () => {
		expect(normalizeText('a\u200b\u00a0b \r\n\r\n\r\n\r\nc\u034f')).toBe('a b\n\nc');
	});
});
