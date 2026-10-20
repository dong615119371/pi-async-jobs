/**
 * Shared, lazily-resolved free-model list.
 *
 * Both the synchronous `opencode` tool and the background-delegation tools need
 * the same allowlist, and listing models spawns a process, so the answer is
 * cached for the life of the runtime. `session_start` clears it so an OpenCode
 * upgrade is picked up without restarting Pi.
 */

import { filterFreeModels, findOpencodeCli, listModels } from "./cli.ts";

let cache: Promise<string[]> | null = null;

export function resetFreeModels(): void {
	cache = null;
}

/** Free-tier model ids, or an empty list when the CLI cannot be asked. */
export function getFreeModels(): Promise<string[]> {
	if (!cache) {
		const cli = findOpencodeCli();
		cache = cli
			? listModels(cli)
					.then((all) => filterFreeModels(all))
					.catch(() => [])
			: Promise.resolve([]);
	}
	return cache;
}
