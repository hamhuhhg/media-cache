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

    function renderVideoTable() {
        const tbody = document.getElementById("availableDownloadsTable").querySelector("tbody");
        tbody.innerHTML = ""; // Clear existing rows

        for (const [tabId, tabData] of tabResultStorage.entries()) {
            if (tabData.videos && tabData.videos.length > 0) {
                for (const item of tabData.videos) {
                    const row = document.createElement("tr");

                    const tabTitleCell = document.createElement("td");
                    tabTitleCell.textContent = tabData.title;
                    row.appendChild(tabTitleCell);

                    const videoTitleCell = document.createElement("td");
                    videoTitleCell.textContent = item.title;
                    row.appendChild(videoTitleCell);

                    const mimeTypeCell = document.createElement("td");
                    mimeTypeCell.textContent = item.mimeType;
                    row.appendChild(mimeTypeCell);

                    const idCell = document.createElement("td");
                    idCell.textContent = item.id;
                    row.appendChild(idCell);

                    const actionsCell = document.createElement("td");

                    const downloadButton = document.createElement("button");
                    downloadButton.textContent = item.writable ? "Finalize stream" : "Download";
                    downloadButton.onclick = () => {
                        browserToUse.tabs.sendMessage(tabId, { action: item.writable ? "fsFinalize" : "downloadThis", content: item.id });
                        renderVideoTable(); // Refresh table
                    };
                    actionsCell.appendChild(downloadButton);

                    if (!item.writable) {
                        const deleteCurrentButton = document.createElement("button");
                        deleteCurrentButton.textContent = "Delete current data";
                        deleteCurrentButton.onclick = () => {
                            browserToUse.tabs.sendMessage(tabId, { action: "deleteThis", content: { id: item.id, permanent: false } });
                            renderVideoTable(); // Refresh table
                        };
                        actionsCell.appendChild(deleteCurrentButton);

                        const deleteFutureButton = document.createElement("button");
                        deleteFutureButton.textContent = "Delete current and future data";
                        deleteFutureButton.onclick = () => {
                            browserToUse.tabs.sendMessage(tabId, { action: "deleteThis", content: { id: item.id, permanent: true } });
                            renderVideoTable(); // Refresh table
                        };
                        actionsCell.appendChild(deleteFutureButton);
                    }
                    row.appendChild(actionsCell);
                    tbody.appendChild(row);
                }
            }
        }
    }

    browserToUse.runtime.onMessage.addListener((msg) => {
        switch (msg.action) {
            case "getDownloads": { // Received an array of the items available to download
                tabResultStorage.set(msg.context.id, { title: msg.context.title, videos: msg.content });
                renderVideoTable();
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
            for (const tabId of tabResultStorage.keys()) {
                browserToUse.tabs.sendMessage(tabId, {
                    action: "updateChoices",
                    content: { [property]: checked }
                });
            }
        });
    }
    browserToUse.tabs.sendMessage(ids[0].id, { action: "getChoices" }); // Ask the current choices to the script.
})()