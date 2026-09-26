import type { Registrable } from "../../../domain/ports/in/registrable";
import type { Registration } from "../../../domain/ports/in/registration";
import type { Consumer } from "../../../domain/entities/consumer";

export class ConsumerRegistrable implements Registrable {
  public constructor(private readonly consumer: Consumer<unknown>) {}

  public register(registration: Registration): void {
    registration.addConsumer(this.consumer);
  }
}
