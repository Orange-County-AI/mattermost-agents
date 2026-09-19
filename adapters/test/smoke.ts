/**
 * Adapter smoke test: `bun adapters/test/smoke.ts`.
 *
 * What is left in `adapters/` after delivery moved onto the harnesses' own
 * background monitors is small and almost entirely declarative, so this probe
 * is small too. It pins the three things that are still ours to get wrong:
 *
 *   - the DECLARATION: one monitor entry, named, always-on, pointing at a
 *     shim that exists and runs, and pinning the identity variable so a
 *     machine that is not a consumer of this mailbox arms nothing,
 *   - the SHIM: an argument or the environment resolves the profile, core is
 *     reached with `exec` so a signal lands on core rather than on a wrapper,
 *     one JSON event per stdout line, and a setup problem exits 78 loudly
 *     instead of pretending to listen,
 *   - the INSTALLER: it writes the MCP binding it promises, takes exactly that
 *     back on `--rollback`, and still undoes the `settings.json` entry an
 *     older install of this repository added.
 *
 * Everything about batching, waking a session, footers and restart policy now
 * belongs to the harness that runs the monitor, and is tested there — in
 * omp-monitor's own smoke test, and by Claude Code itself.
 *
 * Runs against `fake-core.ts`, which speaks the agreed core contract (JSONL
 * stdout, `mattermost-agent:` stderr tokens, exit codes 2/3/4). Deliberately
 * outside `bun test`'s pattern so it never runs as part of the core suite.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = join(HERE, "fake-core.ts");
const PLUGIN = join(HERE, "..", "plugin");
const MONITOR = join(PLUGIN, "bin", "mattermost-monitor");
const DECLARATION = join(PLUGIN, "monitors", "monitors.json");
const INSTALLER = join(HERE, "..", "install-project.ts");
const MCP_WRAPPER = join(HERE, "..", "bin", "mattermost-mcp");
/** The canonical skill, and the copy the plugin ships to both harnesses. */
const ROOT_SKILL = join(HERE, "..", "..", "SKILL.md");
const PLUGIN_SKILL = join(PLUGIN, "skills", "mattermost", "SKILL.md");

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

async function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function workspace(name: string): { dir: string; config: string } {
	const dir = mkdtempSync(join(tmpdir(), `mm-adapter-${name}-`));
	return { dir, config: agentConfig(dir, "config.json") };
}

/** A core agent config on disk, so resolution's existence check passes. */
function agentConfig(dir: string, file: string): string {
	const config = join(dir, file);
	writeFileSync(
		config,
		JSON.stringify({
			version: 1,
			stateDir: join(dir, "state"),
			connections: [
				{
					id: "testconn",
					url: "https://example.invalid",
					tokenEnv: "TEST_MM_TOKEN",
					channelIds: ["channel1"],
					allowedBotIds: [],
					pollIntervalMs: 5000,
				},
			],
		}),
	);
	return config;
}

