export default defineBackground(() => {
	const panelPorts = new Map<number, browser.runtime.Port>();

	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== "webgpu-devtools-panel") return;

		port.onMessage.addListener((msg) => {
			if (msg.type === "WEBGPU_PANEL_READY" && msg.tabId) {
				panelPorts.set(msg.tabId, port);
			}

			if (msg.tabId) {
				browser.tabs.sendMessage(msg.tabId, msg);
			}
		});

		port.onDisconnect.addListener(() => {
			for (const [tabId, p] of panelPorts) {
				if (p === port) {
					panelPorts.delete(tabId);
					break;
				}
			}
		});
	});

	browser.runtime.onMessage.addListener((message, sender) => {
		if (message.source !== "webgpu-devtools") return;

		const tabId = sender.tab?.id;
		if (tabId == null) return;

		const port = panelPorts.get(tabId);
		if (port) {
			port.postMessage({ ...message, tabId });
		}
	});
});
