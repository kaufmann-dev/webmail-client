const DROPPED =
	'script,style,meta,link,title,xml,iframe,object,embed,form,input,button,select,textarea';
const KEPT_ATTRIBUTES = new Set([
	'style',
	'href',
	'src',
	'alt',
	'width',
	'height',
	'align',
	'valign',
	'colspan',
	'rowspan',
	'border',
	'cellpadding',
	'cellspacing',
	'bgcolor',
	'color',
	'face',
	'size'
]);

/**
 * Tidies HTML pasted into the editor (Word and web pages bring comments, classes, Office tags, and
 * `mso-` styles). This is cosmetic: the server sanitizes every message before it is saved or sent.
 */
export function cleanPastedHtml(html: string): string {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	for (const element of doc.body.querySelectorAll(DROPPED)) element.remove();
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
	const comments: Node[] = [];
	while (walker.nextNode()) comments.push(walker.currentNode);
	for (const comment of comments) comment.parentNode?.removeChild(comment);

	for (const element of [...doc.body.querySelectorAll('*')]) {
		// Office namespaced tags (`o:p`, `v:shape`) carry nothing worth keeping.
		if (element.tagName.includes(':')) {
			element.replaceWith(...element.childNodes);
			continue;
		}
		for (const { name } of [...element.attributes]) {
			if (!KEPT_ATTRIBUTES.has(name.toLowerCase())) element.removeAttribute(name);
		}
		const style = element.getAttribute('style');
		if (style !== null) {
			const kept = style
				.split(';')
				.map((rule) => rule.trim())
				.filter((rule) => rule && !/^mso-/i.test(rule))
				.join('; ');
			if (kept) element.setAttribute('style', kept);
			else element.removeAttribute('style');
		}
		const href = element.getAttribute('href');
		if (href !== null && !/^(?:https?:|mailto:|tel:)/i.test(href.trim())) {
			element.removeAttribute('href');
		}
		if (
			element.tagName === 'IMG' &&
			!/^(?:https?:|data:image\/)/i.test(element.getAttribute('src') ?? '')
		) {
			element.remove();
		}
	}
	return doc.body.innerHTML;
}
