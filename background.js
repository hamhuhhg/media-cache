(async () => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;
    const result = await new Promise((res) => browserToUse.storage.sync.get("urls", res));
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
        const result = await new Promise((resolve) => browserToUse.storage.sync.get("urls", resolve));
        if (result.urls && result.urls.length > 0) {
            if (result.urls.some(pattern => { // Check that tab URL is allowed from the extension settings
                try {
                    const regex = wildcardToRegex(pattern).replaceAll("\\.", ".");
                    const url = tab.url.trim();
                    return new RegExp(regex).test(url);
                } catch (ex) {
                    return false;
                }
            })) await tabInject(tab);
        }
    }
    browserToUse.tabs.onUpdated.addListener((_, __, tab) => {
        eventTabChange(tab);
    });
    if (result.urls && Array.isArray(result.urls) && result.urls.length > 0) {
        let validPatterns = result.urls.map(p => {
            if (typeof p === 'string') {
                // Handle *://*.example.com -> *://*.example.com/*
                if (p.startsWith('*://*.') && !p.endsWith('/*') && p.split('/').length === 3 && !p.substring("*://*.".length).includes('/')) {
                    console.warn(`Background: Sanitizing stored pattern "${p}" to "${p}/*"`);
                    return p + "/*";
                }
                // Handle *://example.com -> *://example.com/* (no wildcard in host part)
                if (p.startsWith('*://') && !p.startsWith('*://*.') && !p.endsWith('/*') && p.split('/').length === 3 && !p.substring("*://".length).includes('/')) {
                    console.warn(`Background: Sanitizing stored pattern "${p}" to "${p}/*"`);
                    return p + "/*";
                }
            }
            return p;
        }).filter(p => {
            if (typeof p !== 'string' || p.length === 0) {
                console.warn(`Background: Filtering out invalid pattern (non-string or empty): "${p}"`);
                return false;
            }
            if (!p.includes('://')) {
                 console.warn(`Background: Filtering out invalid pattern (missing '://'): "${p}"`);
                 return false;
            }
            if (!/^(https?|\*):\/\//.test(p)) { // Ensure scheme is http, https, or *
                console.warn(`Background: Filtering out invalid pattern (bad scheme): "${p}"`);
                return false;
            }
            return true;
        });

        if (validPatterns.length > 0) {
            console.log("Background: Querying tabs with patterns on startup:", validPatterns);
            try {
                // The original code wrapped browserToUse.tabs.query in a new Promise.
                // It's generally not needed as tabs.query itself returns a Promise.
                const tabsFound = await browserToUse.tabs.query({ url: validPatterns });
                if (tabsFound && Array.isArray(tabsFound)) {
                    for (const tab of tabsFound) {
                        if (tab && tab.id) {
                           await tabInject(tab);
                        }
                    }
                } else {
                    console.warn("Background: tabs.query on startup did not return an iterable array for patterns:", validPatterns);
                }
            } catch (e) {
                console.error("Background: Error during initial tabs.query or subsequent tabInject:", e, "Patterns were:", validPatterns);
                if (browserToUse.runtime.lastError) {
                    console.error("Background: runtime.lastError after initial tabs.query:", browserToUse.runtime.lastError.message);
                }
            }
        } else {
            console.log("Background: No valid URL patterns found in storage to query tabs on startup after filtering.");
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
        });
        // Inject mp4-muxer.js first, into the MAIN world
        await browserToUse.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["lib/mp4-muxer.js"],
            world: "MAIN" // Added this line
        });
        // Then inject script.js
                        await browserToUse.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['script.js'],
                            world: "MAIN"
                        });
                        browserToUse.tabs.sendMessage(ids[0].id, { // Update user preferences
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