'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const {
    ContentLengthFrameDecoder,
    encodeRuntimeFrame,
    formatRuntimeCommand,
    JanusRuntime,
    parseRuntimeMessage
} = require('../out/janusRuntime');
const {
    parseExecutionState
} = require('../out/executionState');

test('runtime commands preserve spaces in paths', () => {
    assert.equal(
        formatRuntimeCommand('SET_BREAKPOINT', 3, {
            file: '/tmp/a project/main.ja',
            line: 17
        }),
        'SET_BREAKPOINT\t3\t17\t/tmp/a project/main.ja'
    );
    assert.equal(formatRuntimeCommand('STEP_BACK', 5), 'STEP_BACK\t5');
    assert.equal(
        formatRuntimeCommand('REVERSE_CONTINUE', 6),
        'REVERSE_CONTINUE\t6'
    );
    assert.equal(
        formatRuntimeCommand('GET_SCOPES', 7, { frameId: 0 }),
        'GET_SCOPES\t7\t0'
    );
    assert.equal(
        formatRuntimeCommand('GET_VARIABLES', 8, { variablesReference: 1001 }),
        'GET_VARIABLES\t8\t1001'
    );
});

test('runtime commands reject protocol delimiters inside fields', () => {
    assert.throws(
        () => formatRuntimeCommand('SET_BREAKPOINT', 1, {
            file: '/tmp/left\tright.ja',
            line: 1
        }),
        /tabs or newlines/
    );
});

test('runtime frames use Content-Length measured in UTF-8 bytes', () => {
    const payload = 'SET_BREAKPOINT\t4\t7\t/tmp/räv.ja';
    const frame = encodeRuntimeFrame(payload);
    const separator = frame.indexOf('\r\n\r\n');

    assert.equal(
        frame.subarray(0, separator).toString('ascii'),
        `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`
    );
    assert.equal(frame.subarray(separator + 4).toString('utf8'), payload);
});

test('runtime frame decoder handles fragmented and consecutive frames', () => {
    const first = '{"type":"event","event":"output","body":{"output":"räv"}}';
    const second = '{"type":"response","id":7,"success":true,"body":{}}';
    const input = Buffer.concat([
        encodeRuntimeFrame(first),
        encodeRuntimeFrame(second)
    ]);
    const decoder = new ContentLengthFrameDecoder();
    const payloads = [];

    for (const byte of input) {
        payloads.push(...decoder.push(Buffer.from([byte])));
    }

    assert.deepEqual(payloads, [first, second]);
    assert.equal(decoder.hasPendingData, false);
});

test('runtime frame decoder rejects malformed Content-Length headers', () => {
    const decoder = new ContentLengthFrameDecoder();

    assert.throws(
        () => decoder.push(Buffer.from('Content-Length: nope\r\n\r\n{}')),
        /Invalid Content-Length/
    );
    assert.equal(decoder.hasPendingData, false);
});

test('runtime messages are validated before use', () => {
    assert.deepEqual(
        parseRuntimeMessage('{"type":"response","id":7,"success":true,"body":{"line":4}}'),
        { type: 'response', id: 7, success: true, body: { line: 4 } }
    );
    assert.throws(
        () => parseRuntimeMessage('{"type":"response","id":"bad","success":true}'),
        /invalid response/
    );
    assert.throws(() => parseRuntimeMessage('not json'), /Invalid JSON/);
});

test('execution-state events require a valid direction and source position', () => {
    assert.deepEqual(
        parseExecutionState({
            state: 'stopped',
            direction: 'reverse',
            file: '/tmp/program.ja',
            line: 7,
            column: 1
        }),
        {
            state: 'stopped',
            direction: 'reverse',
            file: '/tmp/program.ja',
            line: 7,
            column: 1
        }
    );
    assert.deepEqual(
        parseExecutionState({ state: 'running', direction: 'forward' }),
        { state: 'running', direction: 'forward' }
    );
    assert.equal(
        parseExecutionState({ state: 'stopped', direction: 'sideways', line: 7 }),
        undefined
    );
});

test('runtime exchanges framed commands and JSON with the mock process', {
    timeout: 5_000
}, async t => {
    const packageRoot = path.resolve(__dirname, '..');
    const runtime = new JanusRuntime();
    const protocolErrors = [];
    runtime.on('protocolError', message => protocolErrors.push(message));
    t.after(() => runtime.stop());

    const entryEvent = once(runtime, 'event');
    await runtime.start({
        interpreterPath: path.join(packageRoot, 'mock-janus.js'),
        program: path.join(packageRoot, 'test.janus'),
        cwd: packageRoot,
        args: []
    });

    const [entry] = await entryEvent;
    assert.equal(entry.event, 'stopped');
    assert.equal(entry.body.reason, 'entry');

    const stack = await runtime.request('GET_STACK');
    assert.equal(stack.frames[0].name, 'main');

    const scopes = await runtime.request('GET_SCOPES', { frameId: stack.frames[0].id });
    assert.equal(scopes.scopes[0].variablesReference, 1000);

    const variables = await runtime.request('GET_VARIABLES', {
        variablesReference: scopes.scopes[0].variablesReference
    });
    assert.equal(variables.variables[0].name, 'x');

    await runtime.stop();
    assert.deepEqual(protocolErrors, []);
});
