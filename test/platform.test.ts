import assert from "node:assert/strict";
import test from "node:test";

import type { PlatformAccessory } from "homebridge";

import type { FetchLike } from "../src/api.ts";
import { DisplayDeckPlatform } from "../src/platform.ts";
import { config, isNoResponse, makeApi, makeLog, readOn, setOn, sleep, startStub, waitFor } from "./helpers.ts";

type Stub = Awaited<ReturnType<typeof startStub>>;

/** A platform wired to a stub DisplayDeck. `down` makes every request fail like an unreachable PC. */
async function setup(stubOptions: Parameters<typeof startStub>[0] = {}, extra: Record<string, unknown> = {}, cached: PlatformAccessory[] = []) {
	const stub = await startStub(stubOptions);
	const fake = makeApi();
	const { log, lines } = makeLog();
	const control = { down: false };
	const fetchImpl: FetchLike = (input, init) => (control.down ? Promise.reject(new Error("unreachable")) : fetch(input, init));
	const platform = new DisplayDeckPlatform(log, config(stub.port, extra), fake.api, fetchImpl);
	for (const accessory of cached) platform.configureAccessory(accessory);
	const byProfile = (name: string) => [...platform.accessories.values()].find((a) => a.context.profile === name);
	return {
		stub: stub as Stub,
		platform,
		control,
		lines,
		fake,
		byProfile,
		async finish() {
			platform.stop();
			await stub.stop();
		},
	};
}

const valueOf = async (accessory: PlatformAccessory | undefined) => (accessory ? (await readOn(accessory)).value : "missing");

// ---------- discovery ----------

test("the first poll creates one switch per profile, and the active one is on", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		assert.equal(t.fake.registered.length, 3);
		assert.deepEqual(t.fake.registered.map((a) => a.displayName).sort(), ["Den TV", "Desk", "Living Room"]);
		assert.equal(await valueOf(t.byProfile("Desk")), true);
		assert.equal(await valueOf(t.byProfile("Living Room")), false);
		assert.equal(await valueOf(t.byProfile("Den TV")), false);
		assert.equal(t.stub.requests[0]?.path, "/api/current");
	} finally {
		await t.finish();
	}
});

test("when the live layout matches no profile, the one applied last is shown", async () => {
	const t = await setup({ current: null, lastApplied: "Den TV" });
	try {
		await t.platform.start(false);
		assert.equal(await valueOf(t.byProfile("Den TV")), true);
		assert.equal(await valueOf(t.byProfile("Desk")), false);
	} finally {
		await t.finish();
	}
});

test("only the listed profiles get switches, and a name prefix is applied", async () => {
	const t = await setup({}, { profiles: ["Desk", "Den TV"], namePrefix: "Display: " });
	try {
		await t.platform.start(false);
		assert.deepEqual(t.fake.registered.map((a) => a.displayName).sort(), ["Display: Den TV", "Display: Desk"]);
		assert.equal(t.byProfile("Living Room"), undefined);
	} finally {
		await t.finish();
	}
});

// ---------- switching ----------

test("turning a switch on applies that profile; the others go off at once and the PC's answer settles it", async () => {
	const t = await setup({ applyMs: 200 });
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Living Room")!, true);
		// Not finished yet, but HomeKit already sees the choice.
		assert.equal(await valueOf(t.byProfile("Living Room")), true);
		assert.equal(await valueOf(t.byProfile("Desk")), false);
		assert.deepEqual(t.stub.applied, []);
		await waitFor(() => t.stub.applied.length === 1, 3000, "the apply");
		assert.deepEqual(t.stub.applied, ["Living Room"]);
		await waitFor(() => t.stub.requests.filter((r) => r.path === "/api/current").length >= 2, 3000, "the follow-up poll");
		await sleep(50);
		assert.equal(await valueOf(t.byProfile("Living Room")), true);
		assert.equal(await valueOf(t.byProfile("Desk")), false);
		assert.ok(t.lines.some((l) => l.includes('Applied the profile "Living Room"')));
	} finally {
		await t.finish();
	}
});

test("a poll that lands while a change is running does not flip the switches back", async () => {
	const t = await setup({ applyMs: 300 });
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Den TV")!, true);
		await t.platform.refresh(); // the PC still says Desk
		assert.equal(await valueOf(t.byProfile("Den TV")), true, "the choice stays");
		assert.equal(await valueOf(t.byProfile("Desk")), false);
		await waitFor(() => t.stub.applied.length === 1);
	} finally {
		await t.finish();
	}
});

