import { describe, expect, it } from "vitest";
import { gatewayFixtureCaseId } from "../scripts/gateway-fixture.js";

describe("Gateway inference fixture routing", () => {
  it("keeps a late permission response attached to its original case", () => {
    const request = (id: number) => [
      { role: "user", content: [{ type: "input_text", text: `Run the fixture. gateway-fixture-case-${id}` }] },
      { type: "function_call_output", output: "permission request rejected" },
    ];
    expect(gatewayFixtureCaseId(request(2))).toBe("gateway-fixture-case-2");
    expect(gatewayFixtureCaseId(request(1))).toBe("gateway-fixture-case-1");
  });
  it("does not let tool output or assistant text choose another case", () => {
    expect(gatewayFixtureCaseId([
      { role: "user", content: "gateway-fixture-case-1" },
      { role: "assistant", content: "gateway-fixture-case-2" },
      { type: "function_call_output", output: "gateway-fixture-case-3" },
    ])).toBe("gateway-fixture-case-1");
  });
  it("rejects requests missing the current user prompt's fixture identity", () => {
    expect(gatewayFixtureCaseId(undefined)).toBeUndefined();
    expect(gatewayFixtureCaseId([null, { role: "assistant", content: "gateway-fixture-case-1" }])).toBeUndefined();
    expect(gatewayFixtureCaseId([
      { role: "user", content: "gateway-fixture-case-1" }, { role: "user", content: "unrelated prompt" },
    ])).toBeUndefined();
  });
});
