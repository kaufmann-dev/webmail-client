import { XMLParser } from 'fast-xml-parser';

/**
 * A parsed XML element: attributes and child elements by local name (namespace prefixes removed),
 * text content under `#text`. Elements with only text parse as plain strings.
 */
export type XmlNode = { [name: string]: unknown };

const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: false,
	attributeNamePrefix: '',
	parseTagValue: false,
	parseAttributeValue: false,
	ignoreDeclaration: true
});

export function parseXml(xml: string): XmlNode {
	return parser.parse(xml) as XmlNode;
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;'
};

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function asNode(value: unknown): XmlNode {
	return typeof value === 'object' && value !== null ? (value as XmlNode) : { '#text': value };
}

/** A repeatable child element as a list, whether it occurred never, once, or more often. */
export function list(value: unknown): XmlNode[] {
	if (value === undefined || value === null) return [];
	return (Array.isArray(value) ? value : [value]).map(asNode);
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
	const value = node?.[name];
	if (value === undefined || value === null) return undefined;
	return asNode(Array.isArray(value) ? value[0] : value);
}

/** An element's text, or '' when it is missing. */
export function text(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return text(value[0]);
	if (typeof value === 'object' && value !== null) return text((value as XmlNode)['#text']);
	return '';
}

export function attr(node: XmlNode | undefined, name: string): string {
	const value = node?.[name];
	return typeof value === 'string' ? value : '';
}
