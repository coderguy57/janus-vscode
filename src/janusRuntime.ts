import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';

export type MessageBody = Record<string, unknown>;

export type RuntimeCommand =
    | 'CLEAR_BREAKPOINTS'
    | 'SET_BREAKPOINT'
    | 'CONTINUE'
    | 'STEP'
    | 'STEP_IN'
    | 'STEP_OUT'
    | 'STEP_BACK'
    | 'REVERSE_CONTINUE'
    | 'PAUSE'
    | 'GET_STACK'
    | 'GET_SCOPES'
    | 'GET_VARIABLES'
    | 'TERMINATE';

export interface RuntimeResponse {
    type: 'response';
    id: number;
    success: boolean;
    body?: MessageBody;
    message?: string;
}

export interface RuntimeEvent {
    type: 'event';
    event: string;
    body?: MessageBody;
}

export interface RuntimeLaunchOptions {
    interpreterPath: string;
    program: string;
    cwd: string;
    args: string[];
}

interface PendingCommand {
    resolve: (body: MessageBody) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const PROTOCOL_HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
const MAX_PROTOCOL_HEADER_LENGTH = 8 * 1024;
const MAX_PROTOCOL_BODY_LENGTH = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;

function isObject(value: unknown): value is MessageBody {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasInvalidFieldCharacters(value: string): boolean {
    return /[\t\r\n]/.test(value);
}

function integerArgument(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function formatRuntimeCommand(
    command: RuntimeCommand,
    id: number,
    args: MessageBody = {}
): string {
    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error('Runtime command ID must be a positive integer');
    }

    let fields: Array<string | number>;

    switch (command) {
        case 'CLEAR_BREAKPOINTS':
            if (typeof args.file !== 'string') {
                throw new Error('CLEAR_BREAKPOINTS requires a file');
            }
            fields = [command, id, args.file];
            break;

        case 'SET_BREAKPOINT':
            if (typeof args.file !== 'string' || !integerArgument(args.line) || args.line < 1) {
                throw new Error('SET_BREAKPOINT requires a file and a positive line number');
            }
            fields = [command, id, args.line, args.file];
            break;

        case 'GET_SCOPES':
            if (!integerArgument(args.frameId)) {
                throw new Error('GET_SCOPES requires a frame ID');
            }
            fields = [command, id, args.frameId];
            break;

        case 'GET_VARIABLES':
            if (!integerArgument(args.variablesReference) || args.variablesReference < 1) {
                throw new Error('GET_VARIABLES requires a positive variables reference');
            }
            fields = [command, id, args.variablesReference];
            break;

        case 'CONTINUE':
        case 'STEP':
        case 'STEP_IN':
        case 'STEP_OUT':
        case 'STEP_BACK':
        case 'REVERSE_CONTINUE':
        case 'PAUSE':
        case 'GET_STACK':
        case 'TERMINATE':
            fields = [command, id];
            break;
    }

    const encodedFields = fields.map(String);
    if (encodedFields.some(hasInvalidFieldCharacters)) {
        throw new Error('Runtime protocol fields cannot contain tabs or newlines');
    }

    return encodedFields.join('\t');
}

export function parseRuntimeMessage(line: string): RuntimeResponse | RuntimeEvent {
    let rawMessage: unknown;
    try {
        rawMessage = JSON.parse(line);
    } catch {
        throw new Error(`Invalid JSON from Janus runtime: ${line}`);
    }

    if (!isObject(rawMessage) || typeof rawMessage.type !== 'string') {
        throw new Error('Janus runtime emitted an invalid protocol object');
    }

    if (rawMessage.type === 'response') {
        if (!integerArgument(rawMessage.id) || typeof rawMessage.success !== 'boolean') {
            throw new Error('Janus runtime emitted an invalid response');
        }
        if (rawMessage.body !== undefined && !isObject(rawMessage.body)) {
            throw new Error('Janus runtime response body must be an object');
        }
        if (rawMessage.message !== undefined && typeof rawMessage.message !== 'string') {
            throw new Error('Janus runtime response message must be a string');
        }

        return rawMessage as unknown as RuntimeResponse;
    }

    if (rawMessage.type === 'event') {
        if (typeof rawMessage.event !== 'string') {
            throw new Error('Janus runtime emitted an invalid event');
        }
        if (rawMessage.body !== undefined && !isObject(rawMessage.body)) {
            throw new Error('Janus runtime event body must be an object');
        }

        return rawMessage as unknown as RuntimeEvent;
    }

    throw new Error(`Unknown Janus runtime message type: ${rawMessage.type}`);
}

function parseContentLength(header: Buffer): number {
    let contentLength: number | undefined;

    for (const line of header.toString('ascii').split('\r\n')) {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            throw new Error(`Malformed Janus runtime protocol header: ${line}`);
        }

        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (name !== 'content-length') {
            continue;
        }
        if (contentLength !== undefined) {
            throw new Error('Duplicate Content-Length header from Janus runtime');
        }
        if (!/^(0|[1-9]\d*)$/.test(value)) {
            throw new Error(`Invalid Content-Length from Janus runtime: ${value}`);
        }

        contentLength = Number(value);
        if (!Number.isSafeInteger(contentLength)) {
            throw new Error(`Invalid Content-Length from Janus runtime: ${value}`);
        }
        if (contentLength > MAX_PROTOCOL_BODY_LENGTH) {
            throw new Error('Janus runtime protocol body exceeded 1 MiB');
        }
    }

    if (contentLength === undefined) {
        throw new Error('Missing Content-Length header from Janus runtime');
    }
    return contentLength;
}

export function encodeRuntimeFrame(payload: string): Buffer {
    const body = Buffer.from(payload, 'utf8');
    if (body.length > MAX_PROTOCOL_BODY_LENGTH) {
        throw new Error('Janus runtime protocol body exceeded 1 MiB');
    }

    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
}

export class ContentLengthFrameDecoder {
    private buffer = Buffer.alloc(0);

