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
 *
 * A segment is its label, one space, then its body. The label convention is
 * shared — same three styles, same column budget, same spacing — while the
 * label itself is the integration's own: this file ships byte-identical to
 * every repository that draws into the line, so it can name no one brand and
 * takes each integration's names as data at registration.
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
 *
 * MEASURED against that sanitizer (`sanitizeStatusText` in the shipped
 * bundle: strip control characters, collapse ` +` to one space, trim). A
 * SINGLE space survives it, so one space is the whole spacing vocabulary
 * this file has — inside a segment and around this separator alike. The same
 * measurement says private-use codepoints pass through untouched, which is
 * what makes a brand glyph a label at all.
 */
const SEPARATOR = " │ ";

/**
 * How a segment names its integration. The glyph is the default: a footer is
 * read at a glance and a logo lands faster than a word. `text` is the plain
 * word, for a font without the glyph or an operator who prefers letters, and
 * `none` drops the name entirely.
 */
export const LABEL_STYLES = ["glyph", "text", "none"] as const;
export type LabelStyle = (typeof LABEL_STYLES)[number];
export const DEFAULT_LABEL_STYLE: LabelStyle = "glyph";

/**
 * Widest a label may be, in terminal columns: one wide glyph, or two narrow
 * ones. This line is shared, so an integration that spent five columns on its
 * own name would be spending another integration's identity.
 */
export const MAX_LABEL_COLUMNS = 2;

/**
 * What one integration calls itself, in every style this line understands.
 * Data, not constants: this file is byte-identical across repositories, so
 * each integration hands its own names in when it registers.
 */
export interface ChannelLabel {
	/** The brand glyph — one codepoint, from the operator's Nerd Font. */
	readonly glyph: string;
	/** The word, short enough for a narrow footer. */
	readonly text: string;
	/** The word spelled out, for a verbose line. */
	readonly verbose: string;
}

/** What the operator's profile asked for, this render. */
export interface LabelChoice {
	readonly style: LabelStyle;
	/** Spell the word out. Nothing to a glyph, and nothing to no label at all. */
	readonly verbose?: boolean;
	/** A glyph this machine's font actually has, in place of the registered one. */
	readonly glyph?: string;
}

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
	/**
	 * Replace this owner's segment: the label this choice asks for, one
	 * space, then `body`. An empty body is a segment that is nothing but its
	 * label; a labelless empty body is no segment at all. Returns what the
	 * segment now reads, for whoever has to report it.
	 */
	set(body: string, choice: LabelChoice): string | undefined;
	/** Nothing is listening for this owner: take its segment off the line. */
	clear(): void;
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

/** The name this choice asks for, from the names the integration registered. */
function labelFor(label: ChannelLabel, choice: LabelChoice): string {
	switch (choice.style) {
		case "glyph":
			// An override is the whole remedy for a font without the glyph:
			// whatever the operator can see, this line will draw.
			return choice.glyph ?? label.glyph;
		case "text":
			return choice.verbose ? label.verbose : label.text;
		case "none":
			return "";
	}
}

/**
 * A glyph named the way an operator can act on it: the character itself, and
 * the codepoint to look up in a font. A box on the screen says nothing; `U+E927`
 * says which font is missing what.
 */
export function describeGlyph(glyph: string): string {
	const named = [...glyph]
		.map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`)
		.join(" ");
	return `${glyph} ${named}`;
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
export function registerChannelStatus(
	owner: string,
	order: number,
	label: ChannelLabel,
	publish: StatusPublisher,
): ChannelStatusHandle {
	const { registry, key } = registryFor(owner);
	registry.publishers.add(publish);
	return {
		key,
		set(body: string, choice: LabelChoice): string | undefined {
			const name = labelFor(label, choice);
			// One space between the two, never two: the sanitizer would eat
			// the second, and a caller counting on it would be counting on
			// something that never reaches the screen.
			const text = name.length === 0 ? body : body.length === 0 ? name : `${name} ${body}`;
			if (text.length === 0) registry.segments.delete(owner);
			else registry.segments.set(owner, { order, text });
			draw(registry, key);
			return text.length > 0 ? text : undefined;
		},
		clear(): void {
			registry.segments.delete(owner);
			draw(registry, key);
		},
	};
}
