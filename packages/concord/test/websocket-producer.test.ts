import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { WebSocketProducer } from "../src/infra/adapters/producers/websocket/websocket-producer";
import { noopLogger } from "../src/domain/ports/out/logger";
import { MakeApp } from "../src/infra/main/make-app";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import { Consumer } from "../src/domain/entities/consumer";
import { StdioRule } from "../src/infra/adapters/consumers/stdio/stdio-rule";
import type { App } from "../src/infra/main/app";
import { FixedClock, RecordingHandler, SequentialIdGenerator, successfulOutcome, waitFor } from "./helpers";

describe("WebSocket producer", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  const openClient = (url: string): Promise<WebSocket> => {
    return new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(url);
      client.once("open", () => resolve(client));
      client.once("error", reject);
    });
  };

  it("emits rawjson events for inbound JSON messages", async () => {
    const handler = new RecordingHandler(successfulOutcome());

    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-02T00:00:00Z")),
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c1", new StdioRule(), handler, [], [])));

    const producer = new WebSocketProducer("127.0.0.1", 0, "ws-producer", noopLogger);
    app.register(producer);
    await app.start();
    const port = producer.address!.port;

    const client = await openClient(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ eventId: "pevt-1", hello: "world" }));

    const run = await waitFor(() => handler.calls[0]);
    const event = run.event;

    expect(event.type).toBe("rawjson");
    expect(event.producerId).toBe("ws-producer");
    expect(event.producerEventId).toBe("pevt-1");
    expect(event.id).toBe("id-1");
    expect(event.datetime.toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(event.payload).toEqual({ eventId: "pevt-1", hello: "world" });

    client.close();
  });

  it("rejects JSON messages without a string eventId field without emitting", async () => {
    const handler = new RecordingHandler(successfulOutcome());

    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-02T00:00:00Z")),
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c1", new StdioRule(), handler, [], [])));

    const producer = new WebSocketProducer("127.0.0.1", 0, "ws-producer", noopLogger);
    app.register(producer);
    await app.start();
    const port = producer.address!.port;

    const client = await openClient(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ hello: "world" }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(handler.calls).toHaveLength(0);

    client.close();
  });

  it("rejects messages that are not valid JSON without emitting or throwing", async () => {
    const handler = new RecordingHandler(successfulOutcome());

    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-02T00:00:00Z")),
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c1", new StdioRule(), handler, [], [])));

    const producer = new WebSocketProducer("127.0.0.1", 0, "ws-producer", noopLogger);
    app.register(producer);
    await app.start();
    const port = producer.address!.port;

    const client = await openClient(`ws://127.0.0.1:${port}`);
    client.send("this is not json");

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(handler.calls).toHaveLength(0);

    client.close();
  });
});
