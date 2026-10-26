import type { API, Characteristic, DynamicPlatformPlugin, HapStatusError, Logging, PlatformAccessory, PlatformConfig, Service } from "homebridge";

import { ProfileSwitch, UndoSwitch } from "./accessory.ts";
import { DisplayDeckClient, DisplayDeckError, type FetchLike } from "./api.ts";
import { activeProfile, homekitName, reconcile, selectProfiles } from "./reconcile.ts";
import { PLATFORM_NAME, PLUGIN_NAME, readSettings, type Settings } from "./settings.ts";

const UNDO_KEY = "displaydeck:undo";

/**
 * Keeps one HomeKit switch per DisplayDeck profile. Every few seconds it asks DisplayDeck for its profiles, adds switches for
 * new ones, removes switches for deleted ones, and shows which profile is active.
 */
export class DisplayDeckPlatform implements DynamicPlatformPlugin {
	readonly Service: typeof Service;
	readonly Characteristic: typeof Characteristic;

	/** Every accessory of this platform: the ones Homebridge restored from its cache plus the ones created since. */
	readonly accessories = new Map<string, PlatformAccessory>();

	private settings: Settings | null;
	private client: DisplayDeckClient | null = null;
	private readonly switches = new Map<string, ProfileSwitch>();
	private undoSwitch: UndoSwitch | null = null;
	private missing = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private refreshing: Promise<void> | null = null;
	private applying: string | null = null;
	private applyChain: Promise<void> = Promise.resolve();
	private status: { names: string[]; current: string | null; lastApplied: string | null } | null = null;
	private failure: DisplayDeckError | null = null;

	readonly log: Logging;
	readonly config: PlatformConfig;
	readonly api: API;

