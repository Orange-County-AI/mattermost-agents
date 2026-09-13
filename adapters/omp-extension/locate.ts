/**
 * What to spawn: the core CLI, the bun that runs it, and the config file.
 *
 * Identity is never guessed. A pinned project names one literal profile in the
 * `MATTERMOST_AGENT_CONFIG` field of `<cwd>/.omp/mcp.json`; the session
 * environment may only agree with it. A shared project has one generic
 * Mattermost MCP server with no such field, and each OMP process must select
 * its own profile through `MATTERMOST_AGENT_CONFIG`. The MCP child and this
 * extension then inherit the same selection.
 *
 * Nothing else is searched: no ancestor directory, no `$HOME`, no default
 * profile, no profile directory. A missing shared-project selection is
 * inactive with an exact launch diagnostic. A pinned/environment disagreement,
 * multiple generic servers, or a generic server beside a pin fails closed.
 *
 * The wrappers in `adapters/bin/` deliberately implement only environment
 * selection: they are plain `sh` and run under harnesses with no project
 * directory of their own.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_ENV = "MATTERMOST_AGENT_CONFIG";
export const CLI_ENV = "MATTERMOST_AGENT_CLI";
export const BUN_ENV = "MATTERMOST_AGENT_BUN";

/** `adapters/omp-extension/locate.ts` → `<repo>/src/agent/cli.ts`. */
const DEFAULT_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/agent/cli.ts");
/** The exact generic MCP wrapper installed beside this extension. */
const MATTERMOST_MCP = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/mattermost-mcp");

export type Env = Record<string, string | undefined>;

export type Resolution<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CoreCommand {
	/** Executable to spawn. */
	command: string;
	/** Leading arguments — the CLI entry, when it runs through bun. */
	prefix: string[];
	/** Resolved CLI entry, for diagnostics. */
	cli: string;
}

function fileMode(path: string): number | null {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat.mode : null;
	} catch {
		return null;
	}
}

/**
 * `MATTERMOST_AGENT_BUN`, else this runtime when it is already bun (the normal
 * case inside OMP), else `bun` on PATH. No guessed install locations.
 */
export function findBun(env: Env): string | null {
	const override = env[BUN_ENV];
	if (override) return fileMode(override) === null ? null : override;
	// Only when this runtime really is a bun binary: a host that bundles its own
	// entry can leave execPath pointing at a script, which cannot run the CLI.
	if (process.versions.bun && basename(process.execPath) === "bun") return process.execPath;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "bun");
		const mode = fileMode(candidate);
		if (mode !== null && (mode & 0o111) !== 0) return candidate;
	}
	return null;
}

/**
 * How to invoke the core CLI: `MATTERMOST_AGENT_CLI` when set (a `.ts`/`.js`
 * entry runs through bun, anything else runs directly), otherwise the fixed
 * path inside this checkout, so the whole repo stays relocatable.
 */
export function resolveCoreCommand(env: Env): Resolution<CoreCommand> {
	const override = env[CLI_ENV];
	const cli = override ? resolve(override) : DEFAULT_CLI;
	if (fileMode(cli) === null) {
		return {
			ok: false,
			reason: override
				? `${CLI_ENV}=${override} does not name a file`
				: `core CLI missing at ${cli}`,
		};
	}

	if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(cli)) {
		const mode = fileMode(cli);
		if (mode === null || (mode & 0o111) === 0) return { ok: false, reason: `${cli} is not executable` };
		return { ok: true, value: { command: cli, prefix: [], cli } };
	}

	const bun = findBun(env);
	if (!bun) return { ok: false, reason: `bun not found on PATH; set ${BUN_ENV}` };
	return { ok: true, value: { command: bun, prefix: [cli], cli } };
}

/**
 * `null` when `MATTERMOST_AGENT_CONFIG` is unset — this session is not a
 * Mattermost consumer, which is not an error. A path that does not exist is an
 * error: somebody meant to connect and the setup is wrong.
 */
export function resolveConfigPath(env: Env): Resolution<string> | null {
	const configured = env[CONFIG_ENV];
	if (!configured) return null;
	const path = resolve(configured);
	if (fileMode(path) === null) return { ok: false, reason: `${CONFIG_ENV}=${path} does not exist` };
	return { ok: true, value: path };
}

