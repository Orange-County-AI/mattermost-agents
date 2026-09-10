/**
 * Stand-in for `src/agent/cli.ts` while the adapters are developed against the
 * agreed contract: same argv shape, same stdout JSONL, same stderr tokens, same
 * exit codes. Test-only; never installed anywhere.
 *
 * Behaviour is driven by env so one binary can play every scenario:
 *   FAKE_CORE_MODE=stream (default) — ready, then FAKE_CORE_EVENTS events, then
 *                                     idle until SIGTERM (exit 0).
 *   FAKE_CORE_MODE=lock            — lock-held token, exit 3.
 *   FAKE_CORE_MODE=crash-once      — first run: one event then exit 1;
 *                                    later runs: stream.
 *   FAKE_CORE_SPAWN_LOG=<path>     — one "<command> <pid> <config>" line per
 *                                    invocation.
 *   FAKE_CORE_SIGTERM_LOG=<path>   — one line appended when SIGTERM lands.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--config");
const config = configIndex === -1 ? undefined : argv[configIndex + 1];
const command = argv.find((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--config");

if (!config || !existsSync(config)) {
	process.stderr.write(`mattermost-agent: config-error: ${config ?? "(none)"} unreadable\n`);
	process.exit(2);
}

const spawnLog = process.env.FAKE_CORE_SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${command ?? "?"} ${process.pid} ${config}\n`);

if (command === "ack") {
	const ackLog = process.env.FAKE_CORE_ACK_LOG;
	if (ackLog) appendFileSync(ackLog, `${argv.join(" ")}\n`);
	process.exit(0);
}

if (command !== "watch") {
	process.stderr.write(`mattermost-agent: config-error: unsupported command ${command}\n`);
	process.exit(2);
}

const mode = process.env.FAKE_CORE_MODE ?? "stream";

if (mode === "lock") {
	process.stderr.write(
		`mattermost-agent: lock-held: pid=4242 host=test scope=${config}\n`,
	);
	process.exit(3);
}

let crashThisRun = false;
if (mode === "crash-once") {
	const marker = `${config}.crashed`;
	crashThisRun = !existsSync(marker);
	if (crashThisRun) writeFileSync(marker, "1");
}

const total = Number(process.env.FAKE_CORE_EVENTS ?? "2");
const connection = process.env.FAKE_CORE_CONNECTION ?? "testconn";
/** Core resolves the sender's name and role; the adapter only renders them. */
const senderUsername = process.env.FAKE_CORE_SENDER_USERNAME ?? "user1name";
const senderRole = process.env.FAKE_CORE_SENDER_ROLE ?? "unknown";

function emit(index: number): void {
	const now = Date.now();
	process.stdout.write(
		`${JSON.stringify({
			type: "message",
			connection,
			event_id: `${connection}:post${index}:${now}`,
			post_id: `post${index}`,
			channel_id: "channel1",
			root_id: index % 2 === 0 ? null : "post0",
			sender_id: "user1",
			sender_username: senderUsername,
			sender_role: senderRole,
			text: `hello ${index}`,
			created_at: now,
			updated_at: now,
			replayed: false,
		})}\n`,
	);
}

process.stderr.write(`mattermost-agent: connection-ready connection=${connection} channels=1\n`);
process.stderr.write("mattermost-agent: ready connections=1\n");

if (crashThisRun) {
	emit(0);
	setTimeout(() => process.exit(1), 30);
} else {
	for (let index = 0; index < total; index += 1) {
		setTimeout(() => emit(index), 20 * (index + 1));
	}
	// Stay alive like a real watcher; the adapter owns the lifetime.
	setInterval(() => process.stderr.write("mattermost-agent: warn: idle heartbeat\n"), 5_000);
}

process.on("SIGTERM", () => {
	const log = process.env.FAKE_CORE_SIGTERM_LOG;
	if (log) appendFileSync(log, `${process.pid}\n`);
	process.exit(0);
});
