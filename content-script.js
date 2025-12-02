// Compatibilidad Firefox/Chrome
if (typeof browser === "undefined") {
    var browser = chrome;
}

console.log("[WA Scheduler] content-script cargado");

// -------------------------
// Estado: último textarea y botón asociados
// -------------------------

let lastInput = null;
let lastSendButton = null;
let lastChatTitle = null;
let chatCheckTimeout = null;

// Localizar el input del chat activo (sin usar caché)
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

// Detectar clicks/focus en el editor (con throttling)
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
// Detectar título del chat actual
// -------------------------

function getActiveChatTitle() {
    const selectors = [
        'header [data-testid="conversation-info-header-chat-title"]',
        'header span[dir="auto"][title]',
        'header h2[dir="auto"]',
        'header [role="heading"] span[dir="auto"]',
        'header [role="heading"][dir="auto"]',
        'header div[role="button"] span[dir="auto"]'
    ];

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
            const attr = el.getAttribute("title");
            const txt = (el.textContent || "").trim();
            if (attr && attr.trim()) return attr.trim();
            if (txt) return txt;
        }
    }
    return null;
}

// -------------------------
// Normalizar y comparar nombres
// -------------------------

function normalizeName(s) {
    return (s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function namesMatch(target, candidate) {
    const t = normalizeName(target);
    const c = normalizeName(candidate);
    if (!t || !c) return false;
    if (t === c) return true;
    if (c.startsWith(t) || t.startsWith(c)) return true;
    return false;
}

// -------------------------
// Abrir chat por título
// -------------------------

function openChatByTitle(title) {
    if (!title) return false;

    const spans = document.querySelectorAll('span[dir="auto"][title], span[dir="auto"]');

    for (const span of spans) {
        const tAttr = span.getAttribute("title");
        const tText = (span.textContent || "").trim();
        const candidate = tAttr || tText;

        if (!candidate) continue;

        if (namesMatch(title, candidate)) {
            let row =
                span.closest('div[role="row"]') ||
                span.closest('div[role="button"]') ||
                span.closest('div[aria-label]') ||
                span;

            console.log("[WA Scheduler] Abriendo chat:", candidate, "(target:", title, ")");
            row.click();
            return true;
        }
    }
    console.warn("[WA Scheduler] No se encontró el chat:", title);
    return false;
}

// -------------------------
// Mostrar toast notifications
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

    // 👉 aquí el texto:
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

// Iniciar sincronización del chat activo
startChatObserver();

// -------------------------
// Escribir mensaje y enviarlo
// -------------------------

function sendMessageInActiveChat(text) {
    let input = null;

    if (lastInput && document.contains(lastInput)) {
        input = lastInput;
        console.log("[WA Scheduler] Usando lastInput");
    } else {
        input = findActiveComposer();

        if (input) {
            console.log("[WA Scheduler] Detectado nuevo input lexical");
            setLastTargetsFromElement(input);
        }
    }

    if (!input) {
        console.warn("[WA Scheduler] No se encontró el campo de entrada");
        throw new Error("No se encontró el cuadro de mensaje");
    }

    // Validar límite de caracteres
    if (text.length > 4096) {
        throw new Error(`Mensaje muy largo (${text.length}/4096 caracteres)`);
    }

    input.focus();

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    document.execCommand("insertText", false, text);

    console.log("[WA Scheduler] Texto insertado:", text.slice(0, 50) + "...");

    const tryClickSend = () => {
        let btn =
            document.querySelector('button[aria-label="Send"]') ||
            document.querySelector('button[aria-label="Enviar"]') ||
            document.querySelector('button[aria-label="Enviar mensaje"]') ||
            (document.querySelector('span[data-icon="send"]') &&
                document.querySelector('span[data-icon="send"]').closest("button"));

        if (btn && !btn.disabled) {
            console.log("[WA Scheduler] Click en botón de enviar");
            btn.click();
            return true;
        }

        console.log("[WA Scheduler] Botón no disponible");
        return false;
    };

    setTimeout(() => {
        if (!tryClickSend()) {
            console.log("[WA Scheduler] Enviando ENTER de fallback");
            const ev = new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            });
            input.dispatchEvent(ev);
        }
    }, 120);
}

