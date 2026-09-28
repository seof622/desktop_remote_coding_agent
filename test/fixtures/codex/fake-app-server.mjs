import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expected = process.argv[3] === "error"
  ? { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "This approval type is not supported by the Gateway." } }
  : JSON.parse(readFileSync(process.argv[3], "utf8"));
const resolvedTemplate = JSON.parse(readFileSync(process.argv[4], "utf8"));
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function matchesExpected(message) {
  return JSON.stringify(message) === JSON.stringify(expected);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "thread/start") {
      send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: request.params.threadId } } });
    } else if (message.method === "turn/start") {
      process.stdout.write([
        { jsonrpc: "2.0", id: message.id, result: { turn: { id: request.params.turnId } } },
        request,
      ].map((item) => `${JSON.stringify(item)}\n`).join(""));
    } else if (message.id === request.id) {
      if (!matchesExpected(message)) {
        process.stderr.write("Unexpected approval response.\n");
        process.exit(2);
      }
      send({
        ...resolvedTemplate,
        params: { requestId: request.id, threadId: request.params.threadId },
      });
    }
  }
});
