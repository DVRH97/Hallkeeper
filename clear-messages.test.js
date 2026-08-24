const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClearTimeRequest } = require('./index');

const now = new Date('2026-08-23T12:00:00.000Z');

test('parses today in the configured timezone', () => {
    const range = parseClearTimeRequest('clear all messages from today', now, 'UTC');
    assert.equal(range.start.toISOString(), '2026-08-23T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-08-24T00:00:00.000Z');
});

test('parses clock ranges', () => {
    const range = parseClearTimeRequest('Clear messages from today between 09:15 and 10:45', now, 'UTC');
    assert.equal(range.start.toISOString(), '2026-08-23T09:15:00.000Z');
    assert.equal(range.end.toISOString(), '2026-08-23T10:45:00.000Z');
});

test('parses relative hour and minute ranges', () => {
    const hours = parseClearTimeRequest('clear messages from the last 2 hours', now, 'UTC');
    const minutes = parseClearTimeRequest('clear messages from the last 30 minutes', now, 'UTC');
    assert.equal(hours.start.toISOString(), '2026-08-23T10:00:00.000Z');
    assert.equal(minutes.start.toISOString(), '2026-08-23T11:30:00.000Z');
    assert.equal(hours.end.toISOString(), now.toISOString());
});

test('rejects reversed ranges and unrelated requests', () => {
    assert.equal(parseClearTimeRequest('clear messages from 18:00 to 09:00', now, 'UTC').error, 'The end time must be later than the start time.');
    assert.equal(parseClearTimeRequest('clear the last 20 messages', now, 'UTC'), null);
});
