/**
 * 斜杠命令表：**加一条命令只改这里**，不要去改 Chat.vue 的 keydown 分支。
 *
 * 两条约定（与旧前端 web/app.js 的 SLASH_COMMANDS 一致）：
 *  1. `aliases` 里带拼音（"yasuo" / "jihua"），中文用户敲拼音也能命中；
 *  2. 命令是**数据**：面板只负责挑与执行，具体动作由调用方注入（见 createSlashCommands），
 *     否则"一份逻辑两个入口"必然漂移。
 */

/** 只有命令名与文案，不含动作——动作在运行时注入，便于测试与复用。 */
export const SLASH_COMMAND_DEFS = [
	{
		id: "new",
		label: "新建 Pi 会话",
		hint: "创建一条新的企业对话并保留当前会话",
		aliases: ["new", "xin", "新建会话"],
	},
	{
		id: "compact",
		label: "压缩对话",
		hint: "把之前的对话总结成一段摘要，减少上下文占用",
		aliases: ["yasuo", "compact", "suoduan"],
	},
	{
		id: "plan",
		label: "计划模式",
		hint: "先给方案和步骤、等确认再动手；再执行一次可关闭",
		aliases: ["jihua", "plan"],
	},
	{
		id: "mcp",
		label: "MCP 集成",
		hint: "打开 MCP 服务与工具管理",
		aliases: ["mcp", "工具集成"],
	},
	{
		id: "thinking",
		label: "推理强度",
		hint: "循环调整 Pi 推理强度",
		aliases: ["thinking", "tuizhong", "推理"],
	},
	{
		id: "name",
		label: "重命名对话",
		hint: "设置当前 Pi 会话的名称",
		aliases: ["name", "mingming", "重命名"],
	},
	{
		id: "reload",
		label: "刷新 Pi 资源",
		hint: "重新加载已启用的插件技能和当前会话工具快照",
		aliases: ["reload", "shuaxin", "刷新资源"],
	},
	{
		id: "copy",
		label: "复制最近回复",
		hint: "复制 Pi 会话中最近一条助手回复",
		aliases: ["copy", "fuzhi", "复制回复"],
	},
	{
		id: "session",
		label: "会话统计",
		hint: "查看 Pi 汇总的消息、工具调用、token 与费用",
		aliases: ["session", "stats", "tongji", "统计"],
	},
	{
		id: "resume",
		label: "恢复会话",
		hint: "打开会话列表并继续已有会话",
		aliases: ["resume", "huifu", "恢复会话"],
	},
	{
		id: "settings",
		label: "打开设置",
		hint: "前往 Pi 与企业功能设置页面",
		aliases: ["settings", "shezhi", "设置"],
	},
	{
		id: "export",
		label: "导出 Pi 会话",
		hint: "下载当前会话的 Pi JSONL 历史",
		aliases: ["export", "daochu", "导出"],
	},
	{
		id: "export-html",
		label: "导出 Pi 会话 HTML",
		hint: "使用 Pi 原生导出器生成可阅读的会话报告",
		aliases: ["export-html", "html", "网页导出"],
	},
	{
		id: "tree",
		label: "Pi 会话树",
		hint: "查看会话分支、节点标签，并从历史节点继续",
		aliases: ["tree", "huihuashu", "分支"],
	},
	{
		id: "fork",
		label: "从消息分叉",
		hint: "从选中的用户消息之前创建独立 Pi 会话",
		aliases: ["fork", "fencha", "分叉"],
	},
	{
		id: "clone",
		label: "复制当前对话",
		hint: "将当前活动分支复制为一条独立 Pi 会话",
		aliases: ["clone", "fuzhi", "复制"],
	},
	{
		id: "model",
		label: "切换模型",
		hint: "打开当前会话的模型选择器",
		aliases: ["model", "moxing", "模型"],
	},
];

/**
 * 把动作挂到命令表上。
 *
 * `actions` 用 id 作键（compact / plan），缺哪个就跳过哪条——
 * 界面在"没有当前会话"等场景下可以只提供部分命令，不必为了对齐而塞空函数。
 */
export function createSlashCommands(actions = {}) {
	const commands = SLASH_COMMAND_DEFS.filter((def) => typeof actions[def.id] === "function").map((def) => ({
		...def,
		run: actions[def.id],
	}));
	if (typeof actions.skill === "function") {
		for (const skill of actions.skills ?? []) {
			if (!skill?.id || !skill.name) continue;
			commands.push({
				id: `skill:${skill.id}`,
				kind: "skill",
				label: skill.name,
				hint: skill.active ? "当前技能" : skill.description || "加载此技能",
				active: Boolean(skill.active),
				aliases: [skill.name],
				run: () => actions.skill(skill.id),
			});
		}
		if ((actions.skills ?? []).some((skill) => skill?.active)) {
			commands.push({
				id: "skill:clear",
				label: "退出当前技能",
				hint: "回到当前会话的默认流程",
				aliases: ["tuichu", "退出技能"],
				run: () => actions.skill(null),
			});
		}
	}
	if (typeof actions.piSkill === "function") {
		for (const skill of actions.piSkills ?? []) {
			if (!skill?.name) continue;
			commands.push({
				id: `pi-skill:${skill.name}`,
				kind: "pi-skill",
				skillName: skill.name,
				label: `/skill:${skill.name}`,
				hint: skill.description || "Pi 原生技能",
				aliases: [skill.name],
				run: () => actions.piSkill(skill.name),
			});
		}
	}
	return commands;
}

export function piSkillsFromPlugins(plugins = []) {
	return plugins
		.filter((plugin) => plugin?.enabled && String(plugin.id ?? "").startsWith("pi-skill-"))
	.flatMap((plugin) => Array.isArray(plugin.manifest?.skills) ? plugin.manifest.skills : [])
	.filter((skill) => typeof skill?.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id))
	.map((skill) => ({ name: skill.id, description: String(skill.description ?? "") }));
}

/**
 * 输入框内容 → 面板该展示的过滤词。
 *
 * 返回 `null` 表示"不该弹面板"：不是以 / 开头，或已经敲了空格（在写正文）。
 * 把这条判断抽成纯函数，是为了让它可被单测直接断言，不必起浏览器。
 */
export function slashQueryOf(value) {
	const text = String(value ?? "");
	if (!text.startsWith("/")) return null;
	const rest = text.slice(1);
	if (rest.includes(" ")) return null;
	return rest;
}
