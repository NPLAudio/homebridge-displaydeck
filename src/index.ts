import type { API } from "homebridge";

import { DisplayDeckPlatform } from "./platform.ts";
import { PLATFORM_NAME } from "./settings.ts";

/** Homebridge calls this once when it loads the plugin. */
export default (api: API): void => {
	api.registerPlatform(PLATFORM_NAME, DisplayDeckPlatform);
};
