/** Product-owned identity. Provider and model wire identifiers are deliberately separate. */
export interface ProductIdentity {
	readonly name: string;
	readonly command: string;
	readonly packageName: string;
	readonly configDirectory: string;
	readonly environmentPrefix: string;
	readonly daemonService: string;
	readonly runtimeDistribution: string;
	readonly repository: string;
}

export const PRODUCT = Object.freeze({
	name: "Base Context",
	command: "base-context",
	packageName: "@ponythewhite/base-context",
	configDirectory: ".base-context",
	environmentPrefix: "BASE_CONTEXT",
	daemonService: "base-context.daemon",
	runtimeDistribution: "base-context-runtime",
	repository: "https://github.com/BaseModelAI/base-context",
} as const satisfies ProductIdentity);

export const PRODUCT_ENV = Object.freeze({
	home: "BASE_CONTEXT_HOME",
	sessions: "BASE_CONTEXT_SESSION_DIR",
	packageDirectory: "BASE_CONTEXT_PACKAGE_DIR",
	shareViewer: "BASE_CONTEXT_SHARE_VIEWER_URL",
	interactiveSelfUpdate: "BASE_CONTEXT_INTERACTIVE_SELF_UPDATE",
	kernelPython: "BASE_CONTEXT_KERNEL_PYTHON",
	kernelVenv: "BASE_CONTEXT_KERNEL_VENV",
	installUv: "BASE_CONTEXT_INSTALL_UV",
});
