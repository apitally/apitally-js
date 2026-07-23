import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

// Minimal OTLP sink for the dist child fixtures: stores each POSTed body
// verbatim as <signal>-<sequence>.bin in the given directory, so the parent
// test decodes exactly the bytes the export worker sent.
export async function startOtlpSink(directory) {
  let sequence = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      sequence += 1;
      const signal = (request.url ?? "").split("/").pop();
      writeFile(
        join(directory, `${signal}-${sequence}.bin`),
        Buffer.concat(chunks),
      ).then(
        () => {
          response.writeHead(200);
          response.end();
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
