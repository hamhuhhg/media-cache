(async () => {

    /**
     * Includes some flags that can be enabled/disabled either from the code or from the extension UI. These might not always work.
     */
    const CUSTOM_BEHAVIOR = {
        // Options from the restored version
        finalize_fs_stream_when_video_finishes: true, // Will be renamed/replaced by finalize_fs_when_video_finishes
        delete_entries_when_video_finishes: false,
        download_content_when_video_finishes: true, // Will be renamed/replaced by download_when_video_finishes

        // Re-adding newer options with their defaults
        finalize_fs_when_video_finishes: true,
        download_when_video_finishes: true,
        download_on_new_video_in_tab: false,
        download_on_tab_close: true,
        show_floating_download_button: true,
    };
    // Clean up duplicate/old keys after merging if necessary - for now, new keys will override if names clash
    // More precise merge:
    const defaultRestoredBehavior = {
        finalize_fs_stream_when_video_finishes: true,
        delete_entries_when_video_finishes: false,
        download_content_when_video_finishes: true
    };
    const addedBehavior = {
        finalize_fs_when_video_finishes: true, // New name
        download_when_video_finishes: true,    // New name
        download_on_new_video_in_tab: false,
        download_on_tab_close: true,
        show_floating_download_button: true,
    };
    // Initialize CUSTOM_BEHAVIOR with all desired keys and defaults
    Object.assign(CUSTOM_BEHAVIOR, addedBehavior); // Add new/renamed keys
    // Remove old keys if their names changed to avoid confusion, or ensure they are correctly mapped.
    // For clarity, let's define the final structure directly:
    const FINAL_CUSTOM_BEHAVIOR_DEFAULTS = {
        finalize_fs_when_video_finishes: true,
        delete_entries_when_video_finishes: false,
        download_when_video_finishes: true,
        download_on_new_video_in_tab: false,
        download_on_tab_close: true,
        show_floating_download_button: true,
    };
    // Overwrite CUSTOM_BEHAVIOR with the final clean structure
    for (const key in CUSTOM_BEHAVIOR) { delete CUSTOM_BEHAVIOR[key]; } // Clear old object
    Object.assign(CUSTOM_BEHAVIOR, FINAL_CUSTOM_BEHAVIOR_DEFAULTS); // Assign clean defaults


    /**
     * Tracks if a video has started playing in the current tab to help with download_on_new_video_in_tab
     */
    let isFirstVideoPlayed = false;
    /**
     * Reference to the floating download button element.
     * @type {HTMLButtonElement | null}
     */
    let floatingDownloadButton = null;

    /**
     * Get the suggested title for the file.
     * NOTE: These are only examples from two popular streaming sites. Before downloading anything from them, ensure you've authorization from the channel owner, and download them only in the cases provided for their Terms of Service.
     * @returns an array, with [the suggested title for the file, and if the result should be final (true) or not (false). In this last case, it's suggested to check again later for another title]
     */
    function getSuggestedTitle() {
        const [title, id] = (() => {
            if (window.location.host.endsWith("youtube.com")) {
                return [document.querySelector("#title > h1 > yt-formatted-string, .watch-content .slim-video-information-title > .yt-core-attributed-string")?.textContent, new URLSearchParams(window.location.search).get("v")]
            } else if (window.location.host.endsWith("twitch.tv")) {
                return [document.querySelector("[data-a-target='stream-title']")?.textContent, ""]
            }
            return [undefined, undefined]
        })()
        if (title && id) return [`${title} [${id}]`, true];
        return [document.title, !window.location.host.endsWith("youtube.com") && !window.location.host.endsWith("twitch.tv")];
    }
    let arr = [];
    /**
    * The directory where the files of the current page will be opened
    * @type FileSystemDirectoryHandle
    */
    let picker = undefined;

    /**
     * Write the already-cached ArrayBuffers to a FileSystemWritable. The writable will be linked with the ID, so that further caching wil be directly done on the FS.
     * @param {string} id the identifier of the resource to write
     * @param {FileSystemWritableFileStream} writable where the binary data should be written
     */
    async function fsWriteOperation(id, writable, handle) {
        let position = 0;
        const currentItem = arr.find(item => item.id === id);
        while (currentItem.data.length !== 0) {
            const data = currentItem.data[0];
            await writable.write({ data, position, type: "write" });
            position += data.byteLength;
            currentItem.data.splice(0, 1);
        }
        currentItem.writable = writable; // And save the writable in the object, so that future data will be written there
        currentItem.currentWrite = position; // Save in the "currentWrite" key the position where further buffers should be written
        currentItem.file = handle; // Add the FileSystemFileHandle in the Object so that it can be moved (if the browser supports so)
    }
    /**
     * If a File is being created in the user's file system
     */
    let isFileHandleInCreation = false;
    /**
     *
     * @param {string} name
     * @returns
     */
    async function intelligentFileHandle(name) {
        if (isFileHandleInCreation) {
            await new Promise((res) => setTimeout(res, 50));
            return await intelligentFileHandle(name);
        }
        isFileHandleInCreation = true;
        const file = await picker.getFileHandle(name, { create: true });
        isFileHandleInCreation = false;
        return file;
    }
    /**
     * Edit the MediaSource prototype. Basically, make this script work.
     */
    async function start() {
        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mimeType) { // Keep "function" to inherit the context of the MediaSource
            /**
             * Get the original SourceBuffer
             * @type SourceBuffer
             */
            const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
            /**
             * If the provided title is final, so no further edits will be made
             */
            let finalTitle = false;
            /**
             * Get the suggested title for the item
             * @param id the ID of the item that should be added
             * @param timeout make sure this is 0. The script will automatically increase it before stopping looking for changes in the webpage (if it can't find any special filename)
             */
            function addTitle(id, timeout) {
                const currentItem = arr.find(item => item.id === id);
                if (!currentItem) return;
                const [suggestedTitle, result] = getSuggestedTitle();
                currentItem.title = (`${suggestedTitle} [${mimeType.substring(0, mimeType.indexOf("/"))} ${id}].${mimeType.substring(mimeType.indexOf("/") + 1, mimeType.indexOf(";", mimeType.indexOf("/")))}`).replaceAll("<", "‹").replaceAll(">", "›").replaceAll(":", "∶").replaceAll("\"", "″").replaceAll("/", "∕").replaceAll("\\", "∖").replaceAll("|", "¦").replaceAll("?", "¿").replaceAll("*", "");
                if ((document.readyState !== "complete" || !result) && timeout < 4) {
                    setTimeout(() => addTitle(id, timeout + 1), 1500); // We'll try again when the page has been loaded
                    finalTitle = false;
                } else finalTitle = true;
            }
            const id = crypto.randomUUID() ?? `${Math.random()}-${mimeType}-${Date.now()}`;

            // Handle "download_on_new_video_in_tab"
            // console.log("script.js: addSourceBuffer, CUSTOM_BEHAVIOR:", JSON.parse(JSON.stringify(CUSTOM_BEHAVIOR))); // Deep copy for logging
            if (isFirstVideoPlayed && CUSTOM_BEHAVIOR.download_on_new_video_in_tab) {
                console.log("script.js: New video source detected, download_on_new_video_in_tab=true. Triggering download for previous items.");
                downloadPreviousItemsAsBlobs();
            }
            if (!isFirstVideoPlayed) {
                isFirstVideoPlayed = true;
            }

            arr[arr.length] = { mimeType, data: [], title: document.title, id };
            setTimeout(() => addTitle(id, 0), 1500);
            // Only attempt to use FileSystemAPI if picker is defined AND showDirectoryPicker is supported
            if (picker !== undefined && typeof window.showDirectoryPicker === 'function') {
                setTimeout(() => {
                    async function nextStep() {
                        if (!finalTitle) { // We'll wait that the title of the file is final before writing it to the FS.
                            await new Promise((res) => setTimeout(res, 1750));
                            return await nextStep();
                        }
                        const currentItem = arr.find(entry => entry.id === id);
                        if (!currentItem) return;

                        intelligentFileHandle(currentItem.title).then((handle) => {
                           if (handle) {
                                handle.createWritable().then(async (writable) => {
                                    await fsWriteOperation(id, writable, handle);
                                }).catch((ex) => {
                                    console.warn("Failed to create writable stream, falling back to blob download for this item if data exists.", ex);
                                });
                            }
                        }).catch((ex) => console.warn("Error in intelligentFileHandle sequence for FS:", ex));
                    }
                    nextStep();
                }, 1600)
            }
            const originalAppend = sourceBuffer.appendBuffer;
            sourceBuffer.appendBuffer = function (data) {
                const currentItem = arr.find(item => item.id === id);
                if (currentItem) { // The item hasn't been deleted
                    if (currentItem.writable) { // The File System API is being used
                        currentItem.writable.write({ data, position: currentItem.currentWrite, type: "write" })
                        currentItem.currentWrite += data.byteLength;
                    } else {
                        currentItem.data.push(data);
                    }
                }
                const result = originalAppend.call(this, data); // Do the thing that browsers normally do when adding a MediaSource
                return result;
            }
            return sourceBuffer;
        }
    }
    /**
     * Download an ArrayBuffer from the array
     * @param {string} id the ID of the cached content to download
     */
    function singleDownload(id) {
        const currentItem = arr.find(item => item.id === id);
        if (!currentItem || currentItem.writable || currentItem.data.length === 0) return;
        const a = Object.assign(document.createElement("a"), {
            download: currentItem.title,
            href: URL.createObjectURL(new Blob(currentItem.data))
        });
        a.click();
        currentItem.data = [];
    }
    /**
     * Download every ArrayBuffer stored
     */
    function startDownload() {
        const length = arr.length;
        for (let i = 0; i < length; i++) {
            CUSTOM_BEHAVIOR.download_content_when_video_finishes && singleDownload(arr[i].id);
            CUSTOM_BEHAVIOR.finalize_fs_stream_when_video_finishes && arr[i].writable?.close();
        }
        // Re-introduce the more robust startDownload from the version with more features
        // CUSTOM_BEHAVIOR.delete_entries_when_video_finishes && arr.splice(0, length); // This old line is removed
    }

    /**
     * Specifically downloads items that are not associated with a FileSystem writable stream.
     */
    function downloadPreviousItemsAsBlobs() {
        const itemsToProcess = [...arr];
        let itemsWereDownloaded = false;
        for (const item of itemsToProcess) {
            if (!item.writable && item.data && item.data.length > 0) {
                console.log(`Downloading previous item ${item.title} as Blob due to new video.`);
                singleDownload(item.id);
                itemsWereDownloaded = true;
            }
        }
        if (itemsWereDownloaded) {
            console.log("Finished processing previous items for blob download.");
        }
    }

    /**
     * Download every ArrayBuffer stored or finalize FileSystem writables, respecting CUSTOM_BEHAVIOR settings.
     * @param {object} [triggerOptions] - Options to override default behavior based on the trigger.
     * @param {boolean} [triggerOptions.isTabClose=false] - If true, uses 'download_on_tab_close'.
     * @param {boolean} [triggerOptions.isVideoEnd=false] - If true, uses 'download_when_video_finishes'.
     */
    function startDownload(triggerOptions = {}) { // This is the more advanced version
        // console.log("script.js: startDownload called. Trigger:", triggerOptions, "CUSTOM_BEHAVIOR:", JSON.parse(JSON.stringify(CUSTOM_BEHAVIOR)));
        const { isTabClose = false, isVideoEnd = false } = triggerOptions;
        let shouldDownloadBlobs = false;
        let shouldFinalizeFS = false;
        let shouldDeleteAfterProcessing = CUSTOM_BEHAVIOR.delete_entries_when_video_finishes;

        if (isTabClose) {
            if (!CUSTOM_BEHAVIOR.download_on_tab_close) return;
            shouldDownloadBlobs = true;
            shouldFinalizeFS = true;
        } else if (isVideoEnd) {
            if (!CUSTOM_BEHAVIOR.download_when_video_finishes && !CUSTOM_BEHAVIOR.finalize_fs_when_video_finishes) return;
            shouldDownloadBlobs = CUSTOM_BEHAVIOR.download_when_video_finishes;
            shouldFinalizeFS = CUSTOM_BEHAVIOR.finalize_fs_when_video_finishes;
        } else { // Generic call (e.g. manual from button)
            shouldDownloadBlobs = true; // Default to attempting blob download for manual calls
            shouldFinalizeFS = true;  // Default to attempting FS finalize for manual calls
        }

        const itemsToProcess = [...arr];
        for (const item of itemsToProcess) {
            if (item.writable && typeof item.writable.close === 'function') {
                if (shouldFinalizeFS) {
                    console.log(`Finalizing FS stream for: ${item.title}`);
                    item.writable.close().then(() => {
                        if (shouldDeleteAfterProcessing) {
                            const index = arr.findIndex(i => i.id === item.id);
                            if (index !== -1) arr.splice(index, 1);
                        }
                    }).catch(e => console.warn(`Error closing writable for ${item.title}:`, e));
                }
            } else if (item.data && item.data.length > 0) {
                if (shouldDownloadBlobs) {
                    singleDownload(item.id);
                }
            }
        }
    }

    function setupVideoEndedListener() {
        const attachListenerToVideo = (videoElem) => {
            console.log("Attaching 'ended' listener to video element:", videoElem);
            videoElem.addEventListener("ended", () => {
                // console.log("script.js: video ended event. CUSTOM_BEHAVIOR:", JSON.parse(JSON.stringify(CUSTOM_BEHAVIOR)));
                console.log("Video ended event triggered.");
                startDownload({ isVideoEnd: true });
            });
        };

        const videoElement = document.querySelector("video");
        if (videoElement) {
            attachListenerToVideo(videoElement);
        } else {
            console.log("No video element found on initial setup. Using MutationObserver to detect future video elements.");
            const observer = new MutationObserver((mutationsList, obs) => {
                for (const mutation of mutationsList) {
                    if (mutation.type === 'childList') {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeName === 'VIDEO') {
                                console.log("VIDEO element added to DOM.");
                                attachListenerToVideo(node);
                                // Optionally, disconnect observer if you only care about the first video
                                // obs.disconnect();
                                // return;
                            } else if (node.querySelector && node.querySelector('video')) {
                                // Also check if a video is a descendant of an added node
                                console.log("VIDEO element found in added subtree.");
                                attachListenerToVideo(node.querySelector('video'));
                                // obs.disconnect();
                                // return;
                            }
                        }
                    }
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }
    // Call it once, and potentially again if DOM changes significantly (though MediaSource hook should be primary)
    try {
        setupVideoEndedListener();
    } catch (e) {
        console.warn("Error during initial setupVideoEndedListener call:", e);
    }

    try {
        await start(); // This internally hooks into MediaSource
    } catch (e) {
        console.error("Error during initial start() call:", e);
        // If start() fails, the core functionality is broken.
        // We might want to display an error to the user or disable further operations.
        // For now, just log, but this is a critical failure point.
    }

    const comms = new BroadcastChannel("CUSTOM_MEDIACACHE_EXTENSION_COMMUNICATION");
    window.addEventListener("beforeunload", () => {
        // console.log("script.js: beforeunload event. CUSTOM_BEHAVIOR:", JSON.parse(JSON.stringify(CUSTOM_BEHAVIOR)));
        console.log("beforeunload event triggered.");
        startDownload({ isTabClose: true });
    });

    /**
     * Manually triggers download/finalization for all currently cached items.
     */
    function manualDownloadAllNow() {
        console.log("Manual download triggered by floating button.");
        const itemsToProcess = [...arr];
        if (itemsToProcess.length === 0) {
            alert("MediaCache: No cached media to download for this tab.");
            return;
        }
        // Use the generic startDownload, which defaults to trying to process all.
        startDownload();
        // Alert based on actual processing is harder here as startDownload is async for FS.
        // For simplicity, we won't have a specific "nothing processed" alert here if startDownload handles it.
    }

    /**
     * Creates or updates the floating download button's visibility and existence.
     */
    function updateFloatingDownloadButtonVisibility() {
        if (CUSTOM_BEHAVIOR.show_floating_download_button) {
            if (!floatingDownloadButton) {
                floatingDownloadButton = document.createElement("button");
                floatingDownloadButton.textContent = "⬇️ Download Cache";
                floatingDownloadButton.style.position = "fixed";
                floatingDownloadButton.style.bottom = "20px";
                floatingDownloadButton.style.right = "20px";
                floatingDownloadButton.style.zIndex = "99999";
                floatingDownloadButton.style.padding = "10px 15px";
                floatingDownloadButton.style.backgroundColor = "#007bff";
                floatingDownloadButton.style.color = "white";
                floatingDownloadButton.style.border = "none";
                floatingDownloadButton.style.borderRadius = "5px";
                floatingDownloadButton.style.cursor = "pointer";
                floatingDownloadButton.style.boxShadow = "0 2px 5px rgba(0,0,0,0.2)";
                floatingDownloadButton.style.fontSize = "14px";
                floatingDownloadButton.setAttribute("id", "mediaCacheFloatingDownloadBtn");
                floatingDownloadButton.addEventListener("click", manualDownloadAllNow);
                document.body.appendChild(floatingDownloadButton);
            } else {
                floatingDownloadButton.style.display = "block";
            }
        } else {
            if (floatingDownloadButton) {
                floatingDownloadButton.style.display = "none";
            }
        }
    }
    // Initial check for button visibility after script loads and CUSTOM_BEHAVIOR is set.
    // This needs to be called after CUSTOM_BEHAVIOR is potentially updated by stored settings.
    // So, call it inside the 'updateChoices' message handler for the first update, and initially.
    // updateFloatingDownloadButtonVisibility(); // REMOVED - Will be called from updateChoices after first settings are received


    comms.onmessage = (msg) => {
        if (msg.data.from !== "a") return; // Receive requests only from the isolated content script
        switch (msg.data.action) {
            case "start":
                start(); // Re-initialize MediaSource hooks if needed (e.g. after script was stopped)
                setupVideoEndedListener(); // Re-attach listener if videos might have changed
                break;
            case "stop":
                arr = [];
                isFirstVideoPlayed = false;
                // Potentially remove floating button or disable it if script is "stopped"
                if (floatingDownloadButton) floatingDownloadButton.style.display = "none";
                break;
            case "getDownloads":
                // msg.data.context from popup is { id: tab.id, title: tab.title, forPopup: true }
                // We use msg.data.context.id as the originTabId for the response.
                const responseToPopup = {
                    from: "b",
                    action: "getDownloads",
                    originTabId: msg.data.context?.id, // Correctly using the tab ID from the request's context
                    context: msg.data.context, // Forward the original context object as received
                    content: arr.filter(entry => (entry.writable || entry.data.length > 0)).map(({ id, title, mimeType, data, writable }) => { return { id, title, mimeType, data: msg.data.everything ? data : undefined, writable: msg.data.everything ? writable : !!writable } })
                };
                // console.log("script.js: Sending getDownloads response to popup:", JSON.parse(JSON.stringify(responseToPopup)));
                comms.postMessage(responseToPopup);
                break;
            case "downloadThis":
                // This message comes from ui/comms.js via BroadcastChannel (comms.postMessage)
                // msg.data.content is the item ID.
                singleDownload(msg.data.content);
                break;
            case "fileSystem":
                async function apply(res) {
                    picker = res;
                    for (let i = 0; i < arr.length; i++) {
                        const handle = await res.getFileHandle(arr[i].title, { create: true });
                        const writable = await handle.createWritable({ keepExistingData: true });
                        await fsWriteOperation(arr[i].id, writable, handle);
                    }
                }
                msg.data.content ? apply(msg.data.content) : window.showDirectoryPicker({ id: "MediaCachePicker", mode: "readwrite" }).then((res) => apply(res));
                break;
            case "fileSystemSingleOperation": // Write the already-cached chunks to a file handle provided in the request. Used only in the Console Script.
                (async () => {
                    const writable = await msg.data.content.file.createWritable({ keepExistingData: true });
                    await fsWriteOperation(msg.data.content.id, writable, msg.data.content.handle);
                })()
                break;
            case "deleteThis":
                const getIndex = arr.findIndex(item => item.id === msg.data.content.id);
                if (getIndex === -1) return;
                if (msg.data.content.permanent) arr.splice(getIndex, 1); else arr[getIndex].data = [];
                break;
            case "fsFinalize": // Close the stream in a File System file and delete it from the array list
                const index = arr.findIndex(item => item.id === msg.data.content);
                if (index === -1) return;
                arr[index].writable.close();
                arr.splice(index, 1);
                break;
            case "updateChoices": // Update the CUSTOM_BEHAVIOR settings
                if (msg.data.content && typeof msg.data.content === 'object') {
                    for (const key in msg.data.content) {
                        if (CUSTOM_BEHAVIOR.hasOwnProperty(key)) {
                            CUSTOM_BEHAVIOR[key] = !!msg.data.content[key];
                        }
                    }
                }
                // Always call after choices are updated. This ensures the button visibility
                // is correct based on the latest settings, including the initial ones from background.js.
                updateFloatingDownloadButtonVisibility();
                comms.postMessage({ from: "b", action: "getChoices", content: CUSTOM_BEHAVIOR });
                break;
            case "getChoices": // Return the CUSTOM_BEHAVIOR settings
                comms.postMessage({ from: "b", action: "getChoices", content: CUSTOM_BEHAVIOR });
                break;
        }
    };

    /**
     * The browser interface to use, aliased for consistency.
     * @type Browser | chrome
     */
    const browserToUse = typeof browser !== "undefined" && browser.runtime ? browser : chrome;

    // Listener for messages from background.js (and potentially popup if it uses runtime.sendMessage)
    browserToUse.runtime.onMessage.addListener(
        function(request, sender, sendResponse) {
            if (request.action === "updateChoices") {
                console.log("script.js: Received updateChoices from runtime.onMessage", request.content);
                if (request.content && typeof request.content === 'object') {
                    for (const key in request.content) {
                        if (CUSTOM_BEHAVIOR.hasOwnProperty(key)) {
                            CUSTOM_BEHAVIOR[key] = !!request.content[key];
                        }
                    }
                }
                updateFloatingDownloadButtonVisibility();
                // Optionally, acknowledge the message if sendResponse is used by sender
                // sendResponse({status: "choices updated"});

                // Inform the BroadcastChannel listeners (like the popup) about the choices too,
                // as this might be the initial load of settings.
                comms.postMessage({ from: "b", action: "getChoices", content: CUSTOM_BEHAVIOR });
            } else if (request.action === "ping") { // Respond to pings from background/popup
                sendResponse({ action: "pong" });
                return true; // Indicates that sendResponse will be called asynchronously (or synchronously)
            }
            // Return true if you intend to send a response asynchronously
            // return true;
        }
    );

})()
undefined;