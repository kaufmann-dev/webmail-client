/** A load value that may still be streaming: `current` is null until it arrives. */
class Streamed<T> {
	current = $state.raw<T | null>(null);
	failed = $state(false);
	/** The value arrived or failed. */
	done = $state(false);
}

const wrappers = new WeakMap<object, Streamed<unknown>>();

/**
 * One wrapper per load value, so it stays the same while the value does (a navigation that keeps
 * the layout data keeps its wrappers).
 */
export function streamed<T>(value: T | Promise<T>): Streamed<T> {
	const key = typeof value === 'object' && value !== null ? value : null;
	const cached = key && wrappers.get(key);
	if (cached) return cached as Streamed<T>;
	const result = new Streamed<T>();
	if (value instanceof Promise) {
		value.then(
			(resolved) => {
				result.current = resolved;
				result.done = true;
			},
			() => {
				result.failed = true;
				result.done = true;
			}
		);
	} else {
		result.current = value;
		result.done = true;
	}
	if (key) wrappers.set(key, result);
	return result;
}
