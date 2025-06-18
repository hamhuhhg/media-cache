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

If you want to build the extension packages (`.zip` files for Chrome and Firefox) from the source code, you can use the provided Node.js script. This is useful for development or if you want to package a modified version of the extension.

### Prerequisites

*   **Node.js:** You'll need Node.js installed (which includes npm). You can download it from [nodejs.org](https://nodejs.org/).
*   **Git (optional):** If you plan to build from a GitHub repository URL directly, and the `download-git-repo` library needs it as a fallback or for specific URL types (though typically it tries to avoid this). For local builds or direct downloads, Git might not be strictly necessary on the system.

### Setup

1.  Clone the repository (if you haven't already):
    ```bash
    git clone https://github.com/Dinoosauro/media-cache.git
    cd media-cache
    ```
2.  Install the necessary dependencies:
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

The script will generate the following files in the current working directory (where you run the command):

*   `media_cache_firefox.zip`: The packaged extension for Firefox.
*   `media_cache_chrome.zip`: The packaged extension for Chrome.

### Firefox Add-on Signing

**Important:** The `media_cache_firefox.zip` generated by this script is a packaged add-on, ready for submission. To be installed permanently in Firefox, it must be signed by Mozilla.
You can submit this ZIP file to the [Firefox Add-on Developer Hub (AMO)](https://addons.mozilla.org/developers/) for review and signing. The script itself **does not** perform the electronic signing.
Alternatively, for development, you can temporarily install the unsigned ZIP file in Firefox via `about:debugging`.

## Disclaimer

Please use this extension only if you've the authorization from the original
content owner to do so. I don't claim any responsibilties at all for the usage
of this extension and the eventual consequences.
