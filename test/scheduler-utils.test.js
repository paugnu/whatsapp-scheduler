const test = require("node:test");
const assert = require("node:assert/strict");

const {
    MAX_DELAY_MS,
    createMessageId,
    validateDelay,
    validateMessageText
} = require("../scheduler-utils");

test("accepts a non-empty message without changing its whitespace", () => {
    assert.deepEqual(validateMessageText("  hello  "), { ok: true, value: "  hello  " });
});

test("rejects empty, non-string, and oversized messages", () => {
    assert.equal(validateMessageText("   ").ok, false);
    assert.equal(validateMessageText(undefined).ok, false);
    assert.equal(validateMessageText("x".repeat(4097)).ok, false);
});

test("only accepts finite delays within one year", () => {
    assert.equal(validateDelay(60_000).ok, true);
    for (const delay of [0, -1, NaN, Infinity, MAX_DELAY_MS + 1]) {
        assert.equal(validateDelay(delay).ok, false);
    }
});

test("builds collision-resistant, alarm-safe message identifiers", () => {
    const first = createMessageId(1234, 0.1);
    const second = createMessageId(1234, 0.2);

    assert.match(first, /^msg_[a-z0-9]+_[a-z0-9]+$/);
    assert.notEqual(first, second);
});