test("two quick changes are applied one after the other, in order", async () => {
	const t = await setup({ applyMs: 100 });
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Living Room")!, true);
		await setOn(t.byProfile("Den TV")!, true);
		await waitFor(() => t.stub.applied.length === 2, 4000, "both applies");
		assert.deepEqual(t.stub.applied, ["Living Room", "Den TV"]);
		await waitFor(() => t.stub.state.current === "Den TV");
		await sleep(200);
		assert.equal(await valueOf(t.byProfile("Den TV")), true);
		assert.equal(await valueOf(t.byProfile("Living Room")), false);
	} finally {
		await t.finish();
	}
});

test("turning the active profile off puts it back on; turning another off does nothing", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Desk")!, false);
		await sleep(450);
		assert.equal(await valueOf(t.byProfile("Desk")), true, "snapped back");

		await setOn(t.byProfile("Den TV")!, false);
		await sleep(50);
		assert.equal(await valueOf(t.byProfile("Den TV")), false);
		assert.deepEqual(t.stub.applied, [], "nothing was applied");
	} finally {
		await t.finish();
	}
});

test("a failed apply is logged and the switches fall back to what the PC really shows", async () => {
	const t = await setup({ failApply: true });
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Den TV")!, true);
		await waitFor(() => t.lines.some((l) => l.startsWith("error:") && l.includes("Windows rejected the layout")), 3000, "the error");
		await sleep(150);
		assert.equal(await valueOf(t.byProfile("Desk")), true);
		assert.equal(await valueOf(t.byProfile("Den TV")), false);
	} finally {
		await t.finish();
	}
});

// ---------- keeping HomeKit in step with the profiles ----------

test("a profile added on the PC gets a switch on the next poll", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles.push("Movie Night");
		await t.platform.refresh();
		assert.equal(t.fake.registered.length, 4);
		assert.ok(t.byProfile("Movie Night"));
		assert.equal(await valueOf(t.byProfile("Movie Night")), false);
		assert.ok(t.lines.some((l) => l.includes('Added a switch for the profile "Movie Night"')));
	} finally {
		await t.finish();
	}
});

test("a profile deleted on the PC loses its switch after two polls, not one", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles = ["Desk", "Den TV"];
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 0, "not yet");
		await t.platform.refresh();
		assert.deepEqual(t.fake.unregistered.map((a) => a.displayName), ["Living Room"]);
		assert.equal(t.byProfile("Living Room"), undefined);
		assert.ok(t.lines.some((l) => l.includes('Removed the switch for the profile "Living Room"')));
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 1, "and only once");
	} finally {
		await t.finish();
	}
});

test("a profile that comes back before the second poll keeps its switch", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles = ["Desk", "Den TV"];
		await t.platform.refresh();
		t.stub.state.profiles = ["Desk", "Den TV", "Living Room"];
		await t.platform.refresh();
		t.stub.state.profiles = ["Desk", "Den TV"];
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 0, "the count started over");
	} finally {
		await t.finish();
	}
});

test("a renamed profile is one removal and one addition", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles = ["Desk", "Den TV", "Lounge"];
		await t.platform.refresh();
		await t.platform.refresh();
		assert.deepEqual(t.fake.registered.map((a) => a.displayName).slice(3), ["Lounge"]);
		assert.deepEqual(t.fake.unregistered.map((a) => a.displayName), ["Living Room"]);
	} finally {
		await t.finish();
	}
});

test("one empty answer removes nothing; a lasting one does", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles = [];
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 0);
		t.stub.state.profiles = ["Desk", "Living Room", "Den TV"];
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 0, "recovered");
		t.stub.state.profiles = [];
		await t.platform.refresh();
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 3);
	} finally {
		await t.finish();
	}
});

test("an unreachable PC never removes anything, and its switches say No Response", async () => {
	const t = await setup();
	try {
		await t.platform.start(false);
		t.stub.state.profiles = ["Desk"];
		t.control.down = true;
		for (let i = 0; i < 5; i++) await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 0);
		assert.ok(isNoResponse((await readOn(t.byProfile("Desk")!)).error), "No Response");
		assert.ok(isNoResponse((await readOn(t.byProfile("Den TV")!)).error));
		assert.equal(t.lines.filter((l) => l.startsWith("warn:")).length, 1, "one warning, not one per poll");
		// Back again: the state returns, and the deletion still needs two good polls.
		t.control.down = false;
		await t.platform.refresh();
		assert.equal(await valueOf(t.byProfile("Desk")), true);
		assert.equal(t.fake.unregistered.length, 0);
		await t.platform.refresh();
		assert.equal(t.fake.unregistered.length, 2);
		assert.ok(t.lines.some((l) => l.includes("reachable again")));
	} finally {
		await t.finish();
	}
});

test("a wrong access key says so once, shows No Response, and removes nothing", async () => {
	const t = await setup({ key: "aaaa1111bbbb2222" }, { accessKey: "ffff" });
	try {
		await t.platform.start(false);
		await t.platform.refresh();
		await t.platform.refresh();
		assert.equal(t.fake.registered.length, 0);
		assert.equal(t.fake.unregistered.length, 0);
		assert.equal(t.lines.filter((l) => l.includes("refused the access key")).length, 1);
	} finally {
		await t.finish();
	}
});

