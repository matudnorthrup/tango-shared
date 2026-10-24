// A foreground CDP-shaped listener for process/port ownership tests, not a browser.
import { createServer } from 'node:http';
const port = Number(process.argv.find(arg => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
createServer((req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test`, args: process.argv.slice(2) }))).listen(port, '127.0.0.1');
