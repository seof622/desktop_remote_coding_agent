import { resolve } from "node:path";
import { z } from "zod";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const tailscaleIpv4 = /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

export interface GatewayConfig {
  clientToken: string;
  bindHost: string;
  port: number;
  dataDir: string;
  workspaceRoots: string[];
  codexCommand: string;
  codexArgs: string[];
}

const environmentSchema = z.object({
  GATEWAY_CLIENT_TOKEN: z.string().min(32),
  GATEWAY_BIND_HOST: z.string().optional().default("127.0.0.1"),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  GATEWAY_DATA_DIR: z.string().optional(),
  GATEWAY_WORKSPACE_ROOTS: z.string().optional(),
  CODEX_COMMAND: z.string().optional().default("codex"),
  CODEX_APP_SERVER_ARGS: z.string().optional().default("app-server"),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Gateway configuration is invalid. Set GATEWAY_CLIENT_TOKEN to a value of at least 32 characters.");
  }

  const value = parsed.data;
  if (!loopbackHosts.has(value.GATEWAY_BIND_HOST) && !tailscaleIpv4.test(value.GATEWAY_BIND_HOST)) {
    throw new Error("GATEWAY_BIND_HOST must be loopback or an explicit Tailscale IPv4 address.");
  }

  const separator = process.platform === "win32" ? ";" : ":";
  const workspaceRoots = (value.GATEWAY_WORKSPACE_ROOTS?.split(separator) ?? [process.cwd()])
    .map((root) => resolve(root.trim()))
    .filter(Boolean);
  if (workspaceRoots.length === 0) throw new Error("At least one workspace root is required.");

  return {
    clientToken: value.GATEWAY_CLIENT_TOKEN,
    bindHost: value.GATEWAY_BIND_HOST,
    port: value.GATEWAY_PORT,
    dataDir: resolve(value.GATEWAY_DATA_DIR ?? "data"),
    workspaceRoots,
    codexCommand: value.CODEX_COMMAND,
    codexArgs: value.CODEX_APP_SERVER_ARGS.split(" ").filter(Boolean),
  };
}