// -------------------------
// Envío al chat programado
// -------------------------

function sendToScheduledChat(id, text, chatTitle) {
    console.log("[WA Scheduler] Envío programado a:", chatTitle);

    if (!chatTitle) {
        console.warn("[WA Scheduler] Sin chatTitle, enviando al chat activo");
        try {
            sendMessageInActiveChat(text);
            browser.runtime.sendMessage({ type: "DELIVERY_REPORT", id, ok: true });
        } catch (e) {
            browser.runtime.sendMessage({
                type: "DELIVERY_REPORT",
                id,
                ok: false,
                error: String(e)
            });
        }
        return;
    }

    const opened = openChatByTitle(chatTitle);
    if (!opened) {
        console.error("[WA Scheduler] No se pudo localizar el chat:", chatTitle);
        browser.runtime.sendMessage({
            type: "DELIVERY_REPORT",
            id,
            ok: false,
            error: `No se encontró el chat "${chatTitle}" en la lista.`
        });
        return;
    }

    let tries = 0;
    const maxTries = 12;

    function waitForChat() {
        const current = getActiveChatTitle();
        console.log("[WA Scheduler] Esperando chat:", chatTitle, "/ activo:", current);

        if (current && namesMatch(chatTitle, current)) {
            console.log("[WA Scheduler] Chat correcto abierto, enviando mensaje");
            const composer = findActiveComposer();
            if (composer) {
                setLastTargetsFromElement(composer);
            }
            try {
                sendMessageInActiveChat(text);
                browser.runtime.sendMessage({
                    type: "DELIVERY_REPORT",
                    id,
                    ok: true
                });
            } catch (e) {
                browser.runtime.sendMessage({
                    type: "DELIVERY_REPORT",
                    id,
                    ok: false,
                    error: String(e)
                });
            }
            return;
        }

        tries++;
        if (tries < maxTries) {
            setTimeout(waitForChat, 500);
        } else {
            console.error("[WA Scheduler] Timeout esperando el chat correcto");
            browser.runtime.sendMessage({
                type: "DELIVERY_REPORT",
                id,
                ok: false,
                error: `No se pudo abrir el chat "${chatTitle}".`
            });
        }
    }

    setTimeout(waitForChat, 700);
}

// -------------------------
// Mantener sincronizado el input con el chat activo
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

    // Observador ligero del header
    const header = document.querySelector("header");
    if (header) {
        const mo = new MutationObserver(() => updateTargetsForChat());
        mo.observe(header, { childList: true, subtree: true, characterData: true });
    }

    // Fallback periódico por si el observer no detecta cambios
    setInterval(updateTargetsForChat, 1500);
}

// -------------------------
// Modal para editar mensajes
// -------------------------

