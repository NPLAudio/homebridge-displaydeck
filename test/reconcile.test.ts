import assert from "node:assert/strict";
import test from "node:test";

import { activeProfile, homekitName, reconcile, selectProfiles } from "../src/reconcile.ts";

const sorted = (list: string[]) => [...list].sort();

test("a profile with no switch is added at once", () => {
	const plan = reconcile(["Desk"], ["Desk", "Den TV"]);
	assert.deepEqual(plan.add, ["Den TV"]);
	assert.deepEqual(plan.keep, ["Desk"]);
	assert.deepEqual(plan.remove, []);
});

test("a switch whose profile is gone is not removed on the first sighting", () => {
	const plan = reconcile(["Desk", "Old"], ["Desk"]);
	assert.deepEqual(plan.remove, []);
	assert.deepEqual([...plan.missing], [["Old", 1]]);
});

test("it is removed once it has been missing on two polls in a row", () => {
	const first = reconcile(["Desk", "Old"], ["Desk"]);
	const second = reconcile(["Desk", "Old"], ["Desk"], first.missing);
	assert.deepEqual(second.remove, ["Old"]);
	assert.equal(second.missing.size, 0);
});

test("a profile that comes back resets its count", () => {
	const first = reconcile(["Desk", "Old"], ["Desk"]);
	const back = reconcile(["Desk", "Old"], ["Desk", "Old"], first.missing);
	assert.deepEqual(back.remove, []);
	assert.equal(back.missing.size, 0);
	const again = reconcile(["Desk", "Old"], ["Desk"], back.missing);
	assert.deepEqual(again.remove, [], "the count started over");
});

test("additions and removals can happen together, in any order", () => {
	const missing = new Map([["B", 1]]);
	const plan = reconcile(["C", "B", "A"], ["D", "A"], missing);
	assert.deepEqual(sorted(plan.add), ["D"]);
	assert.deepEqual(sorted(plan.remove), ["B"]);
	assert.deepEqual(sorted(plan.keep), ["A"]);
	assert.deepEqual([...plan.missing], [["C", 1]]);
});

test("nothing changes when the lists match", () => {
	const plan = reconcile(["A", "B"], ["B", "A"]);
	assert.deepEqual(plan.add, []);
	assert.deepEqual(plan.remove, []);
	assert.deepEqual(sorted(plan.keep), ["A", "B"]);
});

test("an empty live list never removes anything on its first sighting", () => {
	const plan = reconcile(["A", "B", "C"], []);
	assert.deepEqual(plan.remove, []);
	assert.equal(plan.missing.size, 3);
});

test("the number of polls before removal can be changed", () => {
	assert.deepEqual(reconcile(["A"], [], new Map(), 1).remove, ["A"]);
	assert.deepEqual(reconcile(["A"], [], new Map([["A", 2]]), 4).remove, []);
	assert.deepEqual(reconcile(["A"], [], new Map([["A", 3]]), 4).remove, ["A"]);
});

test("selectProfiles keeps everything when no list is given, and only the listed ones otherwise", () => {
	assert.deepEqual(selectProfiles(["A", "B", "C"], []), ["A", "B", "C"]);
	assert.deepEqual(selectProfiles(["A", "B", "C"], ["C", "A", "Missing"]), ["A", "C"]);
});

test("the active profile is the live match, else the last one applied, if it still exists", () => {
	const names = ["Desk", "Den TV"];
	assert.equal(activeProfile({ current: "Den TV", lastApplied: "Desk" }, names), "Den TV");
	assert.equal(activeProfile({ current: null, lastApplied: "Desk" }, names), "Desk");
	assert.equal(activeProfile({ current: null, lastApplied: "Gone" }, names), null);
	assert.equal(activeProfile({ current: "Gone", lastApplied: null }, names), null);
	assert.equal(activeProfile({ current: null, lastApplied: null }, names), null);
});

test("names are trimmed to what HomeKit accepts", () => {
	assert.equal(homekitName("Desk"), "Desk");
	assert.equal(homekitName("Living Room"), "Living Room");
	assert.equal(homekitName("  - Den TV! "), "Den TV");
	assert.equal(homekitName("***"), "Display profile");
	assert.equal(homekitName("Desk *30"), "Desk *30");
	assert.equal(homekitName("Caf\u00e9 4K"), "Caf\u00e9 4K");
});
