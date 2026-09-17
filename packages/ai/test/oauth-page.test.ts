import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth/oauth-page.js";

describe("OAuth result pages", () => {
	it("shows Base Context branding after successful authentication", () => {
		const html = oauthSuccessHtml("Return to the application.");
		expect(html).toContain("Synerise base-context authentication successful");
		expect(html).toContain("Return to the application.");
		expect(html).not.toContain("Prime Intellect");
	});

	it("escapes failed authentication messages and details", () => {
		const html = oauthErrorHtml("<failure>", 'details & "quoted"');
		expect(html).toContain("Synerise base-context authentication failed");
		expect(html).toContain("&lt;failure&gt;");
		expect(html).toContain("details &amp; &quot;quoted&quot;");
		expect(html).not.toContain("<failure>");
	});
});
