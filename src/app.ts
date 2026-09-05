import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { GatewayError } from "./errors.js";
import type { GatewayService } from "./gateway.js";
import { validateWorkspacePath } from "./workspace.js";

const projectParams = z.object({ id: z.string().regex(/^prj_[a-f0-9]{32}$/) });
const providerParams = z.object({ id: z.literal("codex") });
const sessionParams = z.object({ sessionId: z.string().regex(/^ses_[a-f0-9]{32}$/) });
const projectBody = z.object({ name: z.string().trim().min(1).max(120), workspacePath: z.string().trim().min(1).max(4096) });
const sessionBody = z.object({ providerId: z.literal("codex"), projectId: z.string().regex(/^prj_[a-f0-9]{32}$/) });
const runBody = z.object({ text: z.string().trim().min(1).max(100_000) });
const eventsQuery = z.object({ sessionId: z.string().regex(/^ses_[a-f0-9]{32}$/).optional(), afterSequence: z.coerce.number().int().min(0).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GatewayError(400, "INVALID_REQUEST", "Request does not match the required format.");
  return result.data;
}

function isAuthorized(request: FastifyRequest, token: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface AppDependencies { config: GatewayConfig; gateway: GatewayService }

export async function buildApp({ config, gateway }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!isAuthorized(request, config.clientToken)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The Gateway could not process this request." } });
  });

  app.get("/health", async () => ({ status: "Online" }));
  app.get("/providers", async () => ([{ providerId: "codex", capabilities: gateway.getCapabilities() }]));
  app.get("/providers/:id/capabilities", async (request) => {
    parse(providerParams, request.params);
    return { providerId: "codex", capabilities: gateway.getCapabilities() };
  });

  app.get("/projects", async () => gateway.listProjects());
  app.post("/projects", async (request, reply) => {
    const body = parse(projectBody, request.body);
    const workspacePath = await validateWorkspacePath(body.workspacePath, config.workspaceRoots);
    const project = gateway.createProject(body.name, workspacePath);
    return reply.code(201).send(project);
  });
  app.get("/projects/:id", async (request) => gateway.getProject(parse(projectParams, request.params).id));

  app.get("/sessions", async () => gateway.listSessions());
  app.post("/sessions", async (request, reply) => {
    const body = parse(sessionBody, request.body);
    const session = await gateway.startSession(body.projectId);
    return reply.code(201).send(session);
  });
  app.get("/sessions/:sessionId", async (request) => gateway.getSession(parse(sessionParams, request.params).sessionId));
  app.post("/sessions/:sessionId/resume", async (request) => gateway.resumeSession(parse(sessionParams, request.params).sessionId));
  app.get("/sessions/:sessionId/events", async (request) => {
    const params = parse(sessionParams, request.params);
    const query = parse(z.object({ afterSequence: z.coerce.number().int().min(0).default(0) }), request.query);
    return gateway.listEvents(params.sessionId, query.afterSequence);
  });
  app.post("/sessions/:sessionId/runs", async (request, reply) => {
    const sessionId = parse(sessionParams, request.params).sessionId;
    const body = parse(runBody, request.body);
    const run = await gateway.startRun(sessionId, body.text);
    return reply.code(201).send(run);
  });
  app.post("/sessions/:sessionId/interrupt", async (request) => gateway.interrupt(parse(sessionParams, request.params).sessionId));

  app.get("/events", { websocket: true }, (connection, request) => {
    const query = parse(eventsQuery, request.query);
    const send = (event: unknown) => {
      if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(event));
    };
    if (query.sessionId) {
      for (const event of gateway.listEvents(query.sessionId, query.afterSequence ?? 0)) send(event);
    }
    const unsubscribe = gateway.events.subscribe((event) => {
      if (!query.sessionId || query.sessionId === event.sessionId) send(event);
    });
    connection.socket.on("close", unsubscribe);
    connection.socket.on("error", unsubscribe);
  });

  return app;
}