/** The project MCP file OMP itself reads for a working directory. */
const PROJECT_MCP = [".omp", "mcp.json"];

/** Where a resolved identity came from, for diagnostics and for the operator. */
export type ConfigOrigin = "env" | "project";

export interface ConfigChoice {
	/** Absolute path of the core agent config. */
	path: string;
	origin: ConfigOrigin;
	/** Human-readable source, shown by `/mattermost status`. */
	detail: string;
}

interface ProjectChoice {
	mode: "pinned" | "shared";
	/** Present only in pinned mode. */
	path?: string;
	/** Human-readable project declaration. */
	detail: string;
}

export type SessionConfigResolution =
	| Resolution<ConfigChoice>
	| { ok: false; inactive: true; reason: string };

export function projectMcpPath(cwd: string): string {
	return join(cwd, ...PROJECT_MCP);
}

/**
 * The slice of OMP's project MCP file this adapter reads. Every field stays
 * `unknown` until it is checked: the file is hand-edited config, and OMP has
 * its own schema for the rest of it.
 */
interface ProjectMcpFile {
	mcpServers?: Record<
		string,
		{ command?: unknown; enabled?: unknown; env?: Record<string, unknown> } | undefined
	>;
	disabledServers?: unknown;
	enabledServers?: unknown;
}

/**
 * Before launching a stdio server OMP may resolve an `env` value through a
 * leading `!` shell command, a `${VAR}` placeholder, or a bare
 * environment-variable name, and only falls back to the literal string. Only
 * the literal case names a config this adapter can verify and hand to core, so
 * the others are reported as unsupported instead of guessed at: resolving them
 * differently from OMP is how a listener ends up on a different account than
 * the tools.
 */
function literalPath(value: string): Resolution<string> {
	if (value.startsWith("!")) {
		return { ok: false, reason: "which OMP runs as a shell command; this adapter needs a literal path" };
	}
	if (value.includes("${")) {
		return { ok: false, reason: "which OMP expands as a placeholder; this adapter needs a literal path" };
	}
	if (!value.includes("/")) {
		return {
			ok: false,
			reason: "which names an environment variable, not a path; this adapter needs a literal path",
		};
	}
	return { ok: true, value };
}

/**
 * The identity contract in `<cwd>/.omp/mcp.json`, if any.
 *
 * A pinned project has exactly one literal `MATTERMOST_AGENT_CONFIG` value.
 * A shared project has exactly one enabled server invoking this checkout's
 * Mattermost wrapper and omits that key entirely, allowing the MCP child to
 * inherit the OMP process's value. Mixing those forms is an error.
 */
