import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import type { DisplayDeckPlatform } from "./platform.ts";

/** One HomeKit switch for one DisplayDeck profile. On means "this is the active profile". */
export class ProfileSwitch {
	readonly service: Service;
	/** The last state reported by DisplayDeck (or chosen by the user while a change is in progress). */
	private on = false;

	private readonly platform: DisplayDeckPlatform;
	readonly accessory: PlatformAccessory;
	readonly profile: string;

	constructor(platform: DisplayDeckPlatform, accessory: PlatformAccessory, profile: string, displayName: string) {
		this.platform = platform;
		this.accessory = accessory;
		this.profile = profile;
		const { Service, Characteristic } = platform;

		const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
		info.setCharacteristic(Characteristic.Manufacturer, "DisplayDeck").setCharacteristic(Characteristic.Model, "Display profile").setCharacteristic(Characteristic.SerialNumber, profile.slice(0, 64) || "profile");

		this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, displayName);
		this.service.setCharacteristic(Characteristic.Name, displayName);
		this.service.getCharacteristic(Characteristic.On).onGet(() => this.read()).onSet((value) => this.write(value));
	}

	/** HomeKit asks for the state: answer from the last poll straight away, or say "No Response". */
	private read(): boolean {
		if (!this.platform.hasState || this.platform.unavailable) throw this.platform.noResponse();
		return this.on;
	}

	private write(value: CharacteristicValue): void {
		if (value === true) {
			this.on = true;
			// Applying takes seconds; do not keep HomeKit waiting. The platform shows the choice at once and settles on the
			// real state when DisplayDeck has finished.
			void this.platform.select(this.profile);
			return;
		}
		// A layout cannot be "un-applied". Turning the active profile off puts the switch back on.
		if (this.platform.activeName === this.profile) setTimeout(() => this.show(true), 250);
		else this.on = false;
	}

	/** Pushes a state to HomeKit. */
	show(on: boolean): void {
		this.on = on;
		this.service.updateCharacteristic(this.platform.Characteristic.On, on);
	}

	/** Tells HomeKit the PC cannot be reached ("No Response"). */
	showUnavailable(): void {
		this.service.updateCharacteristic(this.platform.Characteristic.On, this.platform.noResponse());
	}
}

/** An optional momentary switch that goes back to the previous display layout. */
export class UndoSwitch {
	readonly service: Service;

	private readonly platform: DisplayDeckPlatform;
	readonly accessory: PlatformAccessory;

	constructor(platform: DisplayDeckPlatform, accessory: PlatformAccessory, displayName: string) {
		this.platform = platform;
		this.accessory = accessory;
		const { Service, Characteristic } = platform;
		const info = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
		info.setCharacteristic(Characteristic.Manufacturer, "DisplayDeck").setCharacteristic(Characteristic.Model, "Undo layout").setCharacteristic(Characteristic.SerialNumber, "undo");

		this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, displayName);
		this.service.setCharacteristic(Characteristic.Name, displayName);
		this.service.getCharacteristic(Characteristic.On).onGet(() => this.read()).onSet((value) => this.write(value));
	}

	private read(): boolean {
		if (this.platform.unavailable) throw this.platform.noResponse();
		return false;
	}

	private write(value: CharacteristicValue): void {
		if (value !== true) return;
		void this.platform.undo().finally(() => {
			// A button, not a switch: it springs back.
			setTimeout(() => this.service.updateCharacteristic(this.platform.Characteristic.On, false), 800);
		});
	}

	showUnavailable(): void {
		this.service.updateCharacteristic(this.platform.Characteristic.On, this.platform.noResponse());
	}

	show(): void {
		this.service.updateCharacteristic(this.platform.Characteristic.On, false);
	}
}
