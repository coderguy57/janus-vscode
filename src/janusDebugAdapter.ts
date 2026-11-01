import {
    Breakpoint,
    ContinuedEvent,
    DebugSession,
    Event,
    ExitedEvent,
    InitializedEvent,
    OutputEvent,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';
import {
    errorMessage,
    JanusRuntime,
    MessageBody,
    RuntimeEvent
} from './janusRuntime';
import {
    ExecutionDirection,
    JANUS_EXECUTION_STATE_EVENT
} from './executionState';

export interface JanusLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** Janus source file to run. */
    program: string;
    /** Arguments passed to the Janus program. */
    args?: string[];
    /** Working directory for the interpreter. */
    cwd?: string;
    /** Janus interpreter executable (or a JavaScript mock while developing). */
    interpreterPath?: string;
}

interface ResolvedLaunchOptions {
    program: string;
    args: string[];
    cwd: string;
    interpreterPath: string;
}

function isObject(value: unknown): value is MessageBody {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : fallback;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return isNonNegativeInteger(value) && value > 0;
}

export class JanusDebugSession extends DebugSession {
    private static readonly THREAD_ID = 1;

    private runtime: JanusRuntime | undefined;
    private nextBreakpointId = 1;
    private currentLine = 1;
    private currentFile = '';
    private stackFrames: StackFrame[] = [];
    private configurationComplete = false;
    private deferredEventCount = 0;
    private pendingRuntimeEvents: RuntimeEvent[] = [];
    private terminatedEventSent = false;
    private clientSupportsVariableType = false;
    private executionDirection: ExecutionDirection = 'forward';

    public constructor(
        debuggerLinesAndColumnsStartAt1?: boolean,
        isServer?: boolean
    ) {
        super(debuggerLinesAndColumnsStartAt1, isServer);
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    protected createRuntime(): JanusRuntime {
        return new JanusRuntime();
    }

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        this.clientSupportsVariableType = args.supportsVariableType === true;
        response.body = {
            supportsConfigurationDoneRequest: true,
            supportsStepBack: true,
            supportsTerminateRequest: true
        };
        this.sendResponse(response);
    }

