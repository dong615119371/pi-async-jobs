/**
 * Session IPC bridge (PI 侧原生命名管道接收桥).
 *
 * Implements pure process-to-process IPC via Node.js native named pipes
 * (\\.\pipe\pi-session-<id> on Windows, /tmp/pi-session-<id>.sock on POSIX).
 *
 * Zero shared disk mailbox, zero fs.watch, zero cursor tracking.
 * - Sockets carry messages directly into memory;
 * - ask_session holds the socket open; on agent_end the response is written
 *   directly back through the socket (Connection IS Context).
 * - Live presence is tracked via lightweight zero-content probe files in
 *   ~/.pi/agent/sessions-live/<safeId>.json with PID liveness check.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function getSessionPipePath(sessionId: string): string {
	const safeId = sessionId.replace(/[^\w.-]+/g, "_");
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-session-${safeId}`
		: path.join(os.tmpdir(), `pi-session-${safeId}.sock`);
}

export function getLiveDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions-live");
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | null;
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const texts: string[] = [];
			for (const block of content as Array<{ type?: string; text?: string }>) {
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		const name = ctx.sessionManager.getSessionName() || id;
		const cwd = ctx.sessionManager.getCwd();
		const safeId = id.replace(/[^\w.-]+/g, "_");
		const pipePath = getSessionPipePath(id);

		const liveDir = getLiveDir();
		const liveCard = path.join(liveDir, `${safeId}.json`);

		// Clean up any stale POSIX socket file before listening
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(pipePath);
			} catch {}
		}

		// Keep open sockets for callers waiting on ask_session results
		const pendingAskSockets: net.Socket[] = [];

		const server = net.createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");

			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const envelope = JSON.parse(trimmed) as {
							type: "msg" | "ask" | "read";
							from?: string;
							message?: string;
							count?: number;
						};

						if (envelope.type === "read") {
							// In-memory read request: return last few assistant texts or entries
							const entries = ctx.sessionManager.getEntries();
							const msgs: string[] = [];
							for (let i = entries.length - 1; i >= 0 && msgs.length < (envelope.count || 5); i--) {
								const e = entries[i] as any;
								if (e?.type === "message" && e?.message?.content) {
									const role = e.message.role || "unknown";
									const text =
										typeof e.message.content === "string"
											? e.message.content
											: Array.isArray(e.message.content)
												? e.message.content.map((b: any) => b.text || "").join("")
												: "";
									if (text.trim()) msgs.unshift(`[${role}]\n${text.trim()}`);
								}
							}
							socket.write(JSON.stringify({ ok: true, messages: msgs }) + "\n");
							socket.end();
							continue;
						}

						const isAsk = envelope.type === "ask";
						const sender = envelope.from || "peer-agent";
						const body = envelope.message || "";

						pi.sendMessage(
							{
								customType: "session-relay",
								content:
									(isAsk
										? `[会话提问 · 来自 ${sender}，对方在等你的答复]\n`
										: `[会话消息 · 来自 ${sender}]\n`) + body,
								display: true,
								details: { from: sender, type: envelope.type },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);

						if (isAsk) {
							// Connection IS Context: hold socket open until agent_end
							pendingAskSockets.push(socket);
						} else {
							socket.write(JSON.stringify({ ok: true }) + "\n");
							socket.end();
						}
					} catch (err) {
						socket.write(JSON.stringify({ ok: false, error: String(err) }) + "\n");
						socket.end();
					}
				}
			});

			socket.on("error", () => {
				const idx = pendingAskSockets.indexOf(socket);
				if (idx >= 0) pendingAskSockets.splice(idx, 1);
			});

			socket.on("close", () => {
				const idx = pendingAskSockets.indexOf(socket);
				if (idx >= 0) pendingAskSockets.splice(idx, 1);
			});
		});

		try {
			server.listen(pipePath, () => {
				// Publish live presence card
				try {
					fs.mkdirSync(liveDir, { recursive: true });
					fs.writeFileSync(liveCard, JSON.stringify({ id, name, cwd, pid: process.pid, pipe: pipePath }));
				} catch {}
			});
		} catch {
			// Failed to bind pipe; stay quiet
			return;
		}

		pi.on("agent_end", (event) => {
			if (pendingAskSockets.length === 0) return;
			const answer = lastAssistantText(event.messages);
			// Deliver conclusion directly through the awaiting long-lived sockets
			while (pendingAskSockets.length > 0) {
				const sock = pendingAskSockets.shift();
				if (sock && !sock.destroyed) {
					try {
						sock.write(JSON.stringify({ ok: true, text: answer || "(the target answered with no text)" }) + "\n");
						sock.end();
					} catch {}
				}
			}
		});

		pi.on("session_shutdown", () => {
			try {
				server.close();
			} catch {}
			if (process.platform !== "win32") {
				try {
					fs.unlinkSync(pipePath);
				} catch {}
			}
			try {
				fs.unlinkSync(liveCard);
			} catch {}
			while (pendingAskSockets.length > 0) {
				const sock = pendingAskSockets.shift();
				try {
					sock?.destroy();
				} catch {}
			}
		});
	});
}
