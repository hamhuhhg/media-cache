(async () => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;
    // const result = await new Promise((res) => browserToUse.storage.sync.get("urls", res)); // Removed as per new logic
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
        const data = await new Promise((resolve) => browserToUse.storage.sync.get({ automaticModeEnabled: true, urls: [] }, resolve));
        if (data.automaticModeEnabled) {
            if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
                await tabInject(tab);
            }
        } else {
            if (data.urls && data.urls.length > 0 && tab && tab.url) {
                for (const pattern of data.urls) {
                    try {
                        const regex = wildcardToRegex(pattern); // .replaceAll is not needed here if wildcardToRegex is preserved
                        const url = tab.url.trim();
                        if (new RegExp(regex).test(url)) {
                            await tabInject(tab);
                            break;
                        }
                    } catch (ex) {
                        console.error("Error processing pattern:", pattern, ex);
                    }
                }
            }
        }
    }

    browserToUse.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' && tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
            eventTabChange(tab);
        }
    });

    // Initial tab processing logic on extension startup
    (async () => {
        const startupSettings = await new Promise((resolve) => browserToUse.storage.sync.get({ automaticModeEnabled: true, urls: [] }, resolve));
        const allTabs = await new Promise((resolve) => browserToUse.tabs.query({}, resolve));

        for (const currentTab of allTabs) {
            if (currentTab && currentTab.url && (currentTab.url.startsWith('http://') || currentTab.url.startsWith('https://'))) {
                if (startupSettings.automaticModeEnabled) {
                    await tabInject(currentTab);
                } else {
                    if (startupSettings.urls && startupSettings.urls.length > 0) {
                        for (const pattern of startupSettings.urls) {
                            try {
                                const regex = wildcardToRegex(pattern);
                                const url = currentTab.url.trim();
                                if (new RegExp(regex).test(url)) {
                                    await tabInject(currentTab);
                                    break;
                                }
                            } catch (ex) {
                                console.error("Error processing pattern during startup:", pattern, ex);
                            }
                        }
                    }
                }
            }
        }
    })();

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
                        // Define default choices to ensure all are passed initially
                        const defaultChoices = {
                            finalize_fs_when_video_finishes: true,
                            delete_entries_when_video_finishes: false,
                            download_when_video_finishes: true,
                            download_on_new_video_in_tab: false,
                            download_on_tab_close: true,
                            show_floating_download_button: true, // Added new option
                        };
                        const storedChoices = await browserToUse.storage.sync.get(Object.keys(defaultChoices));
                        const choicesToSend = {};
                        for (const key in defaultChoices) {
                            choicesToSend[key] = storedChoices.hasOwnProperty(key) ? storedChoices[key] : defaultChoices[key];
                        }
                        // Add a small delay to give script.js time to initialize its message listener
                        await new Promise(r => setTimeout(r, 500));
                        browserToUse.tabs.sendMessage(tab.id, {
                            action: "updateChoices",
                            content: choicesToSend
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