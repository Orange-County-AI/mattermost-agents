#!/usr/bin/env bun
/**
 * Wire one OMP project to Mattermost, and be able to undo it.
 *
 * Pinned mode preserves the original one-project/one-identity behavior:
 *
 *   bun adapters/install-project.ts \
 *     --project /abs/path/to/worktree \
 *     --profile /abs/path/to/profile.json \
 *     --server-name mattermost-fleet-security
 *
 * Shared-project mode installs one generic server. Every OMP process must name
 * its own existing profile in `MATTERMOST_AGENT_CONFIG`; both the MCP child and
 * this extension inherit that session environment:
 *
 *   bun adapters/install-project.ts \
 *     --project /abs/path/to/worktree \
 *     --shared-project \
 *     --server-name mattermost-session
 *
 * It touches exactly three files inside `<project>/.omp/`:
 *
 *   settings.json  `extensions` gains the extension ENTRY FILE — never the
 *                  directory, which OMP would scan, loading `locate.ts` and
 *                  `watcher.ts` as extensions of their own.
 *   mcp.json       `mcpServers` gains one stdio server running the shared
 *                  wrapper. Pinned mode sets `MATTERMOST_AGENT_CONFIG`;
 *                  shared-project mode deliberately does not.
 *   .gitignore     keeps both of those, the install record and itself out of
 *                  the project's history: they contain machine-local paths.
 *
 * What it refuses rather than guesses: a config path that is a symlink or
 * resolves outside the project (it would edit somebody else's config), an
 * existing server of the same name that is configured differently, ambiguous
 * Mattermost server entries, another checkout's copy of this extension already
 * in `extensions`, and an existing ignore rule that deliberately un-ignores
 * one of these files.
 *
 * Re-running a pinned install with `--shared-project` is the one supported
 * migration. It is allowed only when this install record owns the existing
 * server and its MCP file still has the recorded hash. `--rollback` removes
 * only what a previous run added, and only while the files still hash to what
 * that run left behind.
 *
 * Credentials are never read, written or logged here: a pinned profile is only
 * a path, and core alone resolves what is inside it.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ENTRY = join(HERE, "omp-extension", "index.ts");
const MCP_WRAPPER = join(HERE, "bin", "mattermost-mcp");
const CONFIG_ENV = "MATTERMOST_AGENT_CONFIG";
const RECORD_SCHEMA_V1 = "mattermost-agents/install-record/1";
const RECORD_SCHEMA = "mattermost-agents/install-record/2";
const RECORD_FILE = "mattermost-agents-install.json";
const IGNORE_HEADER = "# Local Mattermost harness wiring — machine-specific, never committed.";
const IGNORED_FILES = ["mcp.json", "settings.json", RECORD_FILE, ".gitignore"];
/** EX_CONFIG, as the wrappers use: this is a setup problem, not a crash. */
const EX_CONFIG = 78;

const USAGE = `usage:
  install-project.ts --project <dir> --profile <file> --server-name <name> [--dry-run]
  install-project.ts --project <dir> --shared-project --server-name <name> [--dry-run]
  install-project.ts --project <dir> --rollback [--dry-run]`;

/** The slices of the OMP files this installer owns; everything else is preserved verbatim. */
interface SettingsFile {
	extensions?: unknown;
	[key: string]: unknown;
}