export function resolveProjectConfig(cwd: string): Resolution<ProjectChoice> | null {
	const file = projectMcpPath(cwd);
	if (fileMode(file) === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, reason: `${file} is not readable JSON: ${String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: `${file} does not contain a JSON object` };
	}

	const servers = (parsed as ProjectMcpFile).mcpServers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
	const { disabledServers, enabledServers } = parsed as ProjectMcpFile;
	const disabled: readonly unknown[] = Array.isArray(disabledServers) ? disabledServers : [];
	const forceEnabled: readonly unknown[] = Array.isArray(enabledServers) ? enabledServers : [];

	/** Resolved config path → the server names that pin it. */
	const pinned = new Map<string, string[]>();
	const shared: string[] = [];
	for (const [name, entry] of Object.entries(servers)) {
		if (!entry || typeof entry !== "object") continue;
		// A server OMP will not launch cannot be this session's identity contract.
		if (disabled.includes(name)) continue;
		if (entry.enabled === false && !forceEnabled.includes(name)) continue;

		const env = entry.env;
		const hasConfig = Boolean(env && typeof env === "object" && Object.hasOwn(env, CONFIG_ENV));
		if (entry.command === MATTERMOST_MCP && !hasConfig) {
			shared.push(name);
			continue;
		}
		if (!hasConfig) continue;

		const raw = env?.[CONFIG_ENV];
		if (typeof raw !== "string" || raw.trim().length === 0) {
			return {
				ok: false,
				reason: `${file}: server "${name}" sets ${CONFIG_ENV} to a non-path value; refusing to guess`,
			};
		}
		const value = raw.trim();
		const literal = literalPath(value);
		if (!literal.ok) {
			return { ok: false, reason: `${file}: server "${name}" sets ${CONFIG_ENV}=${value}, ${literal.reason}` };
		}
		const path = resolve(cwd, literal.value);
		const owners = pinned.get(path);
		if (owners) owners.push(name);
		else pinned.set(path, [name]);
	}

	if (shared.length > 0 && pinned.size > 0) {
		const pins = [...pinned]
			.map(([path, names]) => `${names.join(", ")} → ${path}`)
			.join("; ");
		return {
			ok: false,
			reason:
				`${file} mixes shared-project server${shared.length === 1 ? "" : "s"} ${shared.map((name) => `"${name}"`).join(", ")} ` +
				`with pinned ${CONFIG_ENV} (${pins}); refusing to choose which identity contract MCP uses`,
		};
	}
	if (shared.length > 1) {
		return {
			ok: false,
			reason: `${file} has ${shared.length} shared-project Mattermost servers (${shared.map((name) => `"${name}"`).join(", ")}); expected exactly one`,
		};
	}
	if (shared.length === 1) {
		return {
			ok: true,
			value: { mode: "shared", detail: `${file} server "${shared[0]}" (shared-project mode)` },
		};
	}

	if (pinned.size === 0) return null;
	if (pinned.size > 1) {
		const listed = [...pinned]
			.map(([path, names]) => `${names.join(", ")} → ${path}`)
			.join("; ");
		return {
			ok: false,
			reason: `${file} pins ${pinned.size} different ${CONFIG_ENV} values (${listed}); one project, one identity`,
		};
	}

	const [path, names] = [...pinned][0];
	const detail = `${file} server ${names.map((name) => `"${name}"`).join(", ")}`;
	if (fileMode(path) === null) return { ok: false, reason: `${detail} points ${CONFIG_ENV} at ${path}, which does not exist` };
	return { ok: true, value: { mode: "pinned", path, detail } };
}

/**
 * The identity this session listens as. Pinned projects require agreement;
 * shared projects require the environment and deliberately provide no default.
 */
export function resolveSessionConfig(env: Env, cwd?: string): SessionConfigResolution | null {
	const explicit = resolveConfigPath(env);
	if (explicit && !explicit.ok) return explicit;

	const project = cwd ? resolveProjectConfig(cwd) : null;
	if (project && !project.ok) return project;

	if (project?.ok && project.value.mode === "shared") {
		if (!explicit?.ok) {
			return {
				ok: false,
				inactive: true,
				reason:
					`${project.value.detail} requires ${CONFIG_ENV}; ` +
					`launch OMP with ${CONFIG_ENV}=/absolute/path/to/profile.json`,
			};
		}
		return {
			ok: true,
			value: {
				path: explicit.value,
				origin: "env",
				detail: `${CONFIG_ENV}, selected for ${project.value.detail}`,
			},
		};
	}

	if (explicit?.ok && project?.ok) {
		const pinned = project.value.path as string;
		if (explicit.value !== pinned) {
			return {
				ok: false,
				reason:
					`${CONFIG_ENV}=${explicit.value} but ${project.value.detail} pins ${pinned}; ` +
					"refusing to listen as one account while the MCP tools act as another",
			};
		}
		return {
			ok: true,
			value: { path: explicit.value, origin: "env", detail: `${CONFIG_ENV}, matching ${project.value.detail}` },
		};
	}
	if (explicit?.ok) return { ok: true, value: { path: explicit.value, origin: "env", detail: CONFIG_ENV } };
	if (project?.ok) {
		return {
			ok: true,
			value: { path: project.value.path as string, origin: "project", detail: project.value.detail },
		};
	}
	return null;
}

/** Why a session outside shared-project mode has no identity. */
export function inactiveReason(cwd?: string): string {
	if (!cwd) return `${CONFIG_ENV} is not set and this session has no project directory`;
	return `${CONFIG_ENV} is not set and no server in ${projectMcpPath(cwd)} pins it or declares shared-project mode`;
}
