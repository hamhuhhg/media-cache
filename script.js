(async () => {

    /**
     * Includes some flags that can be enabled/disabled either from the code or from the extension UI. These might not always work.
     */
    const CUSTOM_BEHAVIOR = {
        finalize_fs_stream_when_video_finishes: true,
        delete_entries_when_video_finishes: false,
        download_content_when_video_finishes: true
    }

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
    let arr = []; // This will store our media entries
    const STREAM_ASSOCIATION_TIMEOUT_MS = 5000; // 5 seconds for associating audio to video

    // New structure for entries in 'arr'
    // {
    //   id: crypto.randomUUID(),
    //   title: "default_title", // Will be updated by addTitle
    //   finalTitle: false,
    //   video: {
    //     mimeType: null, // e.g., "video/mp4; codecs="avc1.42001f""
    //     codec: null, // e.g., 'avc'
    //     width: null,
    //     height: null,
    //     data: [], // Will store { buffer: ArrayBuffer, timestamp: number, duration: number, type: 'key'|'delta' }
    //     currentTimeInMicros: 0, // For generating timestamps
    //     frameCount: 0, // For 'key'/'delta' type and duration estimation
    //     sourceBufferAppend: null, // Original appendBuffer function
    //     originalSourceBuffer: null, // The original SourceBuffer object itself
    //     duration: 0, // Total duration from chunks (approximate)
    //     timescale: 1000, // Default timescale
    //     currentWrite: 0, // For FS API if used for elementary streams
    //     writable: null, // For FS API if used for elementary streams
    //     file: null // For FS API if used for elementary streams
    //   },
    //   audio: { // Similar structure to video
    //     mimeType: null,
    //     codec: null, // e.g., 'aac', 'opus'
    //     numberOfChannels: null,
    //     sampleRate: null,
    //     data: [], // Will store { buffer: ArrayBuffer, timestamp: number, duration: number, type: 'key'|'delta' }
    //     currentTimeInMicros: 0,
    //     frameCount: 0, // Using frameCount for audio too, for consistency, represents chunk count
    //     sourceBufferAppend: null,
    //     originalSourceBuffer: null,
    //     duration: 0,
    //     timescale: 1000,
    //     currentWrite: 0,
    //     writable: null,
    //     file: null
    //   },
    //   muxer: null, // Will hold the Mp4Muxer.Muxer instance later
    //   isMuxedCandidate: false, // True if both audio and video are present
    //   createdAt: Date.now(), // Timestamp when the entry (initially video) was created
    //   lastActivity: Date.now() // Timestamp of the last received data or source buffer
    // }

    /**
    * The directory where the files of the current page will be opened
    * @type FileSystemDirectoryHandle
    */
    let picker = undefined;

    /**
     * Write the already-cached ArrayBuffers to a FileSystemWritable. The writable will be linked with the ID, so that further caching wil be directly done on the FS.
     * @param {string} id the identifier of the resource to write
     * @param {FileSystemWritableFileStream} writable where the binary data should be written
     * @param {FileSystemFileHandle} handle The file handle
     * @param {string} streamType 'video' or 'audio'
     */
    // Refined fsWriteOperation for draining backlog of chunkInfo objects
    async function fsWriteOperation(id, writable, handle, streamType) {
        const entry = arr.find(item => item.id === id);
        if (!entry || !entry[streamType]) return;

        const targetStream = entry[streamType];
        targetStream.writable = writable; // Assign writable and file handle early
        targetStream.file = handle;
        // targetStream.currentWrite should already be 0 or a previously saved position.

        while (targetStream.data.length > 0) {
            const chunkInfo = targetStream.data.shift(); // Get and remove from front
            if (chunkInfo && chunkInfo.buffer) {
                try {
                    await targetStream.writable.write({ data: chunkInfo.buffer, position: targetStream.currentWrite, type: "write" });
                    targetStream.currentWrite += chunkInfo.buffer.byteLength;
                } catch (e) {
                    console.warn(`MediaCache: Error writing to FS for ${id} ${streamType}`, e);
                    targetStream.data.unshift(chunkInfo); // Add back if write failed
                    targetStream.writable = null; // Invalidate writable on error
                    targetStream.file = null;
                    break;
                }
            }
        }
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

    function parseMimeType(mimeTypeStr) {
        if (!mimeTypeStr) return null;

        const result = {
            type: null, // 'video' or 'audio'
            codec: null, // 'avc', 'h264', 'aac', 'opus', 'vp9', 'av1', etc.
            rawCodecString: null, // e.g., "avc1.42001f"
            timescale: null, // Typically from track, not mime directly
            width: null,
            height: null,
            numberOfChannels: null,
            sampleRate: null,
        };

        const [mainType, paramsStr] = mimeTypeStr.split(';');
        if (mainType.startsWith('video/')) result.type = 'video';
        if (mainType.startsWith('audio/')) result.type = 'audio';

        if (paramsStr) {
            const codecsMatch = paramsStr.match(/codecs="([^"]+)"/);
            if (codecsMatch && codecsMatch[1]) {
                result.rawCodecString = codecsMatch[1];
                // Simplified codec extraction. This needs to be robust.
                const codec = result.rawCodecString.split('.')[0];
                if (codec.startsWith('avc') || codec === 'h264') result.codec = 'avc';
                else if (codec.startsWith('hvc') || codec.startsWith('hev')) result.codec = 'hevc';
                else if (codec.startsWith('vp09') || codec === 'vp9') result.codec = 'vp9';
                else if (codec.startsWith('av01') || codec === 'av1') result.codec = 'av1';
                else if (codec.startsWith('mp4a')) result.codec = 'aac';
                else if (codec === 'opus') result.codec = 'opus';
                else result.codec = codec; // Fallback
            }
        }

        if (!result.codec && result.type === 'audio') {
            const simpleCodec = mainType.split('/')[1];
            if (simpleCodec === 'opus') result.codec = 'opus';
        }
        if (!result.codec && result.type === 'video') {
             const simpleCodec = mainType.split('/')[1];
             if (simpleCodec === 'webm' && result.rawCodecString && result.rawCodecString.startsWith('vp')) {
                 // Handled by rawCodecString logic already
             } else if (simpleCodec === 'mp4' && result.rawCodecString && (result.rawCodecString.startsWith('avc') || result.rawCodecString.startsWith('hvc'))) {
                // Handled
             }
        }
        return result;
    }

    /**
     * Edit the MediaSource prototype. Basically, make this script work.
     */
    async function start() { // start function stays, but MediaSource.prototype.addSourceBuffer is modified
        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mimeType) { // Keep "function" to inherit 'this'
            const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
            const parsedMime = parseMimeType(mimeType);

            if (!parsedMime || !parsedMime.type) {
                console.warn("MediaCache: Unknown or unhandled MIME type, not caching:", mimeType);
                return sourceBuffer; // Return original if we can't handle it
            }

            let entry = null;
            const now = Date.now();

            if (parsedMime.type === 'video') {
                const newId = crypto.randomUUID() ?? `${Math.random()}-${mimeType}-${Date.now()}`;
                entry = {
                    id: newId,
                    title: document.title, // Initial title
                    finalTitle: false,
                    video: {
                        mimeType: mimeType,
                        codec: parsedMime.codec,
                        rawCodecString: parsedMime.rawCodecString,
                        width: parsedMime.width, // May be null
                        height: parsedMime.height, // May be null
                        data: [],
                        sourceBufferAppend: sourceBuffer.appendBuffer,
                        originalSourceBuffer: sourceBuffer,
                        duration: 0, // This top-level duration might become redundant or sum of chunk durations
                        timescale: parsedMime.timescale || 90000,
                        currentWrite: 0, writable: null, file: null,
                        currentTimeInMicros: 0,
                        frameCount: 0
                    },
                    audio: null, // Initialize audio as null
                    muxer: null,
                    isMuxedCandidate: false,
                    createdAt: now,
                    lastActivity: now
                };
                arr.push(entry);
                setTimeout(() => addTitle(entry.id, 0), 1500); // Keep title logic similar
            } else if (parsedMime.type === 'audio') {
                // Try to associate with a recent video entry
                let associatedVideoEntry = arr.slice().reverse().find(e =>
                    e.video && !e.audio &&
                    (now - e.lastActivity) < STREAM_ASSOCIATION_TIMEOUT_MS
                );

                if (associatedVideoEntry) {
                    entry = associatedVideoEntry;
                    entry.audio = {
                        mimeType: mimeType,
                        codec: parsedMime.codec,
                        rawCodecString: parsedMime.rawCodecString,
                        numberOfChannels: parsedMime.numberOfChannels, // May be null
                        sampleRate: parsedMime.sampleRate, // May be null
                        data: [],
                        sourceBufferAppend: sourceBuffer.appendBuffer,
                        originalSourceBuffer: sourceBuffer,
                        duration: 0, // Redundant or sum
                        timescale: parsedMime.sampleRate || 48000,
                        currentWrite: 0, writable: null, file: null,
                        currentTimeInMicros: 0,
                        frameCount: 0
                    };
                    entry.isMuxedCandidate = true; // Now a candidate for muxing
                    entry.lastActivity = now;
                } else {
                    // Create audio-only entry
                    const newId = crypto.randomUUID() ?? `${Math.random()}-${mimeType}-${Date.now()}`;
                    entry = {
                        id: newId,
                        title: document.title,
                        finalTitle: false,
                        video: null,
                        audio: {
                            mimeType: mimeType,
                            codec: parsedMime.codec,
                            rawCodecString: parsedMime.rawCodecString,
                            numberOfChannels: parsedMime.numberOfChannels,
                            sampleRate: parsedMime.sampleRate,
                            data: [],
                            sourceBufferAppend: sourceBuffer.appendBuffer,
                            originalSourceBuffer: sourceBuffer,
                            duration: 0, // Redundant or sum
                            timescale: parsedMime.sampleRate || 48000,
                            currentWrite: 0, writable: null, file: null,
                            currentTimeInMicros: 0,
                            frameCount: 0
                        },
                        muxer: null,
                        isMuxedCandidate: false,
                        createdAt: now,
                        lastActivity: now
                    };
                    arr.push(entry);
                    setTimeout(() => addTitle(entry.id, 0), 1500);
                }
            }

            if (!entry) { // Should not happen if parsedMime.type is valid
                return sourceBuffer;
            }

            // FileSystem logic (picker part)
            if (picker !== undefined && entry) { // Check entry exists
                 const streamTypeForFs = parsedMime.type; // 'video' or 'audio'
                 setTimeout(() => {
                    async function nextStep() {
                        const currentEntryForFs = arr.find(e => e.id === entry.id); // Re-fetch entry
                        if (!currentEntryForFs) return;

                        if (!currentEntryForFs.finalTitle) {
                            await new Promise((res) => setTimeout(res, 1750));
                            return await nextStep();
                        }

                        if (currentEntryForFs[streamTypeForFs]) {
                             intelligentFileHandle(currentEntryForFs.title + ` [${streamTypeForFs} elementary].${parsedMime.codec || 'chunk'}`)
                             .then((handle) => {
                                if (!handle) return; // intelligentFileHandle might return null
                                handle.createWritable().then(async (writable) => {
                                    await fsWriteOperation(currentEntryForFs.id, writable, handle, streamTypeForFs);
                                }).catch((ex) => console.warn("MediaCache: FS writable error", ex));
                            }).catch((ex) => console.warn("MediaCache: FS file handle error", ex));
                        }
                    }
                    nextStep();
                }, 1600);
            }

            // Override appendBuffer for this specific SourceBuffer instance
            const originalAppendBuffer = sourceBuffer.appendBuffer;
            sourceBuffer.appendBuffer = function (arrayBufferData) { // Renamed 'data' to 'arrayBufferData' for clarity
                const currentEntry = arr.find(item => item.id === entry.id); // entry.id from outer scope
                if (currentEntry) {
                    currentEntry.lastActivity = Date.now();
                    const targetStream = currentEntry[parsedMime.type]; // parsedMime.type from outer scope

                    if (targetStream) {
                        const chunkType = targetStream.frameCount === 0 ? 'key' : 'delta';
                        const timestamp = targetStream.currentTimeInMicros;

                        let estimatedDuration = 0;
                        if (parsedMime.type === 'video') {
                            estimatedDuration = Math.round(1000000 / (targetStream.timescale === 90000 ? 30 : (targetStream.timescale || 30)));
                        } else if (parsedMime.type === 'audio') {
                            if (targetStream.codec === 'aac' && targetStream.sampleRate) {
                                estimatedDuration = Math.round((1024 / targetStream.sampleRate) * 1000000);
                            } else if (targetStream.codec === 'opus') {
                                estimatedDuration = 20000;
                            } else if (targetStream.sampleRate) {
                                estimatedDuration = Math.round((1024 / targetStream.sampleRate) * 1000000);
                            } else {
                                estimatedDuration = 20000;
                            }
                        }
                        if (estimatedDuration === 0) estimatedDuration = 33333;

                        targetStream.currentTimeInMicros += estimatedDuration;
                        targetStream.frameCount++;

                        const chunkInfo = {
                            buffer: arrayBufferData.slice(0),
                            timestamp: timestamp,
                            duration: estimatedDuration,
                            type: chunkType
                        };

                        if (targetStream.writable) {
                            // targetStream.data.push(chunkInfo); // Don't push to data if directly writing to FS for elementary stream to avoid duplicate processing.
                                                              // However, if fsWriteOperation is meant to drain this, it should be pushed.
                                                              // For now, assume direct write means data doesn't need to be in this array for FS.
                                                              // This needs careful consideration based on how FS writing is triggered.
                                                              // If fsWriteOperation is ONLY for initial backlog, then this direct write is fine.
                                                              // If appendBuffer should *also* queue for a later fsWriteOperation call (e.g. user clicks save later), it must push.
                                                              // Given current fsWriteOperation drains, let's push.
                            targetStream.data.push(chunkInfo);
                            targetStream.writable.write({ data: chunkInfo.buffer, position: targetStream.currentWrite, type: "write" });
                            targetStream.currentWrite += chunkInfo.buffer.byteLength;
                        } else {
                            targetStream.data.push(chunkInfo);
                        }
                    }
                }
                return originalAppendBuffer.call(this, arrayBufferData);
            };
            return sourceBuffer;
        };
            // Inside start() function, after MediaSource.prototype.addSourceBuffer modification
            function addTitle(id, timeout) { // id is entry.id
                const currentItem = arr.find(item => item.id === id);
                if (!currentItem) return;

                const [suggestedTitle, result] = getSuggestedTitle();

                let representativeMime = "unknown/unknown";
                let fileExt = "bin";
                if (currentItem.video && currentItem.video.mimeType) {
                    representativeMime = currentItem.video.mimeType;
                    fileExt = currentItem.video.codec || representativeMime.split('/')[1]?.split(';')[0] || 'vid';
                } else if (currentItem.audio && currentItem.audio.mimeType) {
                    representativeMime = currentItem.audio.mimeType;
                    fileExt = currentItem.audio.codec || representativeMime.split('/')[1]?.split(';')[0] || 'aud';
                }

                let streamIndicator = "";
                if (currentItem.isMuxedCandidate) {
                    streamIndicator = "[AV]";
                } else if (currentItem.video) {
                    streamIndicator = `[V-${currentItem.video.codec || 'vid'}]`;
                } else if (currentItem.audio) {
                    streamIndicator = `[A-${currentItem.audio.codec || 'aud'}]`;
                }

                currentItem.title = (`${suggestedTitle} ${streamIndicator} [${id.substring(0,8)}].${fileExt}`).replaceAll("<", "‹").replaceAll(">", "›").replaceAll(":", "∶").replaceAll("\"", "″").replaceAll("/", "∕").replaceAll("\\", "∖").replaceAll("|", "¦").replaceAll("?", "¿").replaceAll("*", "");

                if ((document.readyState !== "complete" || !result) && timeout < 4) {
                    setTimeout(() => addTitle(id, timeout + 1), 1500);
                    currentItem.finalTitle = false;
                } else {
                    currentItem.finalTitle = true;
                }
            }
    }

async function initMuxer(entry) {
    if (!entry || !entry.video || !entry.audio || !entry.video.codec || !entry.audio.codec) {
        console.warn("MediaCache: Cannot init muxer, missing video/audio tracks or codecs.", entry.id);
        return false;
    }

    // Try to get video dimensions from the video element
    let videoElement = document.querySelector('video');
    let width = entry.video.width;
    let height = entry.video.height;

    if (videoElement && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
        width = videoElement.videoWidth;
        height = videoElement.videoHeight;
    } else { // Fallback if video element not found or dimensions not ready
        if (!width || !height) { // If still no width/height
             // Try finding a visible video element and get its dimensions
            const videos = document.querySelectorAll('video');
            for (let v of videos) {
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                    width = v.videoWidth;
                    height = v.videoHeight;
                    console.log(`MediaCache: Used dimensions from querySelectorAll: ${width}x${height}`);
                    break;
                }
            }
            if (!width || !height) {
                console.warn("MediaCache: Video dimensions not available for muxing for entry:", entry.id, "Using fallback 640x360. Muxing might be incorrect.");
                width = 640; // Fallback dimensions
                height = 360;
            }
        }
    }
    entry.video.width = width; // Store resolved width
    entry.video.height = height; // Store resolved height


    // Audio parameters - use stored if available, else default
    const sampleRate = entry.audio.sampleRate || 48000;
    const numberOfChannels = entry.audio.numberOfChannels || 2;
    entry.audio.sampleRate = sampleRate; // Store resolved/default
    entry.audio.numberOfChannels = numberOfChannels; // Store resolved/default

    if (!width || !height || !entry.video.codec || !entry.audio.codec || !sampleRate || !numberOfChannels) {
        console.error("MediaCache: Critical information missing for muxer initialization.", entry);
        return false;
    }

    try {
        entry.muxer = new Mp4Muxer.Muxer({
            target: new Mp4Muxer.ArrayBufferTarget(),
            video: {
                codec: entry.video.codec === 'h264' ? 'avc' : entry.video.codec, // mp4-muxer uses 'avc'
                width: width,
                height: height,
            },
            audio: {
                codec: entry.audio.codec,
                numberOfChannels: numberOfChannels,
                sampleRate: sampleRate,
            },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'offset'
        });
        console.log("MediaCache: Muxer initialized for entry:", entry.id, entry.muxer);
        return true;
    } catch (e) {
        console.error("MediaCache: Failed to initialize Mp4Muxer:", e, entry);
        entry.muxer = null;
        return false;
    }
}

