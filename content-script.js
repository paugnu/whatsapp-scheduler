// Firefox/Chrome compatibility
if (typeof browser === "undefined") {
    var browser = chrome;
}

console.log("[WA Scheduler] content-script cargado");

function isWhatsAppUIReady() {
    return (
        document.querySelector("#side") ||
        document.querySelector("[data-testid=\"conversation-compose-box\"]") ||
        document.querySelector("[contenteditable=\"true\"][data-lexical-editor=\"true\"]")
    );
}

function notifyBackgroundReady(retries = 5) {
    browser.runtime
        .sendMessage({ type: "WA_READY" })
        .catch(() => {
            if (retries > 0) {
                setTimeout(() => notifyBackgroundReady(retries - 1), 2000);
            }
        });
}

function waitForWhatsAppReadySignal(maxWaitMs = 60000) {
    const start = Date.now();

    function check() {
        if (isWhatsAppUIReady()) {
            notifyBackgroundReady();
            return;
        }

        if (Date.now() - start < maxWaitMs) {
            setTimeout(check, 1000);
        } else {
            // Keep trying but slower to avoid spamming
            setTimeout(check, 5000);
        }
    }

    check();
}

waitForWhatsAppReadySignal();

const AVAILABLE_LOCALES = ["ca", "de", "en", "es", "fr", "hi", "id", "it", "nl", "pt_BR", "ru"];
let localeMessages = {};
let currentLocale = "en";
let localeReady = loadLocaleMessages();

function normalizeLocale(locale = "") {
    const lc = locale.toLowerCase();
    if (lc === "pt-br" || lc === "pt_br") return "pt_BR";
    if (AVAILABLE_LOCALES.includes(lc)) return lc;

    const base = lc.split(/[-_]/)[0];
    if (AVAILABLE_LOCALES.includes(base)) return base;
    return null;
}

async function loadLocaleMessages() {
    const acceptLanguages =
        (await browser?.i18n?.getAcceptLanguages?.().catch(() => [])) || [];
    const navigatorLanguages = Array.isArray(navigator.languages)
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];

    const candidates = [...acceptLanguages, ...navigatorLanguages, currentLocale, "en"];

    for (const candidate of candidates) {
        const normalized = normalizeLocale(candidate);
        if (!normalized) continue;

        try {
            const url = browser.runtime.getURL(`_locales/${normalized}/messages.json`);
            const res = await fetch(url);
            if (res.ok) {
                localeMessages = await res.json();
                currentLocale = normalized;
                return;
            }
        } catch (e) {
            console.warn("[WA Scheduler] Failed to load locale", candidate, e);
        }
    }

    localeMessages = {};
    currentLocale = "en";
}

function applySubstitutions(template, substitutions = []) {
    return template.replace(/\$([0-9]+)/g, (_, index) => substitutions[index - 1] ?? "");
}

function t(key, substitutions = []) {
    const template = localeMessages?.[key]?.message;
    if (template) return applySubstitutions(template, substitutions);

    try {
        const native = browser?.i18n?.getMessage(key, substitutions);
        if (native) return native;
    } catch (e) {
        // Fallback handled below
    }

    return key;
}

async function ensureLocaleReady() {
    try {
        await localeReady;
    } catch (e) {
        console.warn("[WA Scheduler] Locale preload failed", e);
    }
}

// -------------------------
// Base utilities
// -------------------------

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function setStyles(element, styles = {}) {
    if (!element || !styles) return;
    Object.entries(styles).forEach(([key, value]) => {
        element.style[key] = value;
    });
}

function clearElement(element) {
    if (!element) return;
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

// CLICK NUCLEAR: fire pointer + mouse events so React handlers receive them
function superClick(element) {
    if (!element) return;
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
    const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];

    events.forEach((eventType) => {
        const Ctor = eventType.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new Ctor(eventType, opts));
    });
}