	constructor(log: Logging, config: PlatformConfig, api: API, fetchImpl?: FetchLike) {
		this.log = log;
		this.config = config;
		this.api = api;
		this.Service = api.hap.Service;
		this.Characteristic = api.hap.Characteristic;

		const result = readSettings(config as Record<string, unknown>);
		if (!result.ok) {
			this.settings = null;
			log.error(`DisplayDeck is not set up: ${result.error}`);
			return;
		}
		this.settings = result.settings;
		try {
			this.client = new DisplayDeckClient({ host: result.settings.host, port: result.settings.port, accessKey: result.settings.accessKey, fetchImpl });
		} catch (error) {
			this.settings = null;
			log.error(`DisplayDeck is not set up: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		// Cached accessories are only restored before this event, and discovery must wait for them.
		api.on("didFinishLaunching", () => void this.start());
		api.on("shutdown", () => this.stop());
	}

	/** Homebridge hands back the accessories it remembered from the last run. */
	configureAccessory(accessory: PlatformAccessory): void {
		this.accessories.set(accessory.UUID, accessory);
	}

	// ---- state the accessories read ----

	/** True once DisplayDeck has answered at least once, so there is a state to show. */
	get hasState(): boolean {
		return this.status !== null;
	}

	/** True when the last poll could not reach DisplayDeck. */
	get unavailable(): boolean {
		return this.failure !== null;
	}

	/** The profile whose switch should read On (a change in progress counts). */
	get activeName(): string | null {
		return this.applying ?? (this.status ? activeProfile({ current: this.status.current, lastApplied: this.status.lastApplied }, this.status.names) : null);
	}

	noResponse(): HapStatusError {
		return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
	}

	// ---- lifecycle ----

	/** Attaches the cached accessories, does the first poll, and keeps polling. */
	async start(poll = true): Promise<void> {
		if (!this.settings) return;
		for (const accessory of this.accessories.values()) {
			if (accessory.context.undo === true) this.attachUndo(accessory);
			else if (typeof accessory.context.profile === "string") this.attachProfile(accessory, accessory.context.profile);
		}
		await this.refresh();
		if (poll && !this.stopped) this.schedule();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private schedule(): void {
		if (this.stopped || !this.settings) return;
		this.timer = setTimeout(() => {
			void this.refresh().finally(() => this.schedule());
		}, this.settings.pollSeconds * 1000);
		this.timer.unref?.();
	}

	/** Asks DisplayDeck for its profiles and brings HomeKit in line with them. */
	refresh(): Promise<void> {
		if (!this.refreshing) {
			this.refreshing = this.doRefresh().finally(() => {
				this.refreshing = null;
			});
		}
		return this.refreshing;
	}

	private async doRefresh(): Promise<void> {
		if (!this.client || !this.settings) return;
		let fetched;
		try {
			fetched = await this.client.status();
		} catch (error) {
			this.fail(error);
			return;
		}
		if (this.stopped) return;
		this.recover();

		const names = selectProfiles(fetched.profiles, this.settings.profiles);
		this.status = { names, current: fetched.current, lastApplied: fetched.lastApplied };

		// Only a poll that succeeded gets to add or remove anything: an unreachable PC says nothing about the profiles.
		const existing = [...this.switches.keys()];
		const plan = reconcile(existing, names, this.missing);
		this.missing = plan.missing;
		for (const name of plan.add) this.addProfile(name);
		for (const name of plan.remove) this.removeProfile(name);
		this.syncUndo();

		const active = this.activeName;
		for (const [name, sw] of this.switches) sw.show(name === active);
		this.undoSwitch?.show();
	}

	// ---- profiles <-> accessories ----

	/** The name HomeKit shows. HomeKit wants names that start and end with a letter or number, so odd edges are trimmed. */
	private displayName(profile: string): string {
		return homekitName(`${this.settings?.namePrefix ?? ""}${profile}`);
	}

	private attachProfile(accessory: PlatformAccessory, profile: string): void {
		if (this.switches.has(profile)) return;
		this.switches.set(profile, new ProfileSwitch(this, accessory, profile, this.displayName(profile)));
	}

	private addProfile(profile: string): void {
		const uuid = this.api.hap.uuid.generate(`displaydeck:profile:${profile}`);
		const cached = this.accessories.get(uuid);
		if (cached) {
			this.attachProfile(cached, profile);
			return;
		}
		const accessory = new this.api.platformAccessory(this.displayName(profile), uuid);
		accessory.context.profile = profile;
		this.accessories.set(uuid, accessory);
		this.attachProfile(accessory, profile);
		this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		this.log.info(`Added a switch for the profile "${profile}".`);
	}

	private removeProfile(profile: string): void {
		const uuid = this.api.hap.uuid.generate(`displaydeck:profile:${profile}`);
		const accessory = this.accessories.get(uuid);
		this.switches.delete(profile);
		this.missing.delete(profile);
		if (!accessory) return;
		this.accessories.delete(uuid);
		this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		this.log.info(`Removed the switch for the profile "${profile}" (it no longer exists in DisplayDeck).`);
	}

	// ---- the optional undo button ----

	private attachUndo(accessory: PlatformAccessory): void {
		if (this.undoSwitch) return;
		this.undoSwitch = new UndoSwitch(this, accessory, "Undo layout");
	}

	private syncUndo(): void {
		const uuid = this.api.hap.uuid.generate(UNDO_KEY);
		if (this.settings?.undoSwitch) {
			if (this.undoSwitch) return;
			const cached = this.accessories.get(uuid);
			if (cached) {
				this.attachUndo(cached);
				return;
			}
			const accessory = new this.api.platformAccessory("Undo layout", uuid);
			accessory.context.undo = true;
			this.accessories.set(uuid, accessory);
			this.attachUndo(accessory);
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
			this.log.info('Added the "Undo layout" button.');
			return;
		}
		const cached = this.accessories.get(uuid);
		if (cached) {
			this.accessories.delete(uuid);
			this.undoSwitch = null;
			this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
			this.log.info('Removed the "Undo layout" button (it is turned off in the settings).');
		}
	}

	// ---- actions ----

	/** A profile switch was turned on: show the choice at once, apply it, then settle on what DisplayDeck says. */
	select(profile: string): Promise<void> {
		if (!this.client) return Promise.resolve();
		this.applying = profile;
		for (const [name, sw] of this.switches) sw.show(name === profile);

		// Changes happen one at a time, in the order they were asked for.
		this.applyChain = this.applyChain.then(async () => {
			try {
				await this.client?.apply(profile);
				this.log.info(`Applied the profile "${profile}".`);
			} catch (error) {
				this.log.error(`Could not apply "${profile}": ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		const mine = this.applyChain;
		return mine.then(async () => {
			if (this.applying === profile) this.applying = null;
			await this.refresh();
		});
	}

	async undo(): Promise<void> {
		if (!this.client) return;
		try {
			await this.client.undo();
			this.log.info("Went back to the previous display layout.");
		} catch (error) {
			this.log.error(`Could not undo the layout: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.refresh();
	}

	// ---- connection state ----

	private fail(error: unknown): void {
		const failure = error instanceof DisplayDeckError ? error : new DisplayDeckError(error instanceof Error ? error.message : String(error), "offline");
		const changed = !this.failure || this.failure.kind !== failure.kind;
		this.failure = failure;
		if (changed) this.log.warn(failure.message);
		for (const sw of this.switches.values()) sw.showUnavailable();
		this.undoSwitch?.showUnavailable();
	}

	private recover(): void {
		if (!this.failure) return;
		this.failure = null;
		this.log.info("DisplayDeck is reachable again.");
	}
}
