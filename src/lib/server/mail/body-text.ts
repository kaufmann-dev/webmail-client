import { compile, type DomNode, type FormatCallback } from 'html-to-text';
import type { BlockTextBuilder, TablePrinterCell } from 'html-to-text/lib/block-text-builder';

/**
 * Message bodies as clean plain text for AI clients: HTML converted with decoded entities,
 * Markdown tables, and `[image: name]` for embedded images, plus the new text of a reply without
 * the quoted conversation below it.
 */

export interface BodyText {
	/** The whole body; quoted messages keep their `> ` prefix where the HTML marks them. */
	text: string;
	/** The body above the first quoted message, or null when nothing is quoted. */
	newText: string | null;
}

/** Marks where a quoted message starts in converted HTML; private use, never in real text. */
const QUOTE_MARK = '\uE000';

/** Containers mail programs put a quoted or forwarded message in. */
const QUOTE_CONTAINERS = [
	'#appendonsend',
	'#divRplyFwdMsg',
	'#mail-editor-reference-message-container',
	'.gmail_quote',
	'.moz-cite-prefix',
	'.yahoo_quoted',
	'.OutlookMessageHeader',
	'.wm-quote'
];

const ELEMENT_LIMIT = 50;

function tags(nodes: DomNode[] | undefined, names: string[]): DomNode[] {
	return (nodes ?? []).filter((n) => n.type === 'tag' && names.includes(n.name ?? ''));
}

/** The rows of a table, not those of tables nested in it. */
function tableRows(table: DomNode): DomNode[] {
	return [
		...tags(table.children, ['tr']),
		...tags(table.children, ['thead', 'tbody', 'tfoot']).flatMap((s) => tags(s.children, ['tr']))
	];
}

function containsTable(node: DomNode): boolean {
	return (node.children ?? []).some(
		(child) => (child.type === 'tag' && child.name === 'table') || containsTable(child)
	);
}

/**
 * Tables with data (at least two rows of two cells, nothing nested) become Markdown tables. Mail
 * layouts such as newsletters and signatures nest tables or use single cells; those are text.
 */
function isDataTable(table: DomNode, rows: DomNode[]): boolean {
	if (table.attribs?.role === 'presentation' || containsTable(table)) return false;
	return rows.filter((row) => tags(row.children, ['td', 'th']).length >= 2).length >= 2;
}

const span = (value: unknown) => Math.min(Math.max(Number(value) || 1, 1), ELEMENT_LIMIT);

function cellText(text: string): string {
	return text
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\|/g, '\\|')
		.trim();
}

/** A Markdown table; spanned cells repeat as empty cells, empty rows and columns are dropped. */
export function markdownTable(rows: TablePrinterCell[][]): string {
	const grid: string[][] = [];
	rows.forEach((cells, r) => {
		const row = (grid[r] ??= []);
		let c = 0;
		for (const cell of cells) {
			while (row[c] !== undefined) c++;
			const rowspan = Math.min(span(cell.rowspan), rows.length - r);
			for (let dr = 0; dr < rowspan; dr++) {
				const target = (grid[r + dr] ??= []);
				for (let dc = 0; dc < span(cell.colspan); dc++) {
					target[c + dc] = dr === 0 && dc === 0 ? cellText(cell.text) : '';
				}
			}
			c += span(cell.colspan);
		}
	});
	const width = Math.max(0, ...grid.map((row) => row.length));
	const filled = grid
		.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ''))
		.filter((row) => row.some(Boolean));
	const columns = [...Array(width).keys()].filter((c) => filled.some((row) => row[c]));
	const table = filled.map((row) => columns.map((c) => row[c]));
	if (!table.length) return '';
	if (columns.length < 2) return table.map((row) => row.join('')).join('\n');
	const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
	return [line(table[0]), line(columns.map(() => '---')), ...table.slice(1).map(line)].join('\n');
}

const formatTable: FormatCallback = (elem, walk, builder) => {
	const rows = tableRows(elem);
	if (!isDataTable(elem, rows)) {
		builder.openBlock({ leadingLineBreaks: 1 });
		walk(elem.children, builder);
		builder.closeBlock({ trailingLineBreaks: 1 });
		return;
	}
	builder.openTable();
	for (const row of rows) {
		builder.openTableRow();
		for (const cell of tags(row.children, ['td', 'th'])) {
			builder.openTableCell();
			walk(cell.children, builder);
			builder.closeTableCell({
				colspan: span(cell.attribs?.colspan),
				rowspan: span(cell.attribs?.rowspan)
			});
		}
		builder.closeTableRow();
	}
	builder.closeTable({ tableToString: markdownTable, leadingLineBreaks: 2, trailingLineBreaks: 2 });
};

interface Metadata {
	/** File names of embedded images by Content-ID (without angle brackets). */
	images: Map<string, string>;
}

