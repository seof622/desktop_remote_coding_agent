import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "../src/dashboard.js";

// Execute the shipped inline script so browser request ordering is exercised.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  value = "";
  disabled = false;
  onclick?: () => unknown;
  append(...items: Element[]) { this.children.push(...items); }
  prepend(item: Element) { this.children.unshift(item); }
  replaceChildren() { this.children = []; this.textContent = ""; }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
interface MockApproval { id: string; sessionId: string; runId: string; type: string; status: string; display: Record<string, unknown>; availableDecisions: string[] }
const pending = (id = "apr_one", sessionId = "ses_one"): MockApproval => ({
  id, sessionId, runId: "run_one", type: "command", status: "Pending",
  display: { command: "<img src=x onerror=alert(1)>", cwd: "src", reason: "test" },
  availableDecisions: ["accept", "decline", "unknown"],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: { path: string; options: { body?: string } }[] = [];
  let approvals = [pending()];
  let handler: ((path: string) => Promise<unknown> | undefined) | undefined;
  class Socket {
    static all: Socket[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (message: { data: string }) => void;
    constructor(public url: string) { Socket.all.push(this); }
    close() {} // Old callbacks can arrive after replacement.
    event(type: string, sequence = 1, sessionId = "ses_one") {
      this.onmessage?.({ data: JSON.stringify({ type, sequence, sessionId, payload: { approvalId: "apr_one" } }) });
    }
  }
  runInNewContext(DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: element, createElement: () => new Element() },
    window: { addEventListener() {} }, location: { protocol: "http:", host: "localhost" },
    WebSocket: Socket, URLSearchParams, btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    fetch: async (path: string, options: { body?: string }) => {
      requests.push({ path, options });
      const custom = handler?.(path);
      const body = custom ? await custom : path.startsWith("/approvals?") ? approvals
        : path === "/sessions" ? [{ id: "ses_one", status: "Active" }, { id: "ses_two", status: "Active" }]
        : path === "/health" ? { status: "Idle" } : [];
      return { ok: true, json: async () => body };
    },
  });
  return {
    element, requests, Socket,
    setApprovals: (items: typeof approvals) => { approvals = items; },
    setHandler: (value: typeof handler) => { handler = value; },
    connect: async () => { element("token").value = "test-only-token"; await element("connect").onclick!(); },
    buttons: () => element("approvals").children[0]?.children[3].children || [],
  };
}

