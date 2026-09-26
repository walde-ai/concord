import { WebSocketServer, type RawData } from "ws";
import type { Producer } from "../../../../domain/ports/in/producer";
import type { EventSink } from "../../../../domain/ports/in/event-sink";
import type { Registration } from "../../../../domain/ports/in/registration";
import { Event } from "../../../../domain/entities/event";
import type { IdGenerator } from "../../../../domain/ports/out/id-generator";
import type { Clock } from "../../../../domain/ports/out/clock";
import type { Logger } from "../../../../domain/ports/out/logger";
import { UnexpectedStateError } from "../../../../domain/exceptions/errors";
import { extractRawJsonProducerEventId } from "./raw-json-event-id";

export const RAWJSON = "rawjson";

export interface WebSocketProducerAddress {
  readonly host: string;
  readonly port: number;
}

export class WebSocketProducer implements Producer {
  private server: WebSocketServer | null = null;
  private sink: EventSink | null = null;
  private idGenerator: IdGenerator | null = null;
  private clock: Clock | null = null;

  public constructor(
    private readonly host: string,
    private readonly port: number,
    public readonly producerId: string,
    private readonly logger: Logger,
  ) {}

  public register(registration: Registration): void {
    this.idGenerator = registration.idGenerator;
    this.clock = registration.clock;
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    const idGenerator = this.idGenerator;
    const clock = this.clock;
    if (idGenerator === null) {
      throw new UnexpectedStateError("WebSocketProducer has not been registered");
    } else if (clock === null) {
      throw new UnexpectedStateError("WebSocketProducer has not been registered");
    } else {
      this.sink = sink;
      this.server = new WebSocketServer({ host: this.host, port: this.port });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("listening", () => resolve());
        this.server!.once("error", reject);
      });
      this.server.on("connection", (socket) => {
        socket.on("message", (data) => {
          void this.handleMessage(data, idGenerator, clock);
        });
      });
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.server = null;
    this.sink = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  public get address(): WebSocketProducerAddress | null {
    if (this.server === null) {
      return null;
    }
    const addr = this.server.address();
    if (typeof addr === "string" || addr === null) {
      return null;
    }
    return { host: addr.address, port: addr.port };
  }

  private async handleMessage(
    data: RawData,
    idGenerator: IdGenerator,
    clock: Clock,
  ): Promise<void> {
    if (this.sink === null) {
      return;
    }
    const text = data.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.logger.error("websocket-producer", "rejected unparseable message", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const producerEventId = extractRawJsonProducerEventId(parsed);
    if (producerEventId === null) {
      this.logger.error("websocket-producer", "rejected message without eventId field");
      return;
    }
    const event = new Event<unknown>(
      idGenerator.generate(),
      this.producerId,
      producerEventId,
      clock.now(),
      RAWJSON,
      parsed,
    );
    try {
      await this.sink.emit(event);
    } catch (err) {
      this.logger.error("websocket-producer", "error while emitting event", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