test("the right key works, and the cookie is sent on every request", async () => {
	const t = await setup({ key: "aaaa1111bbbb2222" }, { accessKey: "aaaa1111bbbb2222" });
	try {
		await t.platform.start(false);
		await setOn(t.byProfile("Den TV")!, true);
		await waitFor(() => t.stub.applied.length === 1);
		assert.ok(t.stub.requests.length >= 2);
		assert.ok(t.stub.requests.every((r) => r.cookie === "dd_key=aaaa1111bbbb2222"));
	} finally {
		await t.finish();
	}
});

// ---------- accessories remembered by Homebridge ----------

test("remembered switches are reused, ones whose profile is gone are removed after two polls", async () => {
	const fake = makeApi();
	const desk = fake.newAccessory("Desk", fake.uuidFor("displaydeck:profile:Desk"), { profile: "Desk" });
	const gone = fake.newAccessory("Gone", fake.uuidFor("displaydeck:profile:Gone"), { profile: "Gone" });
	const t = await setup({}, {}, [desk, gone]);
	try {
		await t.platform.start(false);
		assert.deepEqual(t.fake.registered.map((a) => a.displayName).sort(), ["Den TV", "Living Room"], "the remembered Desk is not registered again");
		assert.equal(t.byProfile("Desk"), desk, "the same object is reused");
		assert.equal(await valueOf(desk), true, "and it works");
		assert.equal(t.fake.unregistered.length, 0);
		await t.platform.refresh();
		assert.deepEqual(t.fake.unregistered.map((a) => a.displayName), ["Gone"]);
	} finally {
		await t.finish();
	}
});

test("remembered switches say No Response until the PC has answered once", async () => {
	const fake = makeApi();
	const desk = fake.newAccessory("Desk", fake.uuidFor("displaydeck:profile:Desk"), { profile: "Desk" });
	const t = await setup({}, {}, [desk]);
	try {
		t.control.down = true;
		await t.platform.start(false);
		assert.ok(isNoResponse((await readOn(desk)).error));
		assert.equal(t.fake.unregistered.length, 0);
		t.control.down = false;
		await t.platform.refresh();
		assert.equal(await valueOf(desk), true);
	} finally {
		await t.finish();
	}
});

// ---------- the optional undo button ----------

test("the undo button is added when asked for, goes back on press, and springs back", async () => {
	const t = await setup({}, { undoSwitch: true });
	try {
		await t.platform.start(false);
		const undo = [...t.platform.accessories.values()].find((a) => a.context.undo === true);
		assert.ok(undo);
		assert.equal(await valueOf(undo), false);
		await setOn(undo, true);
		await waitFor(() => t.stub.undone === 1, 3000, "the undo request");
		await sleep(1000);
		assert.equal(await valueOf(undo), false, "springs back");
	} finally {
		await t.finish();
	}
});

test("a remembered undo button is removed when it is turned off in the settings", async () => {
	const fake = makeApi();
	const undo = fake.newAccessory("Undo layout", fake.uuidFor("displaydeck:undo"), { undo: true });
	const t = await setup({}, { undoSwitch: false }, [undo]);
	try {
		await t.platform.start(false);
		assert.deepEqual(t.fake.unregistered.map((a) => a.displayName), ["Undo layout"]);
	} finally {
		await t.finish();
	}
});

// ---------- lifecycle ----------

test("it polls on its own, and stops when Homebridge shuts down", async () => {
	const t = await setup({}, { pollSeconds: 2 });
	try {
		await t.platform.start(true);
		const count = () => t.stub.requests.filter((r) => r.path === "/api/current").length;
		assert.equal(count(), 1);
		await waitFor(() => count() >= 2, 4000, "the next poll");
		t.fake.emit("shutdown");
		const after = count();
		await sleep(2300);
		assert.equal(count(), after, "no more polls after shutdown");
	} finally {
		await t.finish();
	}
});

test("Homebridge starting up kicks everything off after its accessories are restored", async () => {
	const t = await setup();
	try {
		t.fake.emit("didFinishLaunching");
		await waitFor(() => t.fake.registered.length === 3, 3000, "the switches");
	} finally {
		await t.finish();
	}
});

test("bad settings are explained and nothing is created", async () => {
	const fake = makeApi();
	const { log, lines } = makeLog();
	const platform = new DisplayDeckPlatform(log, { platform: "DisplayDeck", name: "DisplayDeck" } as never, fake.api);
	await platform.start(false);
	fake.emit("didFinishLaunching");
	assert.ok(lines.some((l) => l.startsWith("error:") && l.includes("host")));
	assert.equal(fake.registered.length, 0);
});
