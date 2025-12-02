// Compatibilidad Firefox/Chrome
if (typeof browser === "undefined") {
    var browser = chrome;
}

console.log("[BG] Background script iniciado");

// Localización con fallback
function t(key, substitutions = []) {
    try {
        return browser?.i18n?.getMessage(key, substitutions) || key;
    } catch (e) {
        return key;
    }
}

// Estado en memoria
let scheduledMessages = {};
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

// -------------------------
// Cargar desde storage
// -------------------------

function loadMessages() {
    return browser.storage.local.get("scheduledMessages")
        .then((data) => {
            if (data && data.scheduledMessages) {
                scheduledMessages = data.scheduledMessages;
            }
            console.log("[BG] Cargados", Object.keys(scheduledMessages).length, "mensajes");
            
            // Replanificar alarmas para mensajes pendientes
            reschedulePendingMessages();
        })
        .catch((e) => console.error("[BG] Error cargando:", e));
}

function saveMessages() {
    return browser.storage.local.set({ scheduledMessages })
        .catch((e) => console.error("[BG] Error guardando:", e));
}

// -------------------------
// Replanificar mensajes pendientes (en caso de reinicio)
// -------------------------

function reschedulePendingMessages() {
    const now = Date.now();
    Object.values(scheduledMessages).forEach((msg) => {
        if (msg.status === "scheduled" && msg.sendAt > now) {
            try {
                browser.alarms.create(msg.id, { when: msg.sendAt });
                console.log("[BG] Replanificada alarma:", msg.id);
            } catch (e) {
                console.error("[BG] Error replanificando:", e);
            }
        }
    });
}

// -------------------------
// Mensajes desde content-script
// -------------------------

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BG] Mensaje recibido:", message.type);

    // SCHEDULE_MESSAGE: programar un nuevo mensaje
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
                browser.alarms.create(id, { when });
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

    // GET_MESSAGES: obtener lista de mensajes
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

    // DELIVERY_REPORT: marcar como enviado/falló
    if (message.type === "DELIVERY_REPORT") {
        const msg = scheduledMessages[message.id];
        if (msg) {
            msg.status = message.ok ? "sent" : "failed";
            msg.deliveredAt = Date.now();
            msg.lastError = message.error || null;
            
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

    // CANCEL_MESSAGE: cancelar un mensaje programado
    if (message.type === "CANCEL_MESSAGE") {
        const msg = scheduledMessages[message.id];
        if (msg && msg.status === "scheduled") {
            try {
                browser.alarms.clear(message.id);
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

    // EDIT_MESSAGE: editar un mensaje antes de enviarlo
    if (message.type === "EDIT_MESSAGE") {
        const msg = scheduledMessages[message.id];
        if (msg && msg.status === "scheduled") {
            try {
                const oldSendAt = msg.sendAt;
                
                msg.text = message.text;
                if (message.delayMs) {
                    msg.delayMs = message.delayMs;
                    msg.sendAt = Date.now() + message.delayMs;
                    
                    // Actualizar alarma
                    browser.alarms.clear(message.id);
                    browser.alarms.create(message.id, { when: msg.sendAt });
                    
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
// Alarmas: dispara el envío
// -------------------------

browser.alarms.onAlarm.addListener(async (alarm) => {
    const id = alarm.name;
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

    let tabs;
    try {
        tabs = await browser.tabs.query({ url: "*://web.whatsapp.com/*" });
    } catch (e) {
        msg.status = "failed";
        msg.lastError = t("errorFindTab", [e]);
        await saveMessages();
        console.error("[BG] Error en query tabs:", e);
        return;
    }

    if (!tabs || tabs.length === 0) {
        msg.status = "failed";
        msg.lastError = t("errorNoWhatsAppTab");
        await saveMessages();
        console.warn("[BG]", msg.lastError);
        return;
    }

    const tab = tabs[0];
    console.log("[BG] Enviando a tab:", tab.id);

    try {
        await browser.tabs.sendMessage(tab.id, {
            type: "SEND_SCHEDULED",
            id,
            text: msg.text,
            chatTitle: msg.chatTitle
        });

        console.log("[BG] Mensaje enviado al content-script");
    } catch (err) {
        msg.status = "failed";
        msg.lastError = t("errorContentScriptCommunication", [String(err)]);
        await saveMessages();
        console.error("[BG] Error:", err);
    }
});

// -------------------------
// Inicializar al cargar
// -------------------------

loadMessages();

// -------------------------
// Limpiar mensajes antiguos (opcional)
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

// Limpiar cada 24 horas
setInterval(cleanOldMessages, 24 * 60 * 60 * 1000);