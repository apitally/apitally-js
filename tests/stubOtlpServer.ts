import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";

export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  destroySocket?: boolean;
  hang?: boolean;
}

export interface CapturedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

// Local HTTP server recording POSTed requests, with scriptable responses per
// path. Doubles as a stub forward proxy: undici proxies exclusively via HTTP
// CONNECT, so CONNECT requests are answered by piping the tunneled bytes to
// the target.
export class StubOtlpServer {
  readonly requests: CapturedRequest[] = [];
  readonly connectTargets: string[] = [];
  respond: (path: string) => StubResponse | Promise<StubResponse> = () => ({
    status: 200,
  });
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly requestWaiters: {
    count: number;
    resolve: () => void;
  }[] = [];

  private constructor() {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => undefined);
    });
    this.server.on("connect", (request, clientSocket, head) => {
      this.handleConnect(request, clientSocket as Socket, head);
    });
    this.server.on("connection", (socket) => {
      this.trackSocket(socket);
    });
  }

  static async start(): Promise<StubOtlpServer> {
    const stub = new StubOtlpServer();
    await new Promise<void>((resolve) => {
      stub.server.listen(0, "127.0.0.1", resolve);
    });
    return stub;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Server is not listening on a TCP port");
    }
    return address.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  paths(): string[] {
    return this.requests.map((request) => request.path);
  }

  waitForRequests(count: number): Promise<void> {
    if (this.requests.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.requestWaiters.push({ count, resolve });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    this.requests.push({
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    for (const waiter of this.requestWaiters.splice(0)) {
      if (this.requests.length >= waiter.count) {
        waiter.resolve();
      } else {
        this.requestWaiters.push(waiter);
      }
    }
    const stubResponse = await this.respond(request.url ?? "");
    if (stubResponse.hang) {
      return;
    }
    if (stubResponse.destroySocket) {
      request.socket.destroy();
      return;
    }
    response.writeHead(stubResponse.status, {
      "Content-Length": "0",
      ...stubResponse.headers,
    });
    response.end();
  }

  private handleConnect(
    request: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): void {
    const target = request.url ?? "";
    this.connectTargets.push(target);
    const [host, port] = target.split(":");
    const targetSocket = connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => targetSocket.destroy());
    this.trackSocket(clientSocket);
    this.trackSocket(targetSocket);
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }
}
