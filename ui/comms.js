(async () => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;
    /**
     * Get the ID of the current tab
     * @type chrome.tabs.Tab[]
     */
    const ids = await new Promise((resolve) => {
        browserToUse.tabs.query({ active: true }, resolve)
    })

    // Automatic Mode Toggle Logic
    const automaticModeToggle = document.getElementById('automaticModeToggle');
    const allowedSitesCard = document.getElementById('allowedSitesCard');

    function updateAllowedSitesVisibility(isAutomaticModeOn) {
        if (isAutomaticModeOn) {
            allowedSitesCard.style.display = 'none';
        } else {
            allowedSitesCard.style.display = 'block';
        }
    }

    browserToUse.storage.sync.get({ automaticModeEnabled: true }, (data) => {
        automaticModeToggle.checked = data.automaticModeEnabled;
        updateAllowedSitesVisibility(data.automaticModeEnabled);
    });
    automaticModeToggle.addEventListener('change', (event) => {
        browserToUse.storage.sync.set({ automaticModeEnabled: event.target.checked });
        updateAllowedSitesVisibility(event.target.checked);
    });

    /**
     * Check that the extension is enabled and is working
     */
    function checkFunctionaly() {
        document.getElementById("notWorking").style.display = "none";
        document.getElementById("chooseDirectory").style.display = typeof window.showDirectoryPicker !== "undefined" ? "block" : "none";
        browserToUse.tabs.sendMessage(ids[0].id, { action: "ping" }).catch((ex) => { // We'll try to send a ping to the isolated content script. If it isn't received since there isn't a receiving end, we'll add it.
            if (ex.toString() === "Error: Could not establish connection. Receiving end does not exist.") { // If the user wants so, they can force running the extension now.
                document.getElementById("notWorking").style.display = "block";
                document.getElementById("chooseDirectory").style.display = "none";
                document.getElementById("forceRun").onclick = async () => {
                    await browserToUse.scripting.executeScript({
                        target: { tabId: ids[0].id },
                        files: ["/bridge.js"]
                    })
                    await browserToUse.scripting.executeScript({
                        target: { tabId: ids[0].id },
                        files: ['/script.js'],
                        world: "MAIN"
                    });
                    // Send all current known choices from storage after forcing script run
                    const currentStoredChoices = await browserToUse.storage.sync.get(Object.keys(allChoiceKeysDefaults));
                    const choicesToSend = {};
                    for (const key in allChoiceKeysDefaults) {
                        choicesToSend[key] = currentStoredChoices.hasOwnProperty(key) ? currentStoredChoices[key] : allChoiceKeysDefaults[key];
                    }
                    browserToUse.tabs.sendMessage(ids[0].id, {
                        action: "updateChoices",
                        content: choicesToSend
                    });
                    checkFunctionaly(); // Check again. If everything works, this card will be hidden
                }
            }
        });
    }

    // Define all choice keys and their defaults centrally.
    const allChoiceKeysDefaults = {
        finalize_fs_when_video_finishes: true,
        delete_entries_when_video_finishes: false,
        download_when_video_finishes: true,
        download_on_new_video_in_tab: false,
        download_on_tab_close: true,
        show_floating_download_button: true, // Added new option
    };

    // Load initial settings from storage to have them available for the change event handler
    let currentChoicesState = { ...allChoiceKeysDefaults };
    try {
        const storedValues = await browserToUse.storage.sync.get(Object.keys(allChoiceKeysDefaults));
        for (const key in allChoiceKeysDefaults) {
            if (storedValues.hasOwnProperty(key)) {
                currentChoicesState[key] = storedValues[key];
            }
        }
    } catch (e) {
        console.warn("Couldn't get stored choices on init, using defaults.", e);
    }

    checkFunctionaly();
    document.getElementById("addHostname").addEventListener("click", () => { // Add a new hostname (with the wildcard pattern) in the list of the alllowed URLs
        const origin = document.getElementById("newHostname").value;
        browserToUse.storage.sync.get({ urls: [] }, (data) => {
            const urls = data.urls;
            urls.push(origin);
            browserToUse.storage.sync.set({ urls: urls }, () => {
                alert("Entry added! You might need to refresh the page to make the extension work.");
                addItemToAllowedList(origin);
            });
        });
    })
    /**
     * Show the URL added by the user in a list
     * @param {string} url the URL syntax (with wildcars if added by the user)
     */
    function addItemToAllowedList(url) {
        document.getElementById("allowedList").append(Object.assign(document.createElement("li"), {
            textContent: url,
            onclick: async (e) => {
                const allowedUrls = await new Promise((resolve) => browserToUse.storage.sync.get({ urls: [] }, resolve));
                allowedUrls.urls.splice(allowedUrls.urls.indexOf(url), 1);
                await browserToUse.storage.sync.set({ urls: allowedUrls.urls });
                e.target.remove();
            }
        }));
    }
    /**
     * A Map that contains all the available downloads from the various content script that are being run
     */
    const tabResultStorage = new Map();
    /**
     * The BroadcastChannel for communication with content scripts.
     */
    const comms = new BroadcastChannel("CUSTOM_MEDIACACHE_EXTENSION_COMMUNICATION");

    document.getElementById("availableTabs").onchange = () => { // The user has changed the selected items in the tab
        document.getElementById("availableDownloads").innerHTML = "";
        const selectedTabId = +document.getElementById("availableTabs").value;
        if (!selectedTabId || !tabResultStorage.has(selectedTabId)) return;

        for (const item of tabResultStorage.get(selectedTabId)) { // Create a Card with all of the downloadable items of that folder
            const card = document.createElement("div");
            card.classList.add("card");
            card.style.backgroundColor = "var(--cardsecond)";
            card.style.marginBottom = "15px";
            card.append(Object.assign(document.createElement("h3"), {
                textContent: `${item.title} [ID: ${item.id}] [Mimetype: ${item.mimeType}]`,
            }), Object.assign(document.createElement("button"), {
                textContent: item.writable ? "Finalize stream" : "Download",
                onclick: () => {
                    // Send message via BroadcastChannel to the specific content script (script.js listens on comms)
                    // The content script itself knows its tab, so no need to specify tab ID here for this action.
                    // However, script.js's comms.onmessage doesn't currently filter by tab. This is a simplification.
                    // For a multi-tab aware popup->script comm via BC, script.js would need to identify its own context.
                    // For now, assuming script.js acts on its own `arr`.
                    comms.postMessage({ from: "a", action: item.writable ? "fsFinalize" : "downloadThis", content: item.id, targetTabId: selectedTabId /* Informational, script.js doesn't use this yet */ });
                }
            }));
            !item.writable && card.append(document.createElement("br"),
                document.createElement("br"),
                Object.assign(document.createElement("label"), {
                    style: "text-decoration: underline; margin-right: 10px;",
                    textContent: "Delete current data",
                    onclick: () => {
                        comms.postMessage({ from: "a", action: "deleteThis", content: { id: item.id, permanent: false }, targetTabId: selectedTabId });
                        card.remove();
                    }
                }),
                Object.assign(document.createElement("label"), {
                    textContent: "Delete current and future data",
                    style: "text-decoration: underline",
                    onclick: () => {
                        comms.postMessage({ from: "a", action: "deleteThis", content: { id: item.id, permanent: true }, targetTabId: selectedTabId });
                        card.remove();
                    }
                }));
            document.getElementById("availableDownloads").append(card);
        }
        // Request choices for the currently selected tab via BroadcastChannel
        comms.postMessage({ from: "a", action: "getChoices", targetTabId: selectedTabId });
    }

    comms.onmessage = (event) => { // Changed from runtime.onMessage to comms.onmessage
        const msg = event.data; // Data is in event.data for BroadcastChannel
        if (msg.from !== "b") return; // Only accept messages from content script (script.js)

        switch (msg.action) {
            case "getDownloads": {
                // msg.context should contain {id: tab.id, title: tab.title} from content script
                // However, script.js currently doesn't send tab context with its "getDownloads" reply.
                // This part needs script.js to send its tabId so popup can map it.
                // For now, we assume msg.tabId (hypothetical) or rely on active tab if context is missing.
                // Let's assume script.js is modified to include its tabId in the response.
                const originTabId = msg.originTabId || ids[0]?.id; // Fallback, less reliable
                if (!originTabId) return;

                if (!tabResultStorage.has(originTabId)) {
                     // If script.js provides title in context, use it. Otherwise, generate.
                    const tabTitle = msg.context?.title || `Tab ID: ${originTabId}`;
                    document.getElementById("availableTabs").append(Object.assign(document.createElement("option"), { textContent: tabTitle, value: originTabId }));
                }
                tabResultStorage.set(originTabId, msg.content);
                if (document.getElementById("availableTabs").children.length === 1 || +document.getElementById("availableTabs").value === originTabId) {
                    document.getElementById("availableTabs").dispatchEvent(new Event("change"));
                }
                break;
            }
            case "getChoices": { // Update the "After downloading, do this..." choices
                if(msg.content && typeof msg.content === 'object'){
                    for (const choice in msg.content) {
                        const checkbox = document.querySelector(`[data-updatechoice='${choice}']`);
                        if(checkbox) checkbox.checked = msg.content[choice];
                    }
                }
                break;
            }
        }
    };

    /**
    * Get the ID of all the tabs that are being run
    * @type chrome.tabs.Tab[]
    */
    const allTabs = await new Promise((resolve) => browserToUse.tabs.query({}, resolve));
    for (const tab of allTabs) {
        if (tab.id) {
            // Request downloads from each tab via BroadcastChannel.
            // script.js needs to be able to identify its own tab ID to respond correctly if multiple content scripts are active.
            // For now, script.js will respond with its 'arr' and popup will try to map it.
            // The 'getDownloads' message in script.js needs to include its tab.id in the response.
            // Let's assume script.js is modified to send { from: "b", action: "getDownloads", content: arr, originTabId: (its own tab.id) }
             comms.postMessage({ from: "a", action: "getDownloads", context: { id: tab.id, title: tab.title, forPopup: true } });
        }
    }

    const allowedUrls = await new Promise((resolve) => browserToUse.storage.sync.get({ urls: [] }, resolve));
    allowedUrls.urls.forEach(origin => addItemToAllowedList(origin)); // Show the added URLs in the UI

    document.getElementById("chooseDirectory").onclick = async () => {
        const targetTabId = +document.getElementById("availableTabs").value || ids[0]?.id;
        if (targetTabId) {
            // Send fileSystem request via BroadcastChannel
            comms.postMessage({ from: "a", action: "fileSystem", targetTabId: targetTabId });
        } else {
            console.warn("No active tab to send fileSystem command to.");
        }
    }

    for (const checkbox of document.querySelectorAll("[data-updatechoice]")) {
        const propertyName = checkbox.getAttribute("data-updatechoice");
        if (currentChoicesState.hasOwnProperty(propertyName)) {
            checkbox.checked = currentChoicesState[propertyName];
        }

        checkbox.addEventListener("change", () => {
            const property = checkbox.getAttribute("data-updatechoice");
            currentChoicesState[property] = checkbox.checked;
            browserToUse.storage.sync.set({ [property]: checkbox.checked });

            const targetTabId = +document.getElementById("availableTabs").value || ids[0]?.id;
            // Send all current choices to the content script(s) via BroadcastChannel
            // script.js's runtime.onMessage listener will handle this if it's still there,
            // or its comms.onmessage if we migrate fully.
            // For now, background.js sends initial via runtime.sendMessage, user changes in popup can go via BC.
            // This message is intended for script.js's runtime.onMessage listener.
            if (targetTabId) {
                 (typeof chrome !== "undefined" ? chrome : browser).tabs.sendMessage(targetTabId, {
                    action: "updateChoices",
                    content: { ...currentChoicesState }
                }).catch(e => console.warn(`Error sending updated choices to tab ${targetTabId} via tabs.sendMessage:`, e));
            }
        });
    }

    // Initial request for choices from the active content script.
    // This uses tabs.sendMessage, expecting script.js's runtime.onMessage listener.
    if (ids[0] && ids[0].id) {
        browserToUse.tabs.sendMessage(ids[0].id, { action: "getChoices" })
            .then(response => {
                // Response from runtime.onMessage in script.js if it uses sendResponse
                // If script.js sends choices back via BroadcastChannel, this .then might not be the primary way to get them.
                // The comms.onmessage handler for "getChoices" should update the UI.
                if (response && response.action === "getChoices" && response.content) {
                     for (const choice in response.content) {
                        const checkbox = document.querySelector(`[data-updatechoice='${choice}']`);
                        if(checkbox) checkbox.checked = response.content[choice];
                    }
                }
            })
            .catch(e => {
                // This error is expected if script.js's runtime.onMessage doesn't send a response or if connection fails.
                console.info("Could not get initial choices from content script via tabs.sendMessage (this might be ok if using BroadcastChannel for replies):", e);
                // Fallback to asking via BroadcastChannel if tabs.sendMessage failed or is not the primary method.
                 comms.postMessage({ from: "a", action: "getChoices", targetTabId: ids[0].id });
            });
    }
})()