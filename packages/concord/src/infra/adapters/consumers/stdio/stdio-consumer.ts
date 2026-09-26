import type { Registrable } from "../../../../domain/ports/in/registrable";
import type { Registration } from "../../../../domain/ports/in/registration";
import { Consumer } from "../../../../domain/entities/consumer";
import { StdioRule } from "./stdio-rule";
import { StdioHandler } from "./stdio-handler";

export class StdioConsumer implements Registrable {
  public constructor(private readonly consumerId: string) {}

  public register(registration: Registration): void {
    registration.addConsumer(
      new Consumer<unknown>(this.consumerId, new StdioRule(), new StdioHandler(), [], []),
    );
  }
}
