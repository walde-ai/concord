import type { UserDescriptor } from "../../user-descriptor";

export interface CreateUser {
  create(username: string, password: string): Promise<UserDescriptor>;
}
