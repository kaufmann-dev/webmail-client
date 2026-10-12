/** HTML conventions shared by the message editor (browser) and outgoing mail (server). */

/** The font of outgoing mail, also used by the editor so messages look the same while writing. */
export const MAIL_FONT =
	'font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.4';

/** An empty line, the place to start writing. */
export const EMPTY_LINE = '<div><br></div>';

/** The left rule of a quoted original. */
export const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

/** Images, backgrounds, or attributes that load something from the web. */
export const REMOTE_RESOURCE =
	/(?:\bsrc\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|\bbackground\s*=\s*["']?\s*https?:)/i;
