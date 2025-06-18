const fs = require('fs');
const path = require('path');
const jszip = require('jszip');
const crypto = require('crypto');
const download = require('download-git-repo');
const os = require('os');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { spawn } = require('child_process'); // Added

const FILES_TO_PACKAGE = [
    "manifest.json",
    "background.js",
    "script.js",
    "bridge.js",
    "ui/comms.js",
    "ui/style.css",
    "ui/ui.html",
    "ui/assets/icon-16.png",
    "ui/assets/icon-48.png",
    "ui/assets/icon-128.png",
    "ui/assets/icon.svg"
];

const BINARY_FILES_EXTENSIONS = ['.png', '.svg'];
const JS_FILES_FOR_CHANNEL_REPLACEMENT = ["background.js", "script.js", "bridge.js", "comms.js"];

function adaptContent(fullFilePath, fileDataRaw, isFirefox, channelId) {
    const fileExtension = path.extname(fullFilePath);
    const baseName = path.basename(fullFilePath);

    if (BINARY_FILES_EXTENSIONS.includes(fileExtension.toLowerCase())) {
        return fileDataRaw;
    }

    let contentStr = fileDataRaw.toString('utf-8');

    if (fileExtension === '.js' && JS_FILES_FOR_CHANNEL_REPLACEMENT.includes(baseName)) {
        contentStr = contentStr.replace(/CUSTOM_MEDIACACHE_EXTENSION_COMMUNICATION/g, channelId);
    }

    if (baseName === 'manifest.json') {
        try {
            let manifest = JSON.parse(contentStr);
            if (isFirefox) {
                if (manifest.background && manifest.background.service_worker) {
                    manifest.background.scripts = [manifest.background.service_worker];
                    delete manifest.background.service_worker;
                }
            } else { // For Chrome
                if (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko) {
                    delete manifest.browser_specific_settings.gecko;
                    if (Object.keys(manifest.browser_specific_settings).length === 0) {
                        delete manifest.browser_specific_settings;
                    }
                }
            }
            contentStr = JSON.stringify(manifest, null, 2);
        } catch (e) {
            console.error(`Error parsing manifest.json (${fullFilePath}): ${e.message}. Content will be included as is (original text).`);
            // contentStr already holds the original string if parsing fails
        }
    }
    return contentStr;
}

// New createPackage function starts here
async function createPackage(isFirefox, projectRootPath) {
    const channelId = crypto.randomUUID().replace(/-/g, '');
    const shortChannelId = channelId.substring(0, 8);

    if (isFirefox) {
        console.log(`Starting Firefox package creation from source: ${projectRootPath}`);
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `firefox-build-${shortChannelId}-`));
        console.log(`Created temporary staging directory for Firefox: ${stagingDir}`);

        try {
            console.log(`Populating staging directory with adapted files...`);
            for (const relativeFilePath of FILES_TO_PACKAGE) {
                const sourceFilePath = path.join(projectRootPath, relativeFilePath);
                const destFilePath = path.join(stagingDir, relativeFilePath);

                if (!fs.existsSync(sourceFilePath)) {
                    console.error(`Error: Source file not found - ${sourceFilePath}`);
                    throw new Error(`Required file not found in source project: ${relativeFilePath}`);
                }

                const fileDataRaw = fs.readFileSync(sourceFilePath);
                fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
                const adaptedContent = adaptContent(sourceFilePath, fileDataRaw, true, channelId);
                fs.writeFileSync(destFilePath, adaptedContent);
            }
            console.log(`Adapted files copied to staging directory: ${stagingDir}`);

            const apiKey = process.env.AMO_JWT_ISSUER;
            const apiSecret = process.env.AMO_JWT_SECRET;

            if (apiKey && apiSecret) {
                console.log("AMO API credentials (AMO_JWT_ISSUER, AMO_JWT_SECRET) found. Attempting to sign the Firefox extension...");

                const artifactsDir = process.cwd();

                console.log(`Running web-ext sign. Source: "${stagingDir}", Artifacts output directory: "${artifactsDir}"`);

                const webExtArgs = [
                    'sign',
                    '--source-dir', stagingDir,
                    '--api-key', apiKey,
                    '--api-secret', apiSecret,
                    '--artifacts-dir', artifactsDir
                ];

                const webExtProcess = spawn('npx', ['web-ext', ...webExtArgs], { stdio: 'inherit' });

                await new Promise((resolve, reject) => {
                    webExtProcess.on('close', (code) => {
                        if (code === 0) {
                            console.log(`web-ext sign completed successfully. Signed XPI should be in "${artifactsDir}".`);
                            resolve();
                        } else {
                            console.error(`web-ext sign failed with exit code ${code}.`);
                            reject(new Error(`web-ext sign process failed. Review output for details.`));
                        }
                    });
                    webExtProcess.on('error', (err) => {
                        console.error('Failed to start or run web-ext process. Ensure "web-ext" is installed (it should be a dependency) and "npx" is available.', err);
                        reject(err);
                    });
                });

            } else {
                console.warn("Warning: AMO API credentials (AMO_JWT_ISSUER, AMO_JWT_SECRET) not found in environment variables.");
                console.log("Creating an unsigned ZIP package for Firefox instead.");

                const zip = new jszip();
                function addFilesToZip(currentPathInStaging, zipPathPrefix) {
                    const entries = fs.readdirSync(currentPathInStaging, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullEntryPath = path.join(currentPathInStaging, entry.name);
                        const zipEntryPath = path.join(zipPathPrefix, entry.name).replace(/\\/g, '/'); // Ensure forward slashes in zip
                        if (entry.isDirectory()) {
                            addFilesToZip(fullEntryPath, zipEntryPath);
                        } else {
                            zip.file(zipEntryPath, fs.readFileSync(fullEntryPath));
                        }
                    }
                }
                addFilesToZip(stagingDir, '');

                const unsignedOutputFileName = path.join(process.cwd(), `media_cache_firefox_unsigned-${shortChannelId}.zip`);
                const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
                fs.writeFileSync(unsignedOutputFileName, buffer);
                console.log(`Successfully created unsigned Firefox package: ${unsignedOutputFileName}`);
            }

        } finally {
            if (stagingDir && fs.existsSync(stagingDir)) {
                console.log(`Cleaning up Firefox staging directory: ${stagingDir}`);
                try {
                    if (fs.rmSync) {
                        fs.rmSync(stagingDir, { recursive: true, force: true });
                    } else {
                        fs.rmdirSync(stagingDir, { recursive: true });
                    }
                } catch (e) {
                    console.error(`Failed to cleanup staging directory ${stagingDir}: ${e.message}. Please remove it manually.`);
                }
            }
        }

    } else { // For Chrome (non-Firefox builds)
        console.log(`Starting Chrome package creation from source: ${projectRootPath}`);
        console.log(`Using Channel ID: ${channelId} (short: ${shortChannelId})`);
        const zip = new jszip();
        for (const relativeFilePath of FILES_TO_PACKAGE) {
            const fullFilePath = path.join(projectRootPath, relativeFilePath);
            if (!fs.existsSync(fullFilePath)) {
                console.error(`Error: File not found in source - ${fullFilePath}`);
                throw new Error(`Required file not found in source project: ${relativeFilePath}`);
            }
            const fileDataRaw = fs.readFileSync(fullFilePath);
            const adaptedData = adaptContent(fullFilePath, fileDataRaw, false, channelId);
            zip.file(relativeFilePath, adaptedData);
        }
        const outputFileName = path.join(process.cwd(), `media_cache_chrome-${shortChannelId}.zip`);
        const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
        fs.writeFileSync(outputFileName, buffer);
        console.log(`Successfully created Chrome package: ${outputFileName}`);
    }
}
// End of new createPackage function