    protected launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: JanusLaunchRequestArguments
    ): void {
        void this.launch(response, args);
    }

    private async launch(
        response: DebugProtocol.LaunchResponse,
        args: JanusLaunchRequestArguments
    ): Promise<void> {
        try {
            if (this.runtime) {
                throw new Error('A Janus debug session is already running');
            }

            const options = await this.resolveLaunchOptions(args);
            const runtime = this.createRuntime();

            this.resetSession(options.program);
            this.runtime = runtime;
            this.attachRuntime(runtime);

            try {
                await runtime.start(options);
            } catch (error) {
                runtime.removeAllListeners();
                if (this.runtime === runtime) {
                    this.runtime = undefined;
                }
                throw error;
            }

            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1001,
                `Unable to launch Janus: ${errorMessage(error)}`
            );
        }
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        _args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        this.configurationComplete = true;
        this.sendResponse(response);
        this.flushRuntimeEvents();
    }

    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): void {
        void this.setBreakpoints(response, args);
    }

    private async setBreakpoints(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const file = args.source.path;
        if (!file) {
            this.sendErrorResponse(response, 1002, 'Breakpoint source path is required');
            return;
        }

        try {
            const runtime = this.requireRuntime();
            await runtime.request('CLEAR_BREAKPOINTS', { file });

            const requestedLines = args.breakpoints?.map(item => item.line) ?? args.lines ?? [];
            const source = new Source(path.basename(file), file);
            const breakpoints: DebugProtocol.Breakpoint[] = [];

            for (const requestedLine of requestedLines) {
                try {
                    const body = await runtime.request('SET_BREAKPOINT', {
                        file,
                        line: requestedLine
                    });
                    const line = positiveInteger(body.line, requestedLine);
                    const verified = body.verified === undefined || body.verified === true;
                    const breakpoint = new Breakpoint(verified, line, undefined, source);
                    breakpoint.setId(this.nextBreakpointId++);

                    if (!verified) {
                        const dapBreakpoint = breakpoint as DebugProtocol.Breakpoint;
                        dapBreakpoint.message = typeof body.message === 'string'
                            ? body.message
                            : 'The Janus interpreter rejected this breakpoint';
                        dapBreakpoint.reason = 'failed';
                    }
                    breakpoints.push(breakpoint);
                } catch (error) {
                    const breakpoint = new Breakpoint(false, requestedLine, undefined, source);
                    breakpoint.setId(this.nextBreakpointId++);
                    const dapBreakpoint = breakpoint as DebugProtocol.Breakpoint;
                    dapBreakpoint.message = errorMessage(error);
                    dapBreakpoint.reason = 'failed';
                    breakpoints.push(breakpoint);
                }
            }

            response.body = { breakpoints };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1003,
                `Unable to set breakpoints: ${errorMessage(error)}`
            );
        }
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [new Thread(JanusDebugSession.THREAD_ID, 'main')]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): void {
        void this.stackTrace(response, args);
    }

    private async stackTrace(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        try {
            const body = await this.requireRuntime().request('GET_STACK');
            this.updateStackFrames(body);

            const start = Math.max(0, args.startFrame ?? 0);
            const requestedLevels = args.levels ?? 0;
            const end = requestedLevels > 0
                ? Math.min(start + requestedLevels, this.stackFrames.length)
                : this.stackFrames.length;

            response.body = {
                stackFrames: this.stackFrames.slice(start, end),
                totalFrames: this.stackFrames.length
            };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1004,
                `Unable to read the Janus stack: ${errorMessage(error)}`
            );
        }
    }

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): void {
        void this.scopes(response, args);
    }

    private async scopes(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        try {
            const body = await this.requireRuntime().request('GET_SCOPES', {
                frameId: args.frameId
            });
            response.body = { scopes: this.parseScopes(body) };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1005,
                `Unable to read Janus scopes: ${errorMessage(error)}`
            );
        }
    }

    protected variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): void {
        void this.variables(response, args);
    }

    private async variables(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        try {
            const body = await this.requireRuntime().request('GET_VARIABLES', {
                variablesReference: args.variablesReference
            });
            response.body = { variables: this.parseVariables(body) };
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1006,
                `Unable to read Janus variables: ${errorMessage(error)}`
            );
        }
    }

    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments
    ): void {
        void this.runExecutionCommand('CONTINUE', response, true);
    }

    protected nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments
    ): void {
        void this.runExecutionCommand('STEP', response);
    }

    protected stepInRequest(
        response: DebugProtocol.StepInResponse,
        _args: DebugProtocol.StepInArguments
    ): void {
        void this.runExecutionCommand('STEP_IN', response);
    }

    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments
    ): void {
        void this.runExecutionCommand('STEP_OUT', response);
    }

    protected stepBackRequest(
        response: DebugProtocol.StepBackResponse,
        _args: DebugProtocol.StepBackArguments
    ): void {
        void this.runExecutionCommand('STEP_BACK', response);
    }

    protected reverseContinueRequest(
        response: DebugProtocol.ReverseContinueResponse,
        _args: DebugProtocol.ReverseContinueArguments
    ): void {
        void this.runExecutionCommand('REVERSE_CONTINUE', response);
    }

    private async runExecutionCommand(
        command:
            | 'CONTINUE'
            | 'STEP'
            | 'STEP_IN'
            | 'STEP_OUT'
            | 'STEP_BACK'
            | 'REVERSE_CONTINUE',
        response: DebugProtocol.Response,
        isContinue = false
    ): Promise<void> {
        this.deferRuntimeEvents();
        try {
            await this.requireRuntime().request(command);
            this.executionDirection = command === 'STEP_BACK' || command === 'REVERSE_CONTINUE'
                ? 'reverse'
                : 'forward';
            if (isContinue) {
                (response as DebugProtocol.ContinueResponse).body = {
                    allThreadsContinued: true
                };
            }
            this.sendResponse(response);
            this.sendEvent(new ContinuedEvent(JanusDebugSession.THREAD_ID, true));
            this.sendEvent(new Event(JANUS_EXECUTION_STATE_EVENT, {
                state: 'running',
                direction: this.executionDirection
            }));
        } catch (error) {
            this.sendErrorResponse(
                response,
                1008,
                `Janus ${command.toLowerCase()} failed: ${errorMessage(error)}`
            );
        } finally {
            this.releaseRuntimeEvents();
        }
    }

    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments
    ): void {
        void this.pause(response);
    }

    private async pause(response: DebugProtocol.PauseResponse): Promise<void> {
        this.deferRuntimeEvents();
        try {
            await this.requireRuntime().request('PAUSE');
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1009,
                `Unable to pause Janus: ${errorMessage(error)}`
            );
        } finally {
            this.releaseRuntimeEvents();
        }
    }

    protected disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments
    ): void {
        void this.stopRuntime(response);
    }

    protected terminateRequest(
        response: DebugProtocol.TerminateResponse,
        _args: DebugProtocol.TerminateArguments
    ): void {
        void this.stopRuntime(response);
    }

    private async stopRuntime(response: DebugProtocol.Response): Promise<void> {
        this.deferRuntimeEvents();
        try {
            const runtime = this.runtime;
            if (runtime) {
                await runtime.stop();
                if (this.runtime === runtime) {
                    this.runtime = undefined;
                }
            }
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(
                response,
                1010,
                `Unable to stop Janus cleanly: ${errorMessage(error)}`
            );
        } finally {
            this.releaseRuntimeEvents();
        }
    }

    private async resolveLaunchOptions(
        args: JanusLaunchRequestArguments
    ): Promise<ResolvedLaunchOptions> {
        if (typeof args.program !== 'string' || !args.program.trim()) {
            throw new Error('The "program" setting must name a Janus source file');
        }
        if (args.args !== undefined && (
            !Array.isArray(args.args) || args.args.some(value => typeof value !== 'string')
        )) {
            throw new Error('The "args" setting must be an array of strings');
        }

        const cwd = path.resolve(args.cwd ?? path.dirname(args.program));
        const program = path.isAbsolute(args.program)
            ? path.normalize(args.program)
            : path.resolve(cwd, args.program);
        const defaultInterpreter = path.join(
            cwd,
            'build',
            process.platform === 'win32' ? 'janus.exe' : 'janus'
        );
        const configuredInterpreter = args.interpreterPath ?? defaultInterpreter;
        const interpreterPath = path.isAbsolute(configuredInterpreter)
            ? path.normalize(configuredInterpreter)
            : path.resolve(cwd, configuredInterpreter);

        const cwdStat = await fs.stat(cwd).catch(() => undefined);
        if (!cwdStat?.isDirectory()) {
            throw new Error(`Working directory does not exist: ${cwd}`);
        }
        await this.requireFile(program, 'Janus program', fsConstants.R_OK);

        const isJavaScript = ['.js', '.cjs', '.mjs'].includes(
            path.extname(interpreterPath).toLowerCase()
        );
        const interpreterMode = isJavaScript || process.platform === 'win32'
            ? fsConstants.R_OK
            : fsConstants.R_OK | fsConstants.X_OK;
        await this.requireFile(interpreterPath, 'Janus interpreter', interpreterMode);

        return {
            program,
            args: args.args ?? [],
            cwd,
            interpreterPath
        };
    }

    private async requireFile(file: string, label: string, mode: number): Promise<void> {
        const stat = await fs.stat(file).catch(() => undefined);
        if (!stat?.isFile()) {
            throw new Error(`${label} does not exist: ${file}`);
        }
        try {
            await fs.access(file, mode);
        } catch {
            throw new Error(`${label} is not accessible: ${file}`);
        }
    }

    private resetSession(program: string): void {
        this.nextBreakpointId = 1;
        this.currentFile = program;
        this.currentLine = 1;
        this.stackFrames = [];
        this.configurationComplete = false;
        this.deferredEventCount = 0;
        this.pendingRuntimeEvents = [];
        this.terminatedEventSent = false;
        this.executionDirection = 'forward';
    }

    private attachRuntime(runtime: JanusRuntime): void {
        runtime.on('event', (event: RuntimeEvent) => this.receiveRuntimeEvent(event));
        runtime.on('stderr', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stderr'));
        });
        runtime.on('protocolError', (message: string) => {
            this.sendEvent(new OutputEvent(`Janus protocol error: ${message}\n`, 'stderr'));
        });
        runtime.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            if (this.runtime === runtime) {
                this.runtime = undefined;
            }
            if (code !== null && code !== 0 && !this.terminatedEventSent) {
                this.sendEvent(new OutputEvent(
                    `Janus interpreter exited with code ${code}.\n`,
                    'stderr'
                ));
            } else if (signal && !this.terminatedEventSent) {
                this.sendEvent(new OutputEvent(
                    `Janus interpreter was stopped by ${signal}.\n`,
                    'stderr'
                ));
            }
            this.receiveRuntimeEvent({
                type: 'event',
                event: 'terminated',
                body: { exitCode: code ?? 0 }
            });
        });
    }

    private requireRuntime(): JanusRuntime {
        if (!this.runtime) {
            throw new Error('The Janus interpreter is not running');
        }
        return this.runtime;
    }

    private receiveRuntimeEvent(event: RuntimeEvent): void {
        if (!this.configurationComplete || this.deferredEventCount > 0) {
            this.pendingRuntimeEvents.push(event);
            return;
        }
        this.handleRuntimeEvent(event);
    }

    private flushRuntimeEvents(): void {
        if (!this.configurationComplete || this.deferredEventCount > 0) {
            return;
        }

        const events = this.pendingRuntimeEvents;
        this.pendingRuntimeEvents = [];
        for (const event of events) {
            this.handleRuntimeEvent(event);
        }
    }

    private deferRuntimeEvents(): void {
        this.deferredEventCount++;
    }

    private releaseRuntimeEvents(): void {
        this.deferredEventCount = Math.max(0, this.deferredEventCount - 1);
        this.flushRuntimeEvents();
    }

    private handleRuntimeEvent(message: RuntimeEvent): void {
        const body = message.body ?? {};

        switch (message.event) {
            case 'stopped': {
                this.currentFile = typeof body.file === 'string'
                    ? body.file
                    : this.currentFile;
                this.currentLine = positiveInteger(body.line, this.currentLine);
                this.updateFallbackStackFrame();

                if (body.direction === 'forward' || body.direction === 'reverse') {
                    this.executionDirection = body.direction;
                }

                const reason = typeof body.reason === 'string' ? body.reason : 'pause';
                const event = new StoppedEvent(reason, JanusDebugSession.THREAD_ID);
                const stoppedBody = event.body as DebugProtocol.StoppedEvent['body'];
                stoppedBody.allThreadsStopped = true;
                if (typeof body.description === 'string') {
                    stoppedBody.description = body.description;
                }
                if (typeof body.text === 'string') {
                    stoppedBody.text = body.text;
                }
                this.sendEvent(event);
                this.sendEvent(new Event(JANUS_EXECUTION_STATE_EVENT, {
                    state: 'stopped',
                    direction: this.executionDirection,
                    file: this.currentFile,
                    line: this.currentLine,
                    column: positiveInteger(body.column, 1)
                }));
                break;
            }

            case 'output': {
                const output = typeof body.output === 'string'
                    ? body.output
                    : String(body.text ?? '');
                const category = body.category === 'stderr' ? 'stderr' : 'stdout';
                this.sendEvent(new OutputEvent(output, category));
                break;
            }

            case 'error':
                this.sendEvent(new OutputEvent(
                    `${String(body.message ?? 'Unknown Janus interpreter error')}\n`,
                    'stderr'
                ));
                break;

            case 'exited':
                this.sendEvent(new ExitedEvent(
                    typeof body.exitCode === 'number'
                        ? body.exitCode
                        : typeof body.exit_code === 'number'
                            ? body.exit_code
                            : 0
                ));
                break;

            case 'terminated':
                this.notifyTerminated();
                break;

            default:
                this.sendEvent(new OutputEvent(
                    `Unknown Janus interpreter event: ${message.event}\n`,
                    'stderr'
                ));
                break;
        }
    }

    private updateFallbackStackFrame(): void {
        this.stackFrames = [
            new StackFrame(
                0,
                'main',
                this.currentFile
                    ? new Source(path.basename(this.currentFile), this.currentFile)
                    : undefined,
                this.currentLine,
                1
            )
        ];
    }

    private updateStackFrames(body: MessageBody): void {
        const rawFrames = body.frames;
        if (!Array.isArray(rawFrames)) {
            this.updateFallbackStackFrame();
            return;
        }

        const frames = rawFrames.flatMap((rawFrame, index): StackFrame[] => {
            if (!isObject(rawFrame)) {
                return [];
            }

            const id = typeof rawFrame.id === 'number' && Number.isSafeInteger(rawFrame.id)
                ? rawFrame.id
                : index;
            const name = typeof rawFrame.name === 'string' ? rawFrame.name : 'unknown';
            const file = typeof rawFrame.file === 'string' && rawFrame.file.length > 0
                ? rawFrame.file
                : this.currentFile;
            const line = positiveInteger(rawFrame.line, 1);
            const column = positiveInteger(rawFrame.column, 1);
            return [new StackFrame(
                id,
                name,
                file ? new Source(path.basename(file), file) : undefined,
                line,
                column
            )];
        });

        if (frames.length === 0) {
            this.updateFallbackStackFrame();
            return;
        }

        this.stackFrames = frames;
        const topFrame = frames[0];
        this.currentFile = topFrame.source?.path ?? this.currentFile;
        this.currentLine = topFrame.line;
    }

    private parseScopes(body: MessageBody): DebugProtocol.Scope[] {
        if (!Array.isArray(body.scopes)) {
            throw new Error('GET_SCOPES response body must contain a scopes array');
        }

        return body.scopes.map((rawScope, index): DebugProtocol.Scope => {
            if (
                !isObject(rawScope) ||
                typeof rawScope.name !== 'string' ||
                !isPositiveInteger(rawScope.variablesReference) ||
                typeof rawScope.expensive !== 'boolean'
            ) {
                throw new Error(`GET_SCOPES returned an invalid scope at index ${index}`);
            }

            const scope: DebugProtocol.Scope = {
                name: rawScope.name,
                variablesReference: rawScope.variablesReference,
                expensive: rawScope.expensive
            };
            if (typeof rawScope.presentationHint === 'string') {
                scope.presentationHint = rawScope.presentationHint;
            }
            if (isNonNegativeInteger(rawScope.namedVariables)) {
                scope.namedVariables = rawScope.namedVariables;
            }
            if (isNonNegativeInteger(rawScope.indexedVariables)) {
                scope.indexedVariables = rawScope.indexedVariables;
            }
            return scope;
        });
    }

    private parseVariables(body: MessageBody): DebugProtocol.Variable[] {
        if (!Array.isArray(body.variables)) {
            throw new Error('GET_VARIABLES response body must contain a variables array');
        }

        return body.variables.map((rawVariable, index): DebugProtocol.Variable => {
            if (
                !isObject(rawVariable) ||
                typeof rawVariable.name !== 'string' ||
                typeof rawVariable.value !== 'string' ||
                !isNonNegativeInteger(rawVariable.variablesReference)
            ) {
                throw new Error(`GET_VARIABLES returned an invalid variable at index ${index}`);
            }

            const variable: DebugProtocol.Variable = {
                name: rawVariable.name,
                value: rawVariable.value,
                variablesReference: rawVariable.variablesReference
            };
            if (this.clientSupportsVariableType && typeof rawVariable.type === 'string') {
                variable.type = rawVariable.type;
            }
            if (isNonNegativeInteger(rawVariable.namedVariables)) {
                variable.namedVariables = rawVariable.namedVariables;
            }
            if (isNonNegativeInteger(rawVariable.indexedVariables)) {
                variable.indexedVariables = rawVariable.indexedVariables;
            }
            return variable;
        });
    }

    private notifyTerminated(): void {
        if (this.terminatedEventSent) {
            return;
        }
        this.terminatedEventSent = true;
        this.sendEvent(new TerminatedEvent());
    }
}
