(async () => {
    /**
     * The browser interface to use
     * @type chrome
     */
    const browserToUse = typeof chrome === "undefined" ? browser : chrome;

    const enableAllSitesModeCheckbox = document.getElementById('enableAllSitesModeCheckbox');
    const newHostnameInput = document.getElementById('newHostname');
    const addHostnameButton = document.getElementById('addHostname');
    const allowedListUl = document.getElementById('allowedList');
    const allowedSitesStatusMessageP = document.getElementById('allowedSitesStatusMessage');
    const downloadAllButton = document.getElementById('downloadAllButton');

    function updateAllowedSitesUI(enabled) {
        newHostnameInput.disabled = enabled;
        addHostnameButton.disabled = enabled;
        if (enabled) {
            allowedListUl.style.opacity = 0.5;
            allowedSitesStatusMessageP.textContent = "Currently active on all sites. The list below is not in use.";
        } else {
            allowedListUl.style.opacity = 1;
            allowedSitesStatusMessageP.textContent = "";
        }
    }

    browserToUse.storage.sync.get({ enableAllSitesMode: false }, (data) => {
        enableAllSitesModeCheckbox.checked = data.enableAllSitesMode;
        updateAllowedSitesUI(data.enableAllSitesMode);
    });

    enableAllSitesModeCheckbox.addEventListener('change', (event) => {
        const enabled = event.target.checked;
        browserToUse.storage.sync.set({ enableAllSitesMode: enabled });
        updateAllowedSitesUI(enabled);
    });

    /**
     * Get the ID of the current tab
     * @type chrome.tabs.Tab[]
     */
    const ids = await new Promise((resolve) => {
        browserToUse.tabs.query({ active: true }, resolve)
    })
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
                    browserToUse.tabs.sendMessage(ids[0].id, { // Change what the script should do when the video ends according to the previously-selected things
                        action: "updateChoices",
                        content: await browserToUse.storage.sync.get(["finalize_fs_stream_when_video_finishes", "delete_entries_when_video_finishes", "download_content_when_video_finishes"])
                    });
                    checkFunctionaly(); // Check again. If everything works, this card will be hidden
                }
            }
        });
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

    downloadAllButton.addEventListener('click', () => {
        if (tabResultStorage.size === 0) {
            alert("No videos available to download from any tab.");
            return;
        }

        let itemsToDownloadFound = false;
        for (const [tabId, videoArray] of tabResultStorage.entries()) {
            if (videoArray && videoArray.length > 0) {
                videoArray.forEach(videoItem => {
                    // Ensure the videoItem itself isn't null or undefined, and has an id
                    if (videoItem && videoItem.id) {
                        itemsToDownloadFound = true;
                        if (videoItem.writable) {
                            browserToUse.tabs.sendMessage(tabId, { action: "fsFinalize", content: videoItem.id })
                                .catch(err => console.warn(`Error finalizing FS for item ${videoItem.id} in tab ${tabId}:`, err));
                        } else {
                            // Also check if videoItem.data exists or if it's already downloaded (not explicitly tracked here, but script.js handles empty data)
                            // The script.js singleDownload checks for data.length === 0.
                            browserToUse.tabs.sendMessage(tabId, { action: "downloadThis", content: videoItem.id })
                                .catch(err => console.warn(`Error downloading item ${videoItem.id} in tab ${tabId}:`, err));
                        }
                    }
                });
            }
        }

        if (itemsToDownloadFound) {
            alert("Initiated processing for all available videos. Downloads will start if content is available and not already saved via File System API.");
            // Optionally, refresh the view or clear parts of tabResultStorage.
            // For now, no automatic refresh. User can re-select tab in dropdown.
        } else {
            alert("No downloadable/finalizable videos found in the tracked tabs.");
        }
    });

    document.getElementById("availableTabs").onchange = () => {
        const availableDownloadsContainer = document.getElementById("availableDownloads");
        availableDownloadsContainer.innerHTML = ""; // Clear previous content

        const selectedTabIdString = document.getElementById("availableTabs").value;
        // Ensure a tab is selected and it's a valid number
        if (!selectedTabIdString || isNaN(+selectedTabIdString)) {
            availableDownloadsContainer.textContent = "Please select a tab.";
             // Potentially call getChoices for a default/active tab if necessary, or handle appropriately
            // For now, if no valid tab is selected, we just show the message.
            // Consider if ids[0].id (active tab) should be used for getChoices if selectedTabId is invalid.
            // However, ids might not be up-to-date if the active tab changed since UI opened.
            // Safest might be to only call getChoices if a valid tab is selected from dropdown.
            return;
        }
        const selectedTabId = +selectedTabIdString;
        const items = tabResultStorage.get(selectedTabId);

        if (!items || items.length === 0) {
            availableDownloadsContainer.textContent = "No captured media for this tab.";
        } else {
            const table = document.createElement("table");
            table.id = "videoDisplayTable"; // For styling

            const thead = table.createTHead();
            const headerRow = thead.insertRow();
            const headers = ["Title", "Type", "ID", "Actions"];
            headers.forEach(headerText => {
                const th = document.createElement("th");
                th.textContent = headerText;
                headerRow.appendChild(th);
            });

            const tbody = table.createTBody();
            for (const item of items) {
                const row = tbody.insertRow();

                // Title, Type, ID cells
                [item.title, item.mimeType, item.id].forEach(text => {
                    const cell = row.insertCell();
                    cell.textContent = text;
                });

                // Actions cell
                const actionsCell = row.insertCell();
                actionsCell.classList.add("actions-cell"); // For styling multiple buttons

                const actionButton = Object.assign(document.createElement("button"), {
                    textContent: item.writable ? "Finalize Stream" : "Download",
                    onclick: (e) => { // Add event argument
                        browserToUse.tabs.sendMessage(selectedTabId, {
                            action: item.writable ? "fsFinalize" : "downloadThis",
                            content: item.id
                        })
                        .then(() => {
                            e.target.closest('tr')?.remove();
                            if (tbody.rows.length === 0) {
                                availableDownloadsContainer.innerHTML = "No captured media for this tab.";
                            }
                        })
                        .catch(err => {
                            console.warn("Error sending action message:", err);
                            alert("Action failed. See console for details.");
                        });
                    }
                });
                actionsCell.appendChild(actionButton);

                if (!item.writable) {
                    const deleteCurrentDataButton = Object.assign(document.createElement("button"), {
                        textContent: "Clear Cache",
                        title: "Delete current data from cache",
                        onclick: (e) => {
                            browserToUse.tabs.sendMessage(selectedTabId, { action: "deleteThis", content: { id: item.id, permanent: false } })
                                .then(() => {
                                    e.target.closest('tr')?.remove();
                                    if (tbody.rows.length === 0) {
                                        availableDownloadsContainer.innerHTML = "No captured media for this tab.";
                                    }
                                })
                                .catch(err => {
                                    console.warn("Error clearing cache:", err);
                                    alert("Failed to clear cache. See console.");
                                });
                        }
                    });
                    actionsCell.appendChild(deleteCurrentDataButton);

                    const deletePermanentDataButton = Object.assign(document.createElement("button"), {
                        textContent: "Forget Item",
                        title: "Delete current and prevent future data for this item",
                        onclick: (e) => {
                            browserToUse.tabs.sendMessage(selectedTabId, { action: "deleteThis", content: { id: item.id, permanent: true } })
                                .then(() => {
                                    e.target.closest('tr')?.remove();
                                    if (tbody.rows.length === 0) {
                                        availableDownloadsContainer.innerHTML = "No captured media for this tab.";
                                    }
                                })
                                .catch(err => {
                                    console.warn("Error forgetting item:", err);
                                    alert("Failed to forget item. See console.");
                                });
                        }
                    });
                    actionsCell.appendChild(deletePermanentDataButton);
                }
            }
            availableDownloadsContainer.appendChild(table);
        }
        // Call getChoices for the currently selected tab, if valid
        if (selectedTabId && !isNaN(selectedTabId)) {
             browserToUse.tabs.sendMessage(selectedTabId, { action: "getChoices" });
        }
    }

    browserToUse.runtime.onMessage.addListener((msg) => {
        switch (msg.action) {
            case "getDownloads": { // Received an array of the items available to download
                if (!tabResultStorage.get(msg.context.id)) document.getElementById("availableTabs").append(Object.assign(document.createElement("option"), { textContent: msg.context.title, value: msg.context.id }));
                tabResultStorage.set(msg.context.id, msg.content);
                if (document.getElementById("availableTabs").children.length === 1) document.getElementById("availableTabs").dispatchEvent(new Event("change"));
                break;
            }
            case "getChoices": { // Update the "After downloading, do this..." choices
                for (const choice in msg.content) {
                    document.querySelector(`[data-updatechoice='${choice}']`).checked = msg.content[choice];
                }
            }
        }
    });
    /**
    * Get the ID of all the tabs that are being run
    * @type chrome.tabs.Tab[]
    */
    const allTabs = await new Promise((resolve) => browserToUse.tabs.query({}, resolve));
    for (const tab of allTabs) {
        browserToUse.tabs.sendMessage(tab.id, { action: "getDownloads", content: { id: tab.id, title: tab.title } }); // Ask the content script the available downloads
    }
    const allowedUrls = await new Promise((resolve) => browserToUse.storage.sync.get({ urls: [] }, resolve));
    allowedUrls.urls.forEach(origin => addItemToAllowedList(origin)); // Show the added URLs in the UI
    document.getElementById("chooseDirectory").onclick = async () => { // Pick a directory for the File System API
        browserToUse.tabs.sendMessage(ids[0].id, { action: "fileSystem" });
    }


    for (const checkbox of document.querySelectorAll("[data-updatechoice]")) { // Permit to change the behavior of the script after the video has ended
        checkbox.addEventListener("change", () => {
            const [checked, property] = [checkbox.checked, checkbox.getAttribute("data-updatechoice")];
            browserToUse.storage.sync.set({ [property]: checked });
            browserToUse.tabs.sendMessage(+document.getElementById("availableTabs").value, {
                action: "updateChoices",
                content: { [property]: checked }
            });
        });
    }
    browserToUse.tabs.sendMessage(ids[0].id, { action: "getChoices" }); // Ask the current choices to the script.
})()