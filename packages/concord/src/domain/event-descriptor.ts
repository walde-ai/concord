export interface EventDescriptor {
  readonly id: string;
  readonly producerId: string;
  readonly producerEventId: string;
  readonly datetime: Date;
  readonly type: string;
  readonly payload: unknown;
}
