# Bookmark Cleaner

> Find duplicates, broken links, organize and search all your bookmarks — fast and clean.

A privacy-first Chrome extension that helps you take control of your bookmark collection. Built with Manifest V3, fully internationalised, and with zero external dependencies.

---

## Features

- **Find Duplicates** — Scans every bookmark and groups those sharing the same normalised URL (UTM parameters stripped, `www.` normalised). Keep the one you want, delete the rest, or use the auto-select mode to keep only the oldest entry per group.
- **Broken Links** — Detects bookmarks with empty URLs, malformed URLs, local-file schemes, non-web protocols (`chrome:`, `data:`, `javascript:`, etc.), and entries whose title matches their URL (suggesting the favicon/title never loaded).
- **Organise & Sort** — Sort bookmarks alphabetically (A→Z, Z→A), by domain, or folders-first. Preview before applying. Optionally sort recursively into all subfolders.
- **Search & Filter** — Real-time full-text search across title and URL, with `<mark>` highlighting. Filter by top-level folder via chip buttons. Inline edit titles or delete with confirmation.
- **Undo Toast** — Every deletion is backed by an 8-second undo window. Restore deleted bookmarks to their original parent folder and position.
- **Dark / Light Theme** — Persistent theme preference stored locally. Sidebar toggle switches between modes.
- **RTL Support** — Automatically detected and applied for Arabic, Hebrew, Farsi, and Urdu locales.
- **Internationalisation (i18n)** — All user-facing strings loaded via `chrome.i18n`. English locale included; add others by creating `_locales/<lang>/messages.json`.

---

## Permissions Justification

| Permission | Why it's required                                                                         |
|------------|-------------------------------------------------------------------------------------------|
| `bookmarks`| Read the bookmark tree to scan, search, and display counts; create, move, and delete bookmarks and folders as the user directs. |
| `storage`  | Persist the user's theme preference (dark/light) across sessions. No other data is stored. |

The extension makes no network requests, collects no analytics, serves no ads, and communicates with no remote servers. All bookmark data stays on your device and is processed entirely in the extension's own context.

---

## Installing from source

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `bookmark-cleaner/` directory.
5. The extension icon appears in the toolbar. Click it to open the popup, then **Open Bookmark Manager** for the full interface.

### Building for the Chrome Web Store

1. Replace the placeholder icons in `icons/` with your own branded assets (16, 32, 48, and 128 px PNGs).
2. Optionally add locale folders (copy `_locales/en/messages.json` into `_locales/fr/`, `_locales/de/`, etc., and translate the values).
3. Zip the entire `bookmark-cleaner/` directory and upload to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## File Structure

```
bookmark-cleaner/
├── manifest.json           # MV3 manifest, permissions, icons
├── background.js           # Service worker (onInstalled listener)
├── popup.html              # Popup launcher (300px)
├── popup.css               # Popup styles
├── popup.js                # Popup logic (stats, i18n, theme)
├── index.html              # Full-page app shell
├── index.css               # Complete application styles
├── index.js                # All application logic
├── _locales/
│   └── en/
│       └── messages.json   # English locale strings
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
├── CWS_DESCRIPTION.md
└── PRIVACY_POLICY.html
```

---

## Development

No build tools or bundlers required. The extension is pure vanilla JavaScript, CSS, and HTML loaded directly by Chrome. Edit any file and reload the extension at `chrome://extensions`.

### Localisation

All user-facing text is looked up via `chrome.i18n.getMessage(key)`. The English locale is at `_locales/en/messages.json`. To add a new language:

1. Create `_locales/<lang>/messages.json` (e.g., `_locales/fr/`).
2. Copy the key structure from the English file and translate the `"message"` values.
3. The extension automatically detects the browser UI language and applies the right locale — and sets RTL direction for Arabic, Hebrew, Farsi, and Urdu.

---

## Privacy

Bookmark Cleaner **does not** collect, transmit, or store any personal data. All operations are performed locally on your device. See [`PRIVACY_POLICY.html`](PRIVACY_POLICY.html) for the full privacy policy.

---

## License

MIT — see the license file for details.
