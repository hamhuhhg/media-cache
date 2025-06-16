/**
 * This content script is isolated, so it doesn't affect the main webpage content (the main "script.js" is exposed since it needs to edit the prototype).
 * It's currently used only as a bridge between the extension UI and the main script
 */
(() => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;
    const comms = new BroadcastChannel("CUSTOM_MEDIACACHE_EXTENSION_COMMUNICATION"); // This is replaced every time the extension is built
    comms.onmessage = (msg) => { // Send back the message to the extension runtime
        try {
            if (browserToUse.runtime && browserToUse.runtime.sendMessage) {
                // console.log("Bridge: Relaying message from script.js to runtime:", msg.data);
                browserToUse.runtime.sendMessage(msg.data);
            }
        } catch (e) {
            // console.warn("Bridge: Error relaying message to runtime (context likely invalidated):", e.message);
            // Error is suppressed.
        }
    }
    browserToUse.runtime.onMessage.addListener((msg, _, response) => { // Send the message to the exposed script
        if (msg.action === "ping") {
            response({ action: "ping", content: "pong from bridge.js" }); // Clarify pong source
            return;
        }
        comms.postMessage({ from: "a", ...msg });
    })
})();
