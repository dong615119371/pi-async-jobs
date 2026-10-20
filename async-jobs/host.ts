/**
 * The host side of the extension ecosystem.
 *
 * async-jobs owns the engine, and the engine is a closure variable inside the
 * extension factory - nothing outside can reach it. That is deliberate: exposing
 * the instance would hand every caller `shutdownAll` and the whole internal surface.
 *
 * But a second extension cannot contribute jobs without it. Module imports do not
 * help: Pi loads each extension with its own jiti instance and `moduleCache: false`,
 * so two extensions importing the same file get two different module instances and
 * two different registries. A renderer registered through an import lands in a Map
 * the engine never reads, and the failure is silent - the job still delivers, just
 * rendered by the fallback.
 *
 * So the service travels over `pi.events`, which Pi creates once per runtime and
 * hands to every extension. Same instance, same process, no serialisation, so a
 * function reference survives the trip.
 *
 * The surface is deliberately narrow - `startProcess`, `registerChannel`, the API
 * version, and two read-only counters. A caller that needs something else should ask
 * for it by name rather than receive the engine.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChannel } from "./channels.ts";
import type { JobEngine } from "./engine.ts";
import type { ChannelRenderer, JobHandle, StartProcessOptions } from "./types.ts";

/** Channel a host asks on to announce it is up. Emitted at session start. */
export const HOST_READY_CHANNEL = "async-jobs:host-ready";

/** Channel a consumer emits to receive the service. Carries a reply channel name. */
export const SERVICE_REQUEST_CHANNEL = "async-jobs:request-service";

/** Bumped when the shape below changes in a way a consumer could notice. */
export const HOST_API_VERSION = 1;

/** What a consumer gets. Intentionally not the engine. */
export interface HostService {
	apiVersion: number;
	/** Start a background job and get its handle. Same contract as the engine's. */
	startProcess(options: StartProcessOptions): JobHandle;
	/** Register a renderer for this consumer's channel. Returns an unregister function. */
	registerChannel(renderer: ChannelRenderer): () => void;
	/** Ids currently occupying a concurrency slot. Read-only. */
	activeCount(): number;
	/** Ids waiting for a slot. Read-only. */
	queuedCount(): number;
}

/**
 * Publish the service and keep answering requests for as long as this runtime lives.
 *
 * The reply carries the service object itself, not a description of it: the consumer
 * calls these functions directly. Nothing is serialised.
 */
export function publishHostService(pi: ExtensionAPI, engine: JobEngine): void {
	const service: HostService = {
		apiVersion: HOST_API_VERSION,
		startProcess: (options) => engine.startProcess(options),
		registerChannel,
		activeCount: () => engine.activeCount(),
		queuedCount: () => engine.queuedCount(),
	};

	pi.events.on(SERVICE_REQUEST_CHANNEL, (data: unknown) => {
		const request = data as { replyChannel?: unknown } | null;
		if (typeof request?.replyChannel !== "string") return;
		pi.events.emit(request.replyChannel, { service });
	});

	// The consumer asks at `session_start`, by which point every extension factory has
	// run. Announcing here - during the factory - would reach nobody: the consumer is
	// not listening yet. `pi.events` keeps no history, so the only reliable moment is
	// after all factories have returned.
	pi.on("session_start", () => {
		pi.events.emit(HOST_READY_CHANNEL, { apiVersion: HOST_API_VERSION });
	});
}
