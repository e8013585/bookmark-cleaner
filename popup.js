"use strict";

(function () {
  /* ── helpers ── */
  const msg = (key) => chrome.i18n.getMessage(key) || key;

  function applyRTL() {
    const lang = chrome.i18n.getUILanguage().toLowerCase().split("-")[0];
    if (["ar", "he", "fa", "ur"].includes(lang)) {
      document.body.classList.add("rtl");
      document.documentElement.setAttribute("dir", "rtl");
      document.documentElement.setAttribute("lang", lang);
    } else {
      document.documentElement.setAttribute("lang", lang);
    }
  }

  function applyTheme() {
    chrome.storage.local.get(["theme"], (res) => {
      if (res.theme === "light") document.body.classList.add("light");
    });
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /* ── localise static strings ── */
  function localise() {
    setText("popup-title",   msg("extName"));
    setText("stat-bk-label", msg("popupBookmarks"));
    setText("stat-fl-label", msg("popupFolders"));
    setText("open-manager-btn", msg("popupOpenManager"));
    setText("popup-tagline", msg("popupTagline"));
  }

  /* ── count bookmarks ── */
  function countTree(nodes, counts) {
    for (const node of nodes) {
      if (node.url) {
        counts.bookmarks++;
      } else {
        counts.folders++;
      }
      if (node.children) countTree(node.children, counts);
    }
  }

  function loadStats() {
    setText("popup-loading", msg("popupLoading"));
    chrome.bookmarks.getTree((tree) => {
      const counts = { bookmarks: 0, folders: 0 };
      countTree(tree, counts);
      counts.folders = Math.max(0, counts.folders - 1);
      setText("stat-bk-num",   counts.bookmarks.toLocaleString());
      setText("stat-fl-num",   counts.folders.toLocaleString());
      setText("popup-loading", "");
    });
  }

  /* ── open manager ── */
  function bindOpenButton() {
    const btn = document.getElementById("open-manager-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      window.close();
    });
  }

  /* ── init ── */
  document.addEventListener("DOMContentLoaded", () => {
    applyRTL();
    applyTheme();
    localise();
    loadStats();
    bindOpenButton();
  });
})();
