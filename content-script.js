// Firefox/Chrome compatibility
if (typeof browser === "undefined") {
    var browser = chrome;
}

console.log("[WA Scheduler] content-script cargado");

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

function namesMatch(target, candidate) {
    const t = normalizeName(target);
    const c = normalizeName(candidate);

    if (!t || !c) return false;
    if (t === c) return true;
    if (c.includes(t)) return true;
    return false;
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

function openChatByTitle(title) {
    if (!title) return false;

    const sidePane = document.getElementById("pane-side") || document.body;
    const candidates = sidePane.querySelectorAll('span[dir="auto"]');

    for (const span of candidates) {
        const text = span.textContent || span.getAttribute("title");
        if (!text) continue;

        if (namesMatch(title, text)) {
            const row = span.closest('div[role="row"]') || span.closest('div[role="button"]');

            if (row) {
                console.log(`[WA Scheduler] Chat encontrado: "${text}". Abriendo...`);
                row.scrollIntoView({ block: "center", behavior: "instant" });

                superClick(span);
                superClick(row);

                return true;
            }
        }
    }
    return false;
}

async function searchAndOpenChat(title) {
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
        return false;
    }

    searchInput.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    triggerInputEvent(searchInput, title);

    await delay(1800);

    const found = openChatByTitle(title);

    if (found) {
        await delay(1500);
        const clearBtn =
            document.querySelector('[data-icon="x-alt"]')?.closest('div[role="button"]') ||
            document.querySelector('[data-icon="back"]')?.closest('div[role="button"]');
        if (clearBtn) superClick(clearBtn);
        return true;
    }

    return false;
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
        right: 20px;
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

async function sendToScheduledChat(id, text, chatTitle) {
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
    if (current && namesMatch(chatTitle, current)) {
        console.log("Chat correcto ya abierto.");
        try {
            sendMessageInActiveChat(text);
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: true });
        } catch (e) {
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: String(e) });
        }
        return;
    }

    let opened = openChatByTitle(chatTitle);
    if (!opened) {
        opened = await searchAndOpenChat(chatTitle);
    }

    if (!opened) {
        browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: false, error: t("errorChatNotFound", [chatTitle]) });
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
            lastInput = null;
            lastSendButton = null;

            const composer = findActiveComposer();
            if (composer) {
                setLastTargetsFromElement(composer);
            }
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
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100000;
        animation: fadeIn 0.2s ease-out;
    `;

    const content = document.createElement("div");
    content.style.cssText = `
        background: rgba(32, 44, 51, 0.98);
        backdrop-filter: blur(4px);
        color: white;
        padding: 20px;
        border-radius: 12px;
        width: 90%;
        max-width: 450px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.1);
        animation: slideUp 0.3s ease-out;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;

    const sendAtDate = new Date(msg.sendAt);
    const hours = Math.floor((msg.sendAt - Date.now()) / (1000 * 60 * 60));
    const mins = Math.floor(((msg.sendAt - Date.now()) % (1000 * 60 * 60)) / (1000 * 60));

    content.innerHTML = `
        <style>
            #wa-edit-modal input,
            #wa-edit-modal textarea {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                border-radius: 6px;
                padding: 10px;
                font-size: 12px;
                font-family: inherit;
                transition: all 0.2s;
                width: 100%;
                box-sizing: border-box;
            }
            #wa-edit-modal input:focus,
            #wa-edit-modal textarea:focus {
                background: rgba(255, 255, 255, 0.15);
                border-color: #25D366;
                outline: none;
                box-shadow: 0 0 8px rgba(37, 211, 102, 0.3);
            }
            #wa-edit-modal input::placeholder,
            #wa-edit-modal textarea::placeholder {
                color: rgba(255, 255, 255, 0.5);
            }
        </style>

        <div style="font-weight: 700; font-size: 16px; margin-bottom: 16px;">${t("labelEditMessageTitle")}</div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">${t("labelChat")}</label>
            <div style="background: rgba(37, 211, 102, 0.15); padding: 8px; border-radius: 6px; border-left: 3px solid #25D366; font-size: 12px;">
                ${msg.chatTitle || t("labelNoChat")}
            </div>
        </div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">${t("labelMessage")}</label>
            <textarea id="wa-edit-text" style="height: 100px; resize: vertical; margin-bottom: 6px;">${msg.text}</textarea>
            <div style="font-size: 10px; opacity: 0.7;"><span id="wa-edit-char-count">${msg.text.length}</span> / 4096</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">${t("labelHours")}</label>
                <input id="wa-edit-hours" type="number" min="0" max="999" value="${hours}">
            </div>
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">${t("labelMinutes")}</label>
                <input id="wa-edit-mins" type="number" min="0" max="59" value="${mins}">
            </div>
        </div>

        <div style="background: rgba(59, 130, 246, 0.15); padding: 8px; border-radius: 6px; margin-bottom: 16px; font-size: 11px; opacity: 0.9;">
            ${t("labelScheduledFor", [sendAtDate.toLocaleString()])}
        </div>

        <div style="display: flex; gap: 8px;">
            <button id="wa-edit-save"
                style="flex: 1; background: #25D366; color: black; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.transform='scale(1.02)'; this.style.boxShadow='0 4px 12px rgba(37,211,102,0.3)'"
                onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none'">
                💾 ${t("buttonSave")}
            </button>

            <button id="wa-edit-cancel"
                style="flex: 1; background: rgba(255, 255, 255, 0.15); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(255, 255, 255, 0.25)'"
                onmouseout="this.style.background='rgba(255, 255, 255, 0.15)'">
                ✕ ${t("buttonCancel")}
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
            charCount.style.color = "rgba(255,255,255,0.7)";
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
                        renderListPanel();
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

async function renderListPanel() {
    await ensureLocaleReady();

    const existing = document.getElementById("wa-scheduler-list");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = "wa-scheduler-list";
    panel.style.cssText = `
        position: fixed;
        bottom: 80px;
        right: 320px;
        z-index: 99999;
        background: rgba(32, 44, 51, 0.98);
        backdrop-filter: blur(4px);
        color: white;
        padding: 12px;
        border-radius: 10px;
        font-size: 11px;
        width: 380px;
        max-height: 65vh;
        overflow-y: auto;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;

    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.15);">
            <div>
                <div style="font-weight: 700; font-size: 13px; margin-bottom: 2px;">${t("listTitle")}</div>
                <div style="font-size: 10px; opacity: 0.7;">${t("listSubtitle")}</div>
            </div>
            <button id="wa-list-close"
                style="background: rgba(255,255,255,0.15);color: white;border: none;border-radius: 6px;padding: 6px 10px;cursor: pointer;font-size: 16px;transition: all 0.2s;"
                onmouseover="this.style.background='rgba(255,255,255,0.25)'"
                onmouseout="this.style.background='rgba(255,255,255,0.15)'">✕</button>
        </div>
        <div id="wa-scheduler-list-body" style="max-height: 55vh; overflow-y: auto;">${t("listLoading")}</div>
    `;

    document.body.appendChild(panel);

    const closeBtn = document.getElementById("wa-list-close");
    closeBtn.onclick = () => panel.remove();

    const body = document.getElementById("wa-scheduler-list-body");

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
            row.style.cssText = `
                margin-bottom: 10px;
                padding: 10px;
                background: rgba(255,255,255,0.08);
                border-radius: 6px;
                border-left: 3px solid ${
                    m.status === "sent" ? "#25D366" :
                    m.status === "failed" ? "#dc2626" :
                    m.status === "sending" ? "#f59e0b" :
                    "#3b82f6"
                };
                transition: all 0.2s;
            `;
            
            row.onmouseover = () => {
                row.style.background = "rgba(255,255,255,0.12)";
            };
            row.onmouseout = () => {
                row.style.background = "rgba(255,255,255,0.08)";
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

            const canEdit = m.status === "scheduled";
            const canCancel = m.status === "scheduled";

            row.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <div>
                        <strong style="color: #25D366;">${statusLabel}</strong>
                        <span style="opacity: 0.7; font-size: 10px; margin-left: 8px;">${when}</span>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        ${canEdit ? `<button class="wa-list-edit" data-id="${m.id}"
                            style="background: rgba(59, 130, 246, 0.7); color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; transition: all 0.2s;"
                            title="${t("buttonEdit")}">
                            ${t("buttonEdit")}
                        </button>` : ""}
                        ${canCancel ? `<button class="wa-list-cancel" data-id="${m.id}"
                            style="background: rgba(220, 38, 38, 0.7); color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; transition: all 0.2s;"
                            title="${t("buttonDelete")}">
                            ${t("buttonDelete")}
                        </button>` : ""}
                    </div>
                </div>
                <div style="font-weight: 600; margin-bottom: 4px; opacity: 0.95; word-break: break-word;">${m.chatTitle || t("labelNoChat")}</div>
                <div style="opacity: 0.85; margin-bottom: 6px; word-break: break-word; line-height: 1.3; font-size: 11px; background: rgba(255,255,255,0.05); padding: 6px; border-radius: 4px;">${textShort}</div>
                ${delivered ? `<div style="font-size: 10px; opacity: 0.7; color: #25D366;">✓ ${delivered}</div>` : ""}
                ${m.lastError ? `<div style="font-size: 10px; color: #ff9999; margin-top: 4px;">⚠ ${m.lastError}</div>` : ""}
            `;

            body.appendChild(row);
        });

        // Event listeners for edit and cancel buttons
        document.querySelectorAll(".wa-list-edit").forEach((btn) => {
            btn.addEventListener("mouseover", () => {
                btn.style.background = "rgba(59, 130, 246, 1)";
                btn.style.transform = "scale(1.05)";
            });
            btn.addEventListener("mouseout", () => {
                btn.style.background = "rgba(59, 130, 246, 0.7)";
                btn.style.transform = "scale(1)";
            });
            btn.addEventListener("click", () => {
                const msgId = btn.getAttribute("data-id");
                const msg = msgs.find((m) => m.id === msgId);
                if (msg) {
                    openEditDialog(msgId, msg);
                }
            });
        });

        document.querySelectorAll(".wa-list-cancel").forEach((btn) => {
            btn.addEventListener("mouseover", () => {
                btn.style.background = "rgba(220, 38, 38, 1)";
                btn.style.transform = "scale(1.05)";
            });
            btn.addEventListener("mouseout", () => {
                btn.style.background = "rgba(220, 38, 38, 0.7)";
                btn.style.transform = "scale(1)";
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
                                renderListPanel();
                            } else {
                                showToast(t("toastErrorWithDetail", [resp?.error || t("errorNoResponse")]), "error");
                            }
                        }
                    );
                }
            });
        });
    });
}

