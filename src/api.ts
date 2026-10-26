// A small client for DisplayDeck's HTTP API. It uses only the global fetch, so it needs no dependencies.

export type Status = {
	profiles: string[];
	current: string | null;
	lastApplied: string | null;
	liveAvailable?: boolean;
};

export type ErrorKind =
	/** The PC could not be reached (switched off, wrong address, firewall, DisplayDeck not running). */
	| "offline"
	/** DisplayDeck answered but did not accept the access key. */
	| "auth"
	/** DisplayDeck answered with an error. */
	| "http";

export class DisplayDeckError extends Error {
	readonly kind: ErrorKind;

	constructor(message: string, kind: ErrorKind) {
		super(message);
		this.name = "DisplayDeckError";
		this.kind = kind;
	}
}

export type FetchLike = (
	input: string,
	init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ClientOptions = {
	host: string;
	port: number;
	/** The phone access key. Leave empty when Homebridge runs on the same PC as DisplayDeck. */
	accessKey?: string;
	fetchImpl?: FetchLike;
};

const STATUS_TIMEOUT_MS = 8000;
// Applying a layout, and then an audio device, can take well over ten seconds.
const ACTION_TIMEOUT_MS = 90000;

export class DisplayDeckClient {
	private readonly base: string;
	private readonly headers: Record<string, string>;
	private readonly fetchImpl: FetchLike;

	constructor(options: ClientOptions) {
		const host = options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host; // IPv6
		this.base = `http://${host}:${options.port}`;
		const key = options.accessKey ?? "";
		if (key && !/^[0-9a-f]+$/i.test(key)) throw new Error("The access key must be hexadecimal.");
		// DisplayDeck accepts the key as a cookie, which avoids its redirect-and-set-cookie dance for browsers.
		this.headers = key ? { Cookie: `dd_key=${key}` } : {};
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	}

	async status(): Promise<Status> {
		const body = await this.request("/api/current", "GET", STATUS_TIMEOUT_MS);
		const s = body as Partial<Status> | null;
		if (!s || !Array.isArray(s.profiles)) throw new DisplayDeckError("DisplayDeck sent an answer this plugin does not understand.", "http");
		return {
			profiles: s.profiles.filter((p): p is string => typeof p === "string"),
			current: typeof s.current === "string" ? s.current : null,
			lastApplied: typeof s.lastApplied === "string" ? s.lastApplied : null,
			liveAvailable: s.liveAvailable,
		};
	}

	/** Applies a profile: its display layout, then its audio settings. Resolves when DisplayDeck has finished. */
	async apply(profile: string): Promise<void> {
		await this.request(`/api/apply/${encodeURIComponent(profile)}`, "POST", ACTION_TIMEOUT_MS);
	}

	/** Goes back to the display layout from before the last change. */
	async undo(): Promise<void> {
		await this.request("/api/undo-layout", "POST", ACTION_TIMEOUT_MS);
	}

	private async request(path: string, method: "GET" | "POST", timeoutMs: number): Promise<unknown> {
		let response;
		try {
			response = await this.fetchImpl(this.base + path, { method, headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
		} catch {
			throw new DisplayDeckError(`Could not reach DisplayDeck at ${this.base}. Is the PC on, and is "Allow other devices" turned on?`, "offline");
		}
		if (response.status === 403) {
			throw new DisplayDeckError("DisplayDeck refused the access key. Copy it again from the phone link on its Phone page.", "auth");
		}
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			/* not JSON */
		}
		if (!response.ok) {
			const message = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${response.status}`;
			throw new DisplayDeckError(message, "http");
		}
		return body;
	}
}
