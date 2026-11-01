#!/usr/bin/env node

const {
    ContentLengthFrameDecoder,
    encodeRuntimeFrame
} = require('./out/janusRuntime');

let currentFile = 'test.janus';
let currentLine = 1;
let isRunning = false;
let direction = 'forward';
const breakpoints = new Map();
const LOCAL_REFERENCE_BASE = 1000;
const GLOBAL_REFERENCE = 2000;
const POINT_REFERENCE = 3000;
const localVariables = [
    { name: 'x', value: '42', type: 'int', variablesReference: 0 },
    { name: 'y', value: '10', type: 'int', variablesReference: 0 },
    {
        name: 'point',
        value: '{ x: 1, y: 2 }',
        type: 'point',
        variablesReference: POINT_REFERENCE,
        namedVariables: 2
    }
];
const globalVariables = [
    { name: 'PI', value: '3.14159', type: 'number', variablesReference: 0 },
    { name: 'VERSION', value: '"1.0.0"', type: 'string', variablesReference: 0 }
];
const pointVariables = [
    { name: 'x', value: '1', type: 'int', variablesReference: 0 },
    { name: 'y', value: '2', type: 'int', variablesReference: 0 }
];

const frameDecoder = new ContentLengthFrameDecoder();

function log(message) {
    if (process.env.JANUS_MOCK_LOG) {
        console.error(`[MOCK] ${message}`);
    }
}

function send(message) {
    process.stdout.write(encodeRuntimeFrame(JSON.stringify(message)));
}

function respond(request, body = {}) {
    send({ type: 'response', id: request.id, success: true, body });
}

function reject(request, message) {
    send({ type: 'response', id: request.id, success: false, message });
}

function emit(event, body = {}) {
    send({ type: 'event', event, body });
}

function processArgs() {
    const args = process.argv.slice(2);
    if (args[0] !== '--debug' || args[1] !== '--stop_on_entry' || !args[2]) {
        return false;
    }

    currentFile = args[2];
    return true;
}

function stop(reason) {
    isRunning = false;
    emit('stopped', {
        reason,
        file: currentFile,
        line: currentLine,
        column: 1,
        direction
    });
}

function step() {
    direction = 'forward';
    currentLine++;
    if (currentLine > 20) {
        emit('terminated', { exitCode: 0 });
        process.exit(0);
    }
    stop('step');
}

function stepBack() {
    direction = 'reverse';
    currentLine = Math.max(1, currentLine - 1);
    stop('step');
}

function continueExecution() {
    if (!isRunning) {
        return;
    }

    currentLine++;
    if (currentLine > 20) {
        emit('terminated', { exitCode: 0 });
        process.exit(0);
    }

    if (breakpoints.get(currentFile)?.has(currentLine)) {
        stop('breakpoint');
        return;
    }

    setTimeout(continueExecution, 25);
}

function reverseContinueExecution() {
    if (!isRunning) {
        return;
    }

    if (currentLine <= 1) {
        stop('entry');
        return;
    }

    currentLine--;
    if (breakpoints.get(currentFile)?.has(currentLine)) {
        stop('breakpoint');
        return;
    }

    setTimeout(reverseContinueExecution, 25);
}

function handleRequest(request) {
    const args = request.arguments || {};
    log(`Received ${request.command} ${JSON.stringify(args)}`);

    switch (request.command) {
        case 'SET_BREAKPOINT': {
            const file = args.file;
            const line = args.line;
            if (typeof file !== 'string' || typeof line !== 'number') {
                reject(request, 'SET_BREAKPOINT requires a file and line');
                return;
            }

            if (!breakpoints.has(file)) {
                breakpoints.set(file, new Set());
            }
            breakpoints.get(file).add(line);
            respond(request, { verified: true, line });
            break;
        }

        case 'CLEAR_BREAKPOINTS':
            if (typeof args.file !== 'string') {
                reject(request, 'CLEAR_BREAKPOINTS requires a file');
                return;
            }
            breakpoints.delete(args.file);
            respond(request);
            break;

        case 'CONTINUE':
            respond(request);
            direction = 'forward';
            isRunning = true;
            setTimeout(continueExecution, 25);
            break;

        case 'REVERSE_CONTINUE':
            respond(request);
            direction = 'reverse';
            isRunning = true;
            setTimeout(reverseContinueExecution, 25);
            break;

        case 'STEP':
        case 'STEP_IN':
        case 'STEP_OUT':
            respond(request);
            setTimeout(step, 25);
            break;

        case 'STEP_BACK':
            respond(request);
            setTimeout(stepBack, 25);
            break;

        case 'PAUSE':
            respond(request);
            stop('pause');
            break;

        case 'GET_STACK':
            respond(request, {
                frames: [
                    { id: 0, name: 'main', file: currentFile, line: currentLine, column: 1 },
                    { id: 1, name: 'calculateSum', file: currentFile, line: Math.max(1, currentLine - 1), column: 5 }
                ]
            });
            break;

        case 'GET_SCOPES': {
            const frameId = args.frameId;
            if (!Number.isSafeInteger(frameId) || frameId < 0) {
                reject(request, 'GET_SCOPES requires a frame ID');
                return;
            }
            respond(request, {
                scopes: [
                    {
                        name: 'Local',
                        presentationHint: 'locals',
                        variablesReference: LOCAL_REFERENCE_BASE + frameId,
                        namedVariables: localVariables.length,
                        expensive: false
                    },
                    {
                        name: 'Global',
                        variablesReference: GLOBAL_REFERENCE,
                        namedVariables: globalVariables.length,
                        expensive: false
                    }
                ]
            });
            break;
        }

        case 'GET_VARIABLES': {
            const reference = args.variablesReference;
            let result;
            if (reference >= LOCAL_REFERENCE_BASE && reference < GLOBAL_REFERENCE) {
                result = localVariables;
            } else if (reference === GLOBAL_REFERENCE) {
                result = globalVariables;
            } else if (reference === POINT_REFERENCE) {
                result = pointVariables;
            } else {
                reject(request, `Unknown variables reference: ${reference}`);
                return;
            }
            respond(request, { variables: result });
            break;
        }

        case 'TERMINATE':
            respond(request);
            emit('terminated', { exitCode: 0 });
            process.nextTick(() => process.exit(0));
            break;

        default:
            reject(request, `Unknown command: ${request.command}`);
            break;
    }
}

