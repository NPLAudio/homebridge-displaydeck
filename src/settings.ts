/** The platform name users put in config.json (it must match "pluginAlias" in config.schema.json). */
export const PLATFORM_NAME = "DisplayDeck";
/** The npm package name. */
export const PLUGIN_NAME = "homebridge-displaydeck";

export type Settings = {
	host: string;
	port: number;
	accessKey: string;
	pollSeconds: number;
	/** Only these profiles are exposed. Empty means all of them. */
	profiles: string[];
	namePrefix: string;
	undoSwitch: boolean;
};

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; error: string };

const MIN_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 300;

/** Turns what the user typed into settings the plugin can rely on, or says what is wrong with it. */
export function readSettings(config: Record<string, unknown>): SettingsResult {
	const rawHost = typeof config.host === "string" ? config.host.trim() : "";
	// People paste "http://192.168.1.50:8765/"; keep only the host name or address.
	const host = rawHost.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
	if (!host) return { ok: false, error: 'Set "host" to the address of the PC that runs DisplayDeck, for example 192.168.1.50.' };
	if (/[\s@?#]/.test(host)) return { ok: false, error: `"${rawHost}" is not a valid host name or address.` };

	const port = config.port === undefined || config.port === "" ? 8765 : Number(config.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `"port" must be a number from 1 to 65535 (DisplayDeck uses 8765).` };

	const accessKey = typeof config.accessKey === "string" ? config.accessKey.trim() : "";
	if (accessKey && !/^[0-9a-f]+$/i.test(accessKey)) {
		return { ok: false, error: '"accessKey" must be the hexadecimal key from the end of DisplayDeck\'s phone link (the part after ?key=).' };
	}

	const poll = config.pollSeconds === undefined || config.pollSeconds === "" ? 5 : Number(config.pollSeconds);
	const pollSeconds = Number.isFinite(poll) ? Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(poll))) : 5;

	const profiles = Array.isArray(config.profiles)
		? config.profiles.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
		: [];

	return {
		ok: true,
		settings: {
			host,
			port,
			accessKey,
			pollSeconds,
			profiles,
			namePrefix: typeof config.namePrefix === "string" ? config.namePrefix : "",
			undoSwitch: config.undoSwitch === true,
		},
	};
}
