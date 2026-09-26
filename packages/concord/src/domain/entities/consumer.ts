import type { Rule } from "../ports/out/rule";
import type { Handler } from "../ports/out/handler";
import type { ConsumerConfigParameter, ConsumerConfigSecretParameter } from "../component";

export class Consumer<T> {
  public constructor(
    public readonly consumerId: string,
    public readonly rule: Rule<T>,
    public readonly handler: Handler<T>,
    public readonly configSchema: readonly ConsumerConfigParameter[],
    public readonly secretSchema: readonly ConsumerConfigSecretParameter[],
  ) {}
}
