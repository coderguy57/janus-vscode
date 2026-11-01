'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { JanusDebugSession } = require('../out/janusDebugAdapter');

const DAP_TIMEOUT_MS = 5_000;

class MockJanusRuntime extends EventEmitter {
    constructor() {
        super();
        this.file = '';
        this.line = 1;
        this.direction = 'forward';
        this.breakpoints = new Map();
    }

    async start(options) {
        this.file = options.program;
        queueMicrotask(() => this.runtimeEvent('stopped', {
            reason: 'entry',
            file: this.file,
            line: this.line,
            column: 1,
            direction: this.direction
        }));
    }

    async request(command, args = {}) {
        switch (command) {
            case 'CLEAR_BREAKPOINTS':
                this.breakpoints.delete(args.file);
                return {};

            case 'SET_BREAKPOINT': {
                const lines = this.breakpoints.get(args.file) ?? new Set();
                lines.add(args.line);
                this.breakpoints.set(args.file, lines);
                return { verified: true, line: args.line };
            }

            case 'GET_STACK':
                return {
                    frames: [
                        { id: 0, name: 'main', line: this.line, column: 1 },
                        {
                            id: 1,
                            name: 'calculateSum',
                            line: Math.max(1, this.line - 1),
                            column: 5
                        }
                    ]
                };

            case 'GET_SCOPES':
                return {
                    scopes: [
                        {
                            name: 'Local',
                            presentationHint: 'locals',
                            variablesReference: 1000 + args.frameId,
                            namedVariables: 2,
                            expensive: false
                        },
                        {
                            name: 'Global',
                            variablesReference: 2000,
                            namedVariables: 1,
                            expensive: false
                        }
                    ]
                };

            case 'GET_VARIABLES':
                if (args.variablesReference >= 1000 && args.variablesReference < 2000) {
                    return {
                        variables: [
                            { name: 'x', value: '42', type: 'int', variablesReference: 0 },
                            {
                                name: 'point',
                                value: '{ x: 1, y: 2 }',
                                type: 'point',
                                variablesReference: 3000,
                                namedVariables: 2
                            }
                        ]
                    };
                }
                if (args.variablesReference === 2000) {
                    return {
                        variables: [
                            {
                                name: 'VERSION',
                                value: '"1.0.0"',
                                type: 'string',
                                variablesReference: 0
                            }
                        ]
                    };
                }
                if (args.variablesReference === 3000) {
                    return {
                        variables: [
                            { name: 'x', value: '1', type: 'int', variablesReference: 0 },
                            { name: 'y', value: '2', type: 'int', variablesReference: 0 }
                        ]
                    };
                }
                throw new Error(`Unknown variables reference: ${args.variablesReference}`);

            case 'STEP':
            case 'STEP_IN':
            case 'STEP_OUT':
                this.direction = 'forward';
                this.line++;
                setImmediate(() => this.runtimeEvent('stopped', {
                    reason: 'step',
                    file: this.file,
                    line: this.line,
                    column: 1,
                    direction: this.direction
                }));
                return {};

            case 'STEP_BACK':
                this.direction = 'reverse';
                this.line = Math.max(1, this.line - 1);
                setImmediate(() => this.runtimeEvent('stopped', {
                    reason: 'step',
                    file: this.file,
                    line: this.line,
                    column: 1,
                    direction: this.direction
                }));
                return {};

            case 'CONTINUE': {
                this.direction = 'forward';
                const nextBreakpoint = [...(this.breakpoints.get(this.file) ?? [])]
                    .filter(line => line > this.line)
                    .sort((left, right) => left - right)[0];
                this.line = nextBreakpoint ?? this.line + 1;
                setImmediate(() => this.runtimeEvent('stopped', {
                    reason: nextBreakpoint === undefined ? 'pause' : 'breakpoint',
                    file: this.file,
                    line: this.line,
                    column: 1,
                    direction: this.direction
                }));
                return {};
            }

            case 'REVERSE_CONTINUE': {
                this.direction = 'reverse';
                const previousBreakpoint = [...(this.breakpoints.get(this.file) ?? [])]
                    .filter(line => line < this.line)
                    .sort((left, right) => right - left)[0];
                this.line = previousBreakpoint ?? Math.max(1, this.line - 1);
                setImmediate(() => this.runtimeEvent('stopped', {
                    reason: previousBreakpoint === undefined ? 'entry' : 'breakpoint',
                    file: this.file,
                    line: this.line,
                    column: 1,
                    direction: this.direction
                }));
                return {};
            }

            case 'PAUSE':
                setImmediate(() => this.runtimeEvent('stopped', {
                    reason: 'pause',
                    file: this.file,
                    line: this.line,
                    column: 1,
                    direction: this.direction
                }));
                return {};

            case 'TERMINATE':
                setImmediate(() => {
                    this.runtimeEvent('terminated', { exitCode: 0 });
                    this.emit('exit', 0, null);
                });
                return {};

            default:
                throw new Error(`Unexpected mock command: ${command}`);
        }
    }

