/** A load value that may still be streaming: `current` is null until it arrives. */
class Streamed<T> {
	current = $state.raw<T | null>(null);
	failed = $state(false);
}

export function streamed<T>(value: T | Promise<T>): Streamed<T> {
	const result = new Streamed<T>();
	if (value instanceof Promise) {
		value.then(
			(resolved) => (result.current = resolved),
			() => (result.failed = true)
		);
	} else {
		result.current = value;
	}
	return result;
}
