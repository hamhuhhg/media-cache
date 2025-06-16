(async () => {
    const scriptInstanceId = crypto.randomUUID(); // Define at the very top of the IIFE
    console.log(`MediaCache: script.js instance started. ID: ${scriptInstanceId}`);

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
    try {
        if (!picker || typeof picker.getFileHandle !== 'function') {
            console.warn("MediaCache: intelligentFileHandle - picker is undefined or not a valid directory handle. Cannot get file handle for:", name);
            isFileHandleInCreation = false;
            return null;
        }
        const file = await picker.getFileHandle(name, { create: true });
        isFileHandleInCreation = false;
        return file;
    } catch (e) {
        console.error("MediaCache: intelligentFileHandle - Error getting file handle for:", name, e);
        isFileHandleInCreation = false;
        return null; // Return null on error
    }
    }

function parseMimeType(mimeTypeStr) {
    if (!mimeTypeStr || typeof mimeTypeStr !== 'string') {
        console.warn("MediaCache: parseMimeType received invalid input:", mimeTypeStr);
        return null;
    }

    const result = {
        type: null, // 'video' or 'audio'
        codec: null, // 'avc', 'hevc', 'vp9', 'av1', 'aac', 'opus', 'mp3' etc.
        rawCodecString: null, // e.g., "avc1.42001f"
        // Optional fields, attempt to populate if easily available
        timescale: null,
        width: null,
        height: null,
        numberOfChannels: null,
        sampleRate: null,
    };

    const parts = mimeTypeStr.toLowerCase().split(';'); // Convert to lowercase early
    const mainType = parts[0].trim();

    if (mainType.startsWith('video/')) result.type = 'video';
    if (mainType.startsWith('audio/')) result.type = 'audio';

    let codecParamStr = "";
    for (let i = 1; i < parts.length; i++) {
        if (parts[i].trim().startsWith('codecs=')) {
            codecParamStr = parts[i].trim();
            break;
        }
    }

    if (codecParamStr) {
        const codecsMatch = codecParamStr.match(/codecs="?([^"]+)"?/); // Made quote optional for flexibility
        if (codecsMatch && codecsMatch[1]) {
            result.rawCodecString = codecsMatch[1];
            // Handle potentially multiple comma-separated codecs, prioritize video/audio specific
            let potentialCodecs = result.rawCodecString.split(',').map(c => c.trim());

            let chosenCodecStr = potentialCodecs[0]; // Default to first if no better match
            if (result.type === 'video') {
                chosenCodecStr = potentialCodecs.find(c =>
                    c.startsWith('avc1') || c.startsWith('avc3') || c.startsWith('hvc1') || c.startsWith('hev1') ||
                    c.startsWith('vp09') || c.startsWith('vp9') || c.startsWith('av01') || c === 'h264'
                ) || potentialCodecs[0];
            } else if (result.type === 'audio') {
                chosenCodecStr = potentialCodecs.find(c =>
                    c.startsWith('mp4a') || c === 'opus' || c === 'mp3'
                ) || potentialCodecs[0];
            }

            result.rawCodecString = chosenCodecStr; // Store the most relevant one found

            // More robust codec mapping
            if (chosenCodecStr.startsWith('avc1') || chosenCodecStr.startsWith('avc3') || chosenCodecStr === 'h264') {
                result.codec = 'avc';
            } else if (chosenCodecStr.startsWith('hvc1') || chosenCodecStr.startsWith('hev1')) {
                result.codec = 'hevc';
            } else if (chosenCodecStr.startsWith('vp09') || chosenCodecStr === 'vp9') {
                result.codec = 'vp9';
            } else if (chosenCodecStr.startsWith('av01')) {
                result.codec = 'av1';
            } else if (chosenCodecStr.startsWith('mp4a')) { // e.g., mp4a.40.2, mp4a.40.5, mp4a.67
                result.codec = 'aac';
            } else if (chosenCodecStr === 'opus') {
                result.codec = 'opus';
            } else if (chosenCodecStr === 'vorbis') {
                result.codec = 'vorbis'; // common in webm audio
            } else if (chosenCodecStr === 'mp3' || chosenCodecStr === 'mpga') {
                result.codec = 'mp3';
            } else {
                result.codec = chosenCodecStr.split('.')[0];
                console.warn("MediaCache: parseMimeType - Unknown specific codec, using fallback:", result.codec, "from raw:", chosenCodecStr);
            }
        }
    }

    if (!result.codec && result.type === 'audio') {
        const audioTypeSuffix = mainType.substring('audio/'.length);
        if (audioTypeSuffix === 'opus') result.codec = 'opus';
        else if (audioTypeSuffix === 'aac' || audioTypeSuffix === 'aacp') result.codec = 'aac';
        else if (audioTypeSuffix === 'mpeg' || audioTypeSuffix === 'mp3') result.codec = 'mp3';
        else if (audioTypeSuffix === 'vorbis') result.codec = 'vorbis';
    }
    if (!result.codec && result.type === 'video') {
        const videoTypeSuffix = mainType.substring('video/'.length);
        if (videoTypeSuffix === 'h264') result.codec = 'avc';
    }

    for (let i = 1; i < parts.length; i++) {
        const param = parts[i].trim();
        if (param.startsWith('width=')) result.width = parseInt(param.substring('width='.length));
        else if (param.startsWith('height=')) result.height = parseInt(param.substring('height='.length));
        else if (param.startsWith('samplerate=')) result.sampleRate = parseInt(param.substring('samplerate='.length));
        else if (param.startsWith('channels=')) result.numberOfChannels = parseInt(param.substring('channels='.length));
    }

    result.width = Number.isFinite(result.width) ? result.width : null;
    result.height = Number.isFinite(result.height) ? result.height : null;
    result.sampleRate = Number.isFinite(result.sampleRate) ? result.sampleRate : null;
    result.numberOfChannels = Number.isFinite(result.numberOfChannels) ? result.numberOfChannels : null;


    console.log("MediaCache: parseMimeType input:", mimeTypeStr, "output:", JSON.parse(JSON.stringify(result)));
    return result;
}

    /**
     * Edit the MediaSource prototype. Basically, make this script work.
     */
    async function start() { // start function stays, but MediaSource.prototype.addSourceBuffer is modified
        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mimeType) { // Keep "function" to inherit 'this'
            console.log("MediaCache: addSourceBuffer called with MIME type:", mimeType);
            const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
            const parsedMime = parseMimeType(mimeType);
            console.log("MediaCache: Parsed MIME info:", parsedMime);

            if (!parsedMime || !parsedMime.type) {
                console.warn("MediaCache: Unknown or unhandled MIME type in addSourceBuffer, not caching:", mimeType);
                return sourceBuffer;
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
                    lastActivity: now,
                    processingAttempted: false // <-- NEW FLAG
                };
                arr.push(entry);
                console.log("MediaCache: Created new VIDEO entry:", entry.id, "MIME:", mimeType, "Parsed Codec:", parsedMime.codec);
                console.log(`MediaCache: [Entry ${entry.id}] pushed to arr. Current arr size: ${arr.length}. IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
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
                    console.log("MediaCache: Associated AUDIO stream with entry:", entry.id, "MIME:", mimeType, "Parsed Codec:", parsedMime.codec, "Now mux candidate:", entry.isMuxedCandidate);
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
                        lastActivity: now,
                        processingAttempted: false // <-- NEW FLAG
                    };
                    arr.push(entry);
                    console.log("MediaCache: Created new AUDIO-ONLY entry:", entry.id, "MIME:", mimeType, "Parsed Codec:", parsedMime.codec);
                    console.log(`MediaCache: [Entry ${entry.id}] pushed to arr. Current arr size: ${arr.length}. IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
                    setTimeout(() => addTitle(entry.id, 0), 1500);
                }
            }

            if (!entry) { // Should not happen if parsedMime.type is valid
                return sourceBuffer;
            }
            console.log("MediaCache: addSourceBuffer finished for entry ID:", entry ? entry.id : 'N/A', "Is Mux Candidate:", entry ? entry.isMuxedCandidate : 'N/A');

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
                        // KEY FRAME ASSUMPTION:
                        // This assumes the very first chunk appended to a track's SourceBuffer is a key frame,
                        // and all subsequent chunks are delta frames. This is a significant simplification.
                        // Modern streaming (DASH/HLS with fMP4) delivers media in segments, each starting
                        // with a key frame. If these segments are appended after frameCount > 0,
                        // their initial key frames will be misidentified as 'delta'.
                        // This can lead to muxing errors or unplayable files if the muxer (Mp4Muxer)
                        // relies on accurate keyframe identification for segmenting or indexing.
                        // True key frame detection would require complex media parsing.
                        // Errors during muxer.addVideoChunkRaw() or muxer.finalize() might be related to this if other parameters seem correct.
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
                        console.log(`MediaCache: [Entry ${currentEntry.id}] appendBuffer for ${parsedMime.type}:`,
                                    `Type: ${chunkInfo.type}`,
                                    `Timestamp: ${chunkInfo.timestamp}µs`,
                                    `Duration: ${chunkInfo.duration}µs`,
                                    `Size: ${chunkInfo.buffer.byteLength}`,
                                    `Frame/ChunkCount: ${targetStream.frameCount}`);

                        if (targetStream.writable) {
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
    console.log("MediaCache: initMuxer called for entry:", entry.id,
                "Video Codec:", entry.video?.codec, "Audio Codec:", entry.audio?.codec,
                "Initial video WxH:", entry.video?.width + "x" + entry.video?.height,
                "Initial audio SR/Ch:", entry.audio?.sampleRate + "/" + entry.audio?.numberOfChannels);

    if (!entry || !entry.video || !entry.audio || !entry.video.codec || !entry.audio.codec) {
        console.warn("MediaCache: initMuxer PRE-CHECK FAIL: Missing video/audio tracks or codecs.", entry.id);
        return false;
    }

    let videoElement = document.querySelector('video'); // Query active video element
    let width = entry.video.width; // Should be null initially unless parseMimeType evolved
    let height = entry.video.height; // Should be null initially
    let dimsFrom = "entry data (likely null)";

    if (videoElement && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
        width = videoElement.videoWidth;
        height = videoElement.videoHeight;
        dimsFrom = "document.querySelector('video')";
    } else {
        const videos = document.querySelectorAll('video');
        for (let v of videos) {
            if (v.videoWidth > 0 && v.videoHeight > 0) {
                width = v.videoWidth;
                height = v.videoHeight;
                dimsFrom = "document.querySelectorAll('video')";
                break; // Use first one found with dimensions
            }
        }
    }

    if (!width || !height) {
        console.warn(`MediaCache: initMuxer FAIL: Video dimensions not found for entry ${entry.id}. Tried: ${dimsFrom}. Cannot proceed with muxing.`);
        return false; // Strict: No dimensions, no muxing.
    }
    console.log(`MediaCache: initMuxer - Video dimensions for ${entry.id} from ${dimsFrom}: ${width}x${height}`);
    entry.video.width = width;
    entry.video.height = height;

    // Audio parameters
    let sampleRate = entry.audio.sampleRate;
    let numberOfChannels = entry.audio.numberOfChannels;
    let audioParamsFrom = "entry.audio object";

    if (!sampleRate || !numberOfChannels) {
        if (entry.audio.codec === 'aac') {
            sampleRate = sampleRate || 48000;
            numberOfChannels = numberOfChannels || 2;
            audioParamsFrom = "AAC defaults (48k, 2ch)";
            console.warn(`MediaCache: initMuxer - Audio SR/Ch for ${entry.id} not found, using AAC defaults: ${sampleRate}/${numberOfChannels}`);
        } else if (entry.audio.codec === 'opus') {
            sampleRate = sampleRate || 48000;
            numberOfChannels = numberOfChannels || 2;
            audioParamsFrom = "Opus defaults (48k, 2ch)";
            console.warn(`MediaCache: initMuxer - Audio SR/Ch for ${entry.id} not found, using Opus defaults: ${sampleRate}/${numberOfChannels}`);
        } else {
            console.warn(`MediaCache: initMuxer FAIL: Audio sampleRate or numberOfChannels not found for entry ${entry.id} (Codec: ${entry.audio.codec}). Cannot proceed with muxing.`);
            return false; // Strict: No SR/Ch for unknown/other codecs, no muxing.
        }
    }
    console.log(`MediaCache: initMuxer - Audio params for ${entry.id} from ${audioParamsFrom}: SR=${sampleRate}, Ch=${numberOfChannels}`);
    entry.audio.sampleRate = sampleRate;
    entry.audio.numberOfChannels = numberOfChannels;

    if (!entry.video.codec || !entry.audio.codec) {
        console.error("MediaCache: initMuxer FAIL: Codec information missing even after checks for entry:", entry.id);
        return false;
    }

    // Log the state of entry.video.decoderConfig BEFORE explicitly constructing videoOptions
    console.log("MediaCache: initMuxer - entry.video.decoderConfig BEFORE override:", entry.video.decoderConfig);

    // Construct videoOptions with an ALWAYS NEW decoderConfig containing the default colorSpace
    const videoOptions = {
        codec: entry.video.codec === 'h264' ? 'avc' : entry.video.codec,
        width: entry.video.width,
        height: entry.video.height,
        decoderConfig: {
            colorSpace: {
                primaries: 'bt709',
                transfer: 'bt709',
                matrix: 'bt709',
                fullRange: false
            }
        }
    };

    const audioOptions = {
        codec: entry.audio.codec,
        numberOfChannels: entry.audio.numberOfChannels,
        sampleRate: entry.audio.sampleRate,
        decoderConfig: entry.audio.decoderConfig || null
    };

    const muxerOptions = {
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: videoOptions,
        audio: audioOptions,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset'
    };

    // Log the final videoOptions passed to Mp4Muxer
    console.log("MediaCache: initMuxer - Final video options FOR Mp4Muxer (explicitly constructed decoderConfig):", videoOptions);
    console.log("MediaCache: initMuxer - Final audio options FOR Mp4Muxer:", audioOptions);
    console.log("MediaCache: Mp4Muxer options for entry:", entry.id, muxerOptions);


    try {
        entry.muxer = new Mp4Muxer.Muxer(muxerOptions);
        console.log("MediaCache: Muxer SUCCESSIVELY initialized for entry:", entry.id);
        return true;
    } catch (e) {
        console.error("MediaCache: initMuxer FAIL: Error during Mp4Muxer instantiation for entry:", entry.id, e, "Options were:", muxerOptions);
        entry.muxer = null;
        return false;
    }
}

