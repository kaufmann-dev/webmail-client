import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { bodyText, previewOf } from './body-text';
import { assembleSource, decodePartStart, planMessage, previewPart } from './structure';

const structure: MessageStructureObject = {
	type: 'multipart/mixed',
	parameters: { boundary: 'outer' },
	childNodes: [
		{
			part: '1',
			type: 'multipart/related',
			parameters: { boundary: 'related' },
			childNodes: [
				{
					part: '1.1',
					type: 'multipart/alternative',
					parameters: { boundary: 'alt' },
					childNodes: [
						{ part: '1.1.1', type: 'text/plain', parameters: { charset: 'utf-8' }, size: 6 },
						{ part: '1.1.2', type: 'text/html', parameters: { charset: 'utf-8' }, size: 40 }
					]
				},
				{ part: '1.2', type: 'image/png', id: '<logo>', encoding: 'base64', size: 8 }
			]
		},
		{
			part: '2',
			type: 'application/pdf',
			disposition: 'attachment',
			dispositionParameters: { filename: 'report.pdf' },
			encoding: 'base64',
			size: 4000
		},
		{ part: '3', type: 'text/calendar', parameters: { method: 'REQUEST' }, size: 30 }
	]
} as MessageStructureObject;

describe('planMessage', () => {
	it('fetches the body, embedded images, and calendar parts, and lists attachments', () => {
		const plan = planMessage(structure);
		expect(plan.whole).toBe(false);
		expect(plan.fetch).toEqual(['1.1.1', '1.1.2', '1.2', '3']);
		expect(plan.attachments).toEqual([
			{ partId: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 3000 },
			{ partId: '3', filename: null, contentType: 'text/calendar', size: 30 }
		]);
	});

	it('fetches single-part messages whole', () => {
		const plan = planMessage({ type: 'text/plain', size: 10 } as MessageStructureObject);
		expect(plan).toEqual({ whole: true, fetch: ['1'], attachments: [] });
	});
});

describe('assembleSource', () => {
	it('rebuilds a message mailparser reads without the skipped parts', async () => {
		const parts = new Map<string, Buffer>([
			['1.1.1', Buffer.from('Hallo!')],
			['1.1.2', Buffer.from('<p>Hallo!</p><img src="cid:logo">')],
			['1.2', Buffer.from('iVBORw0K')]
		]);
		const header = Buffer.from(
			'From: a@example.com\r\nSubject: Test\r\nMIME-Version: 1.0\r\n' +
				'Content-Type: multipart/mixed; boundary="outer"\r\n\r\n'
		);
		const parsed = await simpleParser(assembleSource(header, structure, parts));
		expect(parsed.subject).toBe('Test');
		expect(parsed.text?.trim()).toBe('Hallo!');
		expect(parsed.html).toContain('data:image/png;base64,iVBORw0K');
		expect(parsed.attachments.map((a) => a.contentType)).toEqual(['image/png']);
	});
});

describe('previewPart', () => {
	it('prefers the plain-text body and skips attachments', () => {
		expect(previewPart(structure)).toEqual({
			partId: '1.1.1',
			html: false,
			encoding: '7bit',
			charset: 'utf-8'
		});
	});

	it('falls back to HTML and handles single-part messages', () => {
		expect(
			previewPart({
				type: 'text/html',
				encoding: 'quoted-printable',
				parameters: { charset: 'windows-1252' }
			})
		).toEqual({ partId: '1', html: true, encoding: 'quoted-printable', charset: 'windows-1252' });
		expect(previewPart({ type: 'image/png' })).toBeNull();
	});
});

describe('decodePartStart', () => {
	it('decodes cut-off base64 and quoted-printable starts', () => {
		const base64 = Buffer.from('Grüße aus Wien'.repeat(20)).toString('base64');
		const cut = Buffer.from(`${base64.slice(0, 40)}\r\n${base64.slice(40, 61)}`);
		expect(decodePartStart(cut, { encoding: 'base64', charset: 'utf-8' })).toMatch(
			/^Grüße aus Wien/
		);
		const qp = Buffer.from('Gr=FC=DFe,=\r\n bitte =E4ndern=E');
		expect(decodePartStart(qp, { encoding: 'quoted-printable', charset: 'iso-8859-1' })).toBe(
			'Grüße, bitte ändern'
		);
	});

	it('previews a cut-off reply with only its new text', () => {
		const raw = Buffer.from(
			'Passt, bis Donnerstag!=0D=0A=0D=0AVon: Anna Berger <anna@example.com>=0D=0AGesendet: Mo=\r\nntag, 12. Oktober=0D=0A=\r\n> lange alte Nachricht ',
			'latin1'
		);
		const text = decodePartStart(raw, { encoding: 'quoted-printable', charset: 'utf-8' });
		expect(previewOf(bodyText({ html: null, text, subject: 'AW: Termin' }))).toBe(
			'Passt, bis Donnerstag!'
		);
	});
});
