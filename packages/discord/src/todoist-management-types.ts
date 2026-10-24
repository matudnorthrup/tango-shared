import type { z } from "zod";

export interface ManagementClient {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown>;
  sync(args: Record<string, string>): Promise<Record<string, unknown>>;
}

export interface ManagementOperation {
  schema: z.ZodTypeAny;
  readOnly: boolean;
  execute(data: Record<string, unknown>, client: ManagementClient): Promise<unknown>;
}