interface McpFile {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

/** What a recorded file gained, so rollback removes that and nothing else. */
type Owned = "extension" | "server" | "lines";

interface FileRecord {
	owns: Owned;
	created: boolean;
	sha256Before: string | null;
	sha256After: string;
	/** For `owns: "lines"`: the exact lines this install appended. */
	addedLines?: string[];
}

type InstallMode = "pinned" | "shared";

interface InstallRecord {
	schema: typeof RECORD_SCHEMA;
	installedAt: string;
	adapters: string;
	mode: InstallMode;
	serverName: string;
	profile?: string;
	extensionEntry: string;
	files: Record<string, FileRecord>;
}

interface StoredInstallRecord {
	schema?: unknown;
	installedAt?: unknown;
	adapters?: unknown;
	mode?: unknown;
	serverName?: unknown;
	profile?: unknown;
	extensionEntry?: unknown;
	files?: unknown;
}

interface InstallRequest {
	mode: InstallMode;
	serverName: string;
	profile?: string;
}

function fail(message: string): never {
	process.stderr.write(`mattermost-install: ${message}\n`);
	process.exit(EX_CONFIG);
}

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A path this installer may write: inside the project, and not reached through
 * a symlink. A symlinked `.omp` or `mcp.json` is somebody else's file — often
 * literally, when a checkout shares config with another worktree.
 */
function assertWritablePath(path: string, projectReal: string, label: string): void {
	let current = path;
	for (;;) {
		if (lstatSync(current, { throwIfNoEntry: false })) {
			if (lstatSync(current).isSymbolicLink()) {
				fail(`${label} ${current} is a symlink; refusing to write through it`);
			}
			const real = realpathSync(current);
			if (real !== projectReal && !real.startsWith(`${projectReal}/`)) {
				fail(`${label} ${current} resolves to ${real}, outside the project`);
			}
			return;
		}
		const parent = dirname(current);
		if (parent === current) fail(`${label} ${path} has no existing parent directory`);
		current = parent;
	}
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} ${path} is not readable JSON: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail(`${label} ${path} does not contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function readInstallRecord(path: string): { record: InstallRecord; upgradedFromV1: boolean } {
	const raw = readJsonObject(path, "install record") as StoredInstallRecord;
	if (raw.schema !== RECORD_SCHEMA && raw.schema !== RECORD_SCHEMA_V1) {
		fail(`${path} is schema ${String(raw.schema)}, not ${RECORD_SCHEMA} or ${RECORD_SCHEMA_V1}`);
	}
	if (
		typeof raw.installedAt !== "string" ||
		typeof raw.adapters !== "string" ||
		typeof raw.serverName !== "string" ||
		typeof raw.extensionEntry !== "string" ||
		!raw.files ||
		typeof raw.files !== "object" ||
		Array.isArray(raw.files)
	) {
		fail(`${path} is not a valid Mattermost install record`);
	}

	const upgradedFromV1 = raw.schema === RECORD_SCHEMA_V1;
	const mode = upgradedFromV1 ? "pinned" : raw.mode;
	if (mode !== "pinned" && mode !== "shared") fail(`${path} has invalid install mode ${String(mode)}`);
	if (mode === "pinned" && (typeof raw.profile !== "string" || raw.profile.length === 0)) {
		fail(`${path} records pinned mode without a profile`);
	}
	if (mode === "shared" && raw.profile !== undefined) {
		fail(`${path} records shared mode with a profile; refusing an ambiguous identity binding`);
	}

	const files: Record<string, FileRecord> = {};
	for (const [file, value] of Object.entries(raw.files)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			fail(`${path} has an invalid file record for ${file}`);
		}
		const state = value as Partial<FileRecord>;
		if (
			(state.owns !== "extension" && state.owns !== "server" && state.owns !== "lines") ||
			typeof state.created !== "boolean" ||
			(state.sha256Before !== null && typeof state.sha256Before !== "string") ||
			typeof state.sha256After !== "string" ||
			(state.addedLines !== undefined &&
				(!Array.isArray(state.addedLines) || state.addedLines.some((line) => typeof line !== "string")))
		) {
			fail(`${path} has an invalid file record for ${file}`);
		}
		files[file] = state as FileRecord;
	}

	return {
		record: {
			schema: RECORD_SCHEMA,
			installedAt: raw.installedAt,
			adapters: raw.adapters,
			mode,
			serverName: raw.serverName,
			...(mode === "pinned" ? { profile: raw.profile as string } : {}),
			extensionEntry: raw.extensionEntry,
			files,
		},
		upgradedFromV1,
	};
}

/**
 * Replace the file in one step, so a reader never sees a half-written config.
 * A file this installer creates is 0600; an existing one keeps its own mode —
 * tightening somebody else's config is not this tool's call.
 */
function writeAtomic(path: string, body: string): void {
	const existing = statSync(path, { throwIfNoEntry: false });
	const temporary = `${path}.mattermost-install.${process.pid}.tmp`;
	writeFileSync(temporary, body, { mode: existing ? existing.mode & 0o777 : 0o600 });
	renameSync(temporary, path);
}

function asJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

interface Plan {
	path: string;
	owns: Owned;
	existed: boolean;
	sha256Before: string | null;
	body: string;
	change: string;
	addedLines?: string[];
}

function planSettings(path: string, entry: string): Plan | string {
	const existed = existsSync(path);
	const settings: SettingsFile = existed ? readJsonObject(path, "project settings") : {};
	const configured = settings.extensions;
	if (configured !== undefined && !Array.isArray(configured)) {
		fail(`project settings ${path} has a non-array "extensions"`);
	}
	const extensions: unknown[] = Array.isArray(configured) ? [...configured] : [];

	for (const value of extensions) {
		if (typeof value !== "string") continue;
		const resolved = resolve(dirname(dirname(path)), value);
		if (resolved === entry) return `extensions already load ${entry}`;
		if (resolved === dirname(entry)) {
			fail(
				`project settings ${path} loads the extension DIRECTORY ${value}; ` +
					"OMP scans it and loads the helper modules as extensions too — replace that entry with the index.ts file",
			);
		}
		// A second copy of this extension, from another checkout, would supervise
		// a second listener for the same identity. Repoint it, do not add to it.
		if (resolved.endsWith("/omp-extension/index.ts") || resolved.endsWith("/omp-extension")) {
			fail(
				`project settings ${path} already loads another copy of this extension (${value}); ` +
					`repoint that entry at ${entry} instead of adding a second one`,
			);
		}
	}

	extensions.push(entry);
	return {
		path,
		owns: "extension",
		existed,
		sha256Before: existed ? digest(path) : null,
		body: asJson({ ...settings, extensions }),
		change: `extensions += ${entry}`,
	};
}

function planMcp(path: string, request: InstallRequest, migrateOwnedPin: boolean): Plan | string {
	const existed = existsSync(path);
	const file: McpFile = existed ? readJsonObject(path, "project MCP config") : {};
	const configured = file.mcpServers;
	if (configured !== undefined && (typeof configured !== "object" || configured === null || Array.isArray(configured))) {
		fail(`project MCP config ${path} has a non-object "mcpServers"`);
	}
	const servers: Record<string, unknown> = { ...(configured ?? {}) };
	let target: "missing" | "configured" | "migrate" = "missing";

	for (const [name, entry] of Object.entries(servers)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const { command, env } = entry as { command?: unknown; env?: Record<string, unknown> };
		const hasConfig = Boolean(env && typeof env === "object" && Object.hasOwn(env, CONFIG_ENV));
		const pinned = hasConfig ? env?.[CONFIG_ENV] : undefined;
		const isMattermost = command === MCP_WRAPPER;

		if (name === request.serverName) {
			if (request.mode === "pinned" && isMattermost && pinned === request.profile) {
				target = "configured";
				continue;
			}
			if (request.mode === "shared" && isMattermost && !hasConfig) {
				target = "configured";
				continue;
			}
			if (request.mode === "shared" && migrateOwnedPin && isMattermost && typeof pinned === "string") {
				target = "migrate";
				continue;
			}
			fail(
				`project MCP config ${path} already has a server named "${name}" with different settings; ` +
					"resolve it by hand or choose another --server-name",
			);
		}

		if (isMattermost && !hasConfig) {
			fail(
				`project MCP config ${path} already has a shared-project Mattermost server named "${name}"; ` +
					"refusing to add a second generic server",
			);
		}
		if (request.mode === "shared" && hasConfig) {
			fail(
				`project MCP config ${path} already sets ${CONFIG_ENV} on server "${name}"; ` +
					"shared-project mode requires one generic Mattermost server and no project identity pin",
			);
		}
		if (request.mode === "pinned" && typeof pinned === "string" && pinned !== request.profile) {
			fail(
				`project MCP config ${path} already pins ${CONFIG_ENV}=${pinned} on server "${name}"; ` +
					"two identities in one project is what the listener refuses to guess between",
			);
		}
	}

	if (target === "configured") {
		return `server "${request.serverName}" is already configured in ${request.mode === "pinned" ? "pinned" : "shared-project"} mode`;
	}
	servers[request.serverName] =
		request.mode === "pinned"
			? { command: MCP_WRAPPER, env: { [CONFIG_ENV]: request.profile } }
			: { command: MCP_WRAPPER };
	return {
		path,
		owns: "server",
		existed,
		sha256Before: existed ? digest(path) : null,
		body: asJson({ ...file, mcpServers: servers }),
		change:
			target === "migrate"
				? `migrate mcpServers["${request.serverName}"] from pinned to shared-project mode`
				: request.mode === "pinned"
					? `mcpServers += "${request.serverName}" → ${request.profile}`
					: `mcpServers += "${request.serverName}" → shared-project identity`,
	};
}

/**
 * Keep the harness wiring out of the project's history. Only `.omp/.gitignore`
 * is touched — never the repository root's, and never `.git/info/exclude`,
 * which is shared by every worktree of the same repository.
 */
function planGitignore(path: string): Plan | string {
	const existed = existsSync(path);
	const previous = existed ? readFileSync(path, "utf8") : "";
	const lines = previous.split("\n");

	const missing: string[] = [];
	for (const file of IGNORED_FILES) {
		let present = false;
		for (const raw of lines) {
			const line = raw.trim();
			if (line === file || line === `/${file}`) present = true;
			if (line === `!${file}` || line === `!/${file}`) {
				fail(`${path} explicitly un-ignores ${file}; leaving that decision alone — resolve it by hand`);
			}
		}
		if (!present) missing.push(`/${file}`);
	}
	if (missing.length === 0) return `${path} already ignores the Mattermost harness wiring`;

	const added = existed ? missing : [IGNORE_HEADER, ...missing];
	const head = previous.length === 0 || previous.endsWith("\n") ? previous : `${previous}\n`;
	return {
		path,
		owns: "lines",
		existed,
		sha256Before: existed ? digest(path) : null,
		body: `${head}${added.join("\n")}\n`,
		change: `ignore ${missing.join(" ")}`,
		addedLines: added,
	};
}

function install(projectDir: string, requested: InstallRequest, dryRun: boolean): void {
	if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(requested.serverName)) {
		fail(`--server-name ${requested.serverName} is not a valid MCP server name`);
	}
	for (const [label, path] of [
		["extension entry", EXTENSION_ENTRY],
		["MCP wrapper", MCP_WRAPPER],
	] as const) {
		if (!existsSync(path)) fail(`${label} missing at ${path}; run this from the mattermost-agents checkout`);
	}
	if ((statSync(MCP_WRAPPER).mode & 0o111) === 0) fail(`MCP wrapper ${MCP_WRAPPER} is not executable`);

	const project = resolve(projectDir);
	if (!existsSync(project) || !statSync(project).isDirectory()) fail(`--project ${project} is not a directory`);
	const projectReal = realpathSync(project);

	const request: InstallRequest =
		requested.mode === "pinned"
			? { ...requested, profile: resolve(requested.profile as string) }
			: { mode: "shared", serverName: requested.serverName };
	if (request.mode === "pinned") {
		const profile = request.profile as string;
		if (lstatSync(profile, { throwIfNoEntry: false })?.isSymbolicLink()) {
			fail(`--profile ${profile} is a symlink; pin the real profile path so the listener and the tools agree`);
		}
		if (!existsSync(profile) || !statSync(profile).isFile()) fail(`--profile ${profile} is not a file`);
	}

	const ompDir = join(project, ".omp");
	assertWritablePath(ompDir, projectReal, "project config directory");
	const settingsPath = join(ompDir, "settings.json");
	const mcpPath = join(ompDir, "mcp.json");
	const ignorePath = join(ompDir, ".gitignore");
	const recordPath = join(ompDir, RECORD_FILE);
	for (const [label, path] of [
		["project settings", settingsPath],
		["project MCP config", mcpPath],
		["project ignore file", ignorePath],
		["install record", recordPath],
	] as const) {
		assertWritablePath(path, projectReal, label);
	}

	// A repair run re-plans only the files that need it. The additions this tool
	// already owns in the others are still there, so their records carry over —
	// dropping them would leave rollback nothing to take back.
	let previous: InstallRecord | null = null;
	let upgradeRecord = false;
	let migrateOwnedPin = false;
	if (existsSync(recordPath)) {
		const loaded = readInstallRecord(recordPath);
		previous = loaded.record;
		upgradeRecord = loaded.upgradedFromV1;
		if (previous.serverName !== request.serverName) {
			fail(
				`${recordPath} records a ${previous.mode} install named "${previous.serverName}"; ` +
					"roll that back before installing a differently named server here",
			);
		}
		if (previous.mode === "pinned" && request.mode === "pinned" && previous.profile !== request.profile) {
			fail(
				`${recordPath} records pinned profile ${previous.profile}; ` +
					"roll that back before installing a different identity here",
			);
		}
		if (previous.mode === "shared" && request.mode === "pinned") {
			fail(`${recordPath} records shared-project mode; roll it back before installing a pinned identity`);
		}
		if (previous.mode === "pinned" && request.mode === "shared") {
			const owned = previous.files[mcpPath];
			if (!owned || owned.owns !== "server") {
				fail(`${recordPath} does not own ${mcpPath}; refusing to migrate an ambiguous MCP entry`);
			}
			if (existsSync(mcpPath) && digest(mcpPath) !== owned.sha256After) {
				fail(`${mcpPath} changed since the pinned install; refusing to replace an entry this run no longer owns`);
			}
			migrateOwnedPin = true;
		}
	}

	const plans: Plan[] = [];
	const skipped: string[] = [];
	for (const planned of [
		planSettings(settingsPath, EXTENSION_ENTRY),
		planMcp(mcpPath, request, migrateOwnedPin),
		planGitignore(ignorePath),
	]) {
		if (typeof planned === "string") skipped.push(planned);
		else plans.push(planned);
	}

	for (const note of skipped) process.stdout.write(`already done: ${note}\n`);
	for (const plan of plans) process.stdout.write(`${plan.existed ? "update" : "create"} ${plan.path}: ${plan.change}\n`);
	if (upgradeRecord) process.stdout.write(`update ${recordPath}: ${RECORD_SCHEMA_V1} → ${RECORD_SCHEMA}\n`);
	if (plans.length === 0 && !upgradeRecord) {
		process.stdout.write("nothing to do\n");
		return;
	}
	if (dryRun) {
		process.stdout.write(`dry run: ${recordPath} would record the additions above\n`);
		return;
	}

	mkdirSync(ompDir, { recursive: true });
	const previousFiles = previous?.files ?? {};
	const files: Record<string, FileRecord> = { ...previousFiles };
	for (const plan of plans) {
		writeAtomic(plan.path, plan.body);
		// What this file was BEFORE this tool ever touched it is the first run's
		// answer, not this one's: a file we created, deleted by hand and made
		// again is still ours to remove on rollback.
		const prior = previousFiles[plan.path];
		files[plan.path] = {
			owns: plan.owns,
			created: prior ? prior.created : !plan.existed,
			sha256Before: prior ? prior.sha256Before : plan.sha256Before,
			sha256After: digest(plan.path),
			...(plan.addedLines ? { addedLines: plan.addedLines } : prior?.addedLines ? { addedLines: prior.addedLines } : {}),
		};
	}

	const record: InstallRecord = {
		schema: RECORD_SCHEMA,
		installedAt: previous?.installedAt ?? new Date().toISOString(),
		adapters: HERE,
		mode: request.mode,
		serverName: request.serverName,
		...(request.mode === "pinned" ? { profile: request.profile as string } : {}),
		extensionEntry: EXTENSION_ENTRY,
		files,
	};
	writeAtomic(recordPath, asJson(record));
	process.stdout.write(`wrote ${recordPath}\n`);
	process.stdout.write(
		request.mode === "pinned"
			? `done. ${project} now resumes as "${request.serverName}"; no environment variable and no launch flag is needed.\n`
			: `done. ${project} now uses per-session Mattermost identities; launch each OMP process with ${CONFIG_ENV}=<profile>.\n`,
	);
}

/** What this file should contain once this install's additions are taken back out. */
function undo(path: string, state: FileRecord, record: InstallRecord): { body: string; emptied: boolean } {
	if (state.owns === "lines") {
		const remaining: string[] = [];
		const drop = [...(state.addedLines ?? [])];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const index = drop.indexOf(line);
			if (index !== -1) {
				drop.splice(index, 1);
				continue;
			}
			remaining.push(line);
		}
		const body = remaining.join("\n");
		return { body: body.trim().length === 0 ? "" : body, emptied: body.trim().length === 0 };
	}

	const current = readJsonObject(path, "project config");
	if (state.owns === "server") {
		const servers = { ...((current as McpFile).mcpServers ?? {}) };
		delete servers[record.serverName];
		const emptied = Object.keys(servers).length === 0 && Object.keys(current).length === 1;
		return { body: asJson({ ...current, mcpServers: servers }), emptied };
	}

	const configured = (current as SettingsFile).extensions;
	const extensions = (Array.isArray(configured) ? configured : []).filter((value) => value !== record.extensionEntry);
	const emptied = extensions.length === 0 && Object.keys(current).length === 1;
	return { body: asJson({ ...current, extensions }), emptied };
}

function rollback(projectDir: string, dryRun: boolean): void {
	const project = resolve(projectDir);
	if (!existsSync(project) || !statSync(project).isDirectory()) fail(`--project ${project} is not a directory`);
	const projectReal = realpathSync(project);
	const ompDir = join(project, ".omp");
	const recordPath = join(ompDir, RECORD_FILE);
	if (!existsSync(recordPath)) fail(`no install record at ${recordPath}; nothing this tool installed`);
	const { record } = readInstallRecord(recordPath);

	// The record is a file on disk like any other: it says what to undo, it does
	// not get to say where. Only this project's own config files are in scope,
	// and they are re-checked for symlinks and containment before being written.
	const inScope = [join(ompDir, "settings.json"), join(ompDir, "mcp.json"), join(ompDir, ".gitignore")];

	const actions: (() => void)[] = [];
	for (const [path, state] of Object.entries(record.files)) {
		if (!inScope.includes(path)) {
			fail(`${recordPath} names ${path}, which is not one of this project's .omp config files; refusing to touch it`);
		}
		assertWritablePath(path, projectReal, "recorded config file");
		if (!existsSync(path)) {
			process.stdout.write(`skip ${path}: already gone\n`);
			continue;
		}
		if (digest(path) !== state.sha256After) {
			fail(`${path} changed since the install; remove the entries by hand rather than clobbering that edit`);
		}

