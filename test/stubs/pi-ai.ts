/**
 * Minimal stand-in for the parts of `@earendil-works/pi-ai` the extension uses
 * at runtime. Real pi provides the full stream plumbing; tests only need a lazy
 * wrapper that iterates the generator returned by `setup`.
 */
type AnyEvent = { type: string } & Record<string, unknown>;

export function lazyStream(_model: unknown, setup: () => Promise<AsyncIterable<AnyEvent>>) {
	let cached: Promise<AsyncIterable<AnyEvent>> | undefined;
	const inner = () => (cached ??= Promise.resolve().then(setup));
	return {
		async *[Symbol.asyncIterator]() {
			const source = await inner();
			for await (const event of source) yield event;
		},
		async result() {
			const source = await inner();
			let last: AnyEvent | undefined;
			for await (const event of source) last = event;
			if (last?.type === "error") return last.error;
			if (last?.type === "done") return last.message;
			return undefined;
		},
	};
}