async function finalizeMuxingAndDownload(entry) {
    if (!entry) {
        console.warn("MediaCache: finalizeMuxingAndDownload called with no entry.");
        return;
    }

    // Store original data references in case of muxing failure to allow fallback
    const originalVideoData = entry.video ? [...entry.video.data] : [];
    const originalAudioData = entry.audio ? [...entry.audio.data] : [];
    let muxingAttempted = false;

    if (entry.isMuxedCandidate && entry.video && entry.audio &&
        entry.video.data.length > 0 && entry.audio.data.length > 0) {

        muxingAttempted = true; // Mark that we are attempting to mux
        if (!entry.muxer) {
            console.log("MediaCache: Muxer not yet initialized for", entry.id, "initializing now.");
            const muxerInitialized = await initMuxer(entry);
            if (!muxerInitialized || !entry.muxer) {
                console.warn("MediaCache: Muxer initialization failed for", entry.id, "Falling back to individual downloads.");
                // Restore original data for fallback
                if (entry.video) entry.video.data = originalVideoData;
                if (entry.audio) entry.audio.data = originalAudioData;
                if (entry.video?.data?.length > 0) singleDownload(entry.id, 'video');
                if (entry.audio?.data?.length > 0) singleDownload(entry.id, 'audio');
                return;
            }
        }

        console.log("MediaCache: Starting muxing for entry:", entry.id);

        try {
            // Feed video chunks
            for (const chunk of entry.video.data) { // Use current data for feeding
                if (!entry.muxer) throw new Error("Muxer became null during video chunk processing.");
                entry.muxer.addVideoChunkRaw(chunk.buffer, chunk.type, chunk.timestamp, chunk.duration);
            }

            // Feed audio chunks
            for (const chunk of entry.audio.data) { // Use current data for feeding
                if (!entry.muxer) throw new Error("Muxer became null during audio chunk processing.");
                entry.muxer.addAudioChunkRaw(chunk.buffer, chunk.type, chunk.timestamp, chunk.duration);
            }

            if (!entry.muxer) throw new Error("Muxer is null before finalize, something went wrong.");

            entry.muxer.finalize();
            const { buffer } = entry.muxer.target;

            // Muxing successful, now clear original data arrays in the entry
            if (entry.video) entry.video.data = [];
            if (entry.audio) entry.audio.data = [];

            const blob = new Blob([buffer], { type: 'video/mp4' });
            const titleToUse = `${entry.title.replace(/\[AV\].*?\./, '[MUXED].')}`;

            if (picker && entry.finalTitle) {
                try {
                    const fileHandle = await picker.getFileHandle(titleToUse, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    console.log("MediaCache: Muxed file saved to File System:", titleToUse);
                } catch (fsError) {
                    console.error("MediaCache: Error saving muxed file to File System, falling back to download:", fsError);
                    const a = Object.assign(document.createElement("a"), { download: titleToUse, href: URL.createObjectURL(blob) });
                    a.click();
                    URL.revokeObjectURL(a.href);
                }
            } else {
                const a = Object.assign(document.createElement("a"), { download: titleToUse, href: URL.createObjectURL(blob) });
                a.click();
                URL.revokeObjectURL(a.href);
            }
            console.log("MediaCache: Muxing and download/save completed for entry:", entry.id);

        } catch (error) {
            console.error("MediaCache: Error during muxing or download for entry:", entry.id, error);
            // Restore original data for fallback if muxing failed
            if (entry.video) entry.video.data = originalVideoData;
            if (entry.audio) entry.audio.data = originalAudioData;

            console.warn("MediaCache: Muxing failed. Attempting fallback to individual downloads if data is available.");
            if (entry.video?.data?.length > 0) singleDownload(entry.id, 'video');
            if (entry.audio?.data?.length > 0) singleDownload(entry.id, 'audio');
        } finally {
            if (entry.muxer) entry.muxer = null;

            if (CUSTOM_BEHAVIOR.delete_entries_when_video_finishes) {
                 const videoDataEmpty = !(entry.video && entry.video.data.length > 0);
                 const audioDataEmpty = !(entry.audio && entry.audio.data.length > 0);

                 if (videoDataEmpty && audioDataEmpty) {
                    const itemIndex = arr.findIndex(item => item.id === entry.id);
                    if (itemIndex !== -1) {
                        console.log("MediaCache: Deleting entry after processing:", entry.id);
                        arr.splice(itemIndex, 1);
                    }
                 } else {
                    console.log("MediaCache: Entry not deleted as data remains (muxing/download might have issues or user intervention needed).", entry.id);
                 }
            }
        }

    } else {
        console.log("MediaCache: Not a muxing candidate or missing data, trying individual downloads for:", entry.id);
        if (entry.video && entry.video.data.length > 0) {
            singleDownload(entry.id, 'video');
        }
        if (entry.audio && entry.audio.data.length > 0) {
            singleDownload(entry.id, 'audio');
        }

        if (CUSTOM_BEHAVIOR.delete_entries_when_video_finishes) {
            const videoDataEmpty = !(entry.video && entry.video.data.length > 0);
            const audioDataEmpty = !(entry.audio && entry.audio.data.length > 0);
            if (videoDataEmpty && audioDataEmpty) {
                const itemIndex = arr.findIndex(item => item.id === entry.id);
                if (itemIndex !== -1) {
                     console.log("MediaCache: Deleting non-muxed entry after processing:", entry.id);
                     arr.splice(itemIndex, 1);
                }
            }
        }
    }
}
    // Modify singleDownload
    function singleDownload(id, streamType = null) {
        const currentItem = arr.find(item => item.id === id);
        if (!currentItem) return;

        let titleToUse = currentItem.title;
        let targetStreamInfo = null;
        let isVideo = false;

        if (streamType && currentItem[streamType]) { // streamType is 'video' or 'audio'
            targetStreamInfo = currentItem[streamType];
            isVideo = streamType === 'video';
            titleToUse = `${currentItem.title} [${streamType} only].${targetStreamInfo.codec || (isVideo ? 'vid' : 'aud')}`;
        } else if (currentItem.isMuxedCandidate) {
            console.log("MediaCache: Muxing candidate, download via main process later.", currentItem.id);
            return;
        } else if (currentItem.video) {
            targetStreamInfo = currentItem.video;
            isVideo = true;
            titleToUse = `${currentItem.title} [video only].${targetStreamInfo.codec || 'vid'}`;
        } else if (currentItem.audio) {
            targetStreamInfo = currentItem.audio;
            isVideo = false;
            titleToUse = `${currentItem.title} [audio only].${targetStreamInfo.codec || 'aud'}`;
        }

        if (!targetStreamInfo || targetStreamInfo.data.length === 0) {
            console.warn("MediaCache: No data to download for item", id, streamType);
            return;
        }

        if (targetStreamInfo.writable) {
            console.log("MediaCache: Elementary stream is on File System, finalize there:", titleToUse);
            targetStreamInfo.writable.close().then(() => {
                console.log("MediaCache: Stream finalized on FS:", titleToUse);
            }).catch(e => console.warn("MediaCache: Error closing FS writable for elementary stream", e));
            targetStreamInfo.data = []; // Clear data array as it's assumed to be written/closed
            return;
        }

        const buffersToDownload = targetStreamInfo.data.map(chunkInfo => chunkInfo.buffer);
        if (buffersToDownload.length === 0) {
             console.warn("MediaCache: No actual buffer data to download for item", id, streamType);
            return;
        }

        const blob = new Blob(buffersToDownload, { type: targetStreamInfo.mimeType || (isVideo ? 'video/mp4' : 'audio/mp4') });
        const a = Object.assign(document.createElement("a"), {
            download: titleToUse,
            href: URL.createObjectURL(blob)
        });
        a.click();
        URL.revokeObjectURL(a.href);
        targetStreamInfo.data = []; // Clear downloaded data
    }

    // Modify startDownload
    function startDownload() {
        const itemsToProcess = [...arr]; // Iterate over a copy
        for (let i = 0; i < itemsToProcess.length; i++) {
            const entry = itemsToProcess[i];
            if (CUSTOM_BEHAVIOR.download_content_when_video_finishes) {
                finalizeMuxingAndDownload(entry); // Main call
            }

            if (CUSTOM_BEHAVIOR.finalize_fs_stream_when_video_finishes) {
                if (entry.video && entry.video.writable) {
                    entry.video.writable.close().catch(e=>console.warn("FS close video error on end", e));
                    entry.video.writable = null;
                }
                if (entry.audio && entry.audio.writable) {
                    entry.audio.writable.close().catch(e=>console.warn("FS close audio error on end", e));
                    entry.audio.writable = null;
                }
            }
        }
    }
    document.querySelector("video")?.addEventListener("ended", () => {
        startDownload();
    })
    await start();
    const comms = new BroadcastChannel("CUSTOM_MEDIACACHE_EXTENSION_COMMUNICATION");
    window.addEventListener("beforeunload", () => {
        startDownload();
    })
    comms.onmessage = (msg) => {
        if (msg.data.from !== "a") return;
        switch (msg.data.action) {
            case "start":
                start();
                break;
            case "stop":
                arr = [];
                break;
            case "getDownloads":
                comms.postMessage({
                    from: "b",
                    action: "getDownloads",
                    context: msg.data.content,
                    content: arr.map(entry => {
                        let description = "";
                        let hasData = false;
                        if (entry.isMuxedCandidate) {
                            description = `Video Codec: ${entry.video?.codec}, Audio Codec: ${entry.audio?.codec}`;
                            hasData = (entry.video?.data?.length > 0) || (entry.audio?.data?.length > 0);
                        } else if (entry.video) {
                            description = `Video Codec: ${entry.video.codec}`;
                            hasData = entry.video.data?.length > 0;
                        } else if (entry.audio) {
                            description = `Audio Codec: ${entry.audio.codec}`;
                            hasData = entry.audio.data?.length > 0;
                        }

                        let onFileSystem = (entry.video?.writable !== null) || (entry.audio?.writable !== null);

                        if ((hasData || onFileSystem) && entry.finalTitle) {
                             return {
                                id: entry.id,
                                title: entry.title,
                                description: description,
                                mimeType: entry.video?.mimeType || entry.audio?.mimeType,
                                isMuxedCandidate: entry.isMuxedCandidate,
                                videoDataSize: msg.data.everything && entry.video ? entry.video.data.reduce((s,b)=>s+b.byteLength,0) : (entry.video?.data?.length || 0),
                                audioDataSize: msg.data.everything && entry.audio ? entry.audio.data.reduce((s,b)=>s+b.byteLength,0) : (entry.audio?.data?.length || 0),
                                videoWritable: !!entry.video?.writable,
                                audioWritable: !!entry.audio?.writable
                            };
                        }
                        return null;
                    }).filter(Boolean)
                });
                break;
            case "downloadThis": // Download the item in the data.content (which is entry.id)
                const itemToDownload = arr.find(item => item.id === msg.data.content);
                if (itemToDownload) {
                    finalizeMuxingAndDownload(itemToDownload);
                } else {
                    console.warn("MediaCache: downloadThis - item not found", msg.data.content);
                }
                break;
            case "fileSystem":
                async function apply(res) {
                    if (!res) { // User cancelled picker or an error occurred
                        picker = undefined; // Reset picker state
                        return;
                    }
                    picker = res;
                    for (let i = 0; i < arr.length; i++) {
                        const entry = arr[i];
                        // Decide what to save for this entry
                        if (entry.isMuxedCandidate) {
                            // TODO: Mux to FS. For now, save video and audio separately if they exist.
                            if (entry.video) {
                                const videoHandle = await picker.getFileHandle(entry.title + " [video_fs]."+ (entry.video.codec || "bin"), { create: true });
                                const videoWritable = await videoHandle.createWritable({ keepExistingData: true });
                                await fsWriteOperation(entry.id, videoWritable, videoHandle, 'video');
                            }
                            if (entry.audio) {
                                const audioHandle = await picker.getFileHandle(entry.title + " [audio_fs]." + (entry.audio.codec || "bin"), { create: true });
                                const audioWritable = await audioHandle.createWritable({ keepExistingData: true });
                                await fsWriteOperation(entry.id, audioWritable, audioHandle, 'audio');
                            }
                        } else if (entry.video) {
                            const handle = await picker.getFileHandle(entry.title, { create: true });
                            const writable = await handle.createWritable({ keepExistingData: true });
                            await fsWriteOperation(entry.id, writable, handle, 'video');
                        } else if (entry.audio) {
                             const handle = await picker.getFileHandle(entry.title, { create: true });
                            const writable = await handle.createWritable({ keepExistingData: true });
                            await fsWriteOperation(entry.id, writable, handle, 'audio');
                        }
                    }
                }
                // msg.data.content might be a directory handle from a previous selection in some contexts.
                // For a fresh pick, it should be undefined/null.
                if (msg.data.content && typeof msg.data.content.getDirectoryHandle === 'function') { // Check if it looks like a handle
                     apply(msg.data.content);
                } else {
                    window.showDirectoryPicker({ id: "MediaCachePicker", mode: "readwrite" })
                          .then((res) => apply(res))
                          .catch(err => { console.warn("MediaCache: Directory picker error", err); picker = undefined; });
                }
                break;
            case "fileSystemSingleOperation":
                (async () => {
                    // This case needs to be adapted for the new structure, identify if it's video or audio part.
                    // Assuming msg.data.content.id is the entry ID and msg.data.content.file is the handle.
                    // We need to know if we're saving the video or audio part.
                    // For now, let's assume it's for the primary (video if present, else audio)
                    const entryForSingleFs = arr.find(e => e.id === msg.data.content.id);
                    if (entryForSingleFs) {
                        let streamTypeForSingleFs = null;
                        if (entryForSingleFs.video) streamTypeForSingleFs = 'video';
                        else if (entryForSingleFs.audio) streamTypeForSingleFs = 'audio';

                        if (streamTypeForSingleFs) {
                            const writable = await msg.data.content.file.createWritable({ keepExistingData: true });
                            // The original fsWriteOperation took 'handle' as 3rd param, not msg.data.content.handle
                            // Assuming msg.data.content.handle IS the file handle for this operation.
                            await fsWriteOperation(msg.data.content.id, writable, msg.data.content.file, streamTypeForSingleFs);
                        } else {
                             console.warn("MediaCache: fileSystemSingleOperation - No video or audio stream found for entry", msg.data.content.id);
                        }
                    }
                })()
                break;
            case "deleteThis":
                const itemIndex = arr.findIndex(item => item.id === msg.data.content.id);
                if (itemIndex === -1) return;

                if (msg.data.content.permanent) {
                    if (arr[itemIndex].video && arr[itemIndex].video.writable) arr[itemIndex].video.writable.close().catch(e=>console.warn(e));
                    if (arr[itemIndex].audio && arr[itemIndex].audio.writable) arr[itemIndex].audio.writable.close().catch(e=>console.warn(e));
                    // TODO: If permanent also means deleting from FS, need file handles to call remove()
                    arr.splice(itemIndex, 1);
                } else {
                    if (arr[itemIndex].video) arr[itemIndex].video.data = [];
                    if (arr[itemIndex].audio) arr[itemIndex].audio.data = [];
                }
                break;
            case "fsFinalize":
                const finalizableEntry = arr.find(item => item.id === msg.data.content);
                if (!finalizableEntry) return;
                let closedSomething = false;
                if (finalizableEntry.video && finalizableEntry.video.writable) {
                    finalizableEntry.video.writable.close().then(()=> console.log(`FS Video stream finalized for ${finalizableEntry.id}`))
                                                     .catch(e=>console.warn(e));
                    finalizableEntry.video.writable = null;
                    closedSomething = true;
                }
                if (finalizableEntry.audio && finalizableEntry.audio.writable) {
                    finalizableEntry.audio.writable.close().then(()=> console.log(`FS Audio stream finalized for ${finalizableEntry.id}`))
                                                     .catch(e=>console.warn(e));
                    finalizableEntry.audio.writable = null;
                    closedSomething = true;
                }
                // Optional: remove entry if CUSTOM_BEHAVIOR dictates
                // if (closedSomething && CUSTOM_BEHAVIOR.delete_entries_when_video_finishes) {
                //    arr.splice(arr.findIndex(item => item.id === msg.data.content), 1);
                // }
                break;
            case "updateChoices":
                for (const key in msg.data.content) CUSTOM_BEHAVIOR[key] = !!msg.data.content[key];
                comms.postMessage({ from: "b", action: "getChoices", content: CUSTOM_BEHAVIOR });
                break;
            case "getChoices": // Return the CUSTOM_BEHAVIOR settings
                comms.postMessage({ from: "b", action: "getChoices", content: CUSTOM_BEHAVIOR });
                break;
        }
    };
})()
undefined;