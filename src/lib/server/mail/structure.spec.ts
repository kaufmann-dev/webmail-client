import type { MessageStructureObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { assembleSource, planMessage } from './structure';

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
