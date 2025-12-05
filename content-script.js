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
    if (t === c) return 3;

    if (c.startsWith(t)) {
        const rest = c.slice(t.length);
        if (rest === "" || /^([\s\(\[\{.,-]|–|—)/.test(rest)) return 2;
    }

    if (t.startsWith(c)) {
        const rest = t.slice(c.length);
        if (rest === "" || /^([\s\(\[\{.,-]|–|—)/.test(rest)) return 1;
    }

    return 0;
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

        const score = nameMatchScore(title, text);
        if (score > 0) {
            const row = span.closest('div[role="row"]') || span.closest('div[role="button"]');
            if (row) {
                matches.push({ span, row, text, score });
            }
        }
    }

    if (!matches.length) return { found: false };

    matches.sort((a, b) => b.score - a.score);
    const bestScore = matches[0].score;
    const bestMatches = matches.filter((m) => m.score === bestScore);

    if (bestMatches.length === 1) {
        const match = bestMatches[0];
        console.log(`[WA Scheduler] Chat encontrado: "${match.text}". Abriendo...`);
        match.row.scrollIntoView({ block: "center", behavior: "instant" });
        superClick(match.span);
        superClick(match.row);
        return { found: true };
    }

    if (avatarKey) {
        const avatarMatches = bestMatches.filter((match) => {
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

async function openEditDialog(msgId, msg) {
    await ensureLocaleReady();

    // Remove existing modal if present
    const existing = document.getElementById("wa-edit-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "wa-edit-modal";
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.65);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        animation: fadeIn 0.2s ease-out;
    `;

    const content = document.createElement("div");
    content.style.cssText = `
        background: #202c33;
        color: #e9edef;
        padding: 16px 16px 14px;
        border-radius: 8px;
        width: 90%;
        max-width: 480px;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.08);
        animation: slideUp 0.25s ease-out;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;

    const sendAtDate = new Date(msg.sendAt);
    const hours = Math.floor((msg.sendAt - Date.now()) / (1000 * 60 * 60));
    const mins = Math.floor(((msg.sendAt - Date.now()) % (1000 * 60 * 60)) / (1000 * 60));

    content.innerHTML = `
        <style>
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
        </style>

        <div style="font-weight: 700; font-size: 13px; margin-bottom: 14px;">${t("labelEditMessageTitle")}</div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelChat")}</label>
            <div style="background: rgba(0, 168, 132, 0.08); padding: 8px 10px; border-radius: 8px; border-left: 3px solid #00a884; font-size: 13px; color: #e9edef;">
                ${msg.chatTitle || t("labelNoChat")}
            </div>
        </div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelMessage")}</label>
            <textarea id="wa-edit-text" style="height: 110px; resize: vertical; margin-bottom: 6px; border-radius: 8px;">${msg.text}</textarea>
            <div style="font-size: 11px; opacity: 0.65; text-align: right;"><span id="wa-edit-char-count">${msg.text.length}</span> / 4096</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; align-items: end;">
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelHours")}</label>
                <input id="wa-edit-hours" type="number" min="0" max="999" value="${hours}" style="padding: 8px 10px; border-radius: 6px;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelMinutes")}</label>
                <input id="wa-edit-mins" type="number" min="0" max="59" value="${mins}" style="padding: 8px 10px; border-radius: 6px;">
            </div>
        </div>

        <div style="background: rgba(83, 189, 235, 0.12); padding: 10px; border-radius: 8px; margin-bottom: 14px; font-size: 11px; opacity: 0.9; border: 1px solid rgba(83,189,235,0.2);">
            ${t("labelScheduledFor", [sendAtDate.toLocaleString()])}
        </div>

        <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px;">
            <button id="wa-edit-save"
                style="background: #00a884; color: #111b21; border: none; padding: 9px 14px; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 13px; transition: background 0.15s, box-shadow 0.15s; min-width: 110px;"
                onmouseover="this.style.background='#029273'; this.style.boxShadow='0 2px 8px rgba(0,0,0,0.35)'"
                onmouseout="this.style.background='#00a884'; this.style.boxShadow='none'">
                ${t("buttonSave")}
            </button>

            <button id="wa-edit-cancel"
                style="background: transparent; color: #e9edef; border: 1px solid rgba(134,150,160,0.5); padding: 9px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: border-color 0.15s, background 0.15s; min-width: 110px;"
                onmouseover="this.style.background='rgba(134,150,160,0.1)'; this.style.borderColor='rgba(134,150,160,0.8)'"
                onmouseout="this.style.background='transparent'; this.style.borderColor='rgba(134,150,160,0.5)'">
                ${t("buttonCancel")}
            </button>
        </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Character counter
    const textInput = document.getElementById("wa-edit-text");
    const charCount = document.getElementById("wa-edit-char-count");

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

    // Focus on the textarea
    setTimeout(() => textInput.focus(), 100);

    // Cancel button
    document.getElementById("wa-edit-cancel").addEventListener("click", () => {
        modal.style.animation = "slideOut 0.3s ease-in";
        setTimeout(() => modal.remove(), 300);
    });

    // Close with ESC
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

    // Save button
    document.getElementById("wa-edit-save").addEventListener("click", () => {
        const newText = textInput.value.trim();
        const newHours = parseInt(document.getElementById("wa-edit-hours").value || "0", 10);
        const newMins = parseInt(document.getElementById("wa-edit-mins").value || "0", 10);

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

    // Close when clicking outside the modal
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

    if (host) {
        host.innerHTML = `
            <div style="margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08);">
                <div style="font-weight: 700; font-size: 13px; margin-bottom: 2px;">${t("listTitle")}</div>
                <div style="font-size: 11px; color: rgba(241,241,242,0.6);">${t("listSubtitle")}</div>
            </div>
            <div id="wa-scheduler-list-body" style="max-height: 55vh; overflow-y: auto;">${t("listLoading")}</div>
        `;
        body = host.querySelector("#wa-scheduler-list-body");
    } else {
        const existing = document.getElementById("wa-scheduler-list");
        if (existing) existing.remove();

        const panel = document.createElement("div");
        panel.id = "wa-scheduler-list";
        panel.style.cssText = `
            position: fixed;
            bottom: 80px;
            right: 320px;
            z-index: 99999;
            background: #202c33;
            color: #e9edef;
            padding: 12px;
            border-radius: 8px;
            font-size: 11px;
            width: 380px;
            max-height: 68vh;
            overflow-y: auto;
            box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
            border: 1px solid rgba(255, 255, 255, 0.06);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        `;

        panel.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08);">
                <div>
                    <div style="font-weight: 700; font-size: 13px; margin-bottom: 2px;">${t("listTitle")}</div>
                    <div style="font-size: 11px; color: rgba(241,241,242,0.6);">${t("listSubtitle")}</div>
                </div>
                <button id="wa-list-close"
                    style="width: 32px; height: 32px; background: transparent; color: #e9edef; border: none; border-radius: 16px; cursor: pointer; font-size: 16px; transition: background 0.15s; display: flex; align-items: center; justify-content: center;"
                    onmouseover="this.style.background='rgba(134,150,160,0.16)'"
                    onmouseout="this.style.background='transparent'">✕</button>
            </div>
            <div id="wa-scheduler-list-body" style="max-height: 55vh; overflow-y: auto;">${t("listLoading")}</div>
        `;

        document.body.appendChild(panel);

        const closeBtn = document.getElementById("wa-list-close");
        closeBtn.onclick = () => panel.remove();
        body = document.getElementById("wa-scheduler-list-body");
    }

    if (!body) return;

    browser.runtime.sendMessage({ type: "GET_MESSAGES" }, (resp) => {
        if (!resp || !resp.ok) {
            body.innerHTML = `<div style="color: #ff6b6b; text-align: center; padding: 20px;">${t("listError")}</div>`;
            return;
        }

        const msgs = resp.messages || [];
        if (!msgs.length) {
            body.innerHTML = `<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">${t("listEmpty")}</div>`;
            return;
        }

        msgs.sort((a, b) => (b.sendAt || b.createdAt) - (a.sendAt || a.createdAt));
        body.innerHTML = "";

        msgs.forEach((m) => {
            const row = document.createElement("div");
            const statusColor = m.status === "sent"
                ? "#00a884"
                : m.status === "failed"
                  ? "#dc2626"
                  : m.status === "sending"
                    ? "#f59e0b"
                    : "#53bdeb";

            row.style.cssText = `
                margin-bottom: 10px;
                padding: 10px 12px;
                background: #111b21;
                border-radius: 6px;
                border: 1px solid rgba(255,255,255,0.06);
                transition: background 0.15s, border-color 0.15s;
            `;

            row.onmouseover = () => {
                row.style.background = "rgba(17,27,33,0.9)";
                row.style.borderColor = "rgba(255,255,255,0.12)";
            };
            row.onmouseout = () => {
                row.style.background = "#111b21";
                row.style.borderColor = "rgba(255,255,255,0.06)";
            };

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

            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                    <div style="flex: 1;">
                        <div style="font-weight: 700; font-size: 13px; margin-bottom: 4px;">${textShort}</div>
                        <div style="font-size: 11px; color: rgba(255,255,255,0.65); display: flex; gap: 8px; flex-wrap: wrap;">
                            <span>⏰ ${when}</span>
                        </div>
                        ${delivered ? `
                            <div style="font-size: 10px; color: #00a884; opacity: 0.85;">
                                ✓ ${t("labelDeliveredAt")} ${delivered}
                            </div>
                        ` : ""}
                        <div style="margin-top: 6px; font-size: 11px; display: flex; gap: 10px; align-items: center;">
                            <span style="padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.08); color: ${statusColor}; font-weight: 700;">${statusLabel}</span>
                            ${m.chatTitle ? `<span style="color: rgba(255,255,255,0.7);">💬 ${m.chatTitle}</span>` : ""}
                        </div>
                    </div>
                    ${m.status === "scheduled" || m.status === "sending" ?
                        `<div style="display: flex; flex-direction: column; gap: 6px;">
                            <button class="wa-edit" data-id="${m.id}" style="background: rgba(0,168,132,0.12); color: #00a884; border: 1px solid rgba(0,168,132,0.4); padding: 6px 10px; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 11px; transition: background 0.15s, border-color 0.15s;">${t("buttonEdit")}</button>
                            <button class="wa-cancel" data-id="${m.id}" style="background: rgba(220,38,38,0.12); color: #ef4444; border: 1px solid rgba(220,38,38,0.4); padding: 6px 10px; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 11px; transition: background 0.15s, border-color 0.15s;">${t("buttonCancel")}</button>
                        </div>`
                        : ""
                    }
                </div>
            `;

            body.appendChild(row);

            row.querySelectorAll("button").forEach((btn) => {
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

    root.innerHTML = `
        <div style="background: rgba(0, 168, 132, 0.08); border-left: 3px solid #00a884; padding: 8px 10px; border-radius: 8px; font-size: 12px;">
            <div style="font-weight: 600; font-size: 11px; color: rgba(233,237,239,0.85); letter-spacing: 0.1px;">${t("labelCurrentChat")}</div>
            <div style="font-weight: 600; color: #e9edef; margin-top: 2px;">${chatTitle}</div>
        </div>

        <div>
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelMessage")}</label>
            <textarea id="wa-msg" placeholder="${t("placeholderMessage")}" style="width: 100%; height: 80px; resize: vertical; border-radius: 8px;"></textarea>
            <div style="font-size: 11px; color: rgba(241,241,242,0.65); text-align: right; margin-top: 4px;"><span id="wa-char-count">0</span> / 4096</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div style="grid-column: span 2; display: flex; gap: 10px; align-items: center;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;">
                    <input id="wa-mode-relative" type="radio" name="wa-mode" value="relative" checked style="width: 14px; height: 14px;">
                    <span>${labelAfter}</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;">
                    <input id="wa-mode-datetime" type="radio" name="wa-mode" value="datetime" style="width: 14px; height: 14px;">
                    <span>${labelAt}</span>
                </label>
            </div>
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelHours")}</label>
                <input id="wa-hours" type="number" min="0" max="999" value="0" style="width: 100%; padding: 8px 10px; border-radius: 6px;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${t("labelMinutes")}</label>
                <input id="wa-mins" type="number" min="0" max="59" value="0" style="width: 100%; padding: 8px 10px; border-radius: 6px;">
            </div>
            <div style="grid-column: span 2;">
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; letter-spacing: 0.1px;">${labelAtField}</label>
                <input id="wa-datetime" type="datetime-local" style="width: 100%; padding: 8px 10px; border-radius: 6px;">
            </div>
        </div>

        <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;">
            <button id="wa-list" style="background: transparent; border: 1px solid rgba(134,150,160,0.5); color: #e9edef; border-radius: 6px; padding: 8px 12px; font-weight: 600; cursor: pointer; font-size: 12px; transition: border-color 0.15s, background 0.15s;">
                ${t("buttonList")}
            </button>
            <button id="wa-schedule" style="background: #00a884; color: #111b21; border: none; border-radius: 6px; padding: 8px 12px; font-weight: 700; cursor: pointer; font-size: 12px; transition: background 0.15s, box-shadow 0.15s;">
                ${t("buttonSchedule")}
            </button>
        </div>
    `;

    const msgInput = document.getElementById("wa-msg");
    const charCount = document.getElementById("wa-char-count");
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

    const scheduleBtn = document.getElementById("wa-schedule");
    scheduleBtn.onmouseover = () => {
        scheduleBtn.style.background = "#029273";
        scheduleBtn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
    };
    scheduleBtn.onmouseout = () => {
        scheduleBtn.style.background = "#00a884";
        scheduleBtn.style.boxShadow = "none";
    };

    const listBtn = document.getElementById("wa-list");
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

    const modeRelative = document.getElementById("wa-mode-relative");
    const modeDatetime = document.getElementById("wa-mode-datetime");
    const hoursInput = document.getElementById("wa-hours");
    const minsInput = document.getElementById("wa-mins");
    const datetimeInput = document.getElementById("wa-datetime");

    function updateModeUI() {
        const isRelative = modeRelative.checked;
        hoursInput.disabled = !isRelative;
        minsInput.disabled = !isRelative;
        datetimeInput.disabled = isRelative;
        datetimeInput.style.opacity = isRelative ? 0.5 : 1;
    }

    modeRelative.addEventListener("change", updateModeUI);
    modeDatetime.addEventListener("change", updateModeUI);
    updateModeUI();

    document.getElementById("wa-schedule").onclick = () => {
        const text = document.getElementById("wa-msg").value.trim();
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

            if (!dtValue || isNaN(sendAt) || delayMs <= 0) {
                showToast("Selecciona una fecha/hora futura", "warning");
                return;
            }

            totalMins = Math.ceil(delayMs / (60 * 1000));
        }

        const chatTitle = getActiveChatTitle();
        const avatarKey = getActiveChatAvatarKey();

        browser.runtime.sendMessage(
            {
                type: "SCHEDULE_MESSAGE",
                text,
                delayMs,
                chatTitle,
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
        root.innerHTML = "";
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
    panel.style.cssText = `
        position: fixed;
        bottom: 84px;
        right: 80px;
        z-index: 99999;
        color: #e9edef;
        font-size: 12px;
        width: 340px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        animation: slideUp 0.25s ease-out;
    `;

    panel.innerHTML = `
        <style>
            @keyframes slideUp {
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
            #wa-scheduler-panel textarea {                background: #202c33;                border: 1px solid rgba(134,150,160,0.3);                color: #e9edef;                border-radius: 8px;                padding: 9px 10px;                font-size: 13px;                font-family: inherit;                transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;                box-sizing: border-box;            }
            #wa-scheduler-panel input:focus,
            #wa-scheduler-panel textarea:focus {                background: #202c33;                border-color: #00a884;                outline: none;                box-shadow: 0 0 0 1px rgba(0, 168, 132, 0.4);            }
            #wa-scheduler-panel input::placeholder,
            #wa-scheduler-panel textarea::placeholder {                color: rgba(233, 237, 239, 0.6);            }
            #wa-scheduler-panel input[type=number]::-webkit-inner-spin-button,
            #wa-scheduler-panel input[type=number]::-webkit-outer-spin-button {                -webkit-appearance: none;                margin: 0;            }
            #wa-scheduler-panel input[type=number] {                -moz-appearance: textfield;            }
        </style>

        <div id="wa-scheduler-inner" style="background: #202c33; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.35); overflow: hidden;">
            <div id="wa-scheduler-header" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #202c33; border-bottom: 1px solid rgba(255,255,255,0.08); gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                    <button id="wa-scheduler-back" style="width: 28px; height: 28px; border-radius: 14px; border: none; background: transparent; color: #e9edef; cursor: pointer; transition: background 0.15s; display: none; align-items: center; justify-content: center; font-size: 14px;" onmouseover="this.style.background='rgba(134,150,160,0.16)'" onmouseout="this.style.background='transparent'">←</button>
                    <span style="font-size: 15px; color: #00a884;">🗓️</span>
                    <span id="wa-scheduler-title" style="font-weight: 700; font-size: 13px;">${t("panelTitleSchedule")}</span>
                </div>
                <button id="wa-close" style="width: 32px; height: 32px; border-radius: 16px; border: none; background: transparent; color: #e9edef; cursor: pointer; transition: background 0.15s; display: flex; align-items: center; justify-content: center; font-size: 16px;" onmouseover="this.style.background='rgba(134,150,160,0.16)'" onmouseout="this.style.background='transparent'">✕</button>
            </div>

            <div id="wa-scheduler-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px;"></div>
        </div>
    `;

    document.body.appendChild(panel);

    const closeBtn = document.getElementById("wa-close");
    closeBtn.onclick = () => panel.remove();

    const backBtn = document.getElementById("wa-scheduler-back");
    if (backBtn) {
        backBtn.addEventListener("click", () => {
            waSchedulerMode = "schedule";
            const body = document.getElementById("wa-scheduler-body");
            if (body) renderScheduleView(body);
            updateHeaderForMode();
        });
    }

    waSchedulerMode = "schedule";
    const body = panel.querySelector("#wa-scheduler-body");
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
    btn.innerHTML = `
        <div class="html-div">
            <svg
                class="wa-schedule-icon"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                aria-hidden="true"
            >
                <rect
                    x="3.5"
                    y="4.5"
                    width="17"
                    height="16"
                    rx="2.5"
                    ry="2.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                />
                <line
                    x1="3.5"
                    y1="8.5"
                    x2="20.5"
                    y2="8.5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                />
                <line
                    x1="9"
                    y1="3"
                    x2="9"
                    y2="6.5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                />
                <line
                    x1="15"
                    y1="3"
                    x2="15"
                    y2="6.5"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                />
                <polyline
                    points="9 13 11.3 15.3 15.2 11.8"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </div>
    `;
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
