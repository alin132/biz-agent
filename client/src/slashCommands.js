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
];

/**
 * 把动作挂到命令表上。
 *
 * `actions` 用 id 作键（compact / plan），缺哪个就跳过哪条——
 * 界面在"没有当前会话"等场景下可以只提供部分命令，不必为了对齐而塞空函数。
 */
export function createSlashCommands(actions = {}) {
	return SLASH_COMMAND_DEFS.filter((def) => typeof actions[def.id] === "function").map((def) => ({
		...def,
		run: actions[def.id],
	}));
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
