export const JANUS_EXECUTION_STATE_EVENT = 'janus.executionState';

export type ExecutionDirection = 'forward' | 'reverse';

export interface RunningExecutionState {
    state: 'running';
    direction: ExecutionDirection;
}

export interface StoppedExecutionState {
    state: 'stopped';
    direction: ExecutionDirection;
    file: string;
    line: number;
    column: number;
}

export type ExecutionState = RunningExecutionState | StoppedExecutionState;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isExecutionDirection(value: unknown): value is ExecutionDirection {
    return value === 'forward' || value === 'reverse';
}

export function parseExecutionState(value: unknown): ExecutionState | undefined {
    if (!isObject(value) || !isExecutionDirection(value.direction)) {
        return undefined;
    }

    if (value.state === 'running') {
        return {
            state: 'running',
            direction: value.direction
        };
    }

    if (
        value.state !== 'stopped' ||
        typeof value.file !== 'string' ||
        value.file.length === 0 ||
        typeof value.line !== 'number' ||
        !Number.isSafeInteger(value.line) ||
        value.line < 1 ||
        typeof value.column !== 'number' ||
        !Number.isSafeInteger(value.column) ||
        value.column < 1
    ) {
        return undefined;
    }

    return {
        state: 'stopped',
        direction: value.direction,
        file: value.file,
        line: value.line,
        column: value.column
    };
}