async function finalizeMuxingAndDownload(entry) {
    if (!entry) {
        console.warn("MediaCache: finalizeMuxingAndDownload called with no entry.");
        return;
    }

    if (entry.processingAttempted) {
        console.log(`MediaCache: Entry ${entry.id} already processed or processing initiated. Skipping.`);
        return;
    }
    entry.processingAttempted = true;

    console.log("MediaCache: finalizeMuxingAndDownload called for entry:", entry ? entry.id : "null entry",
                "Is Candidate:", entry?.isMuxedCandidate,
                "Video Chunks:", entry?.video?.data?.length,
                "Audio Chunks:", entry?.audio?.data?.length);

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
            console.log("MediaCache: initMuxer outcome for", entry.id, ":", muxerInitialized);
            if (!muxerInitialized || !entry.muxer) {
                console.warn("MediaCache: Muxer initialization failed for", entry.id, "Falling back to individual downloads.");
                if (entry.video) entry.video.data = originalVideoData;
                if (entry.audio) entry.audio.data = originalAudioData;
                if (entry.video?.data?.length > 0) singleDownload(entry.id, 'video');
                if (entry.audio?.data?.length > 0) singleDownload(entry.id, 'audio');
                return;
            }
        }

        console.log("MediaCache: Attempting muxing for entry:", entry.id);

        console.log("MediaCache: Starting muxing for entry:", entry.id); // This log seems redundant with the one above. Keeping one.

        try {
            const videoMeta = {
                decoderConfig: {
                    colorSpace: {
                        primaries: 'bt709',
                        transfer: 'bt709',
                        matrix: 'bt709',
                        fullRange: false
                    }
                }
            };
            console.log(`MediaCache: [Entry ${entry.id}] Using video meta for addVideoChunkRaw:`, JSON.stringify(videoMeta, null, 2));

            // Feed video chunks
            console.log(`MediaCache: [Entry ${entry.id}] Feeding ${originalVideoData.length} video chunks to muxer.`);
            for (const chunk of entry.video.data) {
                if (!entry.muxer) throw new Error("Muxer became null during video chunk processing.");
                entry.muxer.addVideoChunkRaw(chunk.buffer, chunk.type, chunk.timestamp, chunk.duration, videoMeta);
            }

            // Feed audio chunks
            console.log(`MediaCache: [Entry ${entry.id}] Feeding ${originalAudioData.length} audio chunks to muxer.`);
            for (const chunk of entry.audio.data) {
                if (!entry.muxer) throw new Error("Muxer became null during audio chunk processing.");
                entry.muxer.addAudioChunkRaw(chunk.buffer, chunk.type, chunk.timestamp, chunk.duration);
            }

            if (!entry.muxer) throw new Error("Muxer is null before finalize, something went wrong.");

            entry.muxer.finalize();
            const { buffer } = entry.muxer.target;
            const blobForLog = new Blob([buffer], { type: 'video/mp4' }); // For logging size
            console.log(`MediaCache: [Entry ${entry.id}] Muxing finalized. Blob size: ${blobForLog.size}`);

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
                        console.log(`MediaCache: [Entry ${entry.id}] attemptimg to remove from arr due to successful processing and delete_entries flag. Arr size before: ${arr.length}`);
                        arr.splice(itemIndex, 1);
                        console.log(`MediaCache: [Entry ${entry.id}] removed. Arr size after: ${arr.length}. IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
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
                    console.log(`MediaCache: [Entry ${entry.id}] attemptimg to remove from arr due to successful processing and delete_entries flag. Arr size before: ${arr.length}`);
                    arr.splice(itemIndex, 1);
                    console.log(`MediaCache: [Entry ${entry.id}] removed. Arr size after: ${arr.length}. IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
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
            // titleToUse will be set later with new extension logic
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

    let fileExtension = "media"; // Default fallback extension
    if (targetStreamInfo.codec) {
        switch (targetStreamInfo.codec.toLowerCase()) { // Use toLowerCase for safety
            case 'avc':
            case 'h264':
                fileExtension = 'mp4';
                break;
            case 'hevc':
            case 'h265':
                fileExtension = 'mp4';
                break;
            case 'vp9':
                fileExtension = 'webm';
                break;
            case 'av1':
                fileExtension = 'mp4';
                break;
            case 'aac':
                fileExtension = 'aac';
                break;
            case 'opus':
                fileExtension = 'opus';
                break;
            case 'mp3':
                fileExtension = 'mp3';
                break;
            case 'vorbis':
                fileExtension = 'ogg';
                break;
            default:
                fileExtension = targetStreamInfo.codec.length <= 4 ? targetStreamInfo.codec : 'media';
                console.warn(`MediaCache: singleDownload - Unhandled codec '${targetStreamInfo.codec}' for extension, using '.${fileExtension}'`);
        }
    } else {
        console.warn(`MediaCache: singleDownload - Codec is null for ${streamType}, using default extension '.media'`);
    }
    fileExtension = fileExtension.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    titleToUse = `${currentItem.title} [${streamType} only].${fileExtension}`;


    let blobMimeType = isVideo ? 'video/mp4' : 'audio/aac'; // Sensible general defaults
    if (targetStreamInfo.mimeType) {
        blobMimeType = targetStreamInfo.mimeType;
    } else if (targetStreamInfo.codec) {
        const codecLower = targetStreamInfo.codec.toLowerCase();
        if (isVideo) {
            if (['avc', 'h264', 'hevc', 'h265', 'av1'].includes(codecLower)) blobMimeType = `video/mp4`;
            else if (codecLower === 'vp9') blobMimeType = `video/webm`;
            else blobMimeType = `video/${codecLower}`;

        } else { // Audio
             if (codecLower === 'aac') blobMimeType = 'audio/aac';
             else if (codecLower === 'opus') blobMimeType = 'audio/opus';
             else if (codecLower === 'mp3') blobMimeType = 'audio/mpeg';
             else if (codecLower === 'vorbis') blobMimeType = 'audio/ogg';
             else blobMimeType = `audio/${codecLower}`;
        }
    }
    console.log(`MediaCache: singleDownload - Using Blob MIME type: ${blobMimeType} for ${titleToUse}`);
    const blob = new Blob(buffersToDownload, { type: blobMimeType });

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
                console.log("MediaCache: Received 'stop' action. Clearing arr. Arr size before:", arr.length);
                arr = [];
                picker = undefined; // Also reset picker as per original logic
                console.log("MediaCache: arr cleared. Picker reset.");
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
                const requestedId = msg.data.content;
                console.log(`MediaCache: [Inst: ${scriptInstanceId}] Received 'downloadThis' for ID: ${requestedId}. Current arr IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
                const itemToDownload = arr.find(item => item.id === requestedId);
                if (itemToDownload) {
                    console.log(`MediaCache: [Inst: ${scriptInstanceId}] [Entry ${requestedId}] found for downloadThis. ProcessingAttempted: ${itemToDownload.processingAttempted}`);
                    finalizeMuxingAndDownload(itemToDownload);
                } else {
                    console.warn(`MediaCache: [Inst: ${scriptInstanceId}] downloadThis - item with ID ${requestedId} NOT FOUND in arr.`);
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
                const itemIndexDel = arr.findIndex(item => item.id === msg.data.content.id);
                if (itemIndexDel === -1) {
                    console.warn("MediaCache: deleteThis - item not found:", msg.data.content.id);
                    return;
                }
                console.log(`MediaCache: [Entry ${msg.data.content.id}] deleteThis action. Permanent: ${msg.data.content.permanent}. Arr size before: ${arr.length}`);
                if (msg.data.content.permanent) {
                    if (arr[itemIndexDel].video && arr[itemIndexDel].video.writable) arr[itemIndexDel].video.writable.close().catch(e=>console.warn(e));
                    if (arr[itemIndexDel].audio && arr[itemIndexDel].audio.writable) arr[itemIndexDel].audio.writable.close().catch(e=>console.warn(e));
                    // TODO: If permanent also means deleting from FS, need file handles to call remove()
                    arr.splice(itemIndexDel, 1);
                    console.log(`MediaCache: [Entry ${msg.data.content.id}] permanently deleted. Arr size after: ${arr.length}. IDs: ${arr.map(e=>e.id.substring(0,8)).join(', ')}`);
                } else {
                    if (arr[itemIndexDel].video) arr[itemIndexDel].video.data = [];
                    if (arr[itemIndexDel].audio) arr[itemIndexDel].audio.data = [];
                    console.log(`MediaCache: [Entry ${msg.data.content.id}] in-memory data cleared.`);
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