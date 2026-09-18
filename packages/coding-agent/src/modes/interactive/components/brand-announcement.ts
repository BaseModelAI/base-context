import { Container, Spacer, Text } from "@ponythewhite/base-context-tui";
import { SYNERISE_LOGO } from "../../../themes/synerise-logo.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export class BrandAnnouncementComponent extends Container {
	constructor() {
		super();
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.fg("accent", SYNERISE_LOGO), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}
