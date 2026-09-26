import { describe, it, expect, vi } from "vitest";
import { MakeApp } from "../src/infra/main/make-app";
import { StdioConsumer } from "../src/infra/adapters/consumers/stdio/stdio-consumer";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { Event } from "../src/domain/entities/event";
import { FakeProducer, FixedClock, SequentialIdGenerator } from "./helpers";

describe("stdio consumer", () => {
  it("prints one JSON line per handled event to standard output", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const app = MakeApp({
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-02T00:00:00Z")),
    });

    app.register(new StdioConsumer("stdio-1"));

    const event = new Event<unknown>(
      "evt-1",
      "p-1",
      "pevt-1",
      new Date("2026-07-02T00:00:00Z"),
      "greet",
      { msg: "hi" },
    );
    app.register(new FakeProducer("p-1", [event]));

    await app.start();

    const written = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("greet");
    expect(written).toContain('"msg":"hi"');
    expect(written).toContain("\n");

    writeSpy.mockRestore();
    await app.stop();
  });
});
