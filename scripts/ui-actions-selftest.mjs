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
const { sessionApi } = await import("../client/src/api.js");
await sessionApi.reloadPiResources("session-1");
assert.equal(requests.at(-1).path, "/api/sessions/session-1/pi-reload", "Pi reload 调用当前会话资源刷新接口");
console.log("按钮接口接线：5 项通过");
const { createSlashCommands, piSkillsFromPlugins, slashQueryOf } = await import("../client/src/slashCommands.js");
const selectedSkills = [];
const selectedPiSkills = [];
let renameCalls = 0;
let sessionCalls = 0;
let resumeCalls = 0;
let settingsCalls = 0;
let treeCalls = 0;
let modelCalls = 0;
let exportCalls = 0;
let copyCalls = 0;
let reloadCalls = 0;
let newCalls = 0;
const slash = createSlashCommands({
	new() { newCalls++; },
	compact() {},
	plan() {},
	name() { renameCalls++; },
	copy() { copyCalls++; },
	reload() { reloadCalls++; },
	session() { sessionCalls++; },
	resume() { resumeCalls++; },
	settings() { settingsCalls++; },
	export() { exportCalls++; },
	tree() { treeCalls++; },
	model() { modelCalls++; },
	skills: [
		{ id: "sales-analysis", name: "销售数据分析", description: "分析销售数据", active: true },
		{ id: "approval", name: "审批助手", description: "整理审批", active: false },
	],
	skill: (id) => selectedSkills.push(id),
	piSkills: [{ name: "sales-analysis", description: "Analyze sales records" }],
	piSkill: (name) => selectedPiSkills.push(name),
});
assert.ok(slash.some((item) => item.id === "compact") && slash.some((item) => item.id === "plan") && slash.some((item) => item.id === "name") && slash.some((item) => item.id === "session" && item.aliases.includes("stats")) && slash.some((item) => item.id === "resume") && slash.some((item) => item.id === "settings") && slash.some((item) => item.id === "export") && slash.some((item) => item.id === "tree") && slash.some((item) => item.id === "model"), "动态技能不能替换 Pi 命令");
slash.find((item) => item.id === "name").run();
assert.equal(renameCalls, 1, "/name 调用注入的重命名动作");
slash.find((item) => item.id === "session").run();
assert.equal(sessionCalls, 1, "/session 调用注入的 Pi 统计动作，/stats 保持别名");
slash.find((item) => item.id === "resume").run();
slash.find((item) => item.id === "settings").run();
assert.equal(resumeCalls, 1, "/resume 调用会话列表动作");
assert.equal(settingsCalls, 1, "/settings 调用设置页动作");
slash.find((item) => item.id === "tree").run();
slash.find((item) => item.id === "model").run();
slash.find((item) => item.id === "export").run();
slash.find((item) => item.id === "copy").run();
slash.find((item) => item.id === "reload").run();
slash.find((item) => item.id === "new").run();
assert.equal(treeCalls, 1, "/tree 打开 Pi 会话树");
assert.equal(modelCalls, 1, "/model 打开会话模型选择器");
assert.equal(exportCalls, 1, "/export 调用注入的 Pi 会话导出动作");
assert.equal(copyCalls, 1, "/copy 调用最近回复复制动作");
assert.equal(reloadCalls, 1, "/reload 调用当前 Pi 资源刷新动作");
assert.equal(newCalls, 1, "/new 调用企业会话创建动作");
assert.ok(slash.some((item) => item.kind === "skill" && item.label === "销售数据分析" && item.hint === "当前技能"), "技能应按技能列表样式显示名称、说明和当前状态");
slash.find((item) => item.id === "skill:approval").run();
slash.find((item) => item.id === "skill:clear").run();
assert.deepEqual(selectedSkills, ["approval", null], "选择技能与退出技能都应调用注入的现有动作");
assert.equal(slashQueryOf("/销售"), "销售", "技能名称可通过斜杠搜索");
const piSkill = slash.find((item) => item.id === "pi-skill:sales-analysis");
assert.ok(piSkill?.kind === "pi-skill" && piSkill.label === "/skill:sales-analysis", "导入的 Pi 技能以原生命令显示在斜杠菜单");
piSkill.run();
assert.deepEqual(selectedPiSkills, ["sales-analysis"], "选择 Pi 技能仅将命令交给 composer 插入逻辑");
assert.deepEqual(piSkillsFromPlugins([
	{ id: "pi-skill-enabled", enabled: true, manifest: { skills: [{ id: "sales-analysis", description: "Analyze" }] } },
	{ id: "pi-skill-disabled", enabled: false, manifest: { skills: [{ id: "disabled", description: "Disabled" }] } },
	{ id: "regular-plugin", enabled: true, manifest: { skills: [{ id: "business", description: "Business" }] } },
]), [{ name: "sales-analysis", description: "Analyze" }], "菜单只包含启用的 Pi SKILL.md 插件，不混入业务技能");
const { lastAssistantText } = await import("../client/src/clipboard.js");
assert.equal(lastAssistantText([
	{ role: "assistant", text: "older answer" },
	{ role: "tool", text: "tool output" },
	{ role: "assistant", text: "latest answer" },
]), "latest answer", "/copy 取最近一条助手回复并跳过工具输出");
assert.equal(lastAssistantText([{ role: "assistant", text: " " }, { role: "user", text: "question" }]), "", "/copy 没有助手正文时返回空值");
assert.ok(slash.some((item) => item.id === "copy"), "/copy 在有注入动作时显示在 Pi 命令目录");
console.log("斜杠技能与 Pi 命令：17 项通过");
const { knowledgeSourcesOf, linkifyKnowledgeSources } = await import("../client/src/knowledgeSources.js");
const citation = "依据 [kb:kb_123 doc:doc_456 chunk:78]，退款需要财务审批。";
assert.deepEqual(knowledgeSourcesOf(`${citation} [kb:kb_123 doc:doc_456 chunk:78]`), [
	{ kbId: "kb_123", docId: "doc_456", chunkId: "78", marker: "[kb:kb_123 doc:doc_456 chunk:78]" },
], "来源标记按库/文档/分块去重解析");
assert.ok(linkifyKnowledgeSources(citation).includes("#/knowledge?kbId=kb_123&docId=doc_456&chunkId=78"), "模型回答中的来源标记转成知识库定位链接");
assert.equal(knowledgeSourcesOf("[kb:bad/id doc:doc_456 chunk:78]").length, 0, "来源标记不接受路径字符");
console.log("知识库来源引用：3 项通过");
