#!/usr/bin/env node

const port = Number(process.argv[2] ?? '9231');
const expression = process.argv[3];
if (!expression) {
    console.error('Usage: cdp-evaluate.mjs <port> <expression>');
    process.exit(2);
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
const target = targets.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
if (!target) {
    throw new Error(`No CDP page target on port ${port}`);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const timeout = setTimeout(() => {
    console.error('CDP evaluation timed out');
    process.exit(1);
}, 30_000);

socket.addEventListener('open', () => {
    socket.send(
        JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression,
                awaitPromise: true,
                returnByValue: true,
                userGesture: true
            }
        })
    );
});

socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) {
        return;
    }
    clearTimeout(timeout);
    console.log(JSON.stringify(message.result, null, 2));
    socket.close();
});

socket.addEventListener('error', event => {
    clearTimeout(timeout);
    console.error('CDP WebSocket error', event.message ?? event.type);
    process.exit(1);
});
