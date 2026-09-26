export interface ProducerDescriptor {
  readonly producerId: string;
  readonly enabled: boolean;
  readonly disableable: boolean;
}

export interface ConsumerConfigParameter {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly defaultValue: string;
}

export type ConsumerConfigValues = Record<string, string>;

export interface ConsumerConfigSecretParameter {
  readonly key: string;
  readonly label: string;
}

export type ConsumerConfigSecrets = Record<string, string>;

export interface ConsumerDescriptor {
  readonly consumerId: string;
  readonly enabled: boolean;
  readonly waitForOffPeak: boolean;
  readonly configParameters: readonly ConsumerConfigParameter[];
  readonly configValues: ConsumerConfigValues;
  readonly secretParameters: readonly ConsumerConfigSecretParameter[];
  readonly secretNames: readonly string[];
}
