import type { MessageStructureObject } from 'imapflow';

/** An attachment as the BODYSTRUCTURE describes it, addressed by its IMAP part number. */
export interface StructurePart {
	partId: string;
	filename: string | null;
	contentType: string;
	/** Decoded size, estimated from the transferred size. */
	size: number;
}

export interface MessagePlan {
	/** Fetch the whole message instead of single parts (single-part or malformed messages). */
	whole: boolean;
	/** Parts needed to show the message: body text, calendar parts, and embedded images. */
	fetch: string[];
	/** Parts offered as attachments, fetched only when opened. */
	attachments: StructurePart[];
}

const BODY_TYPES = new Set(['text/plain', 'text/html']);
const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics']);

function isMultipart(node: MessageStructureObject): boolean {
	return node.type.startsWith('multipart/') && Boolean(node.childNodes?.length);
}

function decodedSize(node: MessageStructureObject): number {
	const size = node.size ?? 0;
	return node.encoding === 'base64' ? Math.floor((size * 3) / 4) : size;
}

/**
 * Decides which parts opening a message needs. Body text, calendar parts, and images embedded by
 * `cid:` are fetched; attachments are only listed. Images inside `multipart/related` belong to the
 * HTML and are not listed, matching mailparser's `related` attachments.
 */
export function planMessage(root: MessageStructureObject | undefined): MessagePlan {
	const plan: MessagePlan = { whole: false, fetch: [], attachments: [] };
	if (!root) return { ...plan, whole: true };

	const leaf = (node: MessageStructureObject, partId: string, related: boolean) => {
		const type = node.type;
		const attachment = node.disposition === 'attachment';
		const part: StructurePart = {
			partId,
			filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
			contentType: type,
			size: decodedSize(node)
		};
		if (!attachment && BODY_TYPES.has(type)) {
			plan.fetch.push(partId);
		} else if (CALENDAR_TYPES.has(type)) {
			plan.fetch.push(partId);
			plan.attachments.push(part);
		} else if (!attachment && node.id && type.startsWith('image/')) {
			plan.fetch.push(partId);
			if (!related) plan.attachments.push(part);
		} else {
			plan.attachments.push(part);
		}
	};

	const walk = (node: MessageStructureObject, related: boolean) => {
		if (!node.parameters?.boundary) plan.whole = true;
		for (const child of node.childNodes ?? []) {
			const inRelated = related || node.type === 'multipart/related';
			if (isMultipart(child)) walk(child, inRelated);
			else leaf(child, child.part ?? '1', inRelated);
		}
	};

	if (isMultipart(root)) walk(root, false);
	else {
		plan.whole = true;
		leaf(root, '1', false);
	}
	return plan;
}

function headerBlock(header: Buffer | string): Buffer {
	const text = Buffer.isBuffer(header) ? header.toString('binary') : header;
	return Buffer.from(`${text.replace(/(\r?\n)+$/, '')}\r\n\r\n`, 'binary');
}

/** ASCII parameters only; mailparser needs `charset`, `format`, and `delsp`, not the file names. */
function parameterList(parameters: Record<string, string> | undefined): string {
	return Object.entries(parameters ?? {})
		.filter(([key, value]) => key !== 'name' && /^[\x20-\x7e]*$/.test(value))
		.map(([key, value]) => `; ${key}="${value.replace(/["\\]/g, '\\$&')}"`)
		.join('');
}

/**
 * A part's MIME header, rebuilt from the BODYSTRUCTURE. Some servers answer `<part>.MIME` fetches
 * with the wrong part's header, so it is not fetched.
 */
function partHeader(node: MessageStructureObject): string {
	const lines = [`Content-Type: ${node.type}${parameterList(node.parameters)}`];
	if (node.encoding) lines.push(`Content-Transfer-Encoding: ${node.encoding}`);
	if (node.id) lines.push(`Content-ID: ${node.id}`);
	if (node.disposition) lines.push(`Content-Disposition: ${node.disposition}`);
	return lines.join('\r\n');
}

/**
 * Rebuilds a multipart message from its header and the fetched part bodies, leaving out the rest,
 * so mailparser decodes it as usual.
 */
export function assembleSource(
	header: Buffer,
	root: MessageStructureObject,
	parts: Map<string, Buffer>
): Buffer {
	const chunks: Buffer[] = [headerBlock(header)];
	const body = (node: MessageStructureObject) => {
		const boundary = node.parameters?.boundary ?? '';
		for (const child of node.childNodes ?? []) {
			const content = isMultipart(child) ? null : parts.get(child.part ?? '');
			if (!isMultipart(child) && !content) continue;
			chunks.push(Buffer.from(`--${boundary}\r\n`), headerBlock(partHeader(child)));
			if (content) chunks.push(content);
			else body(child);
			chunks.push(Buffer.from('\r\n'));
		}
		chunks.push(Buffer.from(`--${boundary}--\r\n`));
	};
	body(root);
	return Buffer.concat(chunks);
}

/** The body part a list preview is read from, and how to decode it. */
export interface PreviewPart {
	partId: string;
	html: boolean;
	encoding: string;
	charset: string;
}

/** The first plain-text body part, else the first HTML one; null for messages without text. */
export function previewPart(root: MessageStructureObject | undefined): PreviewPart | null {
	if (!root) return null;
	const candidates: { node: MessageStructureObject; partId: string }[] = [];
	const walk = (node: MessageStructureObject, partId: string) => {
		if (isMultipart(node)) {
			for (const child of node.childNodes ?? []) walk(child, child.part ?? '1');
		} else if (node.disposition !== 'attachment' && BODY_TYPES.has(node.type)) {
			candidates.push({ node, partId });
		}
	};
	walk(root, '1');
	const found =
		candidates.find((c) => c.node.type === 'text/plain') ??
		candidates.find((c) => c.node.type === 'text/html');
	if (!found) return null;
	return {
		partId: found.partId,
		html: found.node.type === 'text/html',
		encoding: (found.node.encoding ?? '7bit').toLowerCase(),
		charset: found.node.parameters?.charset ?? 'utf-8'
	};
}

function decodeQuotedPrintable(text: string): Buffer {
	const bytes: number[] = [];
	const source = text.replace(/=\r?\n/g, '').replace(/=[0-9A-Fa-f]?$/, '');
	for (let i = 0; i < source.length; i++) {
		const hex = source[i] === '=' ? source.slice(i + 1, i + 3) : '';
		if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(source.charCodeAt(i) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

/**
 * Text from the start of a body part, which may end in the middle of an encoded sequence or a
 * character: incomplete trailing input is dropped.
 */
export function decodePartStart(content: Buffer, part: Pick<PreviewPart, 'encoding' | 'charset'>) {
	let bytes = content;
	if (part.encoding === 'base64') {
		const clean = content.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
		bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
	} else if (part.encoding === 'quoted-printable') {
		bytes = decodeQuotedPrintable(content.toString('latin1'));
	}
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(part.charset);
	} catch {
		decoder = new TextDecoder('utf-8');
	}
	return decoder.decode(bytes).replace(/�+$/, '');
}
