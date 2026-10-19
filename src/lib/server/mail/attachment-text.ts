import { OfficeParser } from 'officeparser';
import type { SupportedFileType } from 'officeparser';

/**
 * Attachments as text for AI clients: plain text as it is, and documents (PDF, Office,
 * OpenDocument, RTF, HTML, EPUB) as Markdown, which keeps headings and tables. Anything else, or a
 * document that cannot be parsed, has no text.
 */

const MAX_PARSED_BYTES = 25 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 30_000;

const PLAIN_TYPES = /^text\/(?!html|rtf)|[/+](json|xml|csv)$|^text\/calendar$|^application\/ics$/;
const PLAIN_EXTENSIONS = new Set([
	'txt',
	'csv',
	'tsv',
	'json',
	'xml',
	'ics',
	'log',
	'md',
	'yaml',
	'yml'
]);

const DOCUMENT_TYPES: Record<string, SupportedFileType> = {
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
	'application/vnd.oasis.opendocument.text': 'odt',
	'application/vnd.oasis.opendocument.spreadsheet': 'ods',
	'application/vnd.oasis.opendocument.presentation': 'odp',
	'application/rtf': 'rtf',
	'text/rtf': 'rtf',
	'text/html': 'html',
	'application/epub+zip': 'epub'
};
const DOCUMENT_EXTENSIONS: Record<string, SupportedFileType> = {
	pdf: 'pdf',
	docx: 'docx',
	xlsx: 'xlsx',
	pptx: 'pptx',
	odt: 'odt',
	ods: 'ods',
	odp: 'odp',
	rtf: 'rtf',
	html: 'html',
	htm: 'html',
	epub: 'epub'
};

type Kind = { plain: true } | { plain: false; fileType: SupportedFileType };

/** How to read a file, by MIME type first, then by extension (mail often says octet-stream). */
export function attachmentKind(filename: string, contentType: string): Kind | null {
	const type = contentType.split(';', 1)[0].trim().toLowerCase();
	const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
	const fileType = DOCUMENT_TYPES[type] ?? DOCUMENT_EXTENSIONS[extension];
	if (fileType) return { plain: false, fileType };
	if (PLAIN_TYPES.test(type) || PLAIN_EXTENSIONS.has(extension)) return { plain: true };
	return null;
}

export async function attachmentText(file: {
	filename: string;
	contentType: string;
	content: Buffer;
}): Promise<string | null> {
	const kind = attachmentKind(file.filename, file.contentType);
	if (!kind) return null;
	if (kind.plain) return file.content.toString('utf8');
	if (file.content.length > MAX_PARSED_BYTES) return null;
	try {
		const ast = await OfficeParser.parseOffice(file.content, {
			fileType: kind.fileType,
			ocr: false,
			extractAttachments: false,
			abortSignal: AbortSignal.timeout(PARSE_TIMEOUT_MS)
		});
		const { value } = await ast.to('md');
		// The YAML front matter only holds document metadata such as creation dates, and a page
		// break (`---`) comes before the first page too.
		return value
			.replace(/^---\n[\s\S]*?\n---\n+/, '')
			.replace(/^(?:---\s*\n)+/, '')
			.trim();
	} catch {
		return null;
	}
}