		const { body, emptied } = undo(path, state, record);
		// A file this install created, holding nothing else, goes away entirely.
		if (state.created && emptied) {
			actions.push(() => unlinkSync(path));
			process.stdout.write(`${path}: remove (created by this install, now empty)\n`);
			continue;
		}
		actions.push(() => writeAtomic(path, body));
		process.stdout.write(`${path}: drop this install's additions\n`);
	}

	if (dryRun) {
		process.stdout.write(`dry run: ${recordPath} would be removed\n`);
		return;
	}
	for (const act of actions) act();
	unlinkSync(recordPath);
	process.stdout.write(`removed ${recordPath}\ndone. ${project} no longer starts a Mattermost listener.\n`);
}

const args = process.argv.slice(2);
const options = new Map<string, string>();
const flags = new Set<string>();
for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (!arg.startsWith("--")) fail(`unexpected argument ${arg}\n${USAGE}`);
	const [name, inline] = arg.slice(2).split(/=(.*)/s);
	if (name === "rollback" || name === "dry-run" || name === "help" || name === "shared-project") {
		if (inline !== undefined) fail(`--${name} does not take a value\n${USAGE}`);
		flags.add(name);
		continue;
	}
	if (name !== "project" && name !== "profile" && name !== "server-name") {
		fail(`unknown option --${name}\n${USAGE}`);
	}
	const value = inline ?? args[++index];
	if (value === undefined) fail(`--${name} needs a value\n${USAGE}`);
	options.set(name, value);
}

if (flags.has("help")) {
	process.stdout.write(`${USAGE}\n`);
	process.exit(0);
}

const projectOption = options.get("project");
if (!projectOption) fail(`--project is required\n${USAGE}`);

if (flags.has("rollback")) {
	if (flags.has("shared-project") || options.has("profile") || options.has("server-name")) {
		fail(`--rollback cannot be combined with install options\n${USAGE}`);
	}
	rollback(projectOption, flags.has("dry-run"));
} else {
	const profileOption = options.get("profile");
	const serverOption = options.get("server-name");
	const shared = flags.has("shared-project");
	if (!serverOption) fail(`--server-name is required\n${USAGE}`);
	if (shared === Boolean(profileOption)) {
		fail(`choose exactly one of --profile <file> or --shared-project\n${USAGE}`);
	}
	install(
		projectOption,
		shared
			? { mode: "shared", serverName: serverOption }
			: { mode: "pinned", serverName: serverOption, profile: profileOption as string },
		flags.has("dry-run"),
	);
}
