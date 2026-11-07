import assert from "node:assert/strict";
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const requests = [];
globalThis.fetch = async (path, options) => {
	requests.push({ path, ...options, body: options.body ? JSON.parse(options.body) : null });
	return { ok: true, status: 200, text: async () => "{}" };
};
const { approvalsApi, modelsApi, skillsApi, mcpApi, imApi } = await import("../client/src/api.js");
await approvalsApi.decide("session-1", "request-2", true);
assert.deepEqual(requests.at(-1).body, { requestId: "request-2", approved: true }, "审批必须带上对应请求编号与布尔决定");
await modelsApi.setEmbedding("embedding-1");
assert.equal(requests.at(-1).path, "/api/models/embedding");
await skillsApi.update("skill-1", { name: "更新" });
assert.equal(requests.at(-1).method, "PATCH");
await mcpApi.patch("server-1", { enabled: false });
assert.equal(requests.at(-1).method, "PATCH");
await imApi.patch("bot-1", { enabled: false });
assert.equal(requests.at(-1).method, "PATCH");
console.log("按钮接口接线：5 项通过");