    public get hasPendingData(): boolean {
        return this.buffer.length > 0;
    }

    public reset(): void {
        this.buffer = Buffer.alloc(0);
    }

    public push(chunk: Buffer): string[] {
        if (chunk.length > 0) {
            this.buffer = this.buffer.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([this.buffer, chunk]);
        }

        const payloads: string[] = [];
        while (this.buffer.length > 0) {
            const headerEnd = this.buffer.indexOf(PROTOCOL_HEADER_SEPARATOR);
            if (headerEnd < 0) {
                if (this.buffer.length > MAX_PROTOCOL_HEADER_LENGTH) {
                    this.reset();
                    throw new Error('Janus runtime protocol header exceeded 8 KiB');
                }
                break;
            }
            if (headerEnd > MAX_PROTOCOL_HEADER_LENGTH) {
                this.reset();
                throw new Error('Janus runtime protocol header exceeded 8 KiB');
            }

            let contentLength: number;
            try {
                contentLength = parseContentLength(this.buffer.subarray(0, headerEnd));
            } catch (error) {
                this.reset();
                throw error;
            }

            const bodyStart = headerEnd + PROTOCOL_HEADER_SEPARATOR.length;
            const frameEnd = bodyStart + contentLength;
            if (this.buffer.length < frameEnd) {
                break;
            }

            payloads.push(this.buffer.subarray(bodyStart, frameEnd).toString('utf8'));
            this.buffer = this.buffer.subarray(frameEnd);
        }

        return payloads;
    }
}

export class JanusRuntime extends EventEmitter {
    private child: ChildProcessWithoutNullStreams | undefined;
    private readonly frameDecoder = new ContentLengthFrameDecoder();
    private readonly pendingCommands = new Map<number, PendingCommand>();
    private nextCommandId = 1;
    private closed = false;

