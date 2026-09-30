import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point the store at a throwaway agent dir and return it. */
export function useTempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-switch-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

export function cleanupTempAgentDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
}

export const start = { type: "start", partial: {} };

export function text(delta: string) {
	return { type: "text_delta", contentIndex: 0, delta, partial: {} };
}

export function done() {
	return { type: "done", reason: "stop", message: { role: "assistant", content: [] } };
}

export function failure(errorMessage: string) {
	return { type: "error", reason: "error", error: { role: "assistant", stopReason: "error", errorMessage } };
}

/** An async-iterable provider stream for a fixed list of events. */
export function streamOf(events: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

export interface ScriptedInteraction {
	signal: AbortSignal;
	prompts: Array<{ type: string; message: string; options?: Array<{ id: string }> }>;
	notifications: string[];
	prompt(prompt: { type: string; message: string; options?: Array<{ id: string }> }): Promise<string>;
	notify(event: { type: string; message?: string }): void;
}

/**
 * A fake AuthInteraction that answers each prompt from a queue of strings.
 * Running out of answers throws, which models the user cancelling the dialog.
 */
export function scriptedInteraction(answers: string[]): ScriptedInteraction {
	const queue = [...answers];
	const interaction: ScriptedInteraction = {
		signal: new AbortController().signal,
		prompts: [],
		notifications: [],
		async prompt(prompt) {
			interaction.prompts.push(prompt);
			if (queue.length === 0) throw new Error("Login cancelled");
			return queue.shift() as string;
		},
		notify(event) {
			if (event.message) interaction.notifications.push(event.message);
		},
	};
	return interaction;
}
