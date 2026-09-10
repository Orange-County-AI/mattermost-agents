/**
 * One footer line for every channel integration loaded into this OMP process.
 *
 * MEASURED, not assumed. OMP keeps extension statuses in a map keyed by the
 * `setStatus` key, and the composer that draws them renders ONE LINE PER KEY,
 * sorted by key (`StatusLineComponent.setHookStatus` sorts by
 * `localeCompare`, then `render` pushes one line per entry; the older
 * `FooterComponent` joins them with a space instead). Two integrations with
 * two keys are therefore two stacked lines, and vertical space in a footer is
 * the scarcest thing there is.
 *
 * So the convention is one key, many segments. Every integration that
 * delivers messages into a session registers its segment here, and any change
 * re-renders the whole line through every registered publisher.
 *
 * The registry lives on `globalThis` because these integrations ship from
 * different repositories into the same process: they must cooperate without
 * importing each other, and either one alone must still render — with one
 * segment the line IS that segment, and an integration that never loads
 * leaves nothing behind. `order` fixes the sequence whichever loaded first:
 * chat before mail.
 */

/**
 * Versioned in the name: a future, incompatible registry takes a new property
 * rather than being mistaken for this one by an older copy still in the
 * process.
 */
const REGISTRY_PROPERTY = "__ompChannelStatusRegistry1";

/** The one status key every channel integration writes. */
export const CHANNEL_STATUS_KEY = "channels";

/** Chat before mail, by declaration and not by load order. */
export const CHAT_ORDER = 10;
export const MAIL_ORDER = 20;

/**
 * Two segments, one line. A visible glyph with spaces around it, because OMP
 * sanitizes status text by collapsing runs of spaces — padding alone cannot
 * separate two segments.
 */
const SEPARATOR = " │ ";

/** How an integration hands a rendered line to its own session's UI. */
export type StatusPublisher = (key: string, text: string | undefined) => void;

interface Segment {
	order: number;
	text: string;
}

interface Registry {
	version: 1;
	segments: Map<string, Segment>;
	publishers: Set<StatusPublisher>;
}

export interface ChannelStatusHandle {
	/** Replace this owner's segment, or drop it with `undefined`, and redraw the line. */
	set(text: string | undefined): void;
	/** The key this handle publishes under — the shared one, unless the registry was unusable. */
	readonly key: string;
}

/**
 * A registry this build can speak to. The property is public ground, so the
 * shape is checked rather than trusted: anything else keeps its slot, and this
 * integration falls back to its own key. A second line is worse than one line,
 * and both are better than rendering nothing.
 */
function usable(value: unknown): value is Registry {
	if (!value || typeof value !== "object") return false;
	// Named, because the checks below are what make the assertion true.
	const candidate = value as Partial<Registry>;
	return candidate.version === 1 && candidate.segments instanceof Map && candidate.publishers instanceof Set;
}

function registryFor(owner: string): { registry: Registry; key: string } {
	// The one shared mutable surface these two packages have. Typed as a bag
	// of unknowns, so nothing is read from it without a check.
	const host = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = host[REGISTRY_PROPERTY];
	if (existing === undefined) {
		const created: Registry = { version: 1, segments: new Map(), publishers: new Set() };
		host[REGISTRY_PROPERTY] = created;
		return { registry: created, key: CHANNEL_STATUS_KEY };
	}
	if (usable(existing)) return { registry: existing, key: CHANNEL_STATUS_KEY };
	return { registry: { version: 1, segments: new Map(), publishers: new Set() }, key: owner };
}

function draw(registry: Registry, key: string): void {
	const line = [...registry.segments.entries()]
		.sort(([leftOwner, left], [rightOwner, right]) => left.order - right.order || leftOwner.localeCompare(rightOwner))
		.map(([, segment]) => segment.text)
		.join(SEPARATOR);
	const text = line.length > 0 ? line : undefined;
	for (const publish of registry.publishers) publish(key, text);
}

/**
 * Join this integration's segment to the shared line. The publisher is
 * registered for the life of the process — sessions come and go behind it, so
 * it must read the live one every call rather than close over one context.
 */
export function registerChannelStatus(owner: string, order: number, publish: StatusPublisher): ChannelStatusHandle {
	const { registry, key } = registryFor(owner);
	registry.publishers.add(publish);
	return {
		key,
		set(text: string | undefined): void {
			if (text === undefined || text.length === 0) registry.segments.delete(owner);
			else registry.segments.set(owner, { order, text });
			draw(registry, key);
		},
	};
}