/** Embedded images by file name; remote images only by their alt text, tracking pixels not at all. */
const formatImage: FormatCallback = (elem, _walk, builder) => {
	const src: string = elem.attribs?.src ?? '';
	const alt = String(elem.attribs?.alt ?? '').trim();
	const metadata = (builder as BlockTextBuilder & { metadata?: Metadata }).metadata;
	let name = alt;
	if (/^cid:/i.test(src)) {
		const cid = src.slice(4);
		name = metadata?.images.get(cid) ?? (cid.split('@')[0] || alt);
	} else if (/^data:/i.test(src)) {
		name = alt || 'image';
	}
	if (name) builder.addInline(`[image: ${name}]`, { noWordTransform: true });
};

/** The start of a quoted message: marked, then formatted as a block or `> ` quote. */
const formatQuote: FormatCallback = (elem, walk, builder, options) => {
	builder.addInline(QUOTE_MARK, { noWordTransform: true });
	const format = elem.name === 'blockquote' ? 'blockquote' : 'block';
	builder.options.formatters[format](elem, walk, builder, options);
};

const block = (lines = 1) => ({
	format: 'block',
	options: { leadingLineBreaks: lines, trailingLineBreaks: lines }
});

const convertHtml = compile({
	wordwrap: false,
	formatters: {
		mailTable: formatTable,
		mailImage: formatImage,
		mailQuote: formatQuote
	},
	selectors: [
		{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
		{ selector: 'img', format: 'mailImage' },
		{ selector: 'table', format: 'mailTable' },
		{ selector: 'tr', ...block() },
		{ selector: 'td', ...block() },
		{ selector: 'th', ...block() },
		{ selector: 'hr', format: 'horizontalLine', options: { length: 3 } },
		{ selector: 'ul', options: { itemPrefix: '- ' } },
		{
			selector: 'blockquote',
			format: 'mailQuote',
			options: { leadingLineBreaks: 2, trailingLineBreaks: 2, trimEmptyLines: true }
		},
		...QUOTE_CONTAINERS.map((selector) => ({ ...block(), selector, format: 'mailQuote' })),
		...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
			selector,
			options: { uppercase: false }
		})),
		{ selector: 'style', format: 'skip' },
		{ selector: 'script', format: 'skip' }
	]
}) as unknown as (html: string, metadata: Metadata) => string;

/**
 * Plain text with consistent whitespace: `\n` line ends, no invisible characters, no trailing
 * spaces, and at most one empty line in a row.
 */
export function normalizeText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[\u00a0\u2007\u202f]/g, ' ')
		.replace(/\u00ad|\u034f|\u200b|\u200c|\u2060|\ufeff/g, '')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * HTML as plain text; quoted messages are marked with `QUOTE_MARK`. Entities are decoded once,
 * so text a sender encoded twice reads as mail programs show it.
 */
function htmlText(html: string, images: Map<string, string>): string {
	return convertHtml(html, { images }).replace(/([^\s[\]]+@[^\s[\]]+) \[mailto:\1\]/g, '$1');
}

const SEPARATOR = String.raw`-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Originalnachricht|Original-Nachricht|Message d'origine|Messaggio originale|Mensaje original)\s*-{2,}`;
const UNDERLINE = String.raw`_{10,}\s*\*?(?:Von|From|De|Da)\*?:`;
const WROTE = String.raw`(?:schrieb|wrote|a écrit|ha scritto|escribió)`;

/** Where quoted messages start, in text with line breaks. */
const LINE_PATTERNS = [
	new RegExp(String.raw`(?<![^\n])[ \t]*${SEPARATOR}`, 'i'),
	new RegExp(String.raw`(?<![^\n])[ \t]*${UNDERLINE}`),
	/(?<![^\n])[ \t]*\*?(?:Von|From)\*?:\*?[ \t][^\n]{0,300}\n(?:[^\n]{0,300}\n){0,2}?[ \t]*\*?(?:Gesendet|Sent|Datum|Date)\*?:/,
	new RegExp(
		String.raw`(?<![^\n])[ \t]*(?:Am|On|Le|Il|El)\s[^\n]{0,250}(?:\n[^\n]{0,250}){0,2}?\s${WROTE}[^\n:]{0,150}:[ \t]*(?=\n|$)`,
		'g'
	)
];

/** The same in text whose whitespace was collapsed, such as Exchange's previews. */
const COLLAPSED_PATTERNS = [
	new RegExp(String.raw`(?<!\S)${SEPARATOR}`, 'i'),
	new RegExp(String.raw`(?<!\S)${UNDERLINE}`),
	/(?<!\S)\*?(?:Von|From)\*?:\*?\s\S[\s\S]{0,300}?(?<!\S)\*?(?:Gesendet|Sent|Datum|Date)\*?:/,
	new RegExp(
		String.raw`(?<!\S)(?:Am|On|Le|Il|El)\s[\s\S]{0,250}?\s${WROTE}(?:\s[^:]{0,150})?:(?=\s|$)`,
		'g'
	)
];

function firstMatch(text: string, pattern: RegExp): number {
	if (!pattern.global) return text.search(pattern);
	// An attribution line names when the quoted message was written, so it contains a digit.
	for (const match of text.matchAll(pattern)) if (/\d/.test(match[0])) return match.index;
	return -1;
}