// Write text into contenteditable inputs simulating a paste
function triggerInputEvent(element, value) {
    if (!element) return;
    element.focus();
    const success = document.execCommand("insertText", false, value);
    if (!success) element.textContent = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

// -------------------------
// State: last textarea and send button cached
// -------------------------

let lastInput = null;
let lastSendButton = null;
let lastChatTitle = null;
let chatCheckTimeout = null;
let waSchedulerMode = "schedule"; // "schedule" or "list"

// Find the active chat composer without using cache
function findActiveComposer() {
    return (
        document.querySelector('.lexical-rich-text-input [contenteditable="true"][data-lexical-editor="true"]') ||
        document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') ||
        document.querySelector('[contenteditable="true"][data-tab="10"]') ||
        document.querySelector('[contenteditable="true"]')
    );
}

function setLastTargetsFromElement(el) {
    if (!el) return;
    lastInput = el;

    const container =
        el.closest('footer') ||
        el.closest('[data-testid="conversation-compose-box"]') ||
        document;

    lastSendButton =
        container.querySelector('button[aria-label="Send"]') ||
        container.querySelector('button[aria-label="Enviar"]') ||
        container.querySelector('button[aria-label="Enviar mensaje"]') ||
        (document.querySelector('span[data-icon="send"]') &&
            document.querySelector('span[data-icon="send"]').closest("button")) ||
        null;

    console.log("[WA Scheduler] lastInput actualizado, lastSendButton:", !!lastSendButton);
}

// Detect clicks/focus in the editor (with throttling)
let focusTimeout = null;
document.addEventListener(
    "focusin",
    (e) => {
        if (focusTimeout) clearTimeout(focusTimeout);
        focusTimeout = setTimeout(() => {
            const el = e.target.closest('[contenteditable="true"]');
            if (el) setLastTargetsFromElement(el);
        }, 100);
    },
    true
);

document.addEventListener(
    "click",
    (e) => {
        const el = e.target.closest('[contenteditable="true"]');
        if (el) setLastTargetsFromElement(el);
    },
    true
);

// -------------------------
// Detect the active chat title (right panel #main only)
// -------------------------

function getActiveChatTitle() {
    const mainHeader = document.querySelector("#main header");
    if (!mainHeader) return null;

    const elTestId = mainHeader.querySelector('[data-testid="conversation-info-header-chat-title"]');
    if (elTestId) return elTestId.getAttribute("title") || elTestId.textContent;

    const elTitle = mainHeader.querySelector('span[dir="auto"][title]');
    if (elTitle) return elTitle.getAttribute("title");

    const elText = mainHeader.querySelector('span[dir="auto"]');
    if (elText) return elText.textContent;

    return null;
}

function getActiveChatAvatarKey() {
    const header = document.querySelector("#main header");
    if (!header) return null;

    const img = header.querySelector("img");
    if (!img) return null;

    let src = img.getAttribute("src") || img.style.backgroundImage || "";
    src = src.replace(/^url\(["']?(.+?)["']?\)$/, "$1");

    return src || null;
}

// -------------------------
// Normalize and compare chat names
// -------------------------

function normalizeName(s) {
    return (s || "")
        .replace(/\s+/g, " ")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
        .toLowerCase();
}

function nameMatchScore(target, candidate) {
    const t = normalizeName(target);
    const c = normalizeName(candidate);

    if (!t || !c) return 0;
    // strict equality only
    return t === c ? 1 : 0;
}

function namesMatch(target, candidate) {
    return nameMatchScore(target, candidate) > 0;
}

// -------------------------
// Open chat by title
// -------------------------

function clearSearchBox(searchBox) {
    if (!searchBox) return;
    searchBox.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
}

function getRowAvatarKey(row) {
    if (!row) return null;

    const img = row.querySelector("img") || row.querySelector('[style*="background-image"]');
    if (!img) return null;

    let src = img.getAttribute("src") || img.style.backgroundImage || "";
    src = src.replace(/^url\(["']?(.+?)["']?\)$/, "$1");

    return src || null;
}

function clickRow(row) {
    if (!row) return false;
    row.scrollIntoView({ block: "center", behavior: "instant" });
    superClick(row);
    return true;
}

function openChatByTitle(title, avatarKey) {
    if (!title) return { found: false };

    const sidePane = document.getElementById("pane-side") || document.body;
    const candidates = sidePane.querySelectorAll('span[dir="auto"]');
    const matches = [];

    for (const span of candidates) {
        const text = span.textContent || span.getAttribute("title");
        if (!text) continue;

        if (namesMatch(title, text)) {
            const row = span.closest('div[role="row"]') || span.closest('div[role="button"]');
            if (row) {
                matches.push({ span, row, text });
            }
        }
    }

    if (!matches.length) return { found: false };

    if (matches.length === 1) {
        const match = matches[0];
        console.log(`[WA Scheduler] Chat encontrado: "${match.text}". Abriendo...`);
        match.row.scrollIntoView({ block: "center", behavior: "instant" });
        superClick(match.span);
        superClick(match.row);
        return { found: true };
    }

    if (avatarKey) {
        const avatarMatches = matches.filter((match) => {
            const rowAvatar = getRowAvatarKey(match.row);
            return rowAvatar && rowAvatar === avatarKey;
        });

        if (avatarMatches.length === 1) {
            const match = avatarMatches[0];
            console.log(`[WA Scheduler] Chat encontrado por avatar: "${match.text}".`);
            return clickRow(match.row) ? { found: true } : { found: false };
        }
    }

    showToast(t("errorChatAmbiguous", [title]), "warning", 6000);
    return { found: false, reason: "ambiguous" };
}

async function searchAndOpenChat(title, avatarKey) {
    console.log("[WA Scheduler] Chat oculto, usando buscador:", title);

    let searchInput = document.querySelector('div[contenteditable="true"][data-tab="3"]');

    if (!searchInput) {
        const searchBtn = document.querySelector('[data-icon="search"]')?.closest('div[role="button"]');
        if (searchBtn) {
            superClick(searchBtn);
            await delay(400);
            searchInput = document.querySelector('div[contenteditable="true"][data-tab="3"]');
        }
    }

    if (!searchInput) {
        console.error("[WA Scheduler] No se encontró buscador");
        return { found: false };
    }

    searchInput.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    triggerInputEvent(searchInput, title);

    await delay(1800);

    const result = openChatByTitle(title, avatarKey);

    if (result.found) {
        await delay(1500);
        const clearBtn =
            document.querySelector('[data-icon="x-alt"]')?.closest('div[role="button"]') ||
            document.querySelector('[data-icon="back"]')?.closest('div[role="button"]');
        if (clearBtn) superClick(clearBtn);
        return { found: true };
    }

    return result.reason === "ambiguous"
        ? { found: false, reason: "ambiguous" }
        : { found: false };
}

// -------------------------
// Toast notifications
// -------------------------

function showToast(msg, type = "info", duration = 3000) {
    const toast = document.createElement("div");
    toast.id = `wa-toast-${Date.now()}`;
    
    const bgColor = {
        success: "#25D366",
        error: "#dc2626",
        warning: "#f59e0b",
        info: "#3b82f6"
    }[type] || "#3b82f6";

    toast.style.cssText = `
        position: fixed;
        bottom: 100px;
        right: 80px;
        background: ${bgColor};
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        font-size: 13px;
        z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease-out;
        max-width: 300px;
        word-wrap: break-word;
    `;

    // Insert the message text
    toast.textContent = msg;

    const style = document.createElement("style");
    if (!document.getElementById("wa-toast-styles")) {
        style.id = "wa-toast-styles";
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(400px);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = "slideOut 0.3s ease-in";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Start synchronization for the active chat
startChatObserver();

// -------------------------
// Write and send a message
// -------------------------

function sendMessageInActiveChat(text) {
    const input =
        document.querySelector('footer [contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"][data-tab="10"]');

    if (!input) throw new Error(t("errorNoComposer"));
    if (text.length > 4096) throw new Error(t("errorTextTooLong"));

    input.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, text);

    setTimeout(() => {
        const btn =
            document.querySelector('[data-icon="send"]')?.closest("button") ||
            document.querySelector('button[aria-label="Send"]');

        if (btn) {
            superClick(btn);
        } else {
            input.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true })
            );
        }
    }, 400);
}

// -------------------------
// Send to the scheduled chat
// -------------------------

async function sendToScheduledChat(id, text, chatTitle, avatarKey) {
    await ensureLocaleReady();

    console.log("--- Procesando:", chatTitle);

    if (!chatTitle) {
        try {
            sendMessageInActiveChat(text);
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: true });
        } catch (e) {
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: String(e) });
        }
        return;
    }

    const current = getActiveChatTitle();
    const currentAvatar = getActiveChatAvatarKey();
    const avatarMatches = avatarKey ? currentAvatar && currentAvatar === avatarKey : true;

    if (current && namesMatch(chatTitle, current) && avatarMatches) {
        console.log("Chat correcto ya abierto.");
        try {
            sendMessageInActiveChat(text);
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: true });
        } catch (e) {
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: String(e) });
        }
        return;
    }

    let openResult = openChatByTitle(chatTitle, avatarKey);
    if (!openResult.found) {
        openResult = await searchAndOpenChat(chatTitle, avatarKey);
    }

    if (!openResult.found) {
        const err = openResult.reason === "ambiguous"
            ? t("errorChatAmbiguous", [chatTitle])
            : t("errorChatNotFound", [chatTitle]);
        browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: err });
        return;
    }

    let retries = 0;
    const checkInterval = setInterval(() => {
        retries++;
        const activeNow = getActiveChatTitle();

        if (activeNow && namesMatch(chatTitle, activeNow)) {
            clearInterval(checkInterval);
            setTimeout(() => {
                try {
                    sendMessageInActiveChat(text);
                    browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: true });
                } catch (e) {
                    browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: String(e) });
                }
            }, 800);
        } else if (retries >= 30) {
            clearInterval(checkInterval);
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: t("errorChatTimeout") });
        }
    }, 500);
}

