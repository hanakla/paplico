export default defineContentScript({
	matches: ["<all_urls>"],
	runAt: "document_start",

	async main() {
		// Inject the WebGPU API interceptor into the page context (MAIN world)
		await injectScript("/injected.js", { keepInDom: false });

		// Bridge: page postMessage → browser.runtime.sendMessage
		window.addEventListener("message", (event) => {
			if (event.source !== window) return;
			if (event.data?.source !== "webgpu-devtools") return;

			browser.runtime.sendMessage(event.data);
		});

		// Bridge: browser.runtime messages → page postMessage (for panel commands)
		browser.runtime.onMessage.addListener((message) => {
			if (message.source === "webgpu-devtools") {
				window.postMessage(message, "*");
			}
		});
	},
});
