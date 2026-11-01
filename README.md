# Janus Debugger

A VS Code debug adapter for the Janus reversible language. The extension speaks
Debug Adapter Protocol (DAP) to VS Code and translates requests to the compact
native protocol implemented by
[`janus-interp`](https://gitlab.com/ErikJonasson/janus-interp).

## Develop and test

```bash
npm install
npm test
```

`npm test` compiles the TypeScript and runs both protocol unit tests and a full
debug-session test against a deterministic mock runtime. The session test
covers launch, breakpoints, entry stop, stack frames, scopes, variables,
stepping, forward and reverse continue, breakpoint stops, and clean disconnect.

To try it interactively:

1. Open this repository in VS Code.
2. Run **Run Janus Debugger Extension** from the Run and Debug panel.
3. In the Extension Development Host, run **Debug mock Janus program**.

Use `npm run check` for a type-only check, `npm run watch` while editing, and
`npm run package` to create a VSIX.

## Debug configuration

For the real interpreter, add this to `.vscode/launch.json`:

```json
{
    "name": "Debug Janus Program",
    "type": "janus",
    "request": "launch",
    "program": "${workspaceFolder}/program.ja",
    "interpreterPath": "/path/to/janus-interp/build/janus",
    "cwd": "${workspaceFolder}"
}
```

The adapter does not silently fall back to the mock. A missing program or
interpreter produces a launch error with the relevant path.

## Architecture

- `src/debugAdapter.ts` is the executable DAP entry point.
- `src/janusDebugAdapter.ts` owns VS Code session state and maps DAP requests
  and events.
- `src/janusRuntime.ts` owns the interpreter process, command IDs, timeouts,
  stream framing, and graceful shutdown.
- `mock-janus.js` is a deterministic development backend.
- `DEBUG_PROTOCOL.md` is the contract the native interpreter must implement.

Both directions use `Content-Length` framing. The adapter sends tab-delimited
command bodies on interpreter stdin, and the interpreter returns JSON response
and event bodies on stdout. Diagnostics go to stderr. Paths may contain spaces,
but protocol fields may not contain tabs or newlines.

## Supported DAP operations

- Source breakpoints
- Continue, reverse continue, pause, step over, step in, step out, and step back
- Forward/reverse execution-boundary decoration in the source editor
- Stack traces
- Local and global scopes
- Variable inspection
- Graceful terminate and disconnect

The TypeScript adapter is independently testable with the mock runtime. Using
all features with the native Janus executable additionally requires its debug
backend to implement every command and event in `DEBUG_PROTOCOL.md`.

## Development note

The entire VS Code extension was vibe coded with AI assistance.

## License

Copyright (c) 2026 Erik Jonasson. Licensed under the [MIT License](LICENSE).