function openEditDialog(msgId, msg) {
    // Remover modal anterior si existe
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

        <div style="font-weight: 700; font-size: 16px; margin-bottom: 16px;">✏️ Editar mensaje</div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">Chat</label>
            <div style="background: rgba(37, 211, 102, 0.15); padding: 8px; border-radius: 6px; border-left: 3px solid #25D366; font-size: 12px;">
                ${msg.chatTitle || "(sin chat especificado)"}
            </div>
        </div>

        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">Mensaje</label>
            <textarea id="wa-edit-text" style="height: 100px; resize: vertical; margin-bottom: 6px;">${msg.text}</textarea>
            <div style="font-size: 10px; opacity: 0.7;"><span id="wa-edit-char-count">${msg.text.length}</span> / 4096</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">Horas</label>
                <input id="wa-edit-hours" type="number" min="0" max="999" value="${hours}">
            </div>
            <div>
                <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600;">Minutos</label>
                <input id="wa-edit-mins" type="number" min="0" max="59" value="${mins}">
            </div>
        </div>

        <div style="background: rgba(59, 130, 246, 0.15); padding: 8px; border-radius: 6px; margin-bottom: 16px; font-size: 11px; opacity: 0.9;">
            ⏰ Envío programado para: <strong>${sendAtDate.toLocaleString()}</strong>
        </div>

        <div style="display: flex; gap: 8px;">
            <button id="wa-edit-save"
                style="flex: 1; background: #25D366; color: black; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.transform='scale(1.02)'; this.style.boxShadow='0 4px 12px rgba(37,211,102,0.3)'"
                onmouseout="this.style.transform='scale(1)'; this.style.boxShadow='none'">
                💾 Guardar cambios
            </button>

            <button id="wa-edit-cancel"
                style="flex: 1; background: rgba(255, 255, 255, 0.15); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(255, 255, 255, 0.25)'"
                onmouseout="this.style.background='rgba(255, 255, 255, 0.15)'">
                ✕ Cancelar
            </button>
        </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Contador de caracteres
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

    // Focus al texto
    setTimeout(() => textInput.focus(), 100);

    // Botón cancelar
    document.getElementById("wa-edit-cancel").addEventListener("click", () => {
        modal.style.animation = "slideOut 0.3s ease-in";
        setTimeout(() => modal.remove(), 300);
    });

    // Cerrar con ESC
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

    // Botón guardar
    document.getElementById("wa-edit-save").addEventListener("click", () => {
        const newText = textInput.value.trim();
        const newHours = parseInt(document.getElementById("wa-edit-hours").value || "0", 10);
        const newMins = parseInt(document.getElementById("wa-edit-mins").value || "0", 10);

        if (!newText) {
            showToast("El mensaje no puede estar vacío", "warning");
            return;
        }

        if (newText.length > 4096) {
            showToast(`Mensaje muy largo (${newText.length}/4096)`, "error");
            return;
        }

        const newTotalMins = newHours * 60 + newMins;
        if (newTotalMins <= 0) {
            showToast("Indica un tiempo > 0", "warning");
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
                    showToast("✓ Mensaje actualizado", "success");
                    modal.style.animation = "slideOut 0.3s ease-in";
                    setTimeout(() => {
                        modal.remove();
                        document.removeEventListener("keydown", escapeHandler);
                        renderListPanel();
                    }, 300);
                } else {
                    showToast(`Error: ${resp?.error || "desconocido"}`, "error", 5000);
                }
            }
        );
    });

    // Cerrar clickeando fuera del modal
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
// Panel de lista (mejorado)

