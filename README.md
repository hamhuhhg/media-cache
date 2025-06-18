# media-cache

Cache the video/audio content displayed by various websites, and download it

## Installation:

Download the zip file for your browser from the
[Releases tab](https://github.com/Dinoosauro/media-cache/releases). Then,
depending on your browser:

### Chromium:

Go to the `chrome://extensions` page, and enable the `Developer mode` slider.
Extract the .zip file, and then on your browser click on the
`Load unpacked extension` button. Choose the directory where you've extracted
the .zip file, and the extension will be installed.

### Firefox

Just download it from Mozilla Addons:
https://addons.mozilla.org/it/firefox/addon/media-cache

If you want to sideload it, go to `about:debugging#/runtime/this-firefox`, and
click on the `Load Temporary Add-on` button. Choose the .zip file, and the
extension will be installed.

### Other browsers

There's a script that can be run from the DevTools's console (or other tools
that permit to run JavaScript code in webpages). Look at the
[latest release](https://github.com/Dinoosauro/media-cache/releases), and
copy/paste the:

- `ConsoleScript-UI.js` file if you want to have a button at the top-right
  corner to download the content
- `ConsoleScript-Console.js` file if you want to use the script directly from
  the console. Documentation on the available commands will be added soon.

In case you've chosen the UI, you'll find a button with the download icon at the
top-right. Click it to show the available downloads. To download an item, click
it to load the Blob in the memory, and then click it again (before 5 seconds) if
the download doesn't automatically start. You can also delete the content in
memory if you think it's useless.

## Adding URLs to cache

This extension should work for every website that uses the MediaSource API. To
add a website to cache, click on the extension and write the hostname. Note that
you need to follow a specific syntax to add the URL. For example:

- `*://*.example.com/*`: both for HTTP and HTTPS, cache every video that is
  played from the "example.com" domain
- `https://ex.example.com/*`: cache only videos played from the "ex.example.com"
  domain
- `https://example.com/page`: cache only videos that are played from that
  specific page

## Downloading content

After playing the resource, you can choose from a Select in the popup the page
whose video/audio content you want to download. Click on the "Download" button
to download them.

**Tip: On Chromium-based browsers, you can write files directly to a folder. Use
this option to save memory**

While the download of the videos should automatically start when the page is
closed, or when the video ends playing, it might not always work, so it's
suggested to download them directly from the extension popup.

## Building from Source

If you want to build the extension packages (`.zip` or `.xpi` files for Chrome and Firefox) from the source code, you can use the provided Node.js script. This is useful for development, creating custom builds, or packaging a modified version of the extension.

### Prerequisites

*   **Node.js:** You'll need Node.js installed (which includes npm). You can download it from [nodejs.org](https://nodejs.org/). It's also recommended to ensure that the installation directory for Node.js and npm (which includes `npx`) is correctly added to your system's PATH environment variable for general command-line tool compatibility, although the build script attempts to run `web-ext` directly from project dependencies.
    (The `web-ext` tool for Firefox signing is included as a project dependency and will be installed automatically with `npm install`.)

### Setup

1.  Clone the repository (if you haven't already):
    ```bash
    git clone https://github.com/Dinoosauro/media-cache.git
    cd media-cache
    ```
2.  Install the necessary dependencies (including `web-ext`):
    ```bash
    npm install
    ```

### Packaging Script Usage

The script `create_extension_packages.js` is used to generate the browser-specific ZIP packages. You can run it using npm:

```bash
npm run package -- [options]
```
Note the `--` before specifying options when using `npm run package`. Alternatively, you can run it directly:
```bash
node create_extension_packages.js [options]
```

**Available Options:**

*   `-s, --source <path_or_url>`:
    *   Specifies the source for the build.
    *   If not provided, it defaults to the current working directory.
    *   **Local Path Example:** `npm run package -- --source ./path/to/extension/source`
    *   **GitHub URL Example:** `npm run package -- --source https://github.com/user/repo`

*   `-t, --targetBrowsers <browsers>`:
    *   A comma-separated list of browsers to build for.
    *   Accepted values: `chrome`, `firefox`, `both`.
    *   Defaults to `both` if not specified.
    *   **Examples:**
        *   `npm run package -- --targetBrowsers chrome` (only build for Chrome)
        *   `npm run package -- --targetBrowsers firefox,chrome` (build for Firefox and Chrome)

*   `-h, --help`:
    *   Displays help information about the script and its options.

### Output

The script will generate the following files in the current working directory (where you run the command). Filenames include a short unique ID for each build:

*   **For Chrome:** `media_cache_chrome-[id].zip` (e.g., `media_cache_chrome-1a2b3c4d.zip`)
*   **For Firefox:**
    *   If AMO API keys are provided and signing is successful: A signed `.xpi` file. The exact filename is determined by `web-ext` based on the extension's ID and version from its `manifest.json` (e.g., `media_cache-1.2.3.xpi`).
    *   If AMO API keys are not provided or signing fails: An unsigned `media_cache_firefox_unsigned-[id].zip` (e.g., `media_cache_firefox_unsigned-1a2b3c4d.zip`).

### Firefox Add-on Signing

The build script can now automatically sign the Firefox add-on using `web-ext` if you provide your Mozilla Add-ons (AMO) API credentials.

**Providing AMO API Credentials:**

To enable automatic signing, you must set the following environment variables before running the packaging script:

*   `AMO_JWT_ISSUER`: Your JWT issuer key from AMO.
*   `AMO_JWT_SECRET`: Your JWT secret key from AMO.

**Example (Linux/macOS - bash/zsh):**
```bash
export AMO_JWT_ISSUER="your_issuer_key_here"
export AMO_JWT_SECRET="your_secret_key_here"
npm run package -- --targetBrowsers firefox
```

**Example (Windows - Command Prompt):**
```batch
set AMO_JWT_ISSUER="your_issuer_key_here"
set AMO_JWT_SECRET="your_secret_key_here"
npm run package -- --targetBrowsers firefox
```

**Example (Windows - PowerShell):**
```powershell
$env:AMO_JWT_ISSUER="your_issuer_key_here"
$env:AMO_JWT_SECRET="your_secret_key_here"
npm run package -- --targetBrowsers firefox
```

**Security Note:** Treat your AMO API keys like passwords. Using environment variables is generally safer than hardcoding them into scripts or passing them as command-line arguments. Do not commit them to your version control.

**Signing Process:**

*   If the `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` environment variables are set, the script will invoke `web-ext sign`.
*   You will see output from `web-ext` directly in your console. This includes progress and any success or error messages from Mozilla's signing service.
*   If signing is successful, a signed `.xpi` file will be placed in the current working directory.
*   If the environment variables are not set, the script will skip signing and produce an unsigned `.zip` file for Firefox (e.g., `media_cache_firefox_unsigned-[id].zip`), along with a warning message. This unsigned ZIP can be submitted manually to AMO for signing or used for development via `about:debugging`.

## Disclaimer

Please use this extension only if you've the authorization from the original
content owner to do so. I don't claim any responsibilties at all for the usage
of this extension and the eventual consequences.
