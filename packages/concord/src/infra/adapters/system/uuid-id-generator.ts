import { randomUUID } from "crypto";
import type { IdGenerator } from "../../../domain/ports/out/id-generator";

export class UuidIdGenerator implements IdGenerator {
  public generate(): string {
    return randomUUID();
  }
}
