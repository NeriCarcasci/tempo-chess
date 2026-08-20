/**
 * A Supavisor-shaped pooled endpoint for the disposable rehearsal.
 *
 * Production reaches Postgres through Supavisor on port 6543 with a username of
 * the form `role.tenant`. A bare local Postgres would reject that username
 * outright, so the rehearsal would either have to test a different shape than
 * production uses or invent a role literally named `forma_api.<ref>`. Neither
 * proves anything useful.
 *
 * This proxy models the one behaviour that matters for identity: it accepts the
 * pooled username on the pooled port, checks the tenant is the disposable one,
 * strips the suffix, and forwards the connection to the disposable database. It
 * is a test double for a router, not a connection pool — there is no pooling,
 * no multiplexing, and it exists only for the life of the rehearsal.
 */

import { createServer, connect, type Server, type Socket } from "node:net";

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

export interface PooledEndpointOptions {
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  /** The only tenant suffix this endpoint will route. */
  tenantRef: string;
  /** Adversarial misroute: force a different upstream identity after validation. */
  upstreamRole?: string;
}

export interface PooledEndpoint {
  readonly port: number;
  /** Stop accepting connections. Established sockets are destroyed too. */
  close(): Promise<void>;
}

interface StartupMessage {
  protocol: number;
  parameters: Array<[string, string]>;
}

function parseStartup(body: Buffer): StartupMessage {
  const protocol = body.readInt32BE(0);
  const parameters: Array<[string, string]> = [];
  let offset = 4;
  while (offset < body.length) {
    const keyEnd = body.indexOf(0, offset);
    if (keyEnd === -1 || keyEnd === offset) break;
    const key = body.subarray(offset, keyEnd).toString("utf8");
    const valueEnd = body.indexOf(0, keyEnd + 1);
    if (valueEnd === -1) break;
    const value = body.subarray(keyEnd + 1, valueEnd).toString("utf8");
    parameters.push([key, value]);
    offset = valueEnd + 1;
  }
  return { protocol, parameters };
}

function encodeStartup(message: StartupMessage): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of message.parameters) {
    parts.push(Buffer.from(`${key}\0${value}\0`, "utf8"));
  }
  const body = Buffer.concat([...parts, Buffer.from([0])]);
  const packet = Buffer.alloc(8 + body.length);
  packet.writeInt32BE(8 + body.length, 0);
  packet.writeInt32BE(message.protocol, 4);
  body.copy(packet, 8);
  return packet;
}

/** Read exactly one length-prefixed frontend message. */
function readMessage(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readInt32BE(0);
      if (buffer.length < length) return;
      socket.off("data", onData);
      socket.off("error", onError);
      // Anything past this message belongs to the stream; push it back.
      if (buffer.length > length) socket.unshift(buffer.subarray(length));
      resolve(buffer.subarray(4, length));
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

export async function startPooledEndpoint(
  options: PooledEndpointOptions,
): Promise<PooledEndpoint> {
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());

    void (async () => {
      try {
        let body = await readMessage(client);
        // Decline SSL and GSSAPI so the rehearsal speaks plain protocol to a
        // loopback database, exactly as a local pooler would.
        while (body.length === 4) {
          const code = body.readInt32BE(0);
          if (code !== SSL_REQUEST && code !== GSSENC_REQUEST) break;
          client.write(Buffer.from("N"));
          body = await readMessage(client);
        }

        const startup = parseStartup(body);
        const rewritten: Array<[string, string]> = [];
        let routed = false;
        for (const [key, value] of startup.parameters) {
          if (key !== "user") {
            rewritten.push([key, value]);
            continue;
          }
          const separator = value.indexOf(".");
          if (separator <= 0) {
            rewritten.push([key, value]);
            continue;
          }
          const tenant = value.slice(separator + 1);
          if (tenant !== options.tenantRef) {
            client.destroy();
            return;
          }
          routed = true;
          rewritten.push([key, options.upstreamRole ?? value.slice(0, separator)]);
        }
        void routed;

        const upstream = connect(options.upstreamPort, options.upstreamHost, () => {
          upstream.write(encodeStartup({ protocol: startup.protocol, parameters: rewritten }));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => {
          upstream.destroy();
          client.destroy();
        });
      } catch {
        client.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort, "127.0.0.1", resolve);
  });

  return {
    port: options.listenPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
