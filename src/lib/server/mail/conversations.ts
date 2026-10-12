import type { MessageSummary } from '../../mail-types';

/** Listed messages grouped by conversation, for MCP `group_by: "thread"`. */
export interface Conversation {
	/** The conversation's messages in the listed folder, newest first. */
	listed: MessageSummary[];
	/** Every known message of the conversation, in any folder, oldest first. */
	messages: MessageSummary[];
}

/**
 * Groups a listed page by conversation. Messages belong together when they share the provider's
 * conversation ID (Exchange, Gmail) or, without one, are linked by Message-ID, In-Reply-To, and
 * References. `related` (from `conversationMembers`) only joins conversations that have a listed
 * message. Conversations
 * keep the order of their newest listed message.
 */
export function groupConversations(
	listed: MessageSummary[],
	related: MessageSummary[] = []
): Conversation[] {
	const parent = new Map<string, string>();
	const find = (key: string): string => {
		let root = key;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
		parent.set(key, root);
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(rb, ra);
	};

	const all = [...listed, ...related];
	for (const message of all) {
		const node = `ref:${message.ref}`;
		find(node);
		const scope = message.accountId;
		if (message.messageId) union(node, `id:${scope}:${message.messageId}`);
		// The provider's conversation is authoritative, as in `getThread`: Gmail keeps replies
		// with a new subject apart even when their headers link them.
		if (message.thread?.id) {
			union(node, `thread:${scope}:${message.thread.id}`);
			continue;
		}
		const ids = [message.thread?.inReplyTo, ...(message.thread?.references ?? [])];
		for (const id of ids) if (id) union(node, `id:${scope}:${id}`);
	}

	const groups = new Map<string, Conversation>();
	for (const message of listed) {
		const root = find(`ref:${message.ref}`);
		const group = groups.get(root) ?? { listed: [], messages: [] };
		group.listed.push(message);
		groups.set(root, group);
	}
	const time = (m: MessageSummary) => Date.parse(m.date) || 0;
	for (const [root, group] of groups) {
		// A message in both places (sent to oneself) counts once, as the listed copy.
		const seen = new Set<string>();
		for (const message of all) {
			if (find(`ref:${message.ref}`) !== root) continue;
			const key = message.messageId ?? message.ref;
			if (seen.has(key)) continue;
			seen.add(key);
			group.messages.push(message);
		}
		group.listed.sort((a, b) => time(b) - time(a));
		group.messages.sort((a, b) => time(a) - time(b));
	}
	return [...groups.values()].sort((a, b) => time(b.listed[0]) - time(a.listed[0]));
}
