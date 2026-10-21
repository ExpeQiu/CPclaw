import { createServer } from "node:http";

export function startMockLlm(options = {}) {
  const hang = options.hang === true;
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url === null || !request.url.includes("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      let stream = false;
      let model = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        stream = body.stream === true;
        model = typeof body.model === "string" ? body.model : "";
      } catch {
        stream = false;
      }
      requests.push({ url: request.url, stream, model });
      if (hang && stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        request.on("close", () => {
          response.end();
        });
        return;
      }
      if (stream) {
        const chunk = (choice) => JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          model: "mock-text",
          choices: [choice],
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${chunk({ index: 0, delta: { role: "assistant", content: "合成流结束" }, finish_reason: null })}\n\n`);
        response.write(`data: ${chunk({ index: 0, delta: {}, finish_reason: "stop" })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "好" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("mock llm 没有端口"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((done) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => done());
        }),
      });
    });
  });
}