/** One MCP server entry pinning a config, the way the install snippet does. */
function mcpServer(config: string): Record<string, unknown> {
	return {
		command: "/abs/path/mattermost-agents/adapters/bin/mattermost-mcp",
		env: { MATTERMOST_AGENT_CONFIG: config },
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface Declaration {
	name?: unknown;
	command?: unknown;
	description?: unknown;
	when?: unknown;
	label?: unknown;
}

/**
 * The declaration is the whole OMP adapter now, and Claude Code's too. Nothing
 * executes it here — a harness does — so what matters is that it names an
 * entry that exists, states the identity it needs, and still carries the two
 * rules an agent cannot work out for itself.
 */
async function monitorDeclaration(): Promise<void> {
	console.log("the monitor declaration both harnesses read");
	const entries = JSON.parse(readFileSync(DECLARATION, "utf8")) as Declaration[];
	check("exactly one monitor is declared", entries.length === 1, JSON.stringify(entries.map(entry => entry.name)));
	const entry = entries[0] ?? {};
	check("it is named for the events it carries", entry.name === "mattermost-events", String(entry.name));
	check("it is armed at session start", entry.when === "always", String(entry.when));

	const command = typeof entry.command === "string" ? entry.command : "";
	check(
		"it runs the plugin's own shim, resolved from the plugin root",
		command.includes("${CLAUDE_PLUGIN_ROOT}") && command.includes("/bin/mattermost-monitor"),
		command,
	);
	check(
		"it pins the identity variable, so a machine without one arms nothing",
		command.includes("${MATTERMOST_AGENT_CONFIG}"),
		command,
	);
	check("the shim it names exists and is executable", existsSync(MONITOR) && (lstatSync(MONITOR).mode & 0o111) !== 0, MONITOR);

	const description = typeof entry.description === "string" ? entry.description : "";
	// Both harnesses show this string and neither restarts a killed monitor, so
	// it is the first place an agent can learn what to do about either.
	check("the description carries the re-arm rule", /re-arm/i.test(description), description);
	check("and the exit-3 rule", description.includes("lock-held"), description);

	const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
	check("the plugin manifest names the plugin", manifest.name === "mattermost-agents", String(manifest.name));
	const pkg = JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8")) as { omp?: { monitors?: unknown } };
	check(
		"and the package points omp at the same declarations",
		pkg.omp?.monitors === "./monitors/monitors.json",
		JSON.stringify(pkg.omp),
	);
}

/**
 * The plugin ships a COPY of the repository's canonical `SKILL.md`, generated
 * rather than authored: `claude plugin validate --strict` refuses to read a
 * symlinked component, and a manifest cannot declare a skill outside its own
 * tree. This is what keeps the copy honest.
 */
async function pluginSkillMatchesRoot(): Promise<void> {
	console.log("the shipped skill is a faithful copy of the canonical SKILL.md");
	check(
		"the plugin's copy is a regular file, so validate --strict can read it",
		existsSync(PLUGIN_SKILL) && !lstatSync(PLUGIN_SKILL).isSymbolicLink(),
		PLUGIN_SKILL,
	);
	const root = readFileSync(ROOT_SKILL);
	const shipped = readFileSync(PLUGIN_SKILL);
	check(
		"the plugin ships the canonical skill byte for byte",
		root.equals(shipped),
		`root=${root.length}B plugin=${shipped.length}B — regenerate with bun run skill:sync`,
	);
}

async function monitorShim(): Promise<void> {
	console.log("the monitor shim: one JSON event per line, and a loud setup failure");
	const { dir, config } = workspace("monitor");
	const sigtermLog = join(dir, "sigterm.log");

	const child = spawn(MONITOR, {
		env: { ...process.env, MATTERMOST_AGENT_CLI: FAKE_CORE, MATTERMOST_AGENT_CONFIG: config, FAKE_CORE_SIGTERM_LOG: sigtermLog },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		for (const line of chunk.split("\n")) if (line.trim()) lines.push(line);
	});
	await waitFor("two stdout lines", () => lines.length >= 2);
	check(
		"one parseable message event per stdout line",
		lines.slice(0, 2).every(line => {
			const parsed: unknown = JSON.parse(line);
			return !!parsed && typeof parsed === "object" && "event_id" in parsed;
		}),
	);
	const pid = child.pid ?? 0;
	child.kill("SIGTERM");
	await waitFor("shim exits", () => child.exitCode !== null || child.signalCode !== null);
	check("SIGTERM reached core through the shim (exec, no extra process)", existsSync(sigtermLog));
	check("no orphan", !alive(pid));

	// The declaration passes the profile as an argument, which is what lets the
	// manifest state which variable this listener is about. The argument wins,
	// and an empty one — Claude Code's expansion of an unset variable — falls
	// back to the environment rather than failing.
	const chosen = agentConfig(dir, "chosen.json");
	const argued = spawnSync(MONITOR, [chosen], {
		env: { ...process.env, MATTERMOST_AGENT_CLI: FAKE_CORE, MATTERMOST_AGENT_CONFIG: config, FAKE_CORE_EVENTS: "0", FAKE_CORE_EXIT: "0" },
		encoding: "utf8",
		timeout: 10_000,
	});
	check("an argued profile is the one core is given", argued.stderr.includes(chosen), argued.stderr.trim());
	const empty = spawnSync(MONITOR, [""], {
		env: { ...process.env, MATTERMOST_AGENT_CLI: FAKE_CORE, MATTERMOST_AGENT_CONFIG: config, FAKE_CORE_EVENTS: "0", FAKE_CORE_EXIT: "0" },
		encoding: "utf8",
		timeout: 10_000,
	});
	check("an empty argument falls back to the environment", empty.stderr.includes(config), empty.stderr.trim());

	const { PATH } = process.env;
	const unconfigured = spawnSync(MONITOR, [""], {
		env: { PATH, HOME: dir, XDG_CONFIG_HOME: dir, MATTERMOST_AGENT_CLI: FAKE_CORE },
		encoding: "utf8",
		timeout: 10_000,
	});
	check("with neither, it fails instead of faking health", unconfigured.status === 78, String(unconfigured.status));
	check("it names the variable to set", unconfigured.stderr.includes("MATTERMOST_AGENT_CONFIG"), unconfigured.stderr.trim());
	check("and it emits no events", unconfigured.stdout === "", unconfigured.stdout);
}

interface Ran {
	code: number;
	stdout: string;
	stderr: string;
}

function runInstaller(...args: string[]): Ran {
	const result = spawnSync("bun", [INSTALLER, ...args], { encoding: "utf8" });
	return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

async function installer(): Promise<void> {
	console.log("install-project.ts: writes the MCP binding it promises, and takes exactly it back");
	const { dir, config } = workspace("installer");
	const project = join(dir, "worktree");
	mkdirSync(project);

	const installed = runInstaller("--project", project, "--profile", config, "--server-name", "mattermost-fleet-security");
	check("install succeeds", installed.code === 0, installed.stderr);

	const mcp = JSON.parse(readFileSync(join(project, ".omp", "mcp.json"), "utf8")) as {
		mcpServers: Record<string, { command?: string; env?: Record<string, string> }>;
	};
	check(
		"the server runs the shared wrapper against the pinned profile",
		mcp.mcpServers["mattermost-fleet-security"]?.command === MCP_WRAPPER &&
			mcp.mcpServers["mattermost-fleet-security"]?.env?.MATTERMOST_AGENT_CONFIG === config,
		JSON.stringify(mcp),
	);
	// Delivery is no longer a project-level extension, so a fresh install has no
	// business writing the file that used to load one.
	check("no settings.json is written any more", !existsSync(join(project, ".omp", "settings.json")));
	check("the identity pins are ignored by git", readFileSync(join(project, ".omp", ".gitignore"), "utf8").includes("/mcp.json"));

	const record = JSON.parse(readFileSync(join(project, ".omp", "mattermost-agents-install.json"), "utf8")) as Record<string, unknown>;
	check(
		"the install record identifies pinned schema v3 state",
		record.schema === "mattermost-agents/install-record/3" && record.mode === "pinned" && record.profile === config,
		JSON.stringify(record),
	);

	const again = runInstaller("--project", project, "--profile", config, "--server-name", "mattermost-fleet-security");
	check("a second install changes nothing", again.code === 0 && again.stdout.includes("nothing to do"), again.stdout);

	const rolledBack = runInstaller("--project", project, "--rollback");
	check("rollback succeeds", rolledBack.code === 0, rolledBack.stderr);
	check(
		"rollback leaves nothing of its own behind",
		!existsSync(join(project, ".omp", "mcp.json")) && !existsSync(join(project, ".omp", "mattermost-agents-install.json")),
	);

	// A project that already declares another identity, and one whose config
	// directory belongs to somebody else: neither is a judgement call.
	const taken = join(dir, "taken");
	mkdirSync(join(taken, ".omp"), { recursive: true });
	writeFileSync(join(taken, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { "mattermost-other": mcpServer(join(dir, "other.json")) } }));
	const second = runInstaller("--project", taken, "--profile", config, "--server-name", "mattermost-fleet-security");
	check("a second identity in one project is refused", second.code === 78, `${second.code} ${second.stderr}`);

	const shared = join(dir, "shared");
	mkdirSync(shared);
	symlinkSync(join(dir, "elsewhere"), join(shared, ".omp"));
	mkdirSync(join(dir, "elsewhere"));
	const symlinked = runInstaller("--project", shared, "--profile", config, "--server-name", "mattermost-fleet-security");
	check("a symlinked config directory is refused", symlinked.code === 78, `${symlinked.code} ${symlinked.stderr}`);
	check("and the shared directory is untouched", !existsSync(join(dir, "elsewhere", "mcp.json")));

	const sharedProject = join(dir, "shared-mode");
	mkdirSync(sharedProject);
	const generic = runInstaller("--project", sharedProject, "--shared-project", "--server-name", "mattermost-session");
	const genericMcp = JSON.parse(readFileSync(join(sharedProject, ".omp", "mcp.json"), "utf8")) as {
		mcpServers: Record<string, { command?: string }>;
	};
	check(
		"shared mode installs one generic server with no embedded profile",
		generic.code === 0 &&
			genericMcp.mcpServers["mattermost-session"]?.command === MCP_WRAPPER &&
			!("env" in (genericMcp.mcpServers["mattermost-session"] ?? {})),
		`${generic.stdout} ${generic.stderr}`,
	);
	const genericRollback = runInstaller("--project", sharedProject, "--rollback");
	check("and shared rollback takes it back", genericRollback.code === 0 && !existsSync(join(sharedProject, ".omp", "mcp.json")));
}

/**
 * The fleet has projects installed by the previous version of this installer,
 * whose record owns an `extensions` entry in `settings.json` pointing at an
 * extension that no longer exists. Rollback has to keep undoing those, or the
 * dead entry stays in a live project's settings and every session there fails
 * to load it.
 */
async function rollsBackAPreMonitorInstall(): Promise<void> {
	console.log("rollback still undoes an install made before the monitor cutover");
	const { dir, config } = workspace("legacy");
	const project = join(dir, "worktree");
	const ompDir = join(project, ".omp");
	mkdirSync(ompDir, { recursive: true });

	const extensionEntry = join(HERE, "..", "omp-extension", "index.ts");
	const settings = { extensions: ["/existing/extension.ts", extensionEntry], theme: "dark" };
	const mcp = { mcpServers: { "mattermost-legacy": { command: MCP_WRAPPER, env: { MATTERMOST_AGENT_CONFIG: config } } } };
	const ignore = "keep.me\n# Local Mattermost harness wiring — machine-specific, never committed.\n/mcp.json\n/settings.json\n/mattermost-agents-install.json\n/.gitignore\n";
	const settingsPath = join(ompDir, "settings.json");
	const mcpPath = join(ompDir, "mcp.json");
	const ignorePath = join(ompDir, ".gitignore");
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
	writeFileSync(ignorePath, ignore);

	const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
	writeFileSync(
		join(ompDir, "mattermost-agents-install.json"),
		JSON.stringify(
			{
				schema: "mattermost-agents/install-record/2",
				installedAt: new Date().toISOString(),
				adapters: join(HERE, ".."),
				mode: "pinned",
				serverName: "mattermost-legacy",
				profile: config,
				extensionEntry,
				files: {
					[settingsPath]: { owns: "extension", created: false, sha256Before: null, sha256After: digest(settingsPath) },
					[mcpPath]: { owns: "server", created: true, sha256Before: null, sha256After: digest(mcpPath) },
					[ignorePath]: {
						owns: "lines",
						created: false,
						sha256Before: null,
						sha256After: digest(ignorePath),
						addedLines: [
							"# Local Mattermost harness wiring — machine-specific, never committed.",
							"/mcp.json",
							"/settings.json",
							"/mattermost-agents-install.json",
							"/.gitignore",
						],
					},
				},
			},
			null,
			2,
		),
	);

	const rolledBack = runInstaller("--project", project, "--rollback");
	check("a v2 record rolls back", rolledBack.code === 0, `${rolledBack.stdout} ${rolledBack.stderr}`);
	const afterSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as { extensions?: string[]; theme?: string };
	check(
		"the dead extension entry is gone and the rest of settings survives",
		afterSettings.extensions?.length === 1 &&
			afterSettings.extensions[0] === "/existing/extension.ts" &&
			afterSettings.theme === "dark",
		JSON.stringify(afterSettings),
	);
	check("the server it created is removed", !existsSync(mcpPath));
	check("and only its own ignore lines go", readFileSync(ignorePath, "utf8") === "keep.me\n", JSON.stringify(readFileSync(ignorePath, "utf8")));
	check("the record is gone", !existsSync(join(ompDir, "mattermost-agents-install.json")));
	unlinkSync(settingsPath);
}

for (const scenario of [monitorDeclaration, pluginSkillMatchesRoot, monitorShim, installer, rollsBackAPreMonitorInstall]) {
	await scenario();
}

console.log(failures === 0 ? "\nall adapter smoke checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
