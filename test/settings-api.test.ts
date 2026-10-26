import assert from "node:assert/strict";
import test from "node:test";

import { DisplayDeckClient, DisplayDeckError, type FetchLike } from "../src/api.ts";
import { readSettings } from "../src/settings.ts";
import { startStub } from "./helpers.ts";

// ---------- settings ----------

test("a host is enough; everything else has a sensible default", () => {
	const r = readSettings({ host: "192.168.1.50" });
	assert.ok(r.ok);
	assert.deepEqual(r.settings, { host: "192.168.1.50", port: 8765, accessKey: "", pollSeconds: 5, profiles: [], namePrefix: "", undoSwitch: false });
});

test("a missing host is explained", () => {
	const r = readSettings({});
	assert.ok(!r.ok);
	assert.match(r.error, /host/);
});

test("a pasted link is reduced to its host", () => {
	for (const pasted of ["http://192.168.1.50:8765/", "https://pc.local/", "192.168.1.50:8765", "  pc.local  "]) {
		const r = readSettings({ host: pasted });
		assert.ok(r.ok, pasted);
		assert.ok(["192.168.1.50", "pc.local"].includes(r.settings.host), pasted + " -> " + r.settings.host);
	}
});

test("bad ports, keys and hosts are refused with a reason", () => {
	for (const port of [0, 70000, "abc", 1.5]) assert.ok(!readSettings({ host: "pc", port }).ok, String(port));
	assert.ok(!readSettings({ host: "pc", accessKey: "not hex!" }).ok);
	assert.ok(!readSettings({ host: "a b" }).ok);
	assert.ok(!readSettings({ host: "user@pc" }).ok);
});

test("the poll interval is kept within limits", () => {
	const poll = (v: unknown) => {
		const r = readSettings({ host: "pc", pollSeconds: v });
		assert.ok(r.ok);
		return r.settings.pollSeconds;
	};
	assert.equal(poll(0), 2);
	assert.equal(poll(1), 2);
	assert.equal(poll(10), 10);
	assert.equal(poll(99999), 300);
	assert.equal(poll("abc"), 5);
});

test("the profile list, prefix and undo switch are read", () => {
	const r = readSettings({ host: "pc", profiles: ["Desk", " ", 3, "Den TV"], namePrefix: "Display: ", undoSwitch: true });
	assert.ok(r.ok);
	assert.deepEqual(r.settings.profiles, ["Desk", "Den TV"]);
	assert.equal(r.settings.namePrefix, "Display: ");
	assert.equal(r.settings.undoSwitch, true);
});

// ---------- the client ----------

test("status reads the profile list, and the access key goes in a cookie", async () => {
	const stub = await startStub({ key: "abc123def456" });
	try {
		const client = new DisplayDeckClient({ host: "127.0.0.1", port: stub.port, accessKey: "abc123def456" });
		const status = await client.status();
		assert.deepEqual(status.profiles, ["Desk", "Living Room", "Den TV"]);
		assert.equal(status.current, "Desk");
		assert.equal(stub.requests[0]?.cookie, "dd_key=abc123def456");
	} finally {
		await stub.stop();
	}
});

test("no key means no cookie (Homebridge on the same PC)", async () => {
	const stub = await startStub();
	try {
		await new DisplayDeckClient({ host: "127.0.0.1", port: stub.port }).status();
		assert.equal(stub.requests[0]?.cookie, undefined);
	} finally {
		await stub.stop();
	}
});

test("a wrong key is reported as an access problem", async () => {
	const stub = await startStub({ key: "abc123def456" });
	try {
		const client = new DisplayDeckClient({ host: "127.0.0.1", port: stub.port, accessKey: "ffff" });
		await assert.rejects(client.status(), (e: unknown) => e instanceof DisplayDeckError && e.kind === "auth" && /access key/.test(e.message));
	} finally {
		await stub.stop();
	}
});

test("an unreachable PC is reported as offline", async () => {
	const stub = await startStub();
	const port = stub.port;
	await stub.stop();
	await assert.rejects(new DisplayDeckClient({ host: "127.0.0.1", port }).status(), (e: unknown) => e instanceof DisplayDeckError && e.kind === "offline");
});

test("apply encodes the profile name, and an unknown profile gives DisplayDeck's message", async () => {
	const stub = await startStub({ profiles: ["Living Room", "A/B & C?"] });
	try {
		const client = new DisplayDeckClient({ host: "127.0.0.1", port: stub.port });
		await client.apply("Living Room");
		await client.apply("A/B & C?");
		assert.deepEqual(stub.applied, ["Living Room", "A/B & C?"]);
		assert.equal(stub.requests[0]?.path, "/api/apply/Living%20Room");
		await assert.rejects(client.apply("Nope"), (e: unknown) => e instanceof DisplayDeckError && e.kind === "http" && /No such profile/.test(e.message));
	} finally {
		await stub.stop();
	}
});

test("undo posts to the undo endpoint", async () => {
	const stub = await startStub();
	try {
		await new DisplayDeckClient({ host: "127.0.0.1", port: stub.port }).undo();
		assert.equal(stub.undone, 1);
	} finally {
		await stub.stop();
	}
});

test("an answer that is not a status is refused, and bad keys are rejected up front", async () => {
	const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ hello: "world" }) });
	await assert.rejects(new DisplayDeckClient({ host: "pc", port: 1, fetchImpl }).status(), /does not understand/);
	assert.throws(() => new DisplayDeckClient({ host: "pc", port: 1, accessKey: "xx;yy" }), /hexadecimal/);
});

test("an IPv6 address is bracketed", async () => {
	let seen = "";
	const fetchImpl: FetchLike = async (input) => {
		seen = input;
		return { ok: true, status: 200, json: async () => ({ profiles: [], current: null, lastApplied: null }) };
	};
	await new DisplayDeckClient({ host: "fe80::1", port: 8765, fetchImpl }).status();
	assert.equal(seen, "http://[fe80::1]:8765/api/current");
});
