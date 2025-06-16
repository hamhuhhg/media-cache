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
        });
        // Inject mp4-muxer.js first, into the MAIN world
        await browserToUse.scripting.executeScript({
            target: { tabId: ids[0].id },
            files: ["lib/mp4-muxer.js"], // Corrected path and added world
            world: "MAIN" // Added this line
        });
        // Then inject script.js
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
    document.getElementById("availableTabs").onchange = () => {
        document.getElementById("availableDownloads").innerHTML = ""; // Clear previous cards
        const selectedTabId = +document.getElementById("availableTabs").value;
        const itemsForSelectedTab = tabResultStorage.get(selectedTabId);

        if (itemsForSelectedTab) {
            for (const item of itemsForSelectedTab) {
                if (!item) continue; // Skip if item is null (e.g. filtered out in script.js)

                const card = document.createElement("div");
                card.classList.add("card");
                card.style.backgroundColor = "var(--cardsecond)";
                card.style.marginBottom = "15px";

                let titleText = item.title; // Title from script.js (already descriptive)
                let detailText = item.description || `ID: ${item.id.substring(0,8)}`;
                if (item.videoDataSize > 0 || item.audioDataSize > 0) { // Check if either has data, not just video
                    detailText += ` (V: ${item.videoDataSize > 0 ? 'Yes' : 'No'}, A: ${item.audioDataSize > 0 ? 'Yes' : 'No'})`;
                }

                card.append(Object.assign(document.createElement("h3"), {
                    textContent: titleText,
                    title: item.id // Full ID on hover
                }), Object.assign(document.createElement("p"), { // Use a paragraph for details
                    textContent: detailText,
                    style: "font-size: 0.9em; color: #ccc;"
                }));

                // Main action button (Download/Mux or Finalize)
                const mainButton = Object.assign(document.createElement("button"), {
                    // Determine button text and action
                });

                let canDownloadMuxed = item.isMuxedCandidate && (item.videoDataSize > 0 || item.videoWritable) && (item.audioDataSize > 0 || item.audioWritable);
                let isAnyStreamOnFs = item.videoWritable || item.audioWritable;

                if (canDownloadMuxed) {
                    mainButton.textContent = "Download Muxed MP4";
                } else if (item.videoDataSize > 0 || item.videoWritable) {
                    mainButton.textContent = "Download Video";
                } else if (item.audioDataSize > 0 || item.audioWritable) {
                    mainButton.textContent = "Download Audio";
                } else {
                    mainButton.textContent = "No Data (or already processed)";
                    mainButton.disabled = true;
                }

                mainButton.onclick = () => {
                    console.log(`MediaCache UI: Sending 'downloadThis' for item ID: ${item.id} to tab ID: ${selectedTabId}`);
                    browserToUse.tabs.sendMessage(selectedTabId, {
                        action: "downloadThis",
                        content: item.id
                    });
                    mainButton.textContent = "Processing...";
                    mainButton.disabled = true;
                    setTimeout(() => {
                         setTimeout(()=> browserToUse.tabs.sendMessage(selectedTabId, { action: "getDownloads", content: { id: selectedTabId, title: document.getElementById("availableTabs").options[document.getElementById("availableTabs").selectedIndex].text } }), 2000);

                    }, 1500);
                };
                card.append(mainButton);

                if (isAnyStreamOnFs) {
                    const finalizeButton = Object.assign(document.createElement("button"), {
                        textContent: "Finalize FS Stream(s)",
                        style: "margin-left: 10px;",
                        onclick: () => {
                            browserToUse.tabs.sendMessage(selectedTabId, {
                                action: "fsFinalize",
                                content: item.id
                            });
                            finalizeButton.textContent = "Finalizing...";
                            finalizeButton.disabled = true;
                             setTimeout(()=> browserToUse.tabs.sendMessage(selectedTabId, { action: "getDownloads", content: { id: selectedTabId, title: document.getElementById("availableTabs").options[document.getElementById("availableTabs").selectedIndex].text } }), 2000);
                        }
                    });
                    card.append(finalizeButton);
                }

                const hasAnyLocalData = item.videoDataSize > 0 || item.audioDataSize > 0;
                const hasAnyFsData = item.videoWritable || item.audioWritable;

                if (hasAnyLocalData || hasAnyFsData) {
                     card.append(document.createElement("br"), document.createElement("br"));
                    if (hasAnyLocalData && !isAnyStreamOnFs) {
                         card.append(Object.assign(document.createElement("label"), {
                            style: "text-decoration: underline; margin-right: 10px; cursor: pointer;",
                            textContent: "Delete In-Memory Data",
                            onclick: () => {
                                browserToUse.tabs.sendMessage(selectedTabId, { action: "deleteThis", content: { id: item.id, permanent: false } });
                                card.remove();
                            }
                        }));
                    }

                    card.append(Object.assign(document.createElement("label"), {
                        textContent: "Delete Entry (and future data)",
                        style: "text-decoration: underline; cursor: pointer;",
                        onclick: () => {
                            browserToUse.tabs.sendMessage(selectedTabId, { action: "deleteThis", content: { id: item.id, permanent: true } });
                            card.remove();
                        }
                    }));
                }
                document.getElementById("availableDownloads").append(card);
            }
        }

        const downloadAllButton = document.getElementById("downloadAllButton");
        if (downloadAllButton) downloadAllButton.remove();

        if (itemsForSelectedTab && itemsForSelectedTab.length > 0) {
             document.getElementById("availableDownloads").append(Object.assign(document.createElement("button"), {
                id: "downloadAllButton",
                textContent: "Process All Visible",
                onclick: () => {
                    const currentItems = tabResultStorage.get(selectedTabId);
                    if (currentItems) {
                        for (const item of currentItems) {
                             if (!item) continue;
                            console.log(`MediaCache UI: Batch sending 'downloadThis' for item ID: ${item.id} to tab ID: ${selectedTabId}`);
                            browserToUse.tabs.sendMessage(selectedTabId, { action: "downloadThis", content: item.id });
                        }
                    }
                    setTimeout(()=> browserToUse.tabs.sendMessage(selectedTabId, { action: "getDownloads", content: { id: selectedTabId, title: document.getElementById("availableTabs").options[document.getElementById("availableTabs").selectedIndex].text } }), 2000);
                }
            }));
        }
        browserToUse.tabs.sendMessage(+document.getElementById("availableTabs").value, { action: "getChoices" });
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