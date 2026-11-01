# Janus Debug Protocol

The VS Code adapter and Janus interpreter communicate over the child process's
standard streams:

The native interpreter implementation is maintained in
[`janus-interp`](https://gitlab.com/ErikJonasson/janus-interp).

- Adapter to interpreter: a framed tab-delimited command on stdin.
- Interpreter to adapter: a framed JSON response or event on stdout.
- Diagnostic logging that is not part of the protocol goes to stderr.

Spaces are allowed in paths and expressions. Tabs, carriage returns, and
newlines are not allowed inside command fields.

## Wire framing

Every message in both directions uses DAP-style `Content-Length` framing:

```text
Content-Length: <body byte length>\r\n
\r\n
<body>
```

For example, the eleven-byte command body `STEP_BACK<TAB>7` is transmitted as:

```text
Content-Length: 11\r\n\r\nSTEP_BACK\t7
```

The header is ASCII and the body is UTF-8. `Content-Length` counts only the
UTF-8 body bytes, not Unicode characters and not the header. The body has no
terminating newline or NUL byte. A receiver must handle headers and bodies split
across multiple reads as well as multiple complete frames arriving in one read.
Protocol bodies larger than 1 MiB are rejected.

This adopts DAP's transport framing, but the bodies described below remain the
Janus runtime protocol rather than DAP messages.

## Starting the interpreter

The adapter starts the interpreter as:

```text
janus --debug <program> [arguments...]
```

In debug mode, the interpreter stops before the first executable statement,
sends a `stopped` event with reason `entry`, and waits for a command.

## Input commands

Each framed request body is a command whose fields are separated by literal tab
characters. Every command has an ID, and the interpreter returns that ID in its
response. The examples below show bodies without their `Content-Length` header.

```text
CLEAR_BREAKPOINTS<TAB>1<TAB>/home/erik/My Project/main.ja
SET_BREAKPOINT<TAB>2<TAB>17<TAB>/home/erik/My Project/main.ja
CONTINUE<TAB>3
STEP<TAB>4
STEP_IN<TAB>5
STEP_OUT<TAB>6
STEP_BACK<TAB>7
REVERSE_CONTINUE<TAB>8
PAUSE<TAB>9
GET_STACK<TAB>10
GET_SCOPES<TAB>11<TAB>0
GET_VARIABLES<TAB>12<TAB>1001
TERMINATE<TAB>13
```

Supported commands:

| Command | Fields after command | Meaning |
|---|---|---|
| `CLEAR_BREAKPOINTS` | `id`, `file` | Remove all breakpoints for one source file. |
| `SET_BREAKPOINT` | `id`, `line`, `file` | Add a source breakpoint. |
| `CONTINUE` | `id` | Run until a stop condition or termination. |
| `STEP` | `id` | Step over one source statement. |
| `STEP_IN` | `id` | Enter a called procedure. |
| `STEP_OUT` | `id` | Run until the current procedure returns. |
| `STEP_BACK` | `id` | Execute one source statement backward. |
| `REVERSE_CONTINUE` | `id` | Run backward until a stop condition. |
| `PAUSE` | `id` | Request a cooperative stop at the next safe point. |
| `GET_STACK` | `id` | Return the current call stack. |
| `GET_SCOPES` | `id`, `frameId` | Return the variable scopes for a stack frame. |
| `GET_VARIABLES` | `id`, `variablesReference` | Return the children of a scope or structured variable. |
| `TERMINATE` | `id` | Terminate the debuggee cleanly. |

## Responses

A response frame contains a JSON body. A successful response has `success: true`
and an optional `body`:

```json
{"type":"response","id":3,"success":true,"body":{}}
```

A failed response has `success: false` and a human-readable message:

```json
{"type":"response","id":3,"success":false,"message":"Program is already running"}
```

Stack response:

```json
{"type":"response","id":8,"success":true,"body":{"frames":[{"id":0,"name":"main","file":"/home/erik/My Project/main.ja","line":17,"column":1}]}}
```

Scopes response:

```json
{"type":"response","id":11,"success":true,"body":{"scopes":[{"name":"Local","presentationHint":"locals","variablesReference":1001,"expensive":false}]}}
```

`variablesReference` is an opaque positive integer. It uniquely identifies a
scope or structured value among all references that are valid while execution
is suspended. A reference becomes invalid when execution resumes.

Variables response:

```json
{"type":"response","id":12,"success":true,"body":{"variables":[{"name":"x","value":"42","type":"int","variablesReference":0},{"name":"point","value":"{ x: 1, y: 2 }","type":"point","variablesReference":2001,"namedVariables":2}]}}
```

Every variable value is a string. A variable reference of `0` means the value
has no children. A positive reference can be passed to `GET_VARIABLES` to
retrieve nested children. `type`, `namedVariables`, and `indexedVariables` are
optional. `evaluateName` is not supported.

## Events

Event frames also contain JSON bodies. Events have no request ID because they
may occur at any time.

```json
{"type":"event","event":"stopped","body":{"reason":"breakpoint","file":"/home/erik/My Project/main.ja","line":17,"column":1,"direction":"forward"}}
{"type":"event","event":"stopped","body":{"reason":"exception","description":"Division by zero","text":"Cannot divide 12 by zero","file":"/home/erik/My Project/main.ja","line":17,"column":14,"direction":"forward"}}
{"type":"event","event":"output","body":{"text":"result = 42\n","category":"stdout"}}
{"type":"event","event":"error","body":{"message":"Division by zero"}}
{"type":"event","event":"terminated","body":{"exitCode":0}}
```

Supported stop reasons are `entry`, `step`, `breakpoint`, `pause`, and
`exception`.

An exception stop may include `description`, a short error category, and
`text`, the detailed human-readable error message. The adapter forwards both
fields to the native DAP `stopped` event. Exception IDs and the DAP
`exceptionInfo` request are not supported.

Every `stopped` event includes `direction`, either `forward` or `reverse`. The
line identifies the statement affected by the next operation in that direction.
The VS Code extension uses these fields to place the execution-boundary line
above a forward target or below a reverse target.

## Execution and threading

The command-reader thread parses complete `Content-Length` frames and then
tokenizes their tab-delimited bodies. It sets atomic pause and termination flags
for urgent commands and queues all other requests. The interpreter thread owns
execution state, processes queued requests at safe statement boundaries, and
writes framed JSON responses and events to stdout.

Only the interpreter thread may inspect the call stack or variables. This keeps
debug queries deterministic and avoids data races.
