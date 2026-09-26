import type { Registration } from "./registration";

export interface Registrable {
  register(registration: Registration): void;
}
