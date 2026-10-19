import { describe, expect, it } from 'vitest';
import { attachmentKind, attachmentText } from './attachment-text';

/** A one-page PDF showing "Hello PDF", with a valid cross-reference table. */
function minimalPdf(): Buffer {
	const stream = 'BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf +=
		`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
		offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}

describe('attachmentKind', () => {
	it('recognizes documents by type, then by extension', () => {
		expect(attachmentKind('a.bin', 'application/pdf')).toEqual({ plain: false, fileType: 'pdf' });
		expect(attachmentKind('Offer.DOCX', 'application/octet-stream')).toEqual({
			plain: false,
			fileType: 'docx'
		});
		expect(attachmentKind('page', 'text/html; charset=utf-8')).toEqual({
			plain: false,
			fileType: 'html'
		});
	});

	it('reads text formats as they are and leaves other files alone', () => {
		expect(attachmentKind('data', 'text/csv')).toEqual({ plain: true });
		expect(attachmentKind('invite.ics', 'application/octet-stream')).toEqual({ plain: true });
		expect(attachmentKind('photo.jpg', 'image/jpeg')).toBeNull();
		expect(attachmentKind('setup.exe', 'application/octet-stream')).toBeNull();
	});
});

describe('attachmentText', () => {
	it('returns text files unchanged', async () => {
		const content = Buffer.from('name,amount\nApples,2\n');
		expect(await attachmentText({ filename: 'a.csv', contentType: 'text/csv', content })).toBe(
			'name,amount\nApples,2\n'
		);
	});

	it('extracts the text of a PDF', async () => {
		const text = await attachmentText({
			filename: 'hello.pdf',
			contentType: 'application/pdf',
			content: minimalPdf()
		});
		expect(text).toContain('Hello PDF');
		expect(text).not.toMatch(/^---/);
	});

	it('has no text for unknown binaries or unreadable documents', async () => {
		const content = Buffer.from([0, 1, 2, 3]);
		expect(
			await attachmentText({ filename: 'x.bin', contentType: 'application/zip', content })
		).toBeNull();
		expect(
			await attachmentText({ filename: 'x.pdf', contentType: 'application/pdf', content })
		).toBeNull();
	});
});
