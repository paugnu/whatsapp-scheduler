// Firefox/Chrome compatibility
if (typeof browser === "undefined") {
    var browser = chrome;
}

console.log("[BG] Background script iniciado");

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
    const candidates = [...acceptLanguages, currentLocale, "en"];

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
            console.warn("[BG] Failed to load locale", candidate, e);
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
        console.warn("[BG] Locale preload failed", e);
    }
}

// In-memory state
let scheduledMessages = {};
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const ALARM_PREFIX = "waScheduler::";
const WHATSAPP_URL = "https://web.whatsapp.com/";
const CREATED_TAB_SETTLE_MS = 4000;
const EXISTING_TAB_SETTLE_MS = 1500;

let readyTabs = new Set();
const readyWaiters = new Map();
let pendingCloseTabs = new Map();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// -------------------------
// Load from storage
// -------------------------

function loadMessages() {
    return browser.storage.local.get("scheduledMessages")
        .then((data) => {
            if (data && data.scheduledMessages) {
                scheduledMessages = data.scheduledMessages;
            }
            console.log("[BG] Cargados", Object.keys(scheduledMessages).length, "mensajes");
            
            // Reschedule alarms for pending messages
            reschedulePendingMessages();
        })
        .catch((e) => console.error("[BG] Error cargando:", e));
}

function saveMessages() {
    return browser.storage.local.set({ scheduledMessages })
        .catch((e) => console.error("[BG] Error guardando:", e));
}

// -------------------------
// Reschedule pending messages (after restart)
// -------------------------

function reschedulePendingMessages() {
    const now = Date.now();
    Object.values(scheduledMessages).forEach((msg) => {
        if (msg.status !== "scheduled") return;

        const alarmName = buildAlarmName(msg.id);
        let when = msg.sendAt;
        if (msg.sendAt <= now) {
            // If overdue, try again in a few seconds
            when = Date.now() + 5000;
        }

        try {
            browser.alarms.create(alarmName, { when });
            console.log("[BG] Replanificada alarma:", alarmName, "->", new Date(when).toLocaleString());
        } catch (e) {
            console.error("[BG] Error replanificando:", e);
        }
    });
}

function buildAlarmName(id) {
    return `${ALARM_PREFIX}${id}`;
}

function parseAlarmName(name = "") {
    if (name.startsWith(ALARM_PREFIX)) return name.slice(ALARM_PREFIX.length);
    // Legacy names without prefix
    return scheduledMessages[name] ? name : null;
}

