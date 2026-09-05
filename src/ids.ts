import { randomUUID } from "node:crypto";

export function gatewayId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
