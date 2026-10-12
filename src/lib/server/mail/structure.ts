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