    public async start(options: RuntimeLaunchOptions): Promise<void> {
        if (this.child) {
            throw new Error('Janus runtime is already running');
        }

        const isNodeScript = ['.js', '.cjs', '.mjs'].includes(
            path.extname(options.interpreterPath).toLowerCase()
        );
        const executable = isNodeScript ? process.execPath : options.interpreterPath;
        const runtimeArguments = [
            ...(isNodeScript ? [options.interpreterPath] : []),
            '--debug',
            '--stop_on_entry',
            options.program,
            ...options.args
        ];

        const child = spawn(executable, runtimeArguments, {
            cwd: options.cwd,
            stdio: 'pipe',
            windowsHide: true
        });
        this.child = child;
        this.closed = false;
        this.frameDecoder.reset();

        child.stdout.on('data', (chunk: Buffer) => this.consumeOutput(chunk));
        child.stdout.on('end', () => {
            if (this.frameDecoder.hasPendingData) {
                this.emit('protocolError', 'Janus runtime ended with an incomplete protocol frame');
            }
            this.frameDecoder.reset();
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (data: string) => this.emit('stderr', data));
        child.on('exit', (code, signal) => this.handleExit(code, signal));

        await new Promise<void>((resolve, reject) => {
            const onSpawn = (): void => {
                child.off('error', onStartupError);
                child.on('error', error => this.handleProcessError(error));
                resolve();
            };
            const onStartupError = (error: Error): void => {
                child.off('spawn', onSpawn);
                this.child = undefined;
                this.closed = true;
                reject(error);
            };

            child.once('spawn', onSpawn);
            child.once('error', onStartupError);
        });
    }

    public request(
        command: RuntimeCommand,
        args: MessageBody = {},
        timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
    ): Promise<MessageBody> {
        const child = this.child;
        if (!child || this.closed || !child.stdin.writable) {
            return Promise.reject(new Error('Janus runtime is not running'));
        }

        const id = this.nextCommandId++;
        let encodedCommand: Buffer;
        try {
            encodedCommand = encodeRuntimeFrame(formatRuntimeCommand(command, id, args));
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise<MessageBody>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCommands.delete(id);
                reject(new Error(`Janus runtime timed out while handling ${command}`));
            }, timeoutMs);

            this.pendingCommands.set(id, { resolve, reject, timer });
            child.stdin.write(encodedCommand, error => {
                if (!error) {
                    return;
                }

                const pending = this.pendingCommands.get(id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingCommands.delete(id);
                    pending.reject(error);
                }
            });
        });
    }

    public async stop(gracePeriodMs = 500): Promise<void> {
        const child = this.child;
        if (!child || this.closed) {
            return;
        }

        try {
            await this.request('TERMINATE', {}, gracePeriodMs);
        } catch {
            // The process may not support TERMINATE yet. Fall back to a signal.
        }

        if (!this.closed) {
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, gracePeriodMs);
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }

        if (!this.closed) {
            child.kill();
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, gracePeriodMs);
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    private consumeOutput(data: Buffer): void {
        let payloads: string[];
        try {
            payloads = this.frameDecoder.push(data);
        } catch (error) {
            this.emit('protocolError', errorMessage(error));
            return;
        }

        for (const payload of payloads) {
            try {
                this.handleMessage(parseRuntimeMessage(payload));
            } catch (error) {
                this.emit('protocolError', errorMessage(error));
            }
        }
    }

    private handleMessage(message: RuntimeResponse | RuntimeEvent): void {
        if (message.type === 'event') {
            this.emit('event', message);
            return;
        }

        const pending = this.pendingCommands.get(message.id);
        if (!pending) {
            this.emit('protocolError', `Unexpected Janus runtime response ID: ${message.id}`);
            return;
        }

        clearTimeout(pending.timer);
        this.pendingCommands.delete(message.id);

        if (message.success) {
            pending.resolve(message.body ?? {});
        } else {
            pending.reject(new Error(message.message || 'Janus runtime command failed'));
        }
    }

    private handleProcessError(error: Error): void {
        this.emit('stderr', `Janus runtime process error: ${error.message}\n`);
        this.failPendingCommands(error);
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.child = undefined;
        this.failPendingCommands(new Error('Janus runtime exited'));
        this.emit('exit', code, signal);
    }

    private failPendingCommands(error: Error): void {
        for (const pending of this.pendingCommands.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingCommands.clear();
    }
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
