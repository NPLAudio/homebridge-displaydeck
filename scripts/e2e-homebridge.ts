// An end-to-end check against the real Homebridge: builds nothing, so run `npm run build` first.
//
//   npm run e2e
//
// It starts a stand-in DisplayDeck, runs Homebridge twice on the same storage folder with this plugin, and checks that
//   run 1: switches are created, and one added while Homebridge runs appears;
//   run 2: the remembered switches are reused (not created twice) and the ones whose profile is gone are removed.
// It needs a free TCP port (51898) and does not touch your own Homebridge or HomeKit: it uses a throwaway storage folder
// and a bridge bound to the loopback address.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sleep, startStub } from "../test/helpers.ts";

const root = path.resolve(import.meta.dirname, "..");
const storage = mkdtempSync(path.join(tmpdir(), "hb-e2e-"));
let failed = false;

const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed = true;
};

async function run(label: string, profiles: string[], script: (ctl: { stub: Awaited<ReturnType<typeof startStub>>; until: (re: RegExp, ms?: number) => Promise<boolean>; log: string[] }) => Promise<void>) {
	console.log(`\n${label}`);
	const stub = await startStub({ profiles, current: profiles[0] ?? null });
	writeFileSync(
		path.join(storage, "config.json"),
		JSON.stringify({
			bridge: { name: "DisplayDeck test", username: "0E:11:22:33:44:55", port: 51898, pin: "031-45-154", bind: ["127.0.0.1"] },
			platforms: [{ platform: "DisplayDeck", name: "DisplayDeck", host: "127.0.0.1", port: stub.port, pollSeconds: 2 }],
		}),
	);
	const log: string[] = [];
	const child = spawn(process.execPath, [path.join(root, "node_modules/homebridge/bin/homebridge"), "-U", storage, "-P", root, "-I"], { cwd: root });
	const take = (chunk: Buffer) => {
		for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
	};
	child.stdout.on("data", take);
	child.stderr.on("data", take);
	const until = async (re: RegExp, ms = 12000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (log.some((l) => re.test(l))) return true;
			await sleep(100);
		}
		return false;
	};
	try {
		check(await until(/Loaded plugin: homebridge-displaydeck/, 30000), "Homebridge loads the plugin");
		await script({ stub, until, log });
	} finally {
		child.kill();
		await sleep(500);
		await stub.stop();
	}
}

try {
	await run("Run 1: a fresh Homebridge", ["Desk", "Den TV", "Movie Night"], async ({ stub, until, log }) => {
		for (const name of ["Desk", "Den TV", "Movie Night"]) check(await until(new RegExp(`Added a switch for the profile "${name}"`)), `a switch is created for ${name}`);
		stub.state.profiles.push("Lounge");
		check(await until(/Added a switch for the profile "Lounge"/), "a profile added while it runs gets a switch");
		check(!log.some((l) => /Removed the switch/.test(l)), "nothing is removed");
	});

	await run("Run 2: restart, with two profiles deleted meanwhile", ["Desk", "Den TV"], async ({ until, log }) => {
		check(await until(/Removed the switch for the profile "Movie Night"/), "a remembered switch whose profile is gone is removed");
		check(await until(/Removed the switch for the profile "Lounge"/), "and so is the other");
		check(!log.some((l) => /Added a switch for the profile "(Desk|Den TV)"/.test(l)), "remembered switches are reused, not created again");
	});
} finally {
	rmSync(storage, { recursive: true, force: true });
}

console.log(failed ? "\nFAILED" : "\nAll good.");
process.exit(failed ? 1 : 0);
