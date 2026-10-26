// Decides which HomeKit switches to add and remove so they match the profiles DisplayDeck has.
// Pure functions with no Homebridge imports, so the rules are easy to test.

export type Plan = {
	/** Profiles that have no switch yet. */
	add: string[];
	/** Switches whose profile has been gone for long enough to be sure. */
	remove: string[];
	/** Switches whose profile still exists. */
	keep: string[];
	/** For each switch whose profile is missing but not yet removed: how many polls in a row it has been missing. */
	missing: Map<string, number>;
};

/** How many successful polls in a row a profile must be missing before its switch is removed. */
export const REMOVE_AFTER = 2;

/**
 * Compares the switches that exist with the profiles DisplayDeck reports.
 *
 * Additions happen at once. Removals wait until the profile has been missing on `removeAfter` successful polls in a row, so
 * one odd answer (an empty list while the profiles folder is briefly unavailable, say) cannot wipe every switch. The caller
 * must only call this after a poll that succeeded: an unreachable PC says nothing about the profiles.
 */
export function reconcile(
	existing: Iterable<string>,
	live: Iterable<string>,
	missingBefore: ReadonlyMap<string, number> = new Map(),
	removeAfter: number = REMOVE_AFTER,
): Plan {
	const liveSet = new Set(live);
	const existingSet = new Set(existing);

	const add: string[] = [];
	for (const name of liveSet) if (!existingSet.has(name)) add.push(name);

	const keep: string[] = [];
	const remove: string[] = [];
	const missing = new Map<string, number>();
	for (const name of existingSet) {
		if (liveSet.has(name)) {
			keep.push(name);
			continue;
		}
		const count = (missingBefore.get(name) ?? 0) + 1;
		if (count >= removeAfter) remove.push(name);
		else missing.set(name, count);
	}
	return { add, remove, keep, missing };
}

/** Applies the optional "only these profiles" list. An empty or missing list means every profile. */
export function selectProfiles(profiles: readonly string[], allow: readonly string[]): string[] {
	if (allow.length === 0) return [...profiles];
	const wanted = new Set(allow);
	return profiles.filter((p) => wanted.has(p));
}

/** Which profile's switch should read On: the live layout's match, else the one applied last (if it still exists). */
export function activeProfile(status: { current: string | null; lastApplied: string | null }, names: readonly string[]): string | null {
	if (status.current && names.includes(status.current)) return status.current;
	if (status.lastApplied && names.includes(status.lastApplied)) return status.lastApplied;
	return null;
}

/**
 * A name HomeKit accepts: it must start and end with a letter or number. Profile names are file names, so they can be
 * anything ("Desk!", "- TV -"); trim what HomeKit would complain about and fall back to "Display profile" if nothing is left.
 */
export function homekitName(name: string): string {
	const trimmed = name.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
	return trimmed || "Display profile";
}