    async stop() {
        await this.request('TERMINATE');
    }

    runtimeEvent(event, body) {
        this.emit('event', { type: 'event', event, body });
    }
}

class TestJanusDebugSession extends JanusDebugSession {
    constructor() {
        super();
        this.mockRuntime = new MockJanusRuntime();
    }

    createRuntime() {
        return this.mockRuntime;
    }

    runtimeEvent(event, body) {
        if (event === 'stopped') {
            if (typeof body.file === 'string') {
                this.mockRuntime.file = body.file;
            }
            if (Number.isSafeInteger(body.line) && body.line > 0) {
                this.mockRuntime.line = body.line;
            }
            if (body.direction === 'forward' || body.direction === 'reverse') {
                this.mockRuntime.direction = body.direction;
            }
        }
        this.mockRuntime.runtimeEvent(event, body);
    }
}

class DapHarness {
    constructor(session) {
        this.session = session;
        this.nextSequence = 1;
        this.messages = [];
        this.waiters = [];
        this.subscription = session.onDidSendMessage(message => this.accept(message));
    }

    dispose() {
        this.subscription.dispose();
        this.session.dispose();
    }

    async request(command, args = {}) {
        const requestSequence = this.nextSequence++;
        const responsePromise = this.waitFor(
            message => message.type === 'response' && message.request_seq === requestSequence,
            `${command} response`
        );

        this.session.handleMessage({
            seq: requestSequence,
            type: 'request',
            command,
            arguments: args
        });

        const response = await responsePromise;
        assert.equal(response.success, true, response.message || `${command} failed`);
        return response;
    }

    event(name) {
        return this.waitFor(
            message => message.type === 'event' && message.event === name,
            `${name} event`
        );
    }

    executionState(state) {
        return this.waitFor(
            message => message.type === 'event' &&
                message.event === 'janus.executionState' &&
                message.body?.state === state,
            `${state} execution-state event`
        );
    }

    waitFor(predicate, description) {
        const queuedIndex = this.messages.findIndex(predicate);
        if (queuedIndex >= 0) {
            return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.waiters.findIndex(waiter => waiter.resolve === resolve);
                if (index >= 0) {
                    this.waiters.splice(index, 1);
                }
                reject(new Error(`Timed out waiting for ${description}`));
            }, DAP_TIMEOUT_MS);

            this.waiters.push({ predicate, resolve, timer });
        });
    }

    accept(message) {
        const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(message));
        if (waiterIndex < 0) {
            this.messages.push(message);
            return;
        }

        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
    }
}

