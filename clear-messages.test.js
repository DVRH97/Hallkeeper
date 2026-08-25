const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClearTimeRequest, parseNaturalChannelLayout, parseNaturalChannelPositionRequest, normaliseNaturalRequest } = require('./index');

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

test('parses a numbered voice-only request with a category and named range', () => {
    const layout = parseNaturalChannelLayout('1. create 3 voice channels in Apex Legends category called "Duo 1-3"');
    assert.equal(layout.categoryName, 'Apex Legends');
    assert.deepEqual(layout.textChannels, []);
    assert.deepEqual(layout.voiceChannels, [
        { name: 'Duo 1', userLimit: null },
        { name: 'Duo 2', userLimit: null },
        { name: 'Duo 3', userLimit: null }
    ]);
});

test('parses relative channel positioning requests', () => {
    assert.deepEqual(parseNaturalChannelPositionRequest('Move general above rules'), {
        channelName: 'general',
        direction: 'above',
        referenceChannelName: 'rules'
    });
    assert.deepEqual(parseNaturalChannelPositionRequest('Place #voice-chat below channel lobby'), {
        channelName: 'voice-chat',
        direction: 'below',
        referenceChannelName: 'lobby'
    });
});

test('normalises conversational request wrappers for every command family', () => {
    const requests = [
        ['Could you please create a channel called updates?', 'create a channel called updates'],
        ["I'd like you to delete the memes channel, thanks", 'delete the memes channel'],
        ['Would you mind moving general to Gaming?', 'move general to Gaming'],
        ['Hey HallKeeper, please show me all the channels.', 'show me all the channels'],
        ['Do me a favor and build a category called Events', 'create a category called Events'],
        ['Please help me unassign the Guest role from Alex', 'remove the Guest role from Alex']
    ];
    for (const [input, expected] of requests) assert.equal(normaliseNaturalRequest(input), expected);
});

test('normalises question-style channel listing requests', () => {
    assert.equal(normaliseNaturalRequest('Could you tell me which channels are on the server?'), 'tell me which channels are on the server');
});