describe("dashboard approvals", () => {
  it("shows permission access modes and network requests as text without inventing decisions", async () => {
    const h = harness(); h.setApprovals([{ ...pending(), type: "permission", availableDecisions: [], display: {
      type: "permission", networkEnabled: true, filesystemEntries: ["읽기: src", "쓰기: <outside-workspace>"],
    } }]); await h.connect();
    const text = h.element("approvals").children[0].children[2];
    expect(text.textContent).toContain("네트워크: 접근 요청");
    expect(text.textContent).toContain("파일 권한: 읽기: src");
    expect(text.textContent).toContain("파일 권한: 쓰기: <outside-workspace>");
    expect(text.children).toHaveLength(0);
    expect(h.buttons()).toHaveLength(0);
  });
  it("renders server display as text and submits one allowed decision despite repeated clicks", async () => {
    const h = harness(); await h.connect();
    const card = h.element("approvals").children[0];
    expect(card.children[2].textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.children[2].children).toHaveLength(0);
    expect(h.buttons().map((button) => button.textContent)).toEqual(["이번 요청 승인", "거절"]);
    const decision = deferred<unknown>();
    h.setHandler((path) => path.endsWith("/decision") ? decision.promise : undefined);
    const button = h.buttons()[0];
    const first = button.onclick!(); await button.onclick!();
    expect(h.buttons().every((item) => item.disabled)).toBe(true);
    expect(h.requests.filter((item) => item.path.endsWith("/decision"))).toHaveLength(1);
    expect(h.requests.at(-1)?.options.body).toBe('{"decision":"accept"}');
    h.setApprovals([]); decision.resolve({ status: "Accepted" }); await first;
    expect(h.element("approvals").children).toHaveLength(0);
  });

  it("uses current Pending state for historical replay and restores requests on reconnect", async () => {
    const h = harness(); await h.connect();
    h.setApprovals([]); h.Socket.all[0].event("approval.requested"); await tick();
    expect(h.element("approvals").children).toHaveLength(0);
    h.setApprovals([pending()]); h.Socket.all[0].onopen!(); await tick();
    expect(h.element("approvals").children).toHaveLength(1);
    h.setApprovals([]); h.Socket.all[0].event("approval.resolved", 2); await tick();
    expect(h.element("approvals").children).toHaveLength(0);
  });

  it("ignores late snapshots and socket callbacks after Session changes or Token removal", async () => {
    const h = harness(); await h.connect();
    const old = h.Socket.all[0];
    const late = deferred<unknown>();
    h.setHandler((path) => path.startsWith("/approvals?") ? late.promise : undefined);
    old.event("approval.requested");
    h.element("sessions").children[1].onclick!();
    h.setHandler(undefined); h.setApprovals([pending("apr_two", "ses_two")]);
    h.Socket.all[1].onopen!(); await tick();
    late.resolve([pending()]); await tick();
    expect(h.element("approvals").children[0].children[1].textContent).toContain("ses_two");
    const count = h.requests.length; old.event("approval.requested"); await tick();
    expect(h.requests).toHaveLength(count);
    h.element("clear-token").onclick!(); h.Socket.all[1].event("approval.requested"); await tick();
    expect(h.element("approvals").children).toHaveLength(0);
    expect(h.requests).toHaveLength(count);
  });

  it("does not retry failed decisions and locks cards when state recovery fails", async () => {
    const h = harness(); await h.connect();
    h.setHandler((path) => path.startsWith("/approvals") ? Promise.reject(new Error("offline")) : undefined);
    await h.buttons()[0].onclick!();
    expect(h.buttons().every((button) => button.disabled)).toBe(true);
    expect(h.element("approval-status").textContent).toContain("자동 재전송하지 않았습니다");
    expect(h.requests.filter((item) => item.path.endsWith("/decision"))).toHaveLength(1);
    h.setHandler(undefined); await h.element("refresh").onclick!();
    expect(h.buttons().every((button) => !button.disabled)).toBe(true);
  });

  it("rejects an older snapshot after a newer resolution refresh", async () => {
    const h = harness(); await h.connect();
    const late = deferred<unknown>();
    h.setHandler((path) => path.startsWith("/approvals?") ? late.promise : undefined);
    h.Socket.all[0].event("approval.requested");
    h.setHandler(undefined); h.setApprovals([]);
    h.Socket.all[0].event("approval.resolved", 2); await tick();
    late.resolve([pending()]); await tick();
    expect(h.element("approvals").children).toHaveLength(0);
  });

  it("keeps decisions locked when a snapshot arrives after socket disconnection", async () => {
    const h = harness(); await h.connect();
    const late = deferred<unknown>();
    h.setHandler((path) => path.startsWith("/approvals?") ? late.promise : undefined);
    h.Socket.all[0].event("approval.requested"); h.Socket.all[0].onclose!();
    late.resolve([pending()]); await tick();
    expect(h.buttons().every((button) => button.disabled)).toBe(true);
    const count = h.requests.length; h.Socket.all[0].event("approval.requested", 2); await tick();
    expect(h.requests).toHaveLength(count);
  });

  it("does not restore authenticated data when Token is cleared during refresh", async () => {
    const h = harness(); await h.connect();
    const late = deferred<unknown>();
    h.setHandler((path) => path === "/sessions" ? late.promise : undefined);
    const refreshing = h.element("refresh").onclick!();
    h.element("clear-token").onclick!();
    late.resolve([{ id: "ses_one", status: "Active" }]); await refreshing;
    expect(h.element("sessions").children).toHaveLength(0);
    expect(h.element("approvals").children).toHaveLength(0);
    expect(h.Socket.all).toHaveLength(1);
  });
});