// -------------------------
// Enhanced scheduling panel
// -------------------------

async function createSchedulerUI() {
    await ensureLocaleReady();

    if (document.getElementById("wa-scheduler-panel")) return;

    const panel = document.createElement("div");
    panel.id = "wa-scheduler-panel";
    panel.style.cssText = `
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 99999;
        background: rgba(32, 44, 51, 0.98);
        backdrop-filter: blur(4px);
        color: white;
        padding: 16px;
        border-radius: 12px;
        font-size: 12px;
        width: 320px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        animation: slideUp 0.3s ease-out;
    `;

    const chatTitle = getActiveChatTitle() || t("labelChatUnknown");

    panel.innerHTML = `
        <style>
            @keyframes slideUp {
                from {
                    transform: translateY(20px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
            #wa-scheduler-panel input,
            #wa-scheduler-panel textarea {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                border-radius: 6px;
                padding: 8px;
                font-size: 12px;
                font-family: inherit;
                transition: all 0.2s;
            }
            #wa-scheduler-panel input:focus,
            #wa-scheduler-panel textarea:focus {
                background: rgba(255, 255, 255, 0.15);
                border-color: #25D366;
                outline: none;
                box-shadow: 0 0 8px rgba(37, 211, 102, 0.3);
            }
            #wa-scheduler-panel input::placeholder,
            #wa-scheduler-panel textarea::placeholder {
                color: rgba(255, 255, 255, 0.5);
            }
        </style>

        <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">${t("panelTitleSchedule")}</div>

        <div style="background: rgba(37, 211, 102, 0.15); border-left: 3px solid #25D366; padding: 8px; border-radius: 4px; margin-bottom: 12px; font-size: 11px;">
            <div style="font-weight: 600; color: #25D366;">${t("labelCurrentChat")}</div>
            <div style="opacity: 0.9;">${chatTitle}</div>
        </div>

        <textarea id="wa-msg"
            placeholder="${t("placeholderMessage")}"
            style="width: 100%; height: 70px; margin-bottom: 10px; resize: vertical;"></textarea>

        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
    <div style="flex: 1;">
        <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px;">
            ${t("labelHours")}
        </label>
        <input id="wa-hours"
               type="number"
               min="0"
               max="999"
               value="0"
               style="
                   width: 100%;
                   padding: 6px 8px;
                   border-radius: 6px;
                   border: 1px solid rgba(255,255,255,0.18);
                   background: rgba(32,44,51,0.95);
                   color: #e9edef;
                   font-size: 12px;
                   box-sizing: border-box;
                   -moz-appearance: textfield;
                   appearance: textfield;
               ">
    </div>

    <div style="flex: 1;">
        <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px;">
            ${t("labelMinutes")}
        </label>
        <input id="wa-mins"
               type="number"
               min="0"
               max="59"
               value="0"
               style="
                   width: 100%;
                   padding: 6px 8px;
                   border-radius: 6px;
                   border: 1px solid rgba(255,255,255,0.18);
                   background: rgba(32,44,51,0.95);
                   color: #e9edef;
                   font-size: 12px;
                   box-sizing: border-box;
                   -moz-appearance: textfield;
                   appearance: textfield;
               ">
    </div>
</div>

        <div style="display: flex; gap: 2px; font-size: 10px; opacity: 0.7; margin-bottom: 12px;">
            <span id="wa-char-count">0</span> / 4096
        </div>

        <div style="display: flex; gap: 6px; margin-bottom: 0;">
            <button id="wa-schedule"
                style="flex: 1; background: #25D366; color: black; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.transform='scale(1.02)'; this.style.boxShadow='0 4px 12px rgba(37,211,102,0.3)'"
                onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none'">
                ${t("buttonSchedule")}
            </button>

            <button id="wa-list"
                style="flex: 1; background: rgba(59, 130, 246, 0.8); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(59, 130, 246, 1)'; this.style.transform='scale(1.02)'"
                onmouseout="this.style.background='rgba(59, 130, 246, 0.8)'; this.style.transform='scale(1)'">
                ${t("buttonList")}
            </button>

            <button id="wa-close"
                style="width: 42px; background: rgba(255, 255, 255, 0.15); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-size: 16px; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(255, 255, 255, 0.25)'"
                onmouseout="this.style.background='rgba(255, 255, 255, 0.15)'">
                ✕
            </button>
        </div>
    `;

    document.body.appendChild(panel);

    // Character counter
    const msgInput = document.getElementById("wa-msg");
    const charCount = document.getElementById("wa-char-count");
    msgInput.addEventListener("input", () => {
        charCount.textContent = msgInput.value.length;
        if (msgInput.value.length > 4096) {
            charCount.style.color = "#dc2626";
        } else if (msgInput.value.length > 3500) {
            charCount.style.color = "#f59e0b";
        } else {
            charCount.style.color = "rgba(255,255,255,0.7)";
        }
    });

    document.getElementById("wa-close").onclick = () => panel.remove();
    document.getElementById("wa-list").onclick = () => renderListPanel();

    document.getElementById("wa-schedule").onclick = () => {
        const text = document.getElementById("wa-msg").value.trim();
        const hours = parseInt(document.getElementById("wa-hours").value || "0", 10);
        const mins = parseInt(document.getElementById("wa-mins").value || "0", 10);

        if (!text) {
            showToast(t("toastWriteMessage"), "warning");
            return;
        }

        if (text.length > 4096) {
            showToast(t("toastTextTooLong", [text.length]), "error");
            return;
        }

        const totalMins = hours * 60 + mins;
        if (totalMins <= 0) {
            showToast(t("toastNeedTime"), "warning");
            return;
        }

        const delayMs = totalMins * 60 * 1000;
        const chatTitle = getActiveChatTitle();

        browser.runtime.sendMessage(
            {
                type: "SCHEDULE_MESSAGE",
                text,
                delayMs,
                chatTitle
            },
            (resp) => {
                if (resp && resp.ok) {
                    showToast(t("toastScheduledMinutes", [totalMins]), "success");
                    msgInput.value = "";
                    document.getElementById("wa-hours").value = "0";
                    document.getElementById("wa-mins").value = "0";
                    charCount.textContent = "0";
                    setTimeout(() => panel.remove(), 500);
                } else {
                    showToast(t("toastErrorWithDetail", [resp?.error || t("errorNoResponse")]), "error", 5000);
                }
            }
        );
    };

    // Focus on the text field
    setTimeout(() => msgInput.focus(), 100);
}

// -------------------------
// Floating button
// -------------------------

async function createFloatingButton() {
    await ensureLocaleReady();

    if (document.getElementById("wa-scheduler-button")) return;

    const btn = document.createElement("button");
    btn.id = "wa-scheduler-button";
    btn.textContent = "📅";
    btn.title = t("buttonTooltip");
    btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 99998;
        width: 50px;
        height: 50px;
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
        const { id, text, chatTitle } = msg;
        sendToScheduledChat(id, text, chatTitle).catch((err) =>
            console.error("[WA Scheduler] Error en envío programado:", err)
        );
    }
});