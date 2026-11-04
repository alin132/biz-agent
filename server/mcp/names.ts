/**
 * MCP 工具命名：**唯一真相**。
 *
 * 工具名会直接进 function calling，所以只允许小写字母/数字/下划线：
 *   `mcp_<server 名>_<工具原名>`，例如 `mcp_crm_server_get_weather`。
 *
 * 与 `flowToolName()` 同一套写法（非法字符逐个换成 `_`），区别是这里先转小写：
 * MCP 的工具名来自外部系统，大小写混用会让模型在"该调哪个"上犯错。
 * 中文/空格/连字符都会被换成下划线（不是删除），保证"不同原名 → 不同名字"的直觉。
 */

export const MCP_TOOL_PREFIX = "mcp_";

/** 一段名字 → 工具名片段：小写 + 非 `[a-z0-9_]` 逐个换下划线（可能是连续下划线，不去重）。 */
export function mcpSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** `("CRM Server", "Get-Weather")` → `"mcp_crm_server_get_weather"`。 */
export function mcpToolName(serverName: string, toolName: string): string {
	return `${MCP_TOOL_PREFIX}${mcpSlug(serverName)}_${mcpSlug(toolName)}`;
}

/** 是不是 MCP 工具名（会话层用它把 MCP 工具并入初始工具集，别在别处手拼前缀）。 */
export function isMcpToolName(toolName: string): boolean {
	return toolName.startsWith(MCP_TOOL_PREFIX);
}