// -------------------------
// Keep composer/input synchronized with the active chat
// -------------------------

function startChatObserver() {
    const updateTargetsForChat = () => {
        const current = getActiveChatTitle();
        if (current && current !== lastChatTitle) {
            lastChatTitle = current;

            const panel = document.getElementById("wa-scheduler-panel");
            if (panel) panel.remove();

            lastInput = null;
            lastSendButton = null;

            const composer = findActiveComposer();
            if (composer) {
                setLastTargetsFromElement(composer);
            }

            setTimeout(attachScheduleButtonToComposer, 300);
        }
    };

    // Lightweight observer on the header
    const header = document.querySelector("header");
    if (header) {
        const mo = new MutationObserver(() => updateTargetsForChat());
        mo.observe(header, { childList: true, subtree: true, characterData: true });
    }

    // Periodic fallback in case the observer misses changes
    setInterval(updateTargetsForChat, 1500);
}

// -------------------------
// Edit modal
// -------------------------

async function openEditDialog(msgId, msg, host) {
    await ensureLocaleReady();

    const existing = document.getElementById("wa-edit-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "wa-edit-modal";
    setStyles(modal, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        background: "rgba(0, 0, 0, 0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "100000",
        animation: "fadeIn 0.2s ease-out"
    });

    const content = document.createElement("div");
    setStyles(content, {
        background: "#202c33",
        color: "#e9edef",
        padding: "16px 16px 14px",
        borderRadius: "8px",
        width: "90%",
        maxWidth: "480px",
        boxShadow: "0 2px 12px rgba(0, 0, 0, 0.35)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        animation: "slideUp 0.25s ease-out",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    });

    const styleEl = document.createElement("style");
    styleEl.textContent = `
        #wa-edit-modal input,
        #wa-edit-modal textarea {
            background: #202c33;
            border: 1px solid rgba(134,150,160,0.3);
            color: #e9edef;
            border-radius: 8px;
            padding: 9px 10px;
            font-size: 13px;
            font-family: inherit;
            transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
            width: 100%;
            box-sizing: border-box;
        }
        #wa-edit-modal input:focus,
        #wa-edit-modal textarea:focus {
            background: #202c33;
            border-color: #00a884;
            outline: none;
            box-shadow: 0 0 0 1px rgba(0, 168, 132, 0.4);
        }
        #wa-edit-modal input::placeholder,
        #wa-edit-modal textarea::placeholder {
            color: rgba(233, 237, 239, 0.6);
        }
        #wa-edit-modal input[type=number]::-webkit-inner-spin-button,
        #wa-edit-modal input[type=number]::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        #wa-edit-modal input[type=number] {
            -moz-appearance: textfield;
        }
    `;
    content.appendChild(styleEl);

    const title = document.createElement("div");
    title.textContent = t("labelEditMessageTitle");
    setStyles(title, { fontWeight: "700", fontSize: "13px", marginBottom: "14px" });
    content.appendChild(title);

    const chatWrapper = document.createElement("div");
    setStyles(chatWrapper, { marginBottom: "12px" });
    const chatLabel = document.createElement("label");
    chatLabel.textContent = t("labelChat");
    setStyles(chatLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const chatValue = document.createElement("div");
    chatValue.textContent = msg.chatTitle || t("labelNoChat");
    setStyles(chatValue, {
        background: "rgba(0, 168, 132, 0.08)",
        padding: "8px 10px",
        borderRadius: "8px",
        borderLeft: "3px solid #00a884",
        fontSize: "13px",
        color: "#e9edef"
    });
    chatWrapper.appendChild(chatLabel);
    chatWrapper.appendChild(chatValue);
    content.appendChild(chatWrapper);

    const messageWrapper = document.createElement("div");
    setStyles(messageWrapper, { marginBottom: "12px" });
    const messageLabel = document.createElement("label");
    messageLabel.textContent = t("labelMessage");
    setStyles(messageLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const textInput = document.createElement("textarea");
    textInput.id = "wa-edit-text";
    textInput.value = msg.text;
    setStyles(textInput, { height: "110px", resize: "vertical", marginBottom: "6px", borderRadius: "8px" });
    const charContainer = document.createElement("div");
    setStyles(charContainer, { fontSize: "11px", opacity: "0.65", textAlign: "right" });
    const charCount = document.createElement("span");
    charCount.id = "wa-edit-char-count";
    charCount.textContent = String(msg.text.length);
    charContainer.appendChild(charCount);
    charContainer.appendChild(document.createTextNode(" / 4096"));
    messageWrapper.appendChild(messageLabel);
    messageWrapper.appendChild(textInput);
    messageWrapper.appendChild(charContainer);
    content.appendChild(messageWrapper);

    const grid = document.createElement("div");
    setStyles(grid, {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "10px",
        marginBottom: "12px",
        alignItems: "end"
    });

    const hoursWrapper = document.createElement("div");
    const hoursLabel = document.createElement("label");
    hoursLabel.textContent = t("labelHours");
    setStyles(hoursLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const hoursInput = document.createElement("input");
    hoursInput.id = "wa-edit-hours";
    hoursInput.type = "number";
    hoursInput.min = "0";
    hoursInput.max = "999";
    hoursInput.value = String(Math.max(0, Math.floor((msg.sendAt - Date.now()) / (1000 * 60 * 60))));
    setStyles(hoursInput, { padding: "8px 10px", borderRadius: "6px" });
    hoursWrapper.appendChild(hoursLabel);
    hoursWrapper.appendChild(hoursInput);

    const minsWrapper = document.createElement("div");
    const minsLabel = document.createElement("label");
    minsLabel.textContent = t("labelMinutes");
    setStyles(minsLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const minsInput = document.createElement("input");
    minsInput.id = "wa-edit-mins";
    minsInput.type = "number";
    minsInput.min = "0";
    minsInput.max = "59";
    minsInput.value = String(
        Math.max(0, Math.floor(((msg.sendAt - Date.now()) % (1000 * 60 * 60)) / (1000 * 60)))
    );
    setStyles(minsInput, { padding: "8px 10px", borderRadius: "6px" });
    minsWrapper.appendChild(minsLabel);
    minsWrapper.appendChild(minsInput);

    grid.appendChild(hoursWrapper);
    grid.appendChild(minsWrapper);
    content.appendChild(grid);

    const sendAtDate = new Date(msg.sendAt);
    const info = document.createElement("div");
    info.textContent = t("labelScheduledFor", [sendAtDate.toLocaleString()]);
    setStyles(info, {
        background: "rgba(83, 189, 235, 0.12)",
        padding: "10px",
        borderRadius: "8px",
        marginBottom: "14px",
        fontSize: "11px",
        opacity: "0.9",
        border: "1px solid rgba(83,189,235,0.2)"
    });
    content.appendChild(info);

    const actions = document.createElement("div");
    setStyles(actions, { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "6px" });

    const saveBtn = document.createElement("button");
    saveBtn.id = "wa-edit-save";
    saveBtn.textContent = t("buttonSave");
    setStyles(saveBtn, {
        background: "#00a884",
        color: "#111b21",
        border: "none",
        padding: "9px 14px",
        borderRadius: "6px",
        cursor: "pointer",
        fontWeight: "700",
        fontSize: "13px",
        transition: "background 0.15s, box-shadow 0.15s",
        minWidth: "110px"
    });
    saveBtn.addEventListener("mouseover", () => {
        saveBtn.style.background = "#029273";
        saveBtn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
    });
    saveBtn.addEventListener("mouseout", () => {
        saveBtn.style.background = "#00a884";
        saveBtn.style.boxShadow = "none";
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.id = "wa-edit-cancel";
    cancelBtn.textContent = t("buttonCancel");
    setStyles(cancelBtn, {
        background: "transparent",
        color: "#e9edef",
        border: "1px solid rgba(134,150,160,0.5)",
        padding: "9px 14px",
        borderRadius: "6px",
        cursor: "pointer",
        fontWeight: "600",
        fontSize: "13px",
        transition: "border-color 0.15s, background 0.15s",
        minWidth: "110px"
    });
    cancelBtn.addEventListener("mouseover", () => {
        cancelBtn.style.background = "rgba(134,150,160,0.1)";
        cancelBtn.style.borderColor = "rgba(134,150,160,0.8)";
    });
    cancelBtn.addEventListener("mouseout", () => {
        cancelBtn.style.background = "transparent";
        cancelBtn.style.borderColor = "rgba(134,150,160,0.5)";
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    content.appendChild(actions);

    modal.appendChild(content);
    document.body.appendChild(modal);

    textInput.addEventListener("input", () => {
        charCount.textContent = textInput.value.length;
        if (textInput.value.length > 4096) {
            charCount.style.color = "#dc2626";
        } else if (textInput.value.length > 3500) {
            charCount.style.color = "#f59e0b";
        } else {
            charCount.style.color = "rgba(241,241,242,0.65)";
        }
    });

    setTimeout(() => textInput.focus(), 100);

    const escapeHandler = (e) => {
        if (e.key === "Escape") {
            modal.style.animation = "slideOut 0.3s ease-in";
            setTimeout(() => {
                modal.remove();
                document.removeEventListener("keydown", escapeHandler);
            }, 300);
        }
    };
    document.addEventListener("keydown", escapeHandler);

    cancelBtn.addEventListener("click", () => {
        modal.style.animation = "slideOut 0.3s ease-in";
        setTimeout(() => modal.remove(), 300);
    });

    saveBtn.addEventListener("click", () => {
        const newText = textInput.value.trim();
        const newHours = parseInt(hoursInput.value || "0", 10);
        const newMins = parseInt(minsInput.value || "0", 10);

        if (!newText) {
            showToast(t("toastWriteMessage"), "warning");
            return;
        }

        if (newText.length > 4096) {
            showToast(t("toastTextTooLong", [newText.length]), "error");
            return;
        }

        const newTotalMins = newHours * 60 + newMins;
        if (newTotalMins <= 0) {
            showToast(t("toastNeedTime"), "warning");
            return;
        }

        const newDelayMs = newTotalMins * 60 * 1000;

        browser.runtime.sendMessage(
            {
                type: "EDIT_MESSAGE",
                id: msgId,
                text: newText,
                delayMs: newDelayMs
            },
            (resp) => {
                if (resp && resp.ok) {
                    showToast(t("toastMessageUpdated"), "success");
                    modal.style.animation = "slideOut 0.3s ease-in";
                    setTimeout(() => {
                        modal.remove();
                        document.removeEventListener("keydown", escapeHandler);
                        renderListPanel(host);
                    }, 300);
                } else {
                    showToast(t("toastErrorWithDetail", [resp?.error || t("errorNoResponse")]), "error", 5000);
                }
            }
        );
    });

    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            modal.style.animation = "slideOut 0.3s ease-in";
            setTimeout(() => {
                modal.remove();
                document.removeEventListener("keydown", escapeHandler);
            }, 300);
        }
    });
}

// -------------------------
// Enhanced list panel

async function renderListPanel(host) {
    await ensureLocaleReady();

    let body = null;

    const buildHeader = (container, includeClose) => {
        const header = document.createElement("div");
        setStyles(header, {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "12px",
            paddingBottom: "8px",
            borderBottom: "1px solid rgba(255,255,255,0.08)"
        });

        const titleWrap = document.createElement("div");
        const title = document.createElement("div");
        title.textContent = t("listTitle");
        setStyles(title, { fontWeight: "700", fontSize: "13px", marginBottom: "2px" });
        const subtitle = document.createElement("div");
        subtitle.textContent = t("listSubtitle");
        setStyles(subtitle, { fontSize: "11px", color: "rgba(241,241,242,0.6)" });
        titleWrap.appendChild(title);
        titleWrap.appendChild(subtitle);
        header.appendChild(titleWrap);

        if (includeClose) {
            const closeBtn = document.createElement("button");
            closeBtn.id = "wa-list-close";
            closeBtn.textContent = "✕";
            setStyles(closeBtn, {
                width: "32px",
                height: "32px",
                background: "transparent",
                color: "#e9edef",
                border: "none",
                borderRadius: "16px",
                cursor: "pointer",
                fontSize: "16px",
                transition: "background 0.15s",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            });
            closeBtn.addEventListener("mouseover", () => {
                closeBtn.style.background = "rgba(134,150,160,0.16)";
            });
            closeBtn.addEventListener("mouseout", () => {
                closeBtn.style.background = "transparent";
            });
            closeBtn.onclick = () => container.remove();
            header.appendChild(closeBtn);
        }

        container.appendChild(header);
    };

    if (host) {
        clearElement(host);
        buildHeader(host, false);
        body = document.createElement("div");
        body.id = "wa-scheduler-list-body";
        setStyles(body, { maxHeight: "55vh", overflowY: "auto" });
        body.textContent = t("listLoading");
        host.appendChild(body);
    } else {
        const existing = document.getElementById("wa-scheduler-list");
        if (existing) existing.remove();

        const panel = document.createElement("div");
        panel.id = "wa-scheduler-list";
        setStyles(panel, {
            position: "fixed",
            bottom: "80px",
            right: "320px",
            zIndex: "99999",
            background: "#202c33",
            color: "#e9edef",
            padding: "12px",
            borderRadius: "8px",
            fontSize: "11px",
            width: "380px",
            maxHeight: "68vh",
            overflowY: "auto",
            boxShadow: "0 2px 12px rgba(0, 0, 0, 0.35)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        });

        buildHeader(panel, true);
        body = document.createElement("div");
        body.id = "wa-scheduler-list-body";
        setStyles(body, { maxHeight: "55vh", overflowY: "auto" });
        body.textContent = t("listLoading");
        panel.appendChild(body);

        document.body.appendChild(panel);
    }

    if (!body) return;

    browser.runtime.sendMessage({ type: "GET_MESSAGES" }, (resp) => {
        if (!resp || !resp.ok) {
            clearElement(body);
            const errorDiv = document.createElement("div");
            errorDiv.textContent = t("listError");
            setStyles(errorDiv, { color: "#ff6b6b", textAlign: "center", padding: "20px" });
            body.appendChild(errorDiv);
            return;
        }

        const msgs = resp.messages || [];
        if (!msgs.length) {
            clearElement(body);
            const emptyDiv = document.createElement("div");
            emptyDiv.textContent = t("listEmpty");
            setStyles(emptyDiv, {
                color: "rgba(255,255,255,0.5)",
                textAlign: "center",
                padding: "20px"
            });
            body.appendChild(emptyDiv);
            return;
        }

        msgs.sort((a, b) => (b.sendAt || b.createdAt) - (a.sendAt || a.createdAt));
        clearElement(body);

        msgs.forEach((m) => {
            const row = document.createElement("div");
            const statusColor = m.status === "sent"
                ? "#00a884"
                : m.status === "failed"
                  ? "#dc2626"
                  : m.status === "sending"
                    ? "#f59e0b"
                    : "#53bdeb";

            setStyles(row, {
                marginBottom: "10px",
                padding: "10px 12px",
                background: "#111b21",
                borderRadius: "6px",
                border: "1px solid rgba(255,255,255,0.06)",
                transition: "background 0.15s, border-color 0.15s"
            });

            row.addEventListener("mouseover", () => {
                row.style.background = "rgba(17,27,33,0.9)";
                row.style.borderColor = "rgba(255,255,255,0.12)";
            });
            row.addEventListener("mouseout", () => {
                row.style.background = "#111b21";
                row.style.borderColor = "rgba(255,255,255,0.06)";
            });

            const when = m.sendAt ? new Date(m.sendAt).toLocaleString() : "-";
            const delivered = m.deliveredAt ? new Date(m.deliveredAt).toLocaleString() : null;
            const textShort = (m.text || "").length > 70
                ? (m.text || "").slice(0, 67) + "…"
                : (m.text || "");

            const statusLabel = {
                scheduled: t("statusScheduled"),
                sending: t("statusSending"),
                sent: t("statusSent"),
                failed: t("statusFailed")
            }[m.status] || m.status;

            const rowLayout = document.createElement("div");
            setStyles(rowLayout, {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "8px"
            });

            const leftCol = document.createElement("div");
            setStyles(leftCol, { flex: "1" });

            const messageTitle = document.createElement("div");
            messageTitle.textContent = textShort;
            setStyles(messageTitle, { fontWeight: "700", fontSize: "13px", marginBottom: "4px" });

            const metaLine = document.createElement("div");
            setStyles(metaLine, {
                fontSize: "11px",
                color: "rgba(255,255,255,0.65)",
                display: "flex",
                gap: "8px",
                flexWrap: "wrap"
            });
            const whenSpan = document.createElement("span");
            whenSpan.textContent = `⏰ ${when}`;
            metaLine.appendChild(whenSpan);

            leftCol.appendChild(messageTitle);
            leftCol.appendChild(metaLine);

            if (delivered) {
                const deliveredDiv = document.createElement("div");
                deliveredDiv.textContent = `✓ ${t("labelDeliveredAt")} ${delivered}`;
                setStyles(deliveredDiv, { fontSize: "10px", color: "#00a884", opacity: "0.85" });
                leftCol.appendChild(deliveredDiv);
            }

            const statusLine = document.createElement("div");
            setStyles(statusLine, {
                marginTop: "6px",
                fontSize: "11px",
                display: "flex",
                gap: "10px",
                alignItems: "center"
            });
            const statusBadge = document.createElement("span");
            statusBadge.textContent = statusLabel;
            setStyles(statusBadge, {
                padding: "2px 8px",
                borderRadius: "999px",
                background: "rgba(255,255,255,0.08)",
                color: statusColor,
                fontWeight: "700"
            });
            statusLine.appendChild(statusBadge);

            if (m.chatTitle) {
                const chatSpan = document.createElement("span");
                chatSpan.textContent = `💬 ${m.chatTitle}`;
                setStyles(chatSpan, { color: "rgba(255,255,255,0.7)" });
                statusLine.appendChild(chatSpan);
            }

            leftCol.appendChild(statusLine);
            rowLayout.appendChild(leftCol);

            if (m.status === "scheduled" || m.status === "sending") {
                const actionCol = document.createElement("div");
                setStyles(actionCol, { display: "flex", flexDirection: "column", gap: "6px" });

                const editBtn = document.createElement("button");
                editBtn.className = "wa-edit";
                editBtn.dataset.id = m.id;
                editBtn.textContent = t("buttonEdit");
                setStyles(editBtn, {
                    background: "rgba(0,168,132,0.12)",
                    color: "#00a884",
                    border: "1px solid rgba(0,168,132,0.4)",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontWeight: "700",
                    cursor: "pointer",
                    fontSize: "11px",
                    transition: "background 0.15s, border-color 0.15s"
                });

                const cancelBtn = document.createElement("button");
                cancelBtn.className = "wa-cancel";
                cancelBtn.dataset.id = m.id;
                cancelBtn.textContent = t("buttonCancel");
                setStyles(cancelBtn, {
                    background: "rgba(220,38,38,0.12)",
                    color: "#ef4444",
                    border: "1px solid rgba(220,38,38,0.4)",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontWeight: "700",
                    cursor: "pointer",
                    fontSize: "11px",
                    transition: "background 0.15s, border-color 0.15s"
                });

                [editBtn, cancelBtn].forEach((btn) => {
                    btn.addEventListener("mouseover", () => {
                        if (btn.classList.contains("wa-edit")) {
                            btn.style.background = "rgba(0,168,132,0.2)";
                            btn.style.borderColor = "rgba(0,168,132,0.5)";
                        } else {
                            btn.style.background = "rgba(220,38,38,0.2)";
                            btn.style.borderColor = "rgba(220,38,38,0.6)";
                        }
                    });
                    btn.addEventListener("mouseout", () => {
                        if (btn.classList.contains("wa-edit")) {
                            btn.style.background = "rgba(0,168,132,0.12)";
                            btn.style.borderColor = "rgba(0,168,132,0.4)";
                        } else {
                            btn.style.background = "rgba(220,38,38,0.12)";
                            btn.style.borderColor = "rgba(220,38,38,0.4)";
                        }
                    });
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const msgId = btn.getAttribute("data-id");
                        if (btn.classList.contains("wa-edit")) {
                            openEditDialog(msgId, m, host);
                            return;
                        }
                        if (confirm(t("confirmCancelSend"))) {
                            browser.runtime.sendMessage(
                                { type: "CANCEL_MESSAGE", id: msgId },
                                (resp) => {
                                    if (resp && resp.ok) {
                                        showToast(t("toastMessageCancelled"), "success");
                                        renderListPanel(host);
                                    } else {
                                        showToast(t("toastErrorWithDetail", [resp?.error || t("errorNoResponse")]), "error");
                                    }
                                }
                            );
                        }
                    });
                });

                actionCol.appendChild(editBtn);
                actionCol.appendChild(cancelBtn);
                rowLayout.appendChild(actionCol);
            }

            row.appendChild(rowLayout);
            body.appendChild(row);
        });
    });
}

// -------------------------
// Enhanced scheduling panel

function updateHeaderForMode() {
    const backBtn = document.getElementById("wa-scheduler-back");
    const titleEl = document.getElementById("wa-scheduler-title");

    if (!backBtn || !titleEl) return;

    if (waSchedulerMode === "schedule") {
        backBtn.style.display = "none";
        titleEl.textContent = t("panelTitleSchedule") || "Schedule message";
    } else {
        backBtn.style.display = "inline-flex";
        titleEl.textContent = t("listTitle") || "Scheduled messages";
    }
}

function renderScheduleView(root) {
    if (!root) return;

    const labelAfter = t("labelScheduleAfter") || "Enviar después de";
    const labelAt = t("labelScheduleAt") || "Enviar en fecha/hora";
    const labelAtField = t("labelScheduleAtField") || "Fecha y hora";
    const chatTitle = getActiveChatTitle() || t("labelChatUnknown");

    clearElement(root);

    const chatBox = document.createElement("div");
    setStyles(chatBox, {
        background: "rgba(0, 168, 132, 0.08)",
        borderLeft: "3px solid #00a884",
        padding: "8px 10px",
        borderRadius: "8px",
        fontSize: "12px"
    });
    const chatLabel = document.createElement("div");
    chatLabel.textContent = t("labelCurrentChat");
    setStyles(chatLabel, {
        fontWeight: "600",
        fontSize: "11px",
        color: "rgba(233,237,239,0.85)",
        letterSpacing: "0.1px"
    });
    const chatName = document.createElement("div");
    chatName.textContent = chatTitle;
    setStyles(chatName, { fontWeight: "600", color: "#e9edef", marginTop: "2px" });
    chatBox.appendChild(chatLabel);
    chatBox.appendChild(chatName);

    const messageWrapper = document.createElement("div");
    const msgLabel = document.createElement("label");
    msgLabel.textContent = t("labelMessage");
    setStyles(msgLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const msgInput = document.createElement("textarea");
    msgInput.id = "wa-msg";
    msgInput.placeholder = t("placeholderMessage");
    setStyles(msgInput, { width: "100%", height: "80px", resize: "vertical", borderRadius: "8px" });
    const counter = document.createElement("div");
    setStyles(counter, {
        fontSize: "11px",
        color: "rgba(241,241,242,0.65)",
        textAlign: "right",
        marginTop: "4px"
    });
    const charCount = document.createElement("span");
    charCount.id = "wa-char-count";
    charCount.textContent = "0";
    counter.appendChild(charCount);
    counter.appendChild(document.createTextNode(" / 4096"));
    messageWrapper.appendChild(msgLabel);
    messageWrapper.appendChild(msgInput);
    messageWrapper.appendChild(counter);

    const grid = document.createElement("div");
    setStyles(grid, { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" });

    const radioRow = document.createElement("div");
    setStyles(radioRow, { gridColumn: "span 2", display: "flex", gap: "10px", alignItems: "center" });

    const relativeLabel = document.createElement("label");
    setStyles(relativeLabel, { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" });
    const modeRelative = document.createElement("input");
    modeRelative.id = "wa-mode-relative";
    modeRelative.type = "radio";
    modeRelative.name = "wa-mode";
    modeRelative.value = "relative";
    modeRelative.checked = true;
    setStyles(modeRelative, { width: "14px", height: "14px" });
    const relativeText = document.createElement("span");
    relativeText.textContent = labelAfter;
    relativeLabel.appendChild(modeRelative);
    relativeLabel.appendChild(relativeText);

    const datetimeLabel = document.createElement("label");
    setStyles(datetimeLabel, { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" });
    const modeDatetime = document.createElement("input");
    modeDatetime.id = "wa-mode-datetime";
    modeDatetime.type = "radio";
    modeDatetime.name = "wa-mode";
    modeDatetime.value = "datetime";
    setStyles(modeDatetime, { width: "14px", height: "14px" });
    const datetimeText = document.createElement("span");
    datetimeText.textContent = labelAt;
    datetimeLabel.appendChild(modeDatetime);
    datetimeLabel.appendChild(datetimeText);

    radioRow.appendChild(relativeLabel);
    radioRow.appendChild(datetimeLabel);

    const hoursWrapper = document.createElement("div");
    const hoursLabel = document.createElement("label");
    hoursLabel.textContent = t("labelHours");
    setStyles(hoursLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const hoursInput = document.createElement("input");
    hoursInput.id = "wa-hours";
    hoursInput.type = "number";
    hoursInput.min = "0";
    hoursInput.max = "999";
    hoursInput.value = "0";
    setStyles(hoursInput, { width: "100%", padding: "8px 10px", borderRadius: "6px" });
    hoursWrapper.appendChild(hoursLabel);
    hoursWrapper.appendChild(hoursInput);

    const minsWrapper = document.createElement("div");
    const minsLabel = document.createElement("label");
    minsLabel.textContent = t("labelMinutes");
    setStyles(minsLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const minsInput = document.createElement("input");
    minsInput.id = "wa-mins";
    minsInput.type = "number";
    minsInput.min = "0";
    minsInput.max = "59";
    minsInput.value = "0";
    setStyles(minsInput, { width: "100%", padding: "8px 10px", borderRadius: "6px" });
    minsWrapper.appendChild(minsLabel);
    minsWrapper.appendChild(minsInput);

    const dateWrapper = document.createElement("div");
    setStyles(dateWrapper, { gridColumn: "span 2" });
    const dateLabel = document.createElement("label");
    dateLabel.textContent = labelAtField;
    setStyles(dateLabel, {
        display: "block",
        fontSize: "11px",
        opacity: "0.8",
        marginBottom: "4px",
        fontWeight: "600",
        letterSpacing: "0.1px"
    });
    const datetimeInput = document.createElement("input");
    datetimeInput.id = "wa-datetime";
    datetimeInput.type = "datetime-local";
    setStyles(datetimeInput, { width: "100%", padding: "8px 10px", borderRadius: "6px" });
    dateWrapper.appendChild(dateLabel);
    dateWrapper.appendChild(datetimeInput);

    grid.appendChild(radioRow);
    grid.appendChild(hoursWrapper);
    grid.appendChild(minsWrapper);
    grid.appendChild(dateWrapper);

    const actions = document.createElement("div");
    setStyles(actions, { display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "4px" });
    const listBtn = document.createElement("button");
    listBtn.id = "wa-list";
    listBtn.textContent = t("buttonList");
    setStyles(listBtn, {
        background: "transparent",
        border: "1px solid rgba(134,150,160,0.5)",
        color: "#e9edef",
        borderRadius: "6px",
        padding: "8px 12px",
        fontWeight: "600",
        cursor: "pointer",
        fontSize: "12px",
        transition: "border-color 0.15s, background 0.15s"
    });
    const scheduleBtn = document.createElement("button");
    scheduleBtn.id = "wa-schedule";
    scheduleBtn.textContent = t("buttonSchedule");
    setStyles(scheduleBtn, {
        background: "#00a884",
        color: "#111b21",
        border: "none",
        borderRadius: "6px",
        padding: "8px 12px",
        fontWeight: "700",
        cursor: "pointer",
        fontSize: "12px",
        transition: "background 0.15s, box-shadow 0.15s"
    });

    actions.appendChild(listBtn);
    actions.appendChild(scheduleBtn);

    root.appendChild(chatBox);
    root.appendChild(messageWrapper);
    root.appendChild(grid);
    root.appendChild(actions);

    msgInput.addEventListener("input", () => {
        charCount.textContent = msgInput.value.length;
        if (msgInput.value.length > 4096) {
            charCount.style.color = "#dc2626";
        } else if (msgInput.value.length > 3500) {
            charCount.style.color = "#f59e0b";
        } else {
            charCount.style.color = "rgba(241,241,242,0.65)";
        }
    });

    scheduleBtn.onmouseover = () => {
        scheduleBtn.style.background = "#029273";
        scheduleBtn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
    };
    scheduleBtn.onmouseout = () => {
        scheduleBtn.style.background = "#00a884";
        scheduleBtn.style.boxShadow = "none";
    };

    listBtn.onmouseover = () => {
        listBtn.style.background = "rgba(134,150,160,0.1)";
        listBtn.style.borderColor = "rgba(134,150,160,0.8)";
    };
    listBtn.onmouseout = () => {
        listBtn.style.background = "transparent";
        listBtn.style.borderColor = "rgba(134,150,160,0.5)";
    };

    listBtn.onclick = () => {
        const body = document.getElementById("wa-scheduler-body");
        if (!body) return;
        waSchedulerMode = "list";
        renderListView(body);
        updateHeaderForMode();
    };

    const updateModeUI = () => {
        const isRelative = modeRelative.checked;
        hoursInput.disabled = !isRelative;
        minsInput.disabled = !isRelative;
        datetimeInput.disabled = isRelative;
        datetimeInput.style.opacity = isRelative ? 0.5 : 1;
    };

    modeRelative.addEventListener("change", updateModeUI);
    modeDatetime.addEventListener("change", updateModeUI);
    updateModeUI();

    scheduleBtn.onclick = () => {
        const text = msgInput.value.trim();
        const hours = parseInt(hoursInput.value || "0", 10);
        const mins = parseInt(minsInput.value || "0", 10);

        if (!text) {
            showToast(t("toastWriteMessage"), "warning");
            return;
        }

        if (text.length > 4096) {
            showToast(t("toastTextTooLong", [text.length]), "error");
            return;
        }

        const isRelativeMode = modeRelative.checked;
        let delayMs = 0;
        let totalMins = 0;

        if (isRelativeMode) {
            totalMins = hours * 60 + mins;
            if (totalMins <= 0) {
                showToast(t("toastNeedTime"), "warning");
                return;
            }

            delayMs = totalMins * 60 * 1000;
        } else {
            const dtValue = datetimeInput.value;
            const sendAt = dtValue ? new Date(dtValue).getTime() : NaN;
            delayMs = sendAt - Date.now();

            if (!dtValue || Number.isNaN(sendAt) || delayMs <= 0) {
                showToast("Selecciona una fecha/hora futura", "warning");
                return;
            }

            totalMins = Math.ceil(delayMs / (60 * 1000));
        }

        const chatTitleCurrent = getActiveChatTitle();
        const avatarKey = getActiveChatAvatarKey();

        browser.runtime.sendMessage(
            {
                type: "SCHEDULE_MESSAGE",
                text,
                delayMs,
                chatTitle: chatTitleCurrent,
                avatarKey
            },
            (resp) => {
                if (resp && resp.ok) {
                    showToast(t("toastScheduledMinutes", [totalMins]), "success");
                    msgInput.value = "";
                    hoursInput.value = "0";
                    minsInput.value = "0";
                    datetimeInput.value = "";
                    charCount.textContent = "0";
                    setTimeout(() => document.getElementById("wa-scheduler-panel")?.remove(), 500);
                } else {
                    showToast(t("toastErrorWithDetail", [resp?.error || t("errorNoResponse")]), "error", 5000);
                }
            }
        );
    };

    setTimeout(() => msgInput.focus(), 100);
}


function renderListView(root) {
    const headerTitle = document.getElementById("wa-scheduler-title");
    if (headerTitle) headerTitle.textContent = t("listTitle") || "Scheduled messages";

    if (root) {
        clearElement(root);
        renderListPanel(root);
    }
}

async function createSchedulerUI() {
    await ensureLocaleReady();

    const existing = document.getElementById("wa-scheduler-panel");
    if (existing) {
        existing.remove();
        return;
    }

    const panel = document.createElement("div");
    panel.id = "wa-scheduler-panel";
    setStyles(panel, {
        position: "fixed",
        bottom: "84px",
        right: "80px",
        zIndex: "99999",
        color: "#e9edef",
        fontSize: "12px",
        width: "340px",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        animation: "slideUp 0.25s ease-out"
    });

    const styleEl = document.createElement("style");
    styleEl.textContent = `@keyframes slideUp {
                from {
                    transform: translateY(16px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
            #wa-scheduler-panel input,
            #wa-scheduler-panel textarea {
                background: #202c33;
                border: 1px solid rgba(134,150,160,0.3);
                color: #e9edef;
                border-radius: 8px;
                padding: 9px 10px;
                font-size: 13px;
                font-family: inherit;
                transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
                box-sizing: border-box;
            }
            #wa-scheduler-panel input:focus,
            #wa-scheduler-panel textarea:focus {
                background: #202c33;
                border-color: #00a884;
                outline: none;
                box-shadow: 0 0 0 1px rgba(0, 168, 132, 0.4);
            }
            #wa-scheduler-panel input::placeholder,
            #wa-scheduler-panel textarea::placeholder {
                color: rgba(233, 237, 239, 0.6);
            }
            #wa-scheduler-panel input[type=number]::-webkit-inner-spin-button,
            #wa-scheduler-panel input[type=number]::-webkit-outer-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            #wa-scheduler-panel input[type=number] {
                -moz-appearance: textfield;
            }`;

    const inner = document.createElement("div");
    inner.id = "wa-scheduler-inner";
    setStyles(inner, {
        background: "#202c33",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "8px",
        boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
        overflow: "hidden"
    });

    const header = document.createElement("div");
    header.id = "wa-scheduler-header";
    setStyles(header, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 12px",
        background: "#202c33",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        gap: "8px"
    });

    const leftHeader = document.createElement("div");
    setStyles(leftHeader, { display: "flex", alignItems: "center", gap: "8px", flex: "1" });

    const backBtn = document.createElement("button");
    backBtn.id = "wa-scheduler-back";
    backBtn.textContent = "←";
    setStyles(backBtn, {
        width: "28px",
        height: "28px",
        borderRadius: "14px",
        border: "none",
        background: "transparent",
        color: "#e9edef",
        cursor: "pointer",
        transition: "background 0.15s",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px"
    });
    backBtn.addEventListener("mouseover", () => {
        backBtn.style.background = "rgba(134,150,160,0.16)";
    });
    backBtn.addEventListener("mouseout", () => {
        backBtn.style.background = "transparent";
    });

    const icon = document.createElement("span");
    icon.textContent = "🗓️";
    setStyles(icon, { fontSize: "15px", color: "#00a884" });

    const title = document.createElement("span");
    title.id = "wa-scheduler-title";
    title.textContent = t("panelTitleSchedule");
    setStyles(title, { fontWeight: "700", fontSize: "13px" });

    leftHeader.appendChild(backBtn);
    leftHeader.appendChild(icon);
    leftHeader.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.id = "wa-close";
    closeBtn.textContent = "✕";
    setStyles(closeBtn, {
        width: "32px",
        height: "32px",
        borderRadius: "16px",
        border: "none",
        background: "transparent",
        color: "#e9edef",
        cursor: "pointer",
        transition: "background 0.15s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "16px"
    });
    closeBtn.addEventListener("mouseover", () => {
        closeBtn.style.background = "rgba(134,150,160,0.16)";
    });
    closeBtn.addEventListener("mouseout", () => {
        closeBtn.style.background = "transparent";
    });

    header.appendChild(leftHeader);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.id = "wa-scheduler-body";
    setStyles(body, { padding: "12px", display: "flex", flexDirection: "column", gap: "10px" });

    inner.appendChild(header);
    inner.appendChild(body);
    panel.appendChild(styleEl);
    panel.appendChild(inner);

    document.body.appendChild(panel);

    closeBtn.onclick = () => panel.remove();

    backBtn.addEventListener("click", () => {
        waSchedulerMode = "schedule";
        renderScheduleView(body);
        updateHeaderForMode();
    });

    waSchedulerMode = "schedule";
    renderScheduleView(body);
    updateHeaderForMode();
}


// -------------------------
// Floating button
// -------------------------

function attachScheduleButtonToComposer() {
    createFloatingButton();
}

async function createFloatingButton() {
    await ensureLocaleReady();

    if (document.getElementById("wa-scheduler-button")) return;

    const btn = document.createElement("button");
    btn.id = "wa-scheduler-button";
    const iconWrap = document.createElement("div");
    iconWrap.className = "html-div";
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "wa-schedule-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("aria-hidden", "true");

    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", "3.5");
    rect.setAttribute("y", "4.5");
    rect.setAttribute("width", "17");
    rect.setAttribute("height", "16");
    rect.setAttribute("rx", "2.5");
    rect.setAttribute("ry", "2.5");
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", "currentColor");
    rect.setAttribute("stroke-width", "1.8");
    svg.appendChild(rect);

    const line1 = document.createElementNS(svgNS, "line");
    line1.setAttribute("x1", "3.5");
    line1.setAttribute("y1", "8.5");
    line1.setAttribute("x2", "20.5");
    line1.setAttribute("y2", "8.5");
    line1.setAttribute("stroke", "currentColor");
    line1.setAttribute("stroke-width", "1.8");
    line1.setAttribute("stroke-linecap", "round");
    svg.appendChild(line1);

    const line2 = document.createElementNS(svgNS, "line");
    line2.setAttribute("x1", "9");
    line2.setAttribute("y1", "3");
    line2.setAttribute("x2", "9");
    line2.setAttribute("y2", "6.5");
    line2.setAttribute("stroke", "currentColor");
    line2.setAttribute("stroke-width", "1.8");
    line2.setAttribute("stroke-linecap", "round");
    svg.appendChild(line2);

    const line3 = document.createElementNS(svgNS, "line");
    line3.setAttribute("x1", "15");
    line3.setAttribute("y1", "3");
    line3.setAttribute("x2", "15");
    line3.setAttribute("y2", "6.5");
    line3.setAttribute("stroke", "currentColor");
    line3.setAttribute("stroke-width", "1.8");
    line3.setAttribute("stroke-linecap", "round");
    svg.appendChild(line3);

    const polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("points", "9 13 11.3 15.3 15.2 11.8");
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "currentColor");
    polyline.setAttribute("stroke-width", "1.8");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    svg.appendChild(polyline);

    iconWrap.appendChild(svg);
    btn.appendChild(iconWrap);
    btn.title = t("buttonTooltip");
    btn.style.cssText = `
        position: fixed;
        bottom: 18px;
        right: 70px;
        z-index: 99998;
        width: 40px;
        height: 40px;
        border-radius: 25px;
        border: none;
        background: #25D366;
        color: black;
        font-size: 24px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        transition: all 0.2s;
        font-family: inherit;
    `;

    btn.onmouseover = () => {
        btn.style.transform = "scale(1.1)";
        btn.style.boxShadow = "0 6px 20px rgba(37, 211, 102, 0.4)";
    };

    btn.onmouseout = () => {
        btn.style.transform = "scale(1)";
        btn.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
    };

    btn.onclick = createSchedulerUI;

    document.body.appendChild(btn);
    console.log("[WA Scheduler] Botón flotante creado");
}

setTimeout(createFloatingButton, 3000);

// -------------------------
// Keyboard shortcuts
// -------------------------

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "W") {
        e.preventDefault();
        createSchedulerUI();
    }
});

// -------------------------
// Messages from background
// -------------------------

browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SEND_SCHEDULED") {
        console.log("[WA Scheduler] SEND_SCHEDULED recibido:", msg);
        const { id, text, chatTitle, avatarKey } = msg;
        sendToScheduledChat(id, text, chatTitle, avatarKey).catch((err) =>
            console.error("[WA Scheduler] Error en envío programado:", err)
        );
    }
});
