/**
 * pi-switch — extension entry point.
 *
 * The behavior lives in `./keypool`; this file only wires it to Pi so the module
 * that Pi loads stays tiny and does not export any internals.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureRegistered } from "./keypool";

export default function piSwitch(pi: ExtensionAPI): void {
	// The runtime is only reachable from a session, so wrap the providers on start.
	// This also re-asserts the wrappers after a session switch rebuilds the runtime.
	// The key-pool UI lives in each provider's api-key login flow: /login <provider>.
	pi.on("session_start", (_event, ctx) => {
		const error = ensureRegistered(pi, ctx);
		if (error) ctx.ui.notify(`pi-switch: ${error}`, "error");
	});
}