// IIFE using yargs (should be unchanged from previous step)
(async () => {
    let projectRootPath;
    let tempDir = null;

    const argv = yargs(hideBin(process.argv))
        .option('source', {
            alias: 's',
            type: 'string',
            description: 'Source directory (local path) or GitHub URL (e.g., https://github.com/user/repo). If not provided, uses the current working directory.',
            defaultDescription: 'Current working directory'
            // No 'default' field here, so 'argv.source' will be undefined if option is not used.
        })
        .option('targetBrowsers', {
            alias: 't',
            type: 'string',
            description: "Comma-separated list of browsers to build for (e.g., 'chrome', 'firefox', 'both').",
            default: 'both', // yargs provides 'both' if option is not specified.
            coerce: (arg) => {
                if (typeof arg === 'string') {
                    const validTargets = new Set(['chrome', 'firefox']);
                    let targets = arg.toLowerCase().split(',').map(s => s.trim());
                    if (targets.includes('both')) return ['firefox', 'chrome'];
                    targets = targets.filter(t => validTargets.has(t));
                    return targets.length > 0 ? targets : ['firefox', 'chrome'];
                }
                return ['firefox', 'chrome']; // Default for non-string or problematic input.
            }
        })
        .help()
        .alias('help', 'h')
        .version(false) // Disable the default --version flag.
        .argv;

    try {
        const sourceArg = argv.source;
        const targets = argv.targetBrowsers;

        if (targets.length === 0) {
            console.error("Error: No valid target browsers specified or determined. Use 'chrome', 'firefox', or 'both'.");
            process.exit(1);
        }

        if (!sourceArg) {
            projectRootPath = path.resolve(process.cwd());
            console.log(`Build process starting. No source argument provided, using current directory: ${projectRootPath}`);
        } else if (sourceArg.startsWith('https://github.com/') || sourceArg.startsWith('git@github.com:')) {
            projectRootPath = null;
            let repoStringForDownload = sourceArg;

            if (repoStringForDownload.includes('github.com/')) {
                const urlParts = sourceArg.split('github.com/');
                repoStringForDownload = urlParts[1];
                if (repoStringForDownload.endsWith('.git')) {
                    repoStringForDownload = repoStringForDownload.slice(0, -'.git'.length);
                }
            } else if (repoStringForDownload.startsWith('git@github.com:')) {
                repoStringForDownload = repoStringForDownload.substring('git@github.com:'.length);
                if (repoStringForDownload.endsWith('.git')) {
                    repoStringForDownload = repoStringForDownload.slice(0, -'.git'.length);
                }
            }

            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ext-build-'));
            console.log(`Build process starting. GitHub repository detected: ${sourceArg}`);
            console.log(`Attempting to download "${repoStringForDownload}" to temporary directory: ${tempDir}...`);

            await new Promise((resolve, reject) => {
                download(repoStringForDownload, tempDir, (err) => {
                    if (err) {
                        let alternativeRepoString = `github:${repoStringForDownload}`;
                        console.warn(`Initial download attempt failed for "${repoStringForDownload}". Retrying with "${alternativeRepoString}"...`);
                        download(alternativeRepoString, tempDir, (err2) => {
                            if (err2) {
                                console.error(`Error downloading repository "${repoStringForDownload}" (also tried "${alternativeRepoString}"): ${err2.message}`);
                                reject(err2);
                            } else {
                                console.log(`Repository downloaded successfully as "${alternativeRepoString}".`);
                                projectRootPath = tempDir;
                                resolve();
                            }
                        });
                    } else {
                        console.log("Repository downloaded successfully.");
                        projectRootPath = tempDir;
                        resolve();
                    }
                });
            });

            if (projectRootPath && !fs.existsSync(path.join(projectRootPath, 'manifest.json'))) {
                console.warn(`Warning: manifest.json not found in the root of the downloaded repository from ${sourceArg}. The build might fail if required files are missing.`);
            }

        } else {
            projectRootPath = path.resolve(sourceArg);
            console.log(`Build process starting. Using local project source: ${projectRootPath}`);
            if (!fs.existsSync(projectRootPath)) {
                console.error(`Error: Specified source directory does not exist: ${projectRootPath}`);
                process.exit(1);
            }
            if (!fs.lstatSync(projectRootPath).isDirectory()) {
                console.error(`Error: Specified source path is not a directory: ${projectRootPath}`);
                process.exit(1);
            }
        }

        if (!projectRootPath) {
             console.error("Error: Project source path could not be determined or downloaded.");
             process.exit(1);
        }

        console.log(`Target browsers: ${targets.join(', ')}`);

        if (targets.includes('firefox')) {
            await createPackage(true, projectRootPath);
        }
        if (targets.includes('chrome')) {
            await createPackage(false, projectRootPath);
        }

        console.log("Build process finished successfully.");

    } catch (error) {
        console.error("Build failed. Review messages above for more details.");
        process.exit(1);
    } finally {
        if (tempDir) {
            try {
                if (fs.rmSync) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } else {
                    fs.rmdirSync(tempDir, { recursive: true });
                }
                console.log(`Cleaned up temporary directory: ${tempDir}`);
            } catch (e) {
                console.error(`Error cleaning up temporary directory ${tempDir}: ${e.message}. Please remove it manually.`);
            }
        }
    }
})();
