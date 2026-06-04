"use strict";

/* ═══════════════════════════════════════════════════════════════
   BOOKMARK CLEANER — index.js
   Full application logic. No external dependencies.
═══════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────
   0. HELPERS & CONSTANTS
──────────────────────────────────────────────────────────── */
const msg = (key, subs) => {
  const m = chrome.i18n.getMessage(key, subs);
  return m || key;
};

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function ce(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.cls)   (Array.isArray(opts.cls) ? opts.cls : [opts.cls]).forEach(c => c && el.classList.add(c));
  if (opts.text)  el.textContent = opts.text;
  if (opts.attrs) Object.entries(opts.attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (opts.aria)  Object.entries(opts.aria).forEach(([k, v]) => el.setAttribute("aria-" + k, v));
  return el;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatNumber(n) {
  return n.toLocaleString();
}

/* Favicon URL helper */
function faviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=32`;
  } catch (_) {
    return "";
  }
}

/* Build a breadcrumb string from a folder-path array */
function pathString(path) {
  return path.join(" \u203A ");
}

/* ────────────────────────────────────────────────────────────
   1. RTL + THEME SETUP
──────────────────────────────────────────────────────────── */
function applyRTL() {
  const lang = chrome.i18n.getUILanguage().toLowerCase().split("-")[0];
  document.documentElement.setAttribute("lang", lang);
  if (["ar", "he", "fa", "ur"].includes(lang)) {
    document.body.classList.add("rtl");
    document.documentElement.setAttribute("dir", "rtl");
  }
}

function applyTheme(theme) {
  if (theme === "light") {
    document.body.classList.add("light");
    $("#theme-icon-dark").classList.add("hidden");
    $("#theme-icon-light").classList.remove("hidden");
  } else {
    document.body.classList.remove("light");
    $("#theme-icon-dark").classList.remove("hidden");
    $("#theme-icon-light").classList.add("hidden");
  }
}

async function initTheme() {
  return new Promise(resolve => {
    chrome.storage.local.get(["theme"], (res) => {
      applyTheme(res.theme || "dark");
      resolve(res.theme || "dark");
    });
  });
}

function toggleTheme() {
  const isLight = document.body.classList.contains("light");
  const next = isLight ? "dark" : "light";
  chrome.storage.local.set({ theme: next });
  applyTheme(next);
}

/* ────────────────────────────────────────────────────────────
   2. GLOBAL STATE
──────────────────────────────────────────────────────────── */
const State = {
  allBookmarks: [],
  allFolders: [],
  bookmarkTree: null,
  currentView: "home",
  undoStack: null,
};

/* ────────────────────────────────────────────────────────────
   3. BOOKMARK TREE UTILITIES
──────────────────────────────────────────────────────────── */
function flattenTree(nodes, flat = [], folders = [], path = []) {
  for (const node of nodes) {
    if (node.url) {
      flat.push({ ...node, _path: [...path] });
    } else {
      const newPath = [...path, node.title || msg("unknownFolder")];
      folders.push({ ...node, _path: [...path] });
      if (node.children) flattenTree(node.children, flat, folders, newPath);
    }
  }
  return { flat, folders };
}

/* Build full folder path for a node given the tree */
function buildFolderPath(nodeId, tree) {
  const map = {};
  function index(nodes) {
    for (const n of nodes) {
      map[n.id] = n;
      if (n.children) index(n.children);
    }
  }
  index(tree);

  const path = [];
  let current = map[nodeId];
  while (current && current.parentId) {
    current = map[current.parentId];
    if (current && current.title) path.unshift(current.title);
  }
  return path;
}

function countBookmarks(nodes) {
  let bk = 0, fl = 0;
  function walk(ns) {
    for (const n of ns) {
      if (n.url) bk++;
      else { fl++; if (n.children) walk(n.children); }
    }
  }
  walk(nodes);
  return { bookmarks: bk, folders: fl };
}

function estimateDuplicates(flat) {
  const seen = new Map();
  let count = 0;
  for (const bk of flat) {
    const key = normalizeUrl(bk.url);
    if (!key) continue;
    const prev = seen.get(key) || 0;
    if (prev === 1) count++;
    if (prev >= 1) count++;
    seen.set(key, prev + 1);
  }
  return count;
}

function estimateEmptyFolders(tree) {
  let count = 0;
  function walk(nodes) {
    for (const n of nodes) {
      if (!n.url) {
        const kids = n.children || [];
        if (kids.length === 0) count++;
        else walk(kids);
      }
    }
  }
  for (const root of tree) {
    if (root.children) walk(root.children);
  }
  return count;
}

/* ────────────────────────────────────────────────────────────
   4. URL NORMALIZATION
──────────────────────────────────────────────────────────── */
const UTM_PARAMS = new Set([
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content"
]);

function normalizeUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    UTM_PARAMS.forEach(k => u.searchParams.delete(k));
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let path = u.pathname.replace(/\/+$/, "") || "";
    const search = u.searchParams.toString();
    return host + path + (search ? "?" + search : "");
  } catch (_) {
    return raw.toLowerCase().trim();
  }
}

/* ────────────────────────────────────────────────────────────
   5. INITIAL LOAD
──────────────────────────────────────────────────────────── */
async function loadBookmarkTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tree);
      }
    });
  });
}

async function initApp() {
  applyRTL();
  await initTheme();
  localiseStaticElements();
  bindSidebar();
  bindThemeToggle();
  bindSidebarToggle();

  const loader = $("#initial-loader");
  const loaderBar = $("#loader-bar");
  const loaderText = $("#loader-text");
  loaderText.textContent = msg("loadingBookmarks");

  let pct = 0;
  const barAnim = setInterval(() => {
    pct = Math.min(pct + 8, 85);
    loaderBar.style.width = pct + "%";
  }, 80);

  try {
    const tree = await loadBookmarkTree();
    State.bookmarkTree = tree;
    const { flat, folders } = flattenTree(tree);
    State.allBookmarks = flat;
    State.allFolders = folders;

    clearInterval(barAnim);
    loaderBar.style.width = "100%";

    await sleep(150);

    const counts = countBookmarks(tree);
    const dupCount = estimateDuplicates(flat);
    const emptyCount = estimateEmptyFolders(tree);

    setHomeStats(counts.bookmarks, Math.max(0, counts.folders - 1), dupCount, emptyCount);
    buildFeatureCards();
    buildFolderSelector();
    buildSortOptions();
    buildSearchChips(tree);
    initSearchView();

    loader.classList.add("hidden");
    showView("home");

  } catch (err) {
    clearInterval(barAnim);
    loaderText.textContent = msg("errorLoadingBookmarks");
    console.error("[BookmarkCleaner]", err);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ────────────────────────────────────────────────────────────
   6. LOCALISE STATIC ELEMENTS
──────────────────────────────────────────────────────────── */
function localiseStaticElements() {
  $$("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    el.textContent = msg(key);
  });

  const sidebar = $("#sidebar");
  if (sidebar) sidebar.setAttribute("aria-label", msg("ariaNav"));

  const themeBtn = $("#theme-toggle");
  if (themeBtn) themeBtn.setAttribute("aria-label", msg("ariaThemeToggle"));

  const sidebarToggle = $("#sidebar-toggle");
  if (sidebarToggle) sidebarToggle.setAttribute("aria-label", msg("ariaSidebarToggle"));

  const searchClear = $("#search-clear-btn");
  if (searchClear) searchClear.setAttribute("aria-label", msg("ariaClearSearch"));

  const searchChipsGroup = $("#search-chips");
  if (searchChipsGroup) searchChipsGroup.setAttribute("aria-label", msg("ariaFilterChips"));

  const viewMap = {
    "view-home":       "navHome",
    "view-duplicates": "navDuplicates",
    "view-broken":     "navBroken",
    "view-organize":   "navOrganize",
    "view-search":     "navSearch",
  };
  Object.entries(viewMap).forEach(([id, key]) => {
    const el = $("#" + id);
    if (el) el.setAttribute("aria-label", msg(key));
  });

  const appName = $("#sidebar-app-name");
  if (appName) appName.textContent = msg("extName");

  setButtonText("dup-scan-btn",        "dupScanBtn");
  setButtonText("dup-select-smart-btn","dupSmartSelectBtn");
  setButtonText("dup-delete-btn",      "dupDeleteBtn");
  setButtonText("brk-scan-btn",        "brkScanBtn");
  setButtonText("brk-delete-btn",      "brkDeleteBtn");
  setButtonText("org-tab-sort",        "orgTabSort");
  setButtonText("org-tab-empty",       "orgTabEmpty");
  setButtonText("sort-preview-btn",    "sortPreviewBtn");
  setButtonText("sort-apply-btn",      "sortApplyBtn");
  setButtonText("empty-scan-btn",      "emptyScanBtn");
  setButtonText("empty-delete-btn",    "emptyDeleteBtn");
  setButtonText("toast-undo-btn",      "undoBtn");

  const si = $("#search-input");
  if (si) si.setAttribute("placeholder", msg("searchPlaceholder"));

  const dupSub = $("#view-duplicates .view-subtitle");
  if (dupSub) dupSub.textContent = msg("duplicatesSubtitle");
  const brkSub = $("#view-broken .view-subtitle");
  if (brkSub) brkSub.textContent = msg("brokenSubtitle");
}

function setButtonText(id, key) {
  const el = $("#" + id);
  if (el) el.textContent = msg(key);
}

/* ────────────────────────────────────────────────────────────
   7. HOME VIEW
──────────────────────────────────────────────────────────── */
function setHomeStats(bookmarks, folders, duplicates, emptyFolders) {
  setText("hs-bookmarks",  formatNumber(bookmarks));
  setText("hs-folders",    formatNumber(folders));
  setText("hs-duplicates", formatNumber(duplicates));
  setText("hs-empty",      formatNumber(emptyFolders));
}

function setText(id, text) {
  const el = $("#" + id);
  if (el) el.textContent = text;
}

function buildFeatureCards() {
  const container = $("#feature-cards");
  if (!container) return;
  container.textContent = "";

  const features = [
    {
      view: "duplicates",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <rect x="9" y="9" width="13" height="13" rx="2"/>
               <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
             </svg>`,
      titleKey: "featureDupTitle",
      descKey:  "featureDupDesc",
    },
    {
      view: "broken",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
               <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
               <line x1="2" y1="2" x2="22" y2="22"/>
             </svg>`,
      titleKey: "featureBrkTitle",
      descKey:  "featureBrkDesc",
    },
    {
      view: "organize",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
               <line x1="12" y1="11" x2="12" y2="17"/>
               <line x1="9" y1="14" x2="15" y2="14"/>
             </svg>`,
      titleKey: "featureOrgTitle",
      descKey:  "featureOrgDesc",
    },
    {
      view: "search",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
               <circle cx="11" cy="11" r="8"/>
               <line x1="21" y1="21" x2="16.65" y2="16.65"/>
             </svg>`,
      titleKey: "featureSrchTitle",
      descKey:  "featureSrchDesc",
    },
  ];

  for (const f of features) {
    const card = ce("div", { cls: "feature-card" });

    const iconWrap = ce("div", { cls: "feature-card-icon" });
    iconWrap.innerHTML = f.icon;

    const title = ce("div", { cls: "feature-card-title", text: msg(f.titleKey) });
    const desc  = ce("div", { cls: "feature-card-desc",  text: msg(f.descKey) });

    const runBtn = ce("button", {
      cls:   ["btn", "btn-primary", "feature-card-run"],
      text:  msg("featureRunBtn"),
      attrs: { type: "button" },
    });

    runBtn.addEventListener("click", () => showView(f.view));
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showView(f.view);
      }
    });

    card.append(iconWrap, title, desc, runBtn);
    container.appendChild(card);
  }
}

/* ────────────────────────────────────────────────────────────
   8. VIEW SWITCHING
──────────────────────────────────────────────────────────── */
const VIEW_TITLES = {
  home:       "navHome",
  duplicates: "navDuplicates",
  broken:     "navBroken",
  organize:   "navOrganize",
  search:     "navSearch",
};

function showView(viewName) {
  $$(".view").forEach(v => v.classList.add("hidden"));

  const target = $("#view-" + viewName);
  if (target) target.classList.remove("hidden");

  $$(".nav-item").forEach(btn => {
    const isActive = btn.dataset.view === viewName;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  });

  const topbarTitle = $("#topbar-title");
  if (topbarTitle) topbarTitle.textContent = msg(VIEW_TITLES[viewName] || "navHome");

  document.body.classList.remove("sidebar-open");
  const sidebarToggle = $("#sidebar-toggle");
  if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", "false");

  State.currentView = viewName;

  const main = $("#main-content");
  if (main) main.scrollTop = 0;
}

/* ────────────────────────────────────────────────────────────
   9. SIDEBAR NAVIGATION BINDING
──────────────────────────────────────────────────────────── */
function bindSidebar() {
  $$(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (view) showView(view);
    });
  });
}

function bindSidebarToggle() {
  const toggle = $("#sidebar-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const open = document.body.classList.toggle("sidebar-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

function bindThemeToggle() {
  const btn = $("#theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", toggleTheme);
}

/* ────────────────────────────────────────────────────────────
   10. FEATURE A — FIND DUPLICATES
──────────────────────────────────────────────────────────── */
function initDuplicatesView() {
  const scanBtn        = $("#dup-scan-btn");
  const smartSelectBtn = $("#dup-select-smart-btn");
  const deleteBtn      = $("#dup-delete-btn");

  scanBtn.addEventListener("click", runDuplicateScan);
  smartSelectBtn.addEventListener("click", dupSmartSelect);
  deleteBtn.addEventListener("click", dupDeleteSelected);
}

async function runDuplicateScan() {
  const scanBtn        = $("#dup-scan-btn");
  const smartSelectBtn = $("#dup-select-smart-btn");
  const deleteBtn      = $("#dup-delete-btn");
  const progress       = $("#dup-progress");
  const progressText   = $("#dup-progress-text");
  const results        = $("#dup-results");

  setLoading([scanBtn, smartSelectBtn, deleteBtn], true);
  progress.classList.remove("hidden");
  results.textContent = "";
  smartSelectBtn.disabled = true;
  deleteBtn.disabled = true;

  try {
    const tree = await loadBookmarkTree();
    State.bookmarkTree = tree;
    const { flat } = flattenTree(tree);
    State.allBookmarks = flat;

    const total = flat.length;
    const groups = new Map();

    for (let i = 0; i < flat.length; i++) {
      if (i % 50 === 0) {
        progressText.textContent = msg("scanProgress", [
          formatNumber(i), formatNumber(total)
        ]);
        await sleep(0);
      }
      const bk = flat[i];
      const key = normalizeUrl(bk.url);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(bk);
    }

    const dupGroups = [];
    groups.forEach((items, key) => {
      if (items.length > 1) dupGroups.push({ key, items });
    });

    progress.classList.add("hidden");
    setLoading([scanBtn], false);

    renderDuplicateGroups(dupGroups, results, smartSelectBtn, deleteBtn);
  } catch (err) {
    progress.classList.add("hidden");
    setLoading([scanBtn], false);
    showErrorToast(msg("errorGeneric"));
    console.error(err);
  }
}

function renderDuplicateGroups(groups, container, smartSelectBtn, deleteBtn) {
  container.textContent = "";

  if (groups.length === 0) {
    container.appendChild(buildEmptyState(
      "emptyDupTitle", "emptyDupDesc", buildCheckSvg()
    ));
    return;
  }

  smartSelectBtn.disabled = false;

  const updateDeleteBtn = () => {
    const checked = $$(".dup-entry input[type='checkbox']:checked", container);
    deleteBtn.disabled = checked.length === 0;
    if (checked.length > 0) {
      deleteBtn.textContent = msg("dupDeleteBtnCount", [formatNumber(checked.length)]);
    } else {
      deleteBtn.textContent = msg("dupDeleteBtn");
    }
  };

  for (const group of groups) {
    const groupEl = ce("div", { cls: "dup-group" });

    const header = ce("div", { cls: "dup-group-header" });

    const fav = ce("img", {
      cls: "dup-favicon",
      attrs: {
        src: faviconUrl(group.items[0].url),
        alt: "",
        loading: "lazy",
        "aria-hidden": "true",
      },
    });
    fav.addEventListener("error", () => { fav.style.visibility = "hidden"; });

    const urlSpan = ce("span", { cls: "dup-group-url" });
    urlSpan.textContent = group.items[0].url;
    urlSpan.title = group.items[0].url;

    const countBadge = ce("span", {
      cls:  "dup-group-count",
      text: msg("dupGroupCount", [String(group.items.length)]),
    });

    header.append(fav, urlSpan, countBadge);
    groupEl.appendChild(header);

    const folderPath = (bk) => {
      const path = buildFolderPath(bk.parentId, State.bookmarkTree);
      return path.join(" \u203A ");
    };

    for (const bk of group.items) {
      const entry = ce("div", { cls: "dup-entry" });
      entry.dataset.id = bk.id;
      entry.dataset.groupKey = group.key;

      const cb = ce("input", { attrs: { type: "checkbox" } });
      cb.setAttribute("aria-label", msg("ariaMarkForDeletion") + " " + (bk.title || bk.url));
      cb.addEventListener("change", updateDeleteBtn);

      const info = ce("div", { cls: "dup-entry-info" });

      const titleEl = ce("div", { cls: "dup-entry-title" });
      titleEl.textContent = bk.title || msg("noTitle");

      const pathEl = ce("div", { cls: "dup-entry-path" });
      pathEl.textContent = folderPath(bk) || msg("rootFolder");

      info.append(titleEl, pathEl);

      const keepBtn = ce("button", {
        cls:   ["btn", "btn-secondary", "dup-keep-btn"],
        text:  msg("dupKeepBtn"),
        attrs: { type: "button" },
      });

      keepBtn.addEventListener("click", () => {
        const allEntries = $$(".dup-entry[data-group-key='" + CSS.escape(group.key) + "']", container);
        allEntries.forEach(e => {
          const entryCb = e.querySelector("input[type='checkbox']");
          if (entryCb) entryCb.checked = (e !== entry);
        });
        updateDeleteBtn();
      });

      entry.append(cb, info, keepBtn);
      groupEl.appendChild(entry);
    }

    container.appendChild(groupEl);
  }

  updateDeleteBtn();

  container.addEventListener("change", updateDeleteBtn);
}

function dupSmartSelect() {
  const container = $("#dup-results");
  const groups = $$(".dup-group", container);
  groups.forEach(groupEl => {
    const entries = $$(".dup-entry", groupEl);
    entries.forEach((entry, idx) => {
      const cb = entry.querySelector("input[type='checkbox']");
      if (cb) cb.checked = idx !== 0;
    });
  });
  container.dispatchEvent(new Event("change", { bubbles: true }));
}

async function dupDeleteSelected() {
  const container = $("#dup-results");
  const checked   = $$(".dup-entry input[type='checkbox']:checked", container);
  if (checked.length === 0) return;

  const toDelete = checked.map(cb => {
    const entry = cb.closest(".dup-entry");
    return {
      id:       entry.dataset.id,
      parentId: null,
      title:    entry.querySelector(".dup-entry-title").textContent,
      url:      entry.closest(".dup-group").querySelector(".dup-group-url").textContent,
    };
  });

  const bkMap = new Map(State.allBookmarks.map(b => [b.id, b]));
  const undoItems = toDelete.map(d => {
    const bk = bkMap.get(d.id);
    return { id: d.id, title: d.title, url: d.url, parentId: bk?.parentId, index: bk?.index };
  });

  await performDeletion(undoItems, () => runDuplicateScan());
}

/* ────────────────────────────────────────────────────────────
   11. FEATURE B — BROKEN LINKS
──────────────────────────────────────────────────────────── */
function initBrokenView() {
  $("#brk-scan-btn").addEventListener("click", runBrokenScan);
  $("#brk-delete-btn").addEventListener("click", brkDeleteSelected);
}

async function runBrokenScan() {
  const scanBtn   = $("#brk-scan-btn");
  const deleteBtn = $("#brk-delete-btn");
  const progress  = $("#brk-progress");
  const progressText = $("#brk-progress-text");
  const results   = $("#brk-results");

  setLoading([scanBtn, deleteBtn], true);
  progress.classList.remove("hidden");
  results.textContent = "";
  deleteBtn.disabled = true;

  try {
    const tree = await loadBookmarkTree();
    State.bookmarkTree = tree;
    const { flat } = flattenTree(tree);
    State.allBookmarks = flat;

    const total = flat.length;
    const broken = [];

    for (let i = 0; i < flat.length; i++) {
      if (i % 50 === 0) {
        progressText.textContent = msg("scanProgress", [
          formatNumber(i), formatNumber(total)
        ]);
        await sleep(0);
      }

      const bk = flat[i];
      const category = classifyBookmark(bk, flat);
      if (category) {
        broken.push({ ...bk, _category: category });
      }
    }

    progress.classList.add("hidden");
    setLoading([scanBtn], false);

    renderBrokenItems(broken, results, deleteBtn);
  } catch (err) {
    progress.classList.add("hidden");
    setLoading([scanBtn], false);
    showErrorToast(msg("errorGeneric"));
    console.error(err);
  }
}

const NON_WEB_PROTOCOLS = ["chrome:", "chrome-extension:", "file:", "data:", "javascript:"];

function classifyBookmark(bk, allBookmarks) {
  const url = bk.url || "";

  if (!url || url.trim() === "") return "emptyUrl";

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    return "invalidUrl";
  }

  if (NON_WEB_PROTOCOLS.includes(parsedUrl.protocol)) {
    if (parsedUrl.protocol === "file:") return "localFile";
    return "nonWeb";
  }

  if (bk.title && bk.title.trim() === url.trim()) return "suspiciousTitle";

  return null;
}

function renderBrokenItems(items, container, deleteBtn) {
  container.textContent = "";

  if (items.length === 0) {
    container.appendChild(buildEmptyState(
      "emptyBrkTitle", "emptyBrkDesc", buildCheckSvg()
    ));
    return;
  }

  const updateDeleteBtn = () => {
    const checked = $$(".brk-item input[type='checkbox']:checked", container);
    deleteBtn.disabled = checked.length === 0;
    deleteBtn.textContent = checked.length > 0
      ? msg("dupDeleteBtnCount", [formatNumber(checked.length)])
      : msg("brkDeleteBtn");
  };

  const badgeClass = {
    emptyUrl:        "badge-danger",
    invalidUrl:      "badge-danger",
    localFile:       "badge-warn",
    nonWeb:          "badge-warn",
    suspiciousTitle: "badge-neutral",
  };

  const badgeLabel = {
    emptyUrl:        "badgeEmptyUrl",
    invalidUrl:      "badgeInvalidUrl",
    localFile:       "badgeLocalFile",
    nonWeb:          "badgeNonWeb",
    suspiciousTitle: "badgeSuspicious",
  };

  for (const bk of items) {
    const item = ce("div", { cls: "brk-item" });
    item.dataset.id = bk.id;

    const cb = ce("input", { attrs: { type: "checkbox" } });
    cb.setAttribute("aria-label", msg("ariaMarkForDeletion") + " " + (bk.title || bk.url));
    cb.addEventListener("change", updateDeleteBtn);

    const info = ce("div", { cls: "brk-item-info" });

    const titleEl = ce("div", { cls: "brk-item-title", text: bk.title || msg("noTitle") });

    const urlEl = ce("div", { cls: "brk-item-url" });
    urlEl.textContent = bk.url || "";
    urlEl.title = bk.url || "";

    const badge = ce("span", {
      cls:  ["badge", badgeClass[bk._category] || "badge-neutral"],
      text: msg(badgeLabel[bk._category] || "badgeSuspicious"),
    });

    const pathEl = ce("div", { cls: "brk-item-path" });
    const path = buildFolderPath(bk.parentId, State.bookmarkTree);
    pathEl.textContent = path.join(" \u203A ") || msg("rootFolder");

    info.append(titleEl, urlEl, badge, pathEl);
    item.append(cb, info);
    container.appendChild(item);
  }

  updateDeleteBtn();
}

async function brkDeleteSelected() {
  const container = $("#brk-results");
  const checked   = $$(".brk-item input[type='checkbox']:checked", container);
  if (checked.length === 0) return;

  const bkMap = new Map(State.allBookmarks.map(b => [b.id, b]));
  const undoItems = Array.from(checked).map(cb => {
    const item = cb.closest(".brk-item");
    const id = item.dataset.id;
    const bk = bkMap.get(id);
    return {
      id,
      title:    bk?.title || "",
      url:      bk?.url || "",
      parentId: bk?.parentId,
      index:    bk?.index,
    };
  });

  await performDeletion(undoItems, () => runBrokenScan());
}

/* ────────────────────────────────────────────────────────────
   12. FEATURE C — ORGANIZE & SORT
──────────────────────────────────────────────────────────── */
function initOrganizeView() {
  $$(".tab-btn", $("#org-tabs")).forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab-btn", $("#org-tabs")).forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");

      const tab = btn.dataset.tab;
      $$(".tab-panel", $("#view-organize .content-wrap")).forEach(p => {
        p.classList.add("hidden");
      });
      $("#org-panel-" + tab).classList.remove("hidden");
    });
  });

  $("#sort-preview-btn").addEventListener("click", sortPreview);
  $("#sort-apply-btn").addEventListener("click", sortApply);

  $("#empty-scan-btn").addEventListener("click", runEmptyScan);
  $("#empty-delete-btn").addEventListener("click", emptyDeleteSelected);
}

function buildFolderSelector() {
  const sel = $("#sort-folder-select");
  if (!sel) return;
  sel.textContent = "";

  const allOpt = ce("option", { text: msg("sortAllBookmarks"), attrs: { value: "__all__" } });
  sel.appendChild(allOpt);

  function addFolderOptions(nodes, depth) {
    for (const n of nodes) {
      if (!n.url) {
        if (n.id !== "0" && n.title) {
          const prefix = "\u00A0".repeat(depth * 3);
          const opt = ce("option", {
            text: prefix + (n.title || msg("unknownFolder")),
            attrs: { value: n.id },
          });
          sel.appendChild(opt);
        }
        if (n.children) addFolderOptions(n.children, n.id === "0" ? 0 : depth + 1);
      }
    }
  }

  if (State.bookmarkTree) addFolderOptions(State.bookmarkTree, 0);
}

function buildSortOptions() {
  const group = $("#sort-order-group");
  if (!group) return;
  group.textContent = "";

  const options = [
    { value: "az",      labelKey: "sortAZ" },
    { value: "za",      labelKey: "sortZA" },
    { value: "domain",  labelKey: "sortDomain" },
    { value: "folders", labelKey: "sortFolderFirst" },
  ];

  options.forEach((opt, idx) => {
    const wrapper = ce("label", { cls: "radio-option" });
    const radio   = ce("input", { attrs: { type: "radio", name: "sort-order", value: opt.value } });
    if (idx === 0) radio.checked = true;

    const label = ce("span", { text: msg(opt.labelKey) });
    wrapper.append(radio, label);
    group.appendChild(wrapper);
  });
}

function getSortOrder() {
  const checked = $("input[name='sort-order']:checked");
  return checked ? checked.value : "az";
}

function getFolderChildren(folderId) {
  const map = {};
  function index(nodes) {
    for (const n of nodes) {
      map[n.id] = n;
      if (n.children) index(n.children);
    }
  }
  if (State.bookmarkTree) index(State.bookmarkTree);

  if (folderId === "__all__") {
    const roots = State.bookmarkTree || [];
    const children = [];
    for (const root of roots) {
      if (root.children) children.push(...root.children);
    }
    return children;
  }

  const folder = map[folderId];
  return folder?.children || [];
}

function sortNodes(nodes, order) {
  const sorted = [...nodes];
  sorted.sort((a, b) => {
    if (order === "folders") {
      const aIsFolder = !a.url;
      const bIsFolder = !b.url;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return (a.title || "").localeCompare(b.title || "");
    }
    if (order === "az") {
      return (a.title || "").localeCompare(b.title || "");
    }
    if (order === "za") {
      return (b.title || "").localeCompare(a.title || "");
    }
    if (order === "domain") {
      const domA = a.url ? (() => { try { return new URL(a.url).hostname; } catch(_){return a.title||"";} })() : a.title || "";
      const domB = b.url ? (() => { try { return new URL(b.url).hostname; } catch(_){return b.title||"";} })() : b.title || "";
      return domA.localeCompare(domB);
    }
    return 0;
  });
  return sorted;
}

let _previewDone = false;
let _previewData = null;

function sortPreview() {
  const previewArea = $("#sort-preview-area");
  const applyBtn    = $("#sort-apply-btn");
  previewArea.textContent = "";
  _previewDone = false;
  applyBtn.disabled = true;

  const folderId = $("#sort-folder-select").value;
  const order    = getSortOrder();
  const children = getFolderChildren(folderId);

  if (children.length === 0) {
    const note = ce("p", { text: msg("sortNoChildren"), cls: "view-subtitle" });
    previewArea.appendChild(note);
    previewArea.classList.remove("hidden");
    return;
  }

  const sorted = sortNodes(children, order);
  _previewData = { folderId, sorted, order };
  _previewDone = true;

  const afterLabel = ce("div", { cls: "sort-preview-label", text: msg("sortPreviewLabel") });
  previewArea.appendChild(afterLabel);

  const list = ce("div", { cls: "sort-preview-list" });
  const MAX_PREVIEW = 30;
  sorted.slice(0, MAX_PREVIEW).forEach(node => {
    const item = ce("div", { cls: "sort-preview-item" });
    const icon = ce("span", {
      cls:  "sort-preview-item-icon",
      text: node.url ? "\uD83D\uDD16" : "\uD83D\uDCC1",
      attrs: { "aria-hidden": "true" },
    });
    const title = ce("span", { text: node.title || node.url || msg("noTitle") });
    item.append(icon, title);
    list.appendChild(item);
  });

  if (sorted.length > MAX_PREVIEW) {
    const more = ce("div", {
      cls:  "sort-preview-item",
      text: msg("sortPreviewMore", [String(sorted.length - MAX_PREVIEW)]),
    });
    list.appendChild(more);
  }

  previewArea.appendChild(list);
  previewArea.classList.remove("hidden");
  applyBtn.disabled = false;
}

async function sortApply() {
  if (!_previewDone || !_previewData) return;

  const applyBtn    = $("#sort-apply-btn");
  const previewBtn  = $("#sort-preview-btn");
  setLoading([applyBtn, previewBtn], true);

  const recursive = $("#sort-recursive").checked;

  try {
    const { folderId, order } = _previewData;

    if (folderId === "__all__") {
      const roots = State.bookmarkTree || [];
      for (const root of roots) {
        if (root.children) {
          await sortFolderContents(root.id, order, recursive);
        }
      }
    } else {
      await sortFolderContents(folderId, order, recursive);
    }

    setLoading([applyBtn, previewBtn], false);
    showSuccessToast(msg("sortSuccess"));
    _previewDone = false;
    applyBtn.disabled = true;

    const tree = await loadBookmarkTree();
    State.bookmarkTree = tree;
    const { flat, folders } = flattenTree(tree);
    State.allBookmarks = flat;
    State.allFolders = folders;
    buildFolderSelector();

  } catch (err) {
    setLoading([applyBtn, previewBtn], false);
    showErrorToast(msg("errorGeneric"));
    console.error(err);
  }
}

async function sortFolderContents(folderId, order, recursive) {
  const children = getFolderChildren(folderId);
  if (children.length === 0) return;

  const sorted = sortNodes(children, order);

  for (let i = 0; i < sorted.length; i++) {
    await moveBookmark(sorted[i].id, { parentId: folderId, index: i });
  }

  if (recursive) {
    for (const node of sorted) {
      if (!node.url && node.id !== folderId) {
        await sortFolderContents(node.id, order, true);
      }
    }
  }
}

function moveBookmark(id, dest) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(id, dest, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/* ── Empty Folders ── */
async function runEmptyScan() {
  const scanBtn   = $("#empty-scan-btn");
  const deleteBtn = $("#empty-delete-btn");
  const progress  = $("#empty-progress");
  const progressText = $("#empty-progress-text");
  const results   = $("#empty-results");

  setLoading([scanBtn, deleteBtn], true);
  progress.classList.remove("hidden");
  results.textContent = "";
  deleteBtn.disabled = true;

  try {
    const tree = await loadBookmarkTree();
    State.bookmarkTree = tree;

    progressText.textContent = msg("scanningFolders");
    await sleep(0);

    const emptyFolders = [];

    function findEmpty(nodes, path) {
      for (const n of nodes) {
        if (!n.url && n.id !== "0") {
          const kids = n.children || [];
          const newPath = [...path, n.title || msg("unknownFolder")];
          if (kids.length === 0) {
            emptyFolders.push({ ...n, _path: newPath });
          } else {
            findEmpty(kids, newPath);
          }
        }
      }
    }

    for (const root of tree) {
      if (root.children) findEmpty(root.children, []);
    }

    progress.classList.add("hidden");
    setLoading([scanBtn], false);

    renderEmptyFolders(emptyFolders, results, deleteBtn);
  } catch (err) {
    progress.classList.add("hidden");
    setLoading([scanBtn], false);
    showErrorToast(msg("errorGeneric"));
    console.error(err);
  }
}

function renderEmptyFolders(folders, container, deleteBtn) {
  container.textContent = "";

  if (folders.length === 0) {
    container.appendChild(buildEmptyState(
      "emptyFolderNoneTitle", "emptyFolderNoneDesc", buildCheckSvg()
    ));
    return;
  }

  const updateDeleteBtn = () => {
    const checked = $$(".empty-folder-item input[type='checkbox']:checked", container);
    deleteBtn.disabled = checked.length === 0;
    deleteBtn.textContent = checked.length > 0
      ? msg("dupDeleteBtnCount", [formatNumber(checked.length)])
      : msg("emptyDeleteBtn");
  };

  for (const folder of folders) {
    const item = ce("div", { cls: "empty-folder-item" });
    item.dataset.id = folder.id;

    const cb = ce("input", { attrs: { type: "checkbox" } });
    cb.setAttribute("aria-label", msg("ariaMarkForDeletion") + " " + folder.title);
    cb.addEventListener("change", updateDeleteBtn);

    const pathSpan = ce("span", { cls: "empty-folder-path" });
    pathSpan.textContent = folder._path.join(" \u203A ");

    item.append(cb, pathSpan);
    container.appendChild(item);
  }

  updateDeleteBtn();
}

async function emptyDeleteSelected() {
  const container = $("#empty-results");
  const checked   = $$(".empty-folder-item input[type='checkbox']:checked", container);
  if (checked.length === 0) return;

  const deleteBtn = $("#empty-delete-btn");
  setLoading([deleteBtn], true);

  let deleted = 0;
  const errors = [];

  for (const cb of checked) {
    const item = cb.closest(".empty-folder-item");
    const id = item.dataset.id;
    try {
      await removeBookmark(id);
      deleted++;
      item.remove();
    } catch (err) {
      errors.push(id);
      console.error(err);
    }
  }

  setLoading([deleteBtn], false);

  if (errors.length > 0) {
    showErrorToast(msg("errorGeneric"));
  }

  if (deleted > 0) {
    showSuccessToast(msg("deletedFolders", [formatNumber(deleted)]));
  }

  if ($$(".empty-folder-item", container).length === 0) {
    container.textContent = "";
    container.appendChild(buildEmptyState(
      "emptyFolderNoneTitle", "emptyFolderNoneDesc", buildCheckSvg()
    ));
    deleteBtn.disabled = true;
    deleteBtn.textContent = msg("emptyDeleteBtn");
  }

  const tree = await loadBookmarkTree();
  State.bookmarkTree = tree;
}

function removeBookmark(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(id, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function removeBookmarkTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/* ────────────────────────────────────────────────────────────
   13. FEATURE D — SEARCH & FILTER
──────────────────────────────────────────────────────────── */
let _searchCurrentChip = "__all__";
let _searchQuery = "";

function buildSearchChips(tree) {
  const container = $("#search-chips");
  if (!container) return;
  container.textContent = "";

  const chips = [
    { id: "__all__", label: msg("chipAll") },
  ];

  const roots = tree || [];
  for (const root of roots) {
    if (root.children) {
      for (const child of root.children) {
        if (!child.url && child.title) {
          chips.push({ id: child.id, label: child.title });
        }
      }
    }
  }

  chips.forEach(chip => {
    const btn = ce("button", {
      cls:   ["chip", chip.id === "__all__" ? "active" : ""],
      text:  chip.label,
      attrs: { type: "button" },
    });
    btn.dataset.chipId = chip.id;
    btn.setAttribute("aria-pressed", chip.id === "__all__" ? "true" : "false");

    btn.addEventListener("click", () => {
      $$(".chip", container).forEach(c => {
        c.classList.remove("active");
        c.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      _searchCurrentChip = chip.id;
      runSearch(_searchQuery);
    });

    container.appendChild(btn);
  });
}

function initSearchView() {
  const input     = $("#search-input");
  const clearBtn  = $("#search-clear-btn");

  input.addEventListener("input", debounce(() => {
    _searchQuery = input.value;
    runSearch(_searchQuery);
  }, 200));

  clearBtn.addEventListener("click", () => {
    input.value = "";
    _searchQuery = "";
    runSearch("");
    input.focus();
  });

  runSearch("");
}

function getBookmarksForChip(chipId) {
  if (chipId === "__all__") return State.allBookmarks;

  const result = [];
  function walk(nodes) {
    for (const n of nodes) {
      if (n.url) result.push(n);
      if (n.children) walk(n.children);
    }
  }

  const map = {};
  function index(nodes) {
    for (const n of nodes) {
      map[n.id] = n;
      if (n.children) index(n.children);
    }
  }
  if (State.bookmarkTree) index(State.bookmarkTree);

  const folder = map[chipId];
  if (folder && folder.children) walk(folder.children);
  return result;
}

function highlightText(text, query) {
  const frag = document.createDocumentFragment();
  if (!query) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  let lastIdx = 0;
  let idx;
  while ((idx = lower.indexOf(lowerQ, lastIdx)) !== -1) {
    if (idx > lastIdx) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(idx, idx + query.length);
    frag.appendChild(mark);
    lastIdx = idx + query.length;
  }
  if (lastIdx < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
  return frag;
}

function runSearch(query) {
  const results  = $("#search-results");
  const countEl  = $("#search-result-count");
  results.textContent = "";

  const pool = getBookmarksForChip(_searchCurrentChip);
  const q = query.trim().toLowerCase();

  const matched = q
    ? pool.filter(bk =>
        (bk.title || "").toLowerCase().includes(q) ||
        (bk.url  || "").toLowerCase().includes(q)
      )
    : pool;

  countEl.textContent = msg("searchResultCount", [formatNumber(matched.length)]);

  if (matched.length === 0) {
    results.appendChild(buildEmptyState("emptySearchTitle", "emptySearchDesc", buildSearchEmptySvg()));
    return;
  }

  const bkMap = new Map(State.allBookmarks.map(b => [b.id, b]));

  for (const bk of matched) {
    const item = buildSearchItem(bk, query, bkMap);
    results.appendChild(item);
  }
}

function buildSearchItem(bk, query, bkMap) {
  const item = ce("div", { cls: "search-item" });
  item.dataset.id = bk.id;

  const main = ce("div", { cls: "search-item-main" });

  const fav = ce("img", {
    cls:   "search-item-favicon",
    attrs: {
      src: faviconUrl(bk.url),
      alt: "",
      loading: "lazy",
      "aria-hidden": "true",
    },
  });
  fav.addEventListener("error", () => { fav.style.visibility = "hidden"; });

  const info = ce("div", { cls: "search-item-info" });

  const titleEl = ce("div", { cls: "search-item-title" });
  titleEl.appendChild(highlightText(bk.title || msg("noTitle"), query));

  const urlEl = ce("div", { cls: "search-item-url" });
  urlEl.textContent = bk.url || "";
  urlEl.title = bk.url || "";

  const pathEl = ce("div", { cls: "search-item-path" });
  const path = buildFolderPath(bk.parentId, State.bookmarkTree);
  pathEl.textContent = path.join(" \u203A ") || msg("rootFolder");

  info.append(titleEl, urlEl, pathEl);

  const actions = ce("div", { cls: "search-item-actions" });

  const openBtn = ce("button", {
    cls:   ["btn", "btn-secondary"],
    text:  msg("searchOpenBtn"),
    attrs: { type: "button" },
  });
  openBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: bk.url });
  });

  const editBtn = ce("button", {
    cls:   ["btn", "btn-secondary"],
    text:  msg("searchEditBtn"),
    attrs: { type: "button" },
  });

  const deleteBtn = ce("button", {
    cls:   ["btn", "btn-danger"],
    text:  msg("searchDeleteBtn"),
    attrs: { type: "button" },
  });

  actions.append(openBtn, editBtn, deleteBtn);
  main.append(fav, info, actions);
  item.appendChild(main);

  const editRow = ce("div", { cls: ["search-item-edit", "hidden"] });
  const editInput = ce("input", {
    cls:   "edit-input",
    attrs: { type: "text", value: bk.title || "" },
  });
  editInput.value = bk.title || "";
  editInput.setAttribute("aria-label", msg("ariaEditTitle"));

  const saveBtn = ce("button", {
    cls:  ["btn", "btn-primary"],
    text: msg("searchSaveBtn"),
    attrs: { type: "button" },
  });
  const cancelEditBtn = ce("button", {
    cls:  ["btn", "btn-secondary"],
    text: msg("searchCancelBtn"),
    attrs: { type: "button" },
  });

  editRow.append(editInput, saveBtn, cancelEditBtn);
  item.appendChild(editRow);

  const confirmRow = ce("div", { cls: ["search-item-confirm", "hidden"] });
  const confirmMsg = ce("span", { text: msg("deleteConfirmMsg") });
  const confirmYes = ce("button", {
    cls:  ["btn", "btn-danger"],
    text: msg("deleteConfirmYes"),
    attrs: { type: "button" },
  });
  const confirmNo = ce("button", {
    cls:  ["btn", "btn-secondary"],
    text: msg("deleteConfirmNo"),
    attrs: { type: "button" },
  });
  confirmRow.append(confirmMsg, confirmYes, confirmNo);
  item.appendChild(confirmRow);

  editBtn.addEventListener("click", () => {
    const isOpen = !editRow.classList.contains("hidden");
    if (isOpen) {
      editRow.classList.add("hidden");
      editBtn.textContent = msg("searchEditBtn");
    } else {
      confirmRow.classList.add("hidden");
      editRow.classList.remove("hidden");
      editInput.focus();
      editInput.select();
      editBtn.textContent = msg("searchCancelEditBtn");
    }
  });

  cancelEditBtn.addEventListener("click", () => {
    editRow.classList.add("hidden");
    editBtn.textContent = msg("searchEditBtn");
  });

  saveBtn.addEventListener("click", async () => {
    const newTitle = editInput.value.trim();
    if (!newTitle) return;
    setLoading([saveBtn, cancelEditBtn], true);
    try {
      await updateBookmark(bk.id, { title: newTitle });
      bk.title = newTitle;
      titleEl.textContent = "";
      titleEl.appendChild(highlightText(newTitle, query));
      editRow.classList.add("hidden");
      editBtn.textContent = msg("searchEditBtn");
      showSuccessToast(msg("bookmarkUpdated"));
      const stateItem = State.allBookmarks.find(b => b.id === bk.id);
      if (stateItem) stateItem.title = newTitle;
    } catch (err) {
      showErrorToast(msg("errorGeneric"));
    } finally {
      setLoading([saveBtn, cancelEditBtn], false);
    }
  });

  editInput.addEventListener("keydown", e => {
    if (e.key === "Enter") saveBtn.click();
    if (e.key === "Escape") cancelEditBtn.click();
  });

  deleteBtn.addEventListener("click", () => {
    const isOpen = !confirmRow.classList.contains("hidden");
    if (isOpen) {
      confirmRow.classList.add("hidden");
    } else {
      editRow.classList.add("hidden");
      editBtn.textContent = msg("searchEditBtn");
      confirmRow.classList.remove("hidden");
    }
  });

  confirmNo.addEventListener("click", () => {
    confirmRow.classList.add("hidden");
  });

  confirmYes.addEventListener("click", async () => {
    setLoading([confirmYes, confirmNo], true);
    const rawBk = bkMap.get(bk.id);
    const undoItems = [{
      id:       bk.id,
      title:    bk.title || "",
      url:      bk.url || "",
      parentId: rawBk?.parentId,
      index:    rawBk?.index,
    }];
    await performDeletion(undoItems, () => {
      runSearch(_searchQuery);
    });
  });

  return item;
}

function updateBookmark(id, changes) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.update(id, changes, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/* ────────────────────────────────────────────────────────────
   14. DELETION + UNDO SYSTEM
──────────────────────────────────────────────────────────── */
async function performDeletion(undoItems, afterCallback) {
  if (!undoItems || undoItems.length === 0) return;

  const deleted = [];
  const errors  = [];

  for (const item of undoItems) {
    try {
      await removeBookmark(item.id);
      deleted.push(item);
    } catch (err) {
      errors.push(item);
      console.error("[BookmarkCleaner] Delete failed:", item.id, err);
    }
  }

  if (errors.length > 0) {
    showErrorToast(msg("errorGeneric"));
  }

  if (deleted.length === 0) return;

  const deletedIds = new Set(deleted.map(d => d.id));
  State.allBookmarks = State.allBookmarks.filter(b => !deletedIds.has(b.id));

  setupUndo(deleted, afterCallback);

  if (afterCallback) afterCallback();
}

function setupUndo(deletedItems, afterCallback) {
  if (State.undoStack && State.undoStack.timer) {
    clearTimeout(State.undoStack.timer);
  }
  State.undoStack = { items: deletedItems, timer: null };

  const toast  = $("#toast");
  const toastMsg = $("#toast-msg");
  const undoBtn  = $("#toast-undo-btn");
  const progress = $("#toast-progress");

  toastMsg.textContent = msg("toastDeleted", [formatNumber(deletedItems.length)]);
  undoBtn.textContent  = msg("undoBtn");

  toast.classList.remove("hidden");

  progress.style.animation = "none";
  void progress.offsetWidth;
  progress.style.animation = "toast-countdown 8s linear forwards";

  State.undoStack.timer = setTimeout(() => {
    hideToast();
    State.undoStack = null;
  }, 8000);

  undoBtn.onclick = async () => {
    if (!State.undoStack) return;
    clearTimeout(State.undoStack.timer);
    const items = State.undoStack.items;
    State.undoStack = null;
    hideToast();

    for (const item of items) {
      try {
        const createOpts = { title: item.title, url: item.url, parentId: item.parentId };
        if (typeof item.index === "number") createOpts.index = item.index;
        await createBookmark(createOpts);
      } catch (err) {
        console.error("[BookmarkCleaner] Undo restore failed:", item, err);
      }
    }

    try {
      const tree = await loadBookmarkTree();
      State.bookmarkTree = tree;
      const { flat, folders } = flattenTree(tree);
      State.allBookmarks = flat;
      State.allFolders = folders;
    } catch (_) {}

    if (afterCallback) afterCallback();
    showSuccessToast(msg("toastUndone"));
  };
}

function hideToast() {
  const toast = $("#toast");
  toast.classList.add("hidden");
}

function showToast(message, type = "info") {
  const toast    = $("#toast");
  const toastMsg = $("#toast-msg");
  const undoBtn  = $("#toast-undo-btn");
  const progress = $("#toast-progress");

  toastMsg.textContent = message;
  undoBtn.classList.add("hidden");

  toast.classList.remove("hidden");
  progress.style.animation = "none";
  void progress.offsetWidth;
  progress.style.animation = "toast-countdown 4s linear forwards";

  if (State._toastTimer) clearTimeout(State._toastTimer);
  State._toastTimer = setTimeout(hideToast, 4000);
}

function showErrorToast(message) {
  const toast = $("#toast");
  toast.style.borderColor = "var(--danger)";
  showToast(message, "error");
  setTimeout(() => { toast.style.borderColor = ""; }, 4000);
}

function showSuccessToast(message) {
  const toast = $("#toast");
  toast.style.borderColor = "var(--success)";
  showToast(message, "success");
  setTimeout(() => { toast.style.borderColor = ""; }, 4000);
}

function createBookmark(opts) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(opts, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

/* ────────────────────────────────────────────────────────────
   15. EMPTY STATES
──────────────────────────────────────────────────────────── */
function buildCheckSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 80 80");
  svg.setAttribute("fill", "none");
  svg.classList.add("empty-state-icon");
  svg.setAttribute("aria-hidden", "true");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "40");
  circle.setAttribute("cy", "40");
  circle.setAttribute("r", "36");
  circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "3");
  circle.setAttribute("opacity", "0.3");

  const check = document.createElementNS("http://www.w3.org/2000/svg", "path");
  check.setAttribute("d", "M25 41l10 10 20-20");
  check.setAttribute("stroke", "currentColor");
  check.setAttribute("stroke-width", "3.5");
  check.setAttribute("stroke-linecap", "round");
  check.setAttribute("stroke-linejoin", "round");

  svg.append(circle, check);
  return svg;
}

function buildSearchEmptySvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 80 80");
  svg.setAttribute("fill", "none");
  svg.classList.add("empty-state-icon");
  svg.setAttribute("aria-hidden", "true");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "34");
  circle.setAttribute("cy", "34");
  circle.setAttribute("r", "22");
  circle.setAttribute("stroke", "currentColor");
  circle.setAttribute("stroke-width", "3");
  circle.setAttribute("opacity", "0.3");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "50");
  line.setAttribute("y1", "50");
  line.setAttribute("x2", "68");
  line.setAttribute("y2", "68");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "3.5");
  line.setAttribute("stroke-linecap", "round");

  const x1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  x1.setAttribute("x1", "26"); x1.setAttribute("y1", "26");
  x1.setAttribute("x2", "42"); x1.setAttribute("y2", "42");
  x1.setAttribute("stroke", "currentColor");
  x1.setAttribute("stroke-width", "2");
  x1.setAttribute("stroke-linecap", "round");
  x1.setAttribute("opacity", "0.4");

  const x2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  x2.setAttribute("x1", "42"); x2.setAttribute("y1", "26");
  x2.setAttribute("x2", "26"); x2.setAttribute("y2", "42");
  x2.setAttribute("stroke", "currentColor");
  x2.setAttribute("stroke-width", "2");
  x2.setAttribute("stroke-linecap", "round");
  x2.setAttribute("opacity", "0.4");

  svg.append(circle, line, x1, x2);
  return svg;
}

function buildEmptyState(titleKey, descKey, iconEl) {
  const wrap  = ce("div", { cls: "empty-state" });
  const title = ce("div", { cls: "empty-state-title", text: msg(titleKey) });
  const desc  = ce("div", { cls: "empty-state-desc",  text: msg(descKey) });
  if (iconEl) wrap.appendChild(iconEl);
  wrap.append(title, desc);
  return wrap;
}

/* ────────────────────────────────────────────────────────────
   16. LOADING STATE HELPER
──────────────────────────────────────────────────────────── */
function setLoading(buttons, isLoading) {
  for (const btn of buttons) {
    if (!btn) continue;
    btn.disabled = isLoading;
  }
}

/* ────────────────────────────────────────────────────────────
   17. BOOT
──────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  initApp().then(() => {
    initDuplicatesView();
    initBrokenView();
    initOrganizeView();
  }).catch(err => {
    console.error("[BookmarkCleaner] Fatal init error:", err);
  });
});
