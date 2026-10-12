/** HTML conventions shared by the message editor (browser) and outgoing mail (server). */

/**
 * Fonts an account can send its mail in. Fonts are not embedded: each names a font most
 * recipients have installed, with look-alike fallbacks. Without one, mail names no font and the
 * recipient's mail program uses its own.
 */
export const MAIL_FONTS = {
	calibri: { label: 'Calibri', stack: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif" },
	arial: { label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
	'segoe-ui': { label: 'Segoe UI', stack: "'Segoe UI', Tahoma, Arial, sans-serif" },
	verdana: { label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
	tahoma: { label: 'Tahoma', stack: 'Tahoma, Verdana, sans-serif' },
	georgia: { label: 'Georgia', stack: 'Georgia, serif' },
	'times-new-roman': { label: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
	'courier-new': { label: 'Courier New', stack: "'Courier New', Courier, monospace" }
} as const;
export type MailFont = keyof typeof MAIL_FONTS;

export function isMailFont(value: string): value is MailFont {
	return Object.hasOwn(MAIL_FONTS, value);
}

/** The body style of mail in a font (the usual 11pt, as Outlook sends), or none without one. */
export function mailFontStyle(font: MailFont | null): string {
	return font ? `font-family: ${MAIL_FONTS[font].stack}; font-size: 11pt` : '';
}

/** An empty line, the place to start writing. */
export const EMPTY_LINE = '<div><br></div>';

/** The left rule of a quoted original. */
export const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

/** Images, backgrounds, or attributes that load something from the web. */
export const REMOTE_RESOURCE =
	/(?:\bsrc\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|\bbackground\s*=\s*["']?\s*https?:)/i;