/** The start of a closing block of `>` lines; interleaved answers keep their quotes. */
function trailingQuoteBlock(text: string): number {
	const lines = text.split('\n');
	let start = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		if (!line.startsWith('>')) break;
		start = i;
	}
	return start < 0 ? -1 : lines.slice(0, start).join('\n').length + (start ? 1 : 0);
}

/**
 * The index where the first quoted message starts, or -1: Outlook header blocks ("Von:" /
 * "Gesendet:", "From:" / "Sent:"), "Original Message" separators, "Am … schrieb …:" /
 * "On … wrote:" attributions, and a closing block of `>` lines.
 */
export function quoteIndex(text: string, options: { collapsed?: boolean } = {}): number {
	const patterns = options.collapsed ? COLLAPSED_PATTERNS : LINE_PATTERNS;
	const found = patterns.map((pattern) => firstMatch(text, pattern));
	if (!options.collapsed) found.push(trailingQuoteBlock(text));
	const hits = found.filter((index) => index >= 0);
	return hits.length ? Math.min(...hits) : -1;
}

/** Text above a quote, without separator lines left at its end. */
function above(text: string, index: number): string {
	return text
		.slice(0, index)
		.replace(/(?:\n[ \t]*(?:-{3,}|_{3,}|={3,})[ \t]*)+\s*$/, '')
		.trim();
}

const FORWARD = /^\s*(?:fwd?|wg|tr|rv)\s*(?:\[\d+\])?\s*:/i;

/** Forwarded messages are the content of a forward, never a quote to leave out. */
export function isForwardSubject(subject: string): boolean {
	return FORWARD.test(subject);
}

/** Text parts that are really HTML, as some senders put it in `text/plain`. */
function looksLikeHtml(text: string): boolean {
	return (
		/^\s*<(?:!doctype|html|head|body|div|p|table)\b/i.test(text) ||
		(text.match(/<br\s*\/?>/gi)?.length ?? 0) > 2
	);
}

/**
 * The plain text of a message body and its new text without quoted messages. HTML is preferred:
 * its quote containers (Outlook, Gmail, Thunderbird, Apple Mail, this app) mark quotes before any
 * text patterns apply. Plain-text bodies are only normalized, never decoded further.
 */
export function bodyText(input: {
	html: string | null;
	text: string;
	subject: string;
	/** File names of embedded images by Content-ID. */
	images?: Map<string, string>;
}): BodyText {
	const html = input.html ?? (looksLikeHtml(input.text) ? input.text : null);
	const raw = html ? htmlText(html, input.images ?? new Map()) : input.text;
	const text = normalizeText(raw.replaceAll(QUOTE_MARK, ''));
	if (isForwardSubject(input.subject)) return { text, newText: null };
	const mark = raw.indexOf(QUOTE_MARK);
	const head = normalizeText(mark >= 0 ? raw.slice(0, mark) : raw);
	const index = quoteIndex(head);
	const newText = index >= 0 ? above(head, index) : head;
	return { text, newText: newText.length < text.length ? newText : null };
}

export const PREVIEW_CHARS = 200;

/** One line of at most `PREVIEW_CHARS` characters, without image and link targets. */
export function previewLine(text: string): string {
	const line = text
		.replace(/\[image: [^\]]*\]/g, ' ')
		.replace(/\s?\[(?:https?|mailto):[^\]\s]*\]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
}

/** The preview of a body: its new text on one line. */
export function previewOf(body: BodyText): string {
	return previewLine(body.newText ?? body.text);
}

/** Exchange cuts its preview at this many characters, often inside a quote header. */
const COLLAPSED_LIMIT = 255;
/** How close to the cut a quote header may start and still be recognized without its end. */
const CUT_HEADER_CHARS = 120;

/** Starts of quote headers that the server's cut may have left incomplete. */
const CUT_PATTERNS = [
	/(?<!\S)\*?(?:Von|From|De|Da)\*?:\s/,
	/(?<!\S)(?:Am|On)\s(?=[^\n]*\d)/,
	/(?<!\S)(?:_{8,}|-{5,})/
];

/** Where a quote header starts that the cut at `COLLAPSED_LIMIT` left without its end, or -1. */
function cutQuoteIndex(text: string): number {
	if (text.length < COLLAPSED_LIMIT - 15) return -1;
	const tail = Math.max(1, text.length - CUT_HEADER_CHARS);
	const hits = CUT_PATTERNS.map((pattern) => {
		const index = text.slice(tail).search(pattern);
		return index < 0 ? -1 : tail + index;
	}).filter((index) => index >= 0);
	return hits.length ? Math.min(...hits) : -1;
}

/**
 * The preview from Exchange's `Preview`: the start of the body as one line of plain text,
 * cut after 255 characters. Quote headers are recognized whole, or near the cut by their start.
 */
export function previewOfCollapsed(text: string, subject: string): string {
	const clean = normalizeText(text);
	if (isForwardSubject(subject)) return previewLine(clean);
	let index = quoteIndex(clean, { collapsed: true });
	if (index < 0) index = cutQuoteIndex(clean);
	return previewLine(index >= 0 ? above(clean, index) : clean);
}
