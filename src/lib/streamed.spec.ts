import { describe, expect, it } from 'vitest';
import { streamed } from './streamed.svelte.js';

describe('streamed', () => {
	it('keeps one wrapper per promise and fills it when it resolves', async () => {
		const value = { messages: [] };
		const promise = Promise.resolve(value);
		const wrapper = streamed(promise);
		expect(streamed(promise)).toBe(wrapper);
		await promise;
		expect(wrapper.current).toBe(value);
	});

	it('keeps one wrapper per resolved object', () => {
		const value = { messages: [] };
		const wrapper = streamed(value);
		expect(wrapper.current).toBe(value);
		expect(streamed(value)).toBe(wrapper);
	});

	it('wraps different values separately', () => {
		expect(streamed({ a: 1 })).not.toBe(streamed({ a: 1 }));
		expect(streamed(null).current).toBeNull();
	});
});