// -------------------------
// Messages from the content script
// -------------------------

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BG] Mensaje recibido:", message.type);

    if (message.type === "WA_READY" && sender?.tab?.id) {
        markTabReady(sender.tab.id);
        sendResponse && sendResponse({ ok: true });
        return false;
    }

    // SCHEDULE_MESSAGE: schedule a new message
    if (message.type === "SCHEDULE_MESSAGE") {
        try {
            const id = "msg_" + Date.now();
            const when = Date.now() + message.delayMs;

            if (message.text.length > 4096) {
                throw new Error(t("toastLongLimit"));
            }

            scheduledMessages[id] = {
                id,
                text: message.text,
                chatTitle: message.chatTitle || null,
                createdAt: Date.now(),
                sendAt: when,
                delayMs: message.delayMs,
                status: "scheduled",
                deliveredAt: null,
                lastError: null,
                retries: 0,
                firedAt: null
            };

            saveMessages();

            try {
                browser.alarms.create(buildAlarmName(id), { when });
                console.log("[BG] Programado:", id, "a las", new Date(when).toLocaleString());
            } catch (e) {
                console.error("[BG] Error creando alarma:", e);
                scheduledMessages[id].status = "failed";
                scheduledMessages[id].lastError = t("errorCreateAlarm") + ": " + e;
                saveMessages();
                sendResponse({ ok: false, error: t("errorCreateAlarm") });
                return true;
            }

            sendResponse({ ok: true, id });
        } catch (e) {
            console.error("[BG] Error al programar:", e);
            sendResponse({ ok: false, error: String(e) });
        }
        return true;
    }

    // GET_MESSAGES: retrieve the message list
    if (message.type === "GET_MESSAGES") {
        browser.storage.local.get("scheduledMessages")
            .then((data) => {
                const obj = data?.scheduledMessages || {};
                const list = Object.values(obj);
                sendResponse({ ok: true, messages: list });
            })
            .catch((err) => {
                console.error("[BG] Error en GET_MESSAGES:", err);
                sendResponse({ ok: false, error: String(err) });
            });
        return true;
    }

    // DELIVERY_REPORT: mark as delivered/failed
    if (message.type === "DELIVERY_REPORT") {
        const msg = scheduledMessages[message.id];
        if (msg) {
            msg.status = message.ok ? "sent" : "failed";
            msg.deliveredAt = Date.now();
            msg.lastError = message.error || null;

            const closeTabId = pendingCloseTabs.get(message.id);
            if (message.ok && closeTabId) {
                setTimeout(() => {
                    browser.tabs.remove(closeTabId).catch(() => {});
                }, 8000);
                pendingCloseTabs.delete(message.id);
            }

            if (message.ok) {
                console.log("[BG] ✓ Mensaje entregado:", message.id);
            } else {
                console.log("[BG] ✗ Error en entrega:", message.id, message.error);
                msg.retries = (msg.retries || 0) + 1;
            }

            saveMessages();
        }
        sendResponse && sendResponse({ ok: true });
        return false;
    }

    // CANCEL_MESSAGE: cancel a scheduled message
    if (message.type === "CANCEL_MESSAGE") {
        const msg = scheduledMessages[message.id];
        if (msg && msg.status === "scheduled") {
            try {
                browser.alarms.clear(buildAlarmName(message.id));
                browser.alarms.clear(message.id); // Legacy name
                delete scheduledMessages[message.id];
                saveMessages();
                console.log("[BG] ✓ Mensaje cancelado:", message.id);
                sendResponse({ ok: true });
            } catch (e) {
                console.error("[BG] Error cancelando:", e);
                sendResponse({ ok: false, error: String(e) });
            }
        } else {
            sendResponse({
                ok: false,
                error: msg ? t("errorMessageNotScheduled") : t("errorMessageNotFound")
            });
        }
        return true;
    }

    // EDIT_MESSAGE: edit a message before delivery
    if (message.type === "EDIT_MESSAGE") {
        const msg = scheduledMessages[message.id];
        if (msg && msg.status === "scheduled") {
            try {
                const oldSendAt = msg.sendAt;
                
                msg.text = message.text;
                if (message.delayMs) {
                    msg.delayMs = message.delayMs;
                    msg.sendAt = Date.now() + message.delayMs;

                    // Update alarm
                    browser.alarms.clear(buildAlarmName(message.id));
                    browser.alarms.clear(message.id); // Legacy name
                    browser.alarms.create(buildAlarmName(message.id), { when: msg.sendAt });
                    
                    console.log("[BG] ✏️ Alarma actualizada:", message.id, "de", new Date(oldSendAt).toLocaleString(), "a", new Date(msg.sendAt).toLocaleString());
                }
                
                saveMessages();
                console.log("[BG] ✏️ Mensaje editado:", message.id);
                sendResponse({ ok: true });
            } catch (e) {
                console.error("[BG] Error editando mensaje:", e);
                sendResponse({ ok: false, error: String(e) });
            }
        } else {
            sendResponse({
                ok: false,
                error: msg ? t("errorMessageNotScheduled") : t("errorMessageNotFound")
            });
        }
        return true;
    }

    return false;
});

// -------------------------
// Alarms: trigger scheduled delivery
// -------------------------

