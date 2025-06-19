(async () => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;
    // const result = await new Promise((res) => browserToUse.storage.sync.get("urls", res));

    // At the beginning of the IIFE, after browserToUse is defined:
    const initialSettings = await new Promise((res) => browserToUse.storage.sync.get(["urls", "enableAllSitesMode"], res));
    const initialUrls = initialSettings.urls;
    const initialEnableAllSitesMode = initialSettings.enableAllSitesMode;

    /**
     * Convert a wildcard to a regex.
     * _Made by Claude, since I wouldn't be able to write something like this_
     * @param {string} wildcardPattern the pattern
     * @returns a Regex to test
     */
    function wildcardToRegex(wildcardPattern) {
        // Escape special regex characters except * and ?
        const escaped = wildcardPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

        // Replace wildcards with regex equivalents
        const converted = escaped
            .replace(/\*/g, '.*')  // * becomes .*
            .replace(/\?/g, '.')   // ? becomes .

        // Ensure the pattern matches the entire string
        return `^${converted}$`;
    }
    /**
     * The Set that contains the ID of the tabs in which the scripts are being injected
     */
    let isTabInjectRunning = new Set();
    /**
     * Check if in the new tab the script should run or not
     * @param {chrome.tabs.Tab} tab the tab to check
     */
    async function eventTabChange(tab) {
        // Check if the tab URL is valid for injection
        if (!tab || !tab.url || (!tab.url.startsWith("http:") && !tab.url.startsWith("https://"))) {
            // console.log("Skipping injection for non-http(s) URL:", tab.url);
            return;
        }

        const settings = await new Promise((resolve) => browserToUse.storage.sync.get(["urls", "enableAllSitesMode"], resolve));
        const currentUrls = settings.urls;
        const enableAllSitesModeActive = settings.enableAllSitesMode;

        if (enableAllSitesModeActive) {
            // console.log("All sites mode active, injecting for:", tab.url);
            await tabInject(tab);
        } else {
            if (currentUrls && currentUrls.length > 0) {
                if (currentUrls.some(pattern => {
                    try {
                        const regex = wildcardToRegex(pattern).replaceAll("\\.", "."); // Keep original replaceAll
                        const url = tab.url.trim();
                        return new RegExp(regex).test(url);
                    } catch (ex) {
                        // console.error("Regex error for pattern:", pattern, ex);
                        return false;
                    }
                })) {
                    // console.log("URL match based on pattern, injecting for:", tab.url);
                    await tabInject(tab);
                }
            }
        }
    }

    browserToUse.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        // Ensure injection only happens when the tab is fully loaded or URL changes significantly
        // For simplicity, let's stick to the original filtering if any, or just use the tab from the event
        // The original code calls eventTabChange(tab) directly.
        // Let's ensure 'tab' has a URL. Sometimes changeInfo might be for other things.
        if (tab.url) { // Only proceed if the tab object has a URL
            eventTabChange(tab);
        }
    });

    // Initial injection logic when extension starts/reloads
    if (initialEnableAllSitesMode) {
        const queryResult = await new Promise((resolve) => browserToUse.tabs.query({ url: ["http://*/*", "https://*/*"] }, resolve));
        for (const tab of queryResult) {
            // console.log("Initial injection (all sites mode) for:", tab.url);
            // Ensure tab URL is valid before injecting - tabInject will also check, but good to be defensive
            if (tab.url && (tab.url.startsWith("http:") || tab.url.startsWith("https://"))) {
                await tabInject(tab);
            }
        }
    } else {
        if (initialUrls && initialUrls.length > 0) {
            const queryResult = await new Promise((resolve) => browserToUse.tabs.query({}, resolve)); // Query all tabs
            for (const tab of queryResult) {
                if (tab.url && initialUrls.some(pattern => {
                    try {
                        const regex = wildcardToRegex(pattern).replaceAll("\\.", ".");
                        return new RegExp(regex).test(tab.url.trim());
                    } catch (ex) { return false; }
                })) {
                    // console.log("Initial injection (specific URLs mode) for:", tab.url);
                     // Ensure tab URL is valid before injecting
                    if (tab.url && (tab.url.startsWith("http:") || tab.url.startsWith("https://"))) {
                        await tabInject(tab);
                    }
                }
            }
        }
    }
    /**
     * Inject the content scripts in the tab
     * @param {chrome.tabs.Tab} tab the Tab in which the scripts will be injected
     */
    async function tabInject(tab) {
        if (isTabInjectRunning.has(tab.id)) return;
        isTabInjectRunning.add(tab.id);
        function getPromise() {
            return new Promise((resolve) => {
                browserToUse.tabs.sendMessage(tab.id, { action: "ping" }).catch(async (ex) => { // We'll try to send a ping to the isolated content script. If it isn't received since there isn't a receiving end, we'll add it.
                    if (ex.toString() === "Error: Could not establish connection. Receiving end does not exist.") { // The extension isn't running. Let's add the scripts
                        await browserToUse.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ["bridge.js"]
                        })
                        await browserToUse.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['script.js'],
                            world: "MAIN"
                        });
                        // browserToUse.tabs.sendMessage(ids[0].id, { // Update user preferences - ids[0] is not defined here
                        //     action: "updateChoices",
                        //     content: await browserToUse.storage.sync.get(["finalize_fs_stream_when_video_finishes", "delete_entries_when_video_finishes", "download_content_when_video_finishes"])
                        // });
                        // Send message to the specific tab instead of ids[0]
                        browserToUse.tabs.sendMessage(tab.id, {
                            action: "updateChoices",
                            content: await browserToUse.storage.sync.get(["finalize_fs_stream_when_video_finishes", "delete_entries_when_video_finishes", "download_content_when_video_finishes"])
                        });
                        await getPromise(); // Check again
                        resolve();
                    }
                }).then(async (res) => res?.action && resolve());
            });
        }
        await getPromise();
        isTabInjectRunning.delete(tab.id); // The script has been added, so we can delete it from the tab injection
    }
})() 