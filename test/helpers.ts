// Test helpers: a stand-in for DisplayDeck's HTTP API, and a Homebridge API built from the real HAP library, so switches
// behave exactly as they would for HomeKit (handlers, characteristics, status errors).
import http from "node:http";
import type { AddressInfo } from "node:net";

import * as hap from "@homebridge/hap-nodejs";
import type { API, Logging, PlatformAccessory, PlatformConfig } from "homebridge";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await sleep(10);
	}
}

// ---------- the DisplayDeck stand-in ----------

export type StubState = {
	profiles: string[];
	current: string | null;
	lastApplied: string | null;
	/** The access key the server wants; null means open (as on the PC itself). */
	key: string | null;
	/** Milliseconds an apply takes. */
	applyMs: number;
	failApply: boolean;
};

export async function startStub(initial: Partial<StubState> = {}) {
	const state: StubState = { profiles: ["Desk", "Living Room", "Den TV"], current: "Desk", lastApplied: null, key: null, applyMs: 0, failApply: false, ...initial };
	const requests: Array<{ method: string; path: string; cookie: string | undefined }> = [];
	const applied: string[] = [];
	let undone = 0;

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		const path = url.pathname;
		const cookie = req.headers.cookie;
		requests.push({ method: req.method ?? "GET", path, cookie });
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (state.key !== null && !(cookie ?? "").split(/;\s*/).includes(`dd_key=${state.key}`)) {
			res.writeHead(403, { "Content-Type": "text/html" });
			res.end("<p>Access key required.</p>");
			return;
		}
		if (req.method === "GET" && path === "/api/current") {
			return json(200, { profiles: state.profiles, current: state.current, lastApplied: state.lastApplied, liveAvailable: true });
		}
		const apply = /^\/api\/apply\/(.+)$/.exec(path);
		if (req.method === "POST" && apply) {
			const name = decodeURIComponent(apply[1] ?? "");
			if (!state.profiles.includes(name)) return json(404, { error: `No such profile: ${name}` });
			setTimeout(() => {
				if (state.failApply) return json(500, { error: "Windows rejected the layout" });
				state.current = name;
				state.lastApplied = name;
				applied.push(name);
				json(200, { ok: true, audio: "none", warnings: [] });
			}, state.applyMs);
			return;
		}
		if (req.method === "POST" && path === "/api/undo-layout") {
			undone++;
			return json(200, { ok: true });
		}
		json(404, { error: "Not found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		state,
		port,
		requests,
		applied,
		get undone() {
			return undone;
		},
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

// ---------- a Homebridge API made from the real HAP library ----------

class TestPlatformAccessory extends hap.Accessory {
	context: Record<string, unknown> = {};
}

export function makeApi() {
	const handlers = new Map<string, Array<() => void>>();
	const registered: PlatformAccessory[] = [];
	const unregistered: PlatformAccessory[] = [];
	const api = {
		hap: {
			uuid: hap.uuid,
			HapStatusError: hap.HapStatusError,
			// A const enum in the type definitions, but a real object at runtime (Homebridge hands it to plugins).
			HAPStatus: (hap as unknown as { HAPStatus: object }).HAPStatus,
			Service: hap.Service,
			Characteristic: hap.Characteristic,
		},
		platformAccessory: TestPlatformAccessory,
		registerPlatform: () => {},
		registerPlatformAccessories: (_plugin: string, _platform: string, list: PlatformAccessory[]) => void registered.push(...list),
		unregisterPlatformAccessories: (_plugin: string, _platform: string, list: PlatformAccessory[]) => void unregistered.push(...list),
		on: (event: string, handler: () => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	return {
		api: api as unknown as API,
		registered,
		unregistered,
		emit: (event: string) => (handlers.get(event) ?? []).forEach((h) => h()),
		newAccessory: (name: string, uuid: string, context: Record<string, unknown>) => {
			const accessory = new TestPlatformAccessory(name, uuid);
			accessory.context = context;
			return accessory as unknown as PlatformAccessory;
		},
		uuidFor: (key: string) => hap.uuid.generate(key),
	};
}

export function makeLog() {
	const lines: string[] = [];
	const push = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
	const log = Object.assign(push("info"), { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug"), success: push("info"), log: push("info"), prefix: "" });
	return { log: log as unknown as Logging, lines };
}

export function config(port: number, extra: Record<string, unknown> = {}): PlatformConfig {
	return { platform: "DisplayDeck", name: "DisplayDeck", host: "127.0.0.1", port, pollSeconds: 2, ...extra } as PlatformConfig;
}

/** What HomeKit would read from a switch right now (or the error it would get). */
export async function readOn(accessory: PlatformAccessory): Promise<{ value?: unknown; error?: unknown }> {
	const characteristic = accessory.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On);
	try {
		return { value: await characteristic.handleGetRequest() };
	} catch (error) {
		return { error };
	}
}

/** What HomeKit does when the user flips a switch. */
export async function setOn(accessory: PlatformAccessory, value: boolean): Promise<void> {
	await accessory.getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On).handleSetRequest(value);
}

// HAP rejects a failed read with the numeric status code (-70402 is "communication failure"), which the Home app shows as "No Response".
export const isNoResponse = (error: unknown): boolean => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
