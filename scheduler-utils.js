(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.SchedulerUtils = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MAX_MESSAGE_LENGTH = 4096;
    const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

    function validateMessageText(text) {
        if (typeof text !== "string" || !text.trim()) {
            return { ok: false, error: "Message text is required" };
        }
        if (text.length > MAX_MESSAGE_LENGTH) {
            return { ok: false, error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` };
        }
        return { ok: true, value: text };
    }

    function validateDelay(delayMs) {
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
            return { ok: false, error: "Delay must be a positive number" };
        }
        if (delayMs > MAX_DELAY_MS) {
            return { ok: false, error: "Messages can be scheduled up to one year ahead" };
        }
        return { ok: true, value: delayMs };
    }

    function createMessageId(now = Date.now(), random = Math.random()) {
        const randomPart = Math.floor(random * 0x100000000)
            .toString(36)
            .padStart(7, "0");
        return `msg_${now.toString(36)}_${randomPart}`;
    }

    return {
        MAX_DELAY_MS,
        MAX_MESSAGE_LENGTH,
        createMessageId,
        validateDelay,
        validateMessageText
    };
});