browser.alarms.onAlarm.addListener(async (alarm) => {
    const id = parseAlarmName(alarm.name);
    if (!id) return;

    const msg = scheduledMessages[id];

    if (!msg) {
        console.warn("[BG] Alarma sin mensaje:", id);
        return;
    }

    if (msg.status !== "scheduled") {
        console.warn("[BG] Mensaje no en estado programado:", id, msg.status);
        return;
    }

    msg.status = "sending";
    msg.firedAt = Date.now();
    await saveMessages();

    console.log("[BG] ⏱️ Alarma disparada:", id);

    try {
        await ensureWhatsAppTabAndSend(msg);
    } catch (err) {
        msg.status = "failed";
        msg.lastError = t("errorContentScriptCommunication", [String(err)]);
        await saveMessages();
        console.error("[BG] Error en envío programado:", err);
    }
});

async function ensureWhatsAppTabAndSend(msg) {
    const { tab, created } = await ensureWhatsAppTab();

    await waitForWhatsAppReady(tab.id);
    await delay(created ? CREATED_TAB_SETTLE_MS : EXISTING_TAB_SETTLE_MS);

    console.log("[BG] Enviando a tab:", tab.id);
    await browser.tabs.sendMessage(tab.id, {
        type: "SEND_SCHEDULED",
        id: msg.id,
        text: msg.text,
        chatTitle: msg.chatTitle
    });

    console.log("[BG] Mensaje enviado al content-script");

    if (created) {
        pendingCloseTabs.set(msg.id, tab.id);
    }
}

async function ensureWhatsAppTab() {
    let tabs = [];
    try {
        tabs = await browser.tabs.query({ url: "*://web.whatsapp.com/*" });
    } catch (e) {
        console.error("[BG] Error en query tabs:", e);
        throw e;
    }

    if (tabs && tabs.length > 0) {
        return { tab: tabs[0], created: false };
    }

    const createdTab = await browser.tabs.create({ url: WHATSAPP_URL, active: false });
    await waitForTabComplete(createdTab.id);
    return { tab: createdTab, created: true };
}

function waitForTabComplete(tabId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            browser.tabs.onUpdated.removeListener(listener);
            reject(new Error("Timeout esperando tab"));
        }, 30000);

        const listener = (id, changeInfo) => {
            if (id === tabId && changeInfo.status === "complete") {
                clearTimeout(timeout);
                browser.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };

        browser.tabs.onUpdated.addListener(listener);
    });
}

function waitForWhatsAppReady(tabId) {
    if (readyTabs.has(tabId)) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            removeWaiter(tabId, resolver);
            reject(new Error("Timeout esperando WhatsApp"));
        }, 30000);

        const resolver = (ok = true) => {
            clearTimeout(timer);
            ok ? resolve() : reject(new Error("WhatsApp tab cerrada"));
        };

        const waiters = readyWaiters.get(tabId) || [];
        waiters.push(resolver);
        readyWaiters.set(tabId, waiters);
    });
}

function markTabReady(tabId) {
    readyTabs.add(tabId);
    const waiters = readyWaiters.get(tabId) || [];
    waiters.forEach((fn) => fn(true));
    readyWaiters.delete(tabId);
}

function removeWaiter(tabId, resolver) {
    const waiters = readyWaiters.get(tabId) || [];
    const next = waiters.filter((fn) => fn !== resolver);
    if (next.length) {
        readyWaiters.set(tabId, next);
    } else {
        readyWaiters.delete(tabId);
    }
}

// -------------------------
// Initialize on load
// -------------------------

loadMessages();

browser.tabs.onRemoved.addListener((tabId) => {
    readyTabs.delete(tabId);
    const waiters = readyWaiters.get(tabId) || [];
    waiters.forEach((fn) => fn(false));
    readyWaiters.delete(tabId);
});

// -------------------------
// Cleanup old messages (optional)
// -------------------------

function cleanOldMessages() {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let cleaned = 0;

    Object.keys(scheduledMessages).forEach((id) => {
        const msg = scheduledMessages[id];
        if ((msg.deliveredAt || msg.createdAt) < oneWeekAgo && msg.status !== "scheduled") {
            delete scheduledMessages[id];
            cleaned++;
        }
    });

    if (cleaned > 0) {
        saveMessages();
        console.log("[BG] Limpiados", cleaned, "mensajes antiguos");
    }
}

// Cleanup every 24 hours
setInterval(cleanOldMessages, 24 * 60 * 60 * 1000);