function renderListPanel() {
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
                <div style="font-weight: 700; font-size: 13px; margin-bottom: 2px;">Mensajes programados</div>
                <div style="font-size: 10px; opacity: 0.7;">Historial de envíos</div>
            </div>
            <button id="wa-list-close"
                style="background: rgba(255,255,255,0.15);color: white;border: none;border-radius: 6px;padding: 6px 10px;cursor: pointer;font-size: 16px;transition: all 0.2s;"
                onmouseover="this.style.background='rgba(255,255,255,0.25)'"
                onmouseout="this.style.background='rgba(255,255,255,0.15)'">✕</button>
        </div>
        <div id="wa-scheduler-list-body" style="max-height: 55vh; overflow-y: auto;">Cargando...</div>
    `;

    document.body.appendChild(panel);

    const closeBtn = document.getElementById("wa-list-close");
    closeBtn.onclick = () => panel.remove();

    const body = document.getElementById("wa-scheduler-list-body");

    browser.runtime.sendMessage({ type: "GET_MESSAGES" }, (resp) => {
        if (!resp || !resp.ok) {
            body.innerHTML = '<div style="color: #ff6b6b; text-align: center; padding: 20px;">Error obteniendo la lista</div>';
            return;
        }

        const msgs = resp.messages || [];
        if (!msgs.length) {
            body.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">No hay mensajes todavía</div>';
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
                scheduled: "⏱️ Programado",
                sending: "📤 Enviando",
                sent: "✅ Enviado",
                failed: "❌ Error"
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
                            title="Editar mensaje">
                            ✏️ Editar
                        </button>` : ""}
                        ${canCancel ? `<button class="wa-list-cancel" data-id="${m.id}"
                            style="background: rgba(220, 38, 38, 0.7); color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; transition: all 0.2s;"
                            title="Cancelar envío">
                            🗑️ Cancelar
                        </button>` : ""}
                    </div>
                </div>
                <div style="font-weight: 600; margin-bottom: 4px; opacity: 0.95; word-break: break-word;">${m.chatTitle || "(sin chat)"}</div>
                <div style="opacity: 0.85; margin-bottom: 6px; word-break: break-word; line-height: 1.3; font-size: 11px; background: rgba(255,255,255,0.05); padding: 6px; border-radius: 4px;">${textShort}</div>
                ${delivered ? `<div style="font-size: 10px; opacity: 0.7; color: #25D366;">✓ ${delivered}</div>` : ""}
                ${m.lastError ? `<div style="font-size: 10px; color: #ff9999; margin-top: 4px;">⚠ ${m.lastError}</div>` : ""}
            `;

            body.appendChild(row);
        });

        // Event listeners para botones de editar y cancelar
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
                if (confirm("¿Cancelar el envío de este mensaje?")) {
                    browser.runtime.sendMessage(
                        { type: "CANCEL_MESSAGE", id: msgId },
                        (resp) => {
                            if (resp && resp.ok) {
                                showToast("Mensaje cancelado", "success");
                                renderListPanel();
                            } else {
                                showToast(`Error: ${resp?.error || "desconocido"}`, "error");
                            }
                        }
                    );
                }
            });
        });
    });
}

// -------------------------
// Panel de programación (mejorado)
// -------------------------

function createSchedulerUI() {
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

    const chatTitle = getActiveChatTitle() || "(no detectado)";

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

        <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">📅 Programar mensaje</div>
        
        <div style="background: rgba(37, 211, 102, 0.15); border-left: 3px solid #25D366; padding: 8px; border-radius: 4px; margin-bottom: 12px; font-size: 11px;">
            <div style="font-weight: 600; color: #25D366;">Chat actual</div>
            <div style="opacity: 0.9;">${chatTitle}</div>
        </div>

        <textarea id="wa-msg"
            placeholder="Escribe tu mensaje (máx. 4096 caracteres)..."
            style="width: 100%; height: 70px; margin-bottom: 10px; resize: vertical;"></textarea>

        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
    <div style="flex: 1;">
        <label style="display: block; font-size: 11px; opacity: 0.8; margin-bottom: 4px;">
            Horas
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
            Minutos
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
                ✓ Programar
            </button>

            <button id="wa-list"
                style="flex: 1; background: rgba(59, 130, 246, 0.8); color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;"
                onmouseover="this.style.background='rgba(59, 130, 246, 1)'; this.style.transform='scale(1.02)'"
                onmouseout="this.style.background='rgba(59, 130, 246, 0.8)'; this.style.transform='scale(1)'">
                📋 Ver lista
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

    // Actualizar contador de caracteres
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
            showToast("Escribe un mensaje", "warning");
            return;
        }

        if (text.length > 4096) {
            showToast(`Mensaje muy largo (${text.length}/4096)`, "error");
            return;
        }

        const totalMins = hours * 60 + mins;
        if (totalMins <= 0) {
            showToast("Indica un tiempo > 0", "warning");
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
                    showToast(`✓ Mensaje programado en ${totalMins} minuto(s)`, "success");
                    msgInput.value = "";
                    document.getElementById("wa-hours").value = "0";
                    document.getElementById("wa-mins").value = "0";
                    charCount.textContent = "0";
                    setTimeout(() => panel.remove(), 500);
                } else {
                    showToast(`Error: ${resp?.error || "sin respuesta"}`, "error", 5000);
                }
            }
        );
    };

    // Focus al campo de texto
    setTimeout(() => msgInput.focus(), 100);
}

// -------------------------
// Botón flotante
// -------------------------

function createFloatingButton() {
    if (document.getElementById("wa-scheduler-button")) return;

    const btn = document.createElement("button");
    btn.id = "wa-scheduler-button";
    btn.textContent = "📅";
    btn.title = "Programar mensaje (Ctrl+Shift+W)";
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
// Atajos de teclado
// -------------------------

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "W") {
        e.preventDefault();
        createSchedulerUI();
    }
});

// -------------------------
// Mensajes desde background
// -------------------------

browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SEND_SCHEDULED") {
        console.log("[WA Scheduler] SEND_SCHEDULED recibido:", msg);
        const { id, text, chatTitle } = msg;
        sendToScheduledChat(id, text, chatTitle);
    }
});