import { createServer } from "node:net";

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.stderr.write("无法分配端口\n");
    process.exit(1);
  }
  process.stdout.write(`${address.port}\n`);
  server.close();
});
