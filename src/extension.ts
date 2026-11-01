import * as path from 'path';
import * as vscode from 'vscode';
import {
    ExecutionState,
    JANUS_EXECUTION_STATE_EVENT,
    parseExecutionState
} from './executionState';

function comparablePath(file: string): string {
    const normalized = path.normalize(path.resolve(file));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function editorShowsFile(editor: vscode.TextEditor, file: string): boolean {
    return editor.document.uri.scheme === 'file' &&
        comparablePath(editor.document.uri.fsPath) === comparablePath(file);
}

export function activate(context: vscode.ExtensionContext): void {
    const forwardBoundary = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '1px 0 0 0',
        borderColor: new vscode.ThemeColor('janus.executionBoundary')
    });
    const reverseBoundary = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '0 0 1px 0',
        borderColor: new vscode.ThemeColor('janus.executionBoundary')
    });
    const states = new Map<string, ExecutionState>();

    const refreshDecorations = (): void => {
        const activeSession = vscode.debug.activeDebugSession;
        const state = activeSession ? states.get(activeSession.id) : undefined;

        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(forwardBoundary, []);
            editor.setDecorations(reverseBoundary, []);

            if (
                !state ||
                state.state !== 'stopped' ||
                !editorShowsFile(editor, state.file) ||
                state.line > editor.document.lineCount
            ) {
                continue;
            }

            const line = state.line - 1;
            const position = new vscode.Position(line, 0);
            const range = new vscode.Range(position, position);
            const decoration = state.direction === 'forward'
                ? forwardBoundary
                : reverseBoundary;
            editor.setDecorations(decoration, [range]);
        }
    };

    context.subscriptions.push(
        forwardBoundary,
        reverseBoundary,
        vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
            if (event.session.type !== 'janus' || event.event !== JANUS_EXECUTION_STATE_EVENT) {
                return;
            }

            const state = parseExecutionState(event.body);
            if (!state) {
                return;
            }

            states.set(event.session.id, state);
            refreshDecorations();
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
            states.delete(session.id);
            refreshDecorations();
        }),
        vscode.debug.onDidChangeActiveDebugSession(refreshDecorations),
        vscode.window.onDidChangeActiveTextEditor(refreshDecorations),
        vscode.window.onDidChangeVisibleTextEditors(refreshDecorations)
    );
}

export function deactivate(): void {
    // VS Code disposes the extension context subscriptions.
}