test('DAP session supports a complete debugging workflow', async t => {
    const packageRoot = path.resolve(__dirname, '..');
    const program = path.join(packageRoot, 'test.janus');
    const interpreterPath = path.join(packageRoot, 'mock-janus.js');
    const session = new TestJanusDebugSession();
    const harness = new DapHarness(session);
    t.after(() => harness.dispose());

    const initialize = await harness.request('initialize', {
        adapterID: 'janus',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true
    });
    assert.equal(initialize.body.supportsConfigurationDoneRequest, true);
    assert.equal(initialize.body.supportsStepBack, true);
    assert.equal(initialize.body.supportsTerminateRequest, true);

    const initializedEvent = harness.event('initialized');
    const launchResponse = harness.request('launch', {
        program,
        interpreterPath,
        cwd: packageRoot,
        args: []
    });
    await Promise.all([initializedEvent, launchResponse]);

    const breakpointResponse = await harness.request('setBreakpoints', {
        source: { name: path.basename(program), path: program },
        breakpoints: [{ line: 1 }, { line: 3 }]
    });
    assert.deepEqual(
        breakpointResponse.body.breakpoints.map(breakpoint => ({
            verified: breakpoint.verified,
            line: breakpoint.line
        })),
        [
            { verified: true, line: 1 },
            { verified: true, line: 3 }
        ]
    );

    const entryStop = harness.event('stopped');
    const entryExecutionState = harness.executionState('stopped');
    await harness.request('configurationDone');
    assert.equal((await entryStop).body.reason, 'entry');
    assert.deepEqual((await entryExecutionState).body, {
        state: 'stopped',
        direction: 'forward',
        file: program,
        line: 1,
        column: 1
    });

    const threads = await harness.request('threads');
    assert.equal(threads.body.threads.length, 1);
    assert.equal(threads.body.threads[0].id, 1);
    assert.equal(threads.body.threads[0].name, 'main');

    const stack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(stack.body.totalFrames, 2);
    assert.equal(stack.body.stackFrames[0].line, 1);
    assert.equal(stack.body.stackFrames[0].source.path, program);

    const scopes = await harness.request('scopes', {
        frameId: stack.body.stackFrames[0].id
    });
    assert.deepEqual(scopes.body.scopes.map(scope => scope.name), ['Local', 'Global']);
    assert.equal(scopes.body.scopes[0].presentationHint, 'locals');
    assert.equal(scopes.body.scopes[0].variablesReference, 1000);
    assert.equal(scopes.body.scopes[0].namedVariables, 2);
    assert.equal(scopes.body.scopes[0].expensive, false);

    const variables = await harness.request('variables', {
        variablesReference: scopes.body.scopes[0].variablesReference
    });
    assert.equal(variables.body.variables[0].name, 'x');
    assert.equal(variables.body.variables[0].value, '42');
    assert.equal(variables.body.variables[0].type, 'int');
    assert.equal(variables.body.variables[0].variablesReference, 0);
    assert.equal(variables.body.variables[1].variablesReference, 3000);
    assert.equal(variables.body.variables[1].namedVariables, 2);

    const pointMembers = await harness.request('variables', {
        variablesReference: variables.body.variables[1].variablesReference
    });
    assert.deepEqual(
        pointMembers.body.variables.map(variable => [variable.name, variable.value]),
        [['x', '1'], ['y', '2']]
    );

    const stepContinued = harness.event('continued');
    const stepStopped = harness.event('stopped');
    const stepRunningState = harness.executionState('running');
    const stepStoppedState = harness.executionState('stopped');
    await harness.request('next', { threadId: 1 });
    assert.equal((await stepContinued).body.threadId, 1);
    assert.equal((await stepStopped).body.reason, 'step');
    assert.equal((await stepRunningState).body.direction, 'forward');
    assert.equal((await stepStoppedState).body.direction, 'forward');

    const steppedStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(steppedStack.body.stackFrames[0].line, 2);

    const runContinued = harness.event('continued');
    const breakpointStop = harness.event('stopped');
    const runState = harness.executionState('running');
    const breakpointState = harness.executionState('stopped');
    await harness.request('continue', { threadId: 1 });
    await runContinued;
    assert.equal((await breakpointStop).body.reason, 'breakpoint');
    assert.equal((await runState).body.direction, 'forward');
    assert.equal((await breakpointState).body.direction, 'forward');

    const breakpointStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(breakpointStack.body.stackFrames[0].line, 3);

    const backContinued = harness.event('continued');
    const backStopped = harness.event('stopped');
    const backRunningState = harness.executionState('running');
    const backStoppedState = harness.executionState('stopped');
    await harness.request('stepBack', { threadId: 1 });
    await backContinued;
    assert.equal((await backStopped).body.reason, 'step');
    assert.equal((await backRunningState).body.direction, 'reverse');
    assert.equal((await backStoppedState).body.direction, 'reverse');

    const backStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(backStack.body.stackFrames[0].line, 2);

    const reverseContinued = harness.event('continued');
    const reverseStopped = harness.event('stopped');
    const reverseRunningState = harness.executionState('running');
    const reverseStoppedState = harness.executionState('stopped');
    await harness.request('reverseContinue', { threadId: 1 });
    await reverseContinued;
    assert.equal((await reverseStopped).body.reason, 'breakpoint');
    assert.equal((await reverseRunningState).body.direction, 'reverse');
    assert.equal((await reverseStoppedState).body.direction, 'reverse');

    const reverseStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(reverseStack.body.stackFrames[0].line, 1);

    const forwardAgainStopped = harness.event('stopped');
    const forwardAgainRunningState = harness.executionState('running');
    const forwardAgainStoppedState = harness.executionState('stopped');
    await harness.request('next', { threadId: 1 });
    await forwardAgainStopped;
    assert.equal((await forwardAgainRunningState).body.direction, 'forward');
    assert.equal((await forwardAgainStoppedState).body.direction, 'forward');

    const forwardAgainStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(forwardAgainStack.body.stackFrames[0].line, 2);

    const exceptionStop = harness.event('stopped');
    const exceptionState = harness.executionState('stopped');
    session.runtimeEvent('stopped', {
        reason: 'exception',
        description: 'Division by zero',
        text: 'Cannot divide 12 by zero',
        file: program,
        line: 17,
        column: 14,
        direction: 'forward'
    });

    const exception = await exceptionStop;
    assert.equal(exception.body.reason, 'exception');
    assert.equal(exception.body.description, 'Division by zero');
    assert.equal(exception.body.text, 'Cannot divide 12 by zero');
    assert.equal(exception.body.threadId, 1);
    assert.equal(exception.body.allThreadsStopped, true);
    assert.deepEqual((await exceptionState).body, {
        state: 'stopped',
        direction: 'forward',
        file: program,
        line: 17,
        column: 14
    });

    const exceptionStack = await harness.request('stackTrace', { threadId: 1 });
    assert.equal(exceptionStack.body.stackFrames[0].line, 17);

    const terminated = harness.event('terminated');
    await harness.request('disconnect', { terminateDebuggee: true });
    await terminated;
});