function handleLine(line) {
    const fields = line.split('\t');
    const command = fields[0];
    const request = { command, id: parseId(fields[1]), arguments: {} };

    function parseId(value) {
        if (!/^\d+$/.test(value)) {
            return undefined;
        }
        const id = Number(value);
        return Number.isSafeInteger(id) ? id : undefined;
    }

    if (request.id === undefined) {
        emit('error', { message: `Invalid request ID for ${command}` });
        return;
    }

    switch (command) {
        case 'CLEAR_BREAKPOINTS':
            if (fields.length !== 3) {
                emit('error', { message: 'Invalid CLEAR_BREAKPOINTS command' });
                return;
            }
            request.arguments = { file: fields[2] };
            break;

        case 'SET_BREAKPOINT': {
            const lineNumber = Number(fields[2]);
            if (fields.length !== 4 || !Number.isInteger(lineNumber)) {
                emit('error', { message: 'Invalid SET_BREAKPOINT command' });
                return;
            }
            request.arguments = { file: fields[3], line: lineNumber };
            break;
        }

        case 'PAUSE':
            if (fields.length !== 2) {
                emit('error', { message: 'Invalid PAUSE command' });
                return;
            }
            break;

        case 'CONTINUE':
        case 'STEP':
        case 'STEP_IN':
        case 'STEP_OUT':
        case 'STEP_BACK':
        case 'REVERSE_CONTINUE':
        case 'GET_STACK':
        case 'TERMINATE':
            if (fields.length !== 2) {
                emit('error', { message: `Invalid ${command} command` });
                return;
            }
            break;

        case 'GET_SCOPES': {
            const frameId = Number(fields[2]);
            if (fields.length !== 3 || !Number.isSafeInteger(frameId) || frameId < 0) {
                emit('error', { message: 'Invalid GET_SCOPES command' });
                return;
            }
            request.arguments = { frameId };
            break;
        }

        case 'GET_VARIABLES': {
            const variablesReference = Number(fields[2]);
            if (
                fields.length !== 3 ||
                !Number.isSafeInteger(variablesReference) ||
                variablesReference < 1
            ) {
                emit('error', { message: 'Invalid GET_VARIABLES command' });
                return;
            }
            request.arguments = { variablesReference };
            break;
        }

        default:
            emit('error', { message: `Unknown command: ${command}` });
            return;
    }

    if (!request.command) {
        emit('error', { message: 'Empty command' });
        return;
    }

    handleRequest(request);
}

if (!processArgs()) {
    console.error('Usage: mock-janus --debug --stop_on_entry <program.janus>');
    process.exit(1);
}

log(`Mock Janus interpreter started for ${currentFile}`);
emit('stopped', {
    reason: 'entry',
    file: currentFile,
    line: currentLine,
    column: 1,
    direction
});

process.stdin.on('data', chunk => {
    try {
        for (const payload of frameDecoder.push(chunk)) {
            handleLine(payload);
        }
    } catch (error) {
        console.error(`[MOCK] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
});

process.stdin.on('end', () => {
    if (frameDecoder.hasPendingData) {
        console.error('[MOCK] Input ended with an incomplete protocol frame');
        process.exitCode = 1;
    }
});

process.on('SIGINT', () => {
    emit('terminated', { exitCode: 130 });
    process.exit(130);
});

process.on('SIGTERM', () => {
    emit('terminated', { exitCode: 143 });
    process.exit(143);
});
