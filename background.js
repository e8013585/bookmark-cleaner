"use strict";

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[BookmarkCleaner] Installed:", details.reason);
});
