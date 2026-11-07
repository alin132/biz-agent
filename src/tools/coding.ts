/**
 * 编码 Agent 的工具集：读 / 写 / 列目录 / 搜索 / shell / git。
 *
 * 与业务工具（工单、审批、数据）的区别只有一个：这些工具**直接动磁盘**。
 * 所以三条边界必须写死，不能靠提示词自觉：
 *  1. 所有路径都锁在工作目录内——`..` 和绝对路径绕不出去（见 `resolveInside`）；
 *  2. 写文件、执行命令是 `high` 风险，走平台的审批钩子，人点了才执行；
 *  3. 输出一律截断并标明，别让一次 `ls` 撑爆模型上下文。
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolDef, ToolResult } from "../core/types.js";

const run = promisify(exec);

/** 单次工具结果的最大字符数：超了截断并如实标注，别让模型以为就是全部。 */
const MAX_OUTPUT = 20000;
/** shell 单次执行超时：卡死的命令不能拖死整个会话。 */
const SHELL_TIMEOUT_MS = 120000;

function clip(text: string, limit = MAX_OUTPUT): ToolResult {
	if (text.length <= limit) return { content: text };
	return {
		content: `${text.slice(0, limit)}\n\n[输出被截断：共 ${text.length} 字符，只显示前 ${limit} 字符]`,
	};
}

/**
 * 把用户给的相对路径锁进工作目录。
 *
 * 这是安全边界不是方便函数：模型可能被诱导写 `../../etc/passwd` 或绝对路径，
 * 一旦越界就直接报错，绝不"尽量满足"。
 */
function resolveInside(root: string, input: unknown): string {
	const raw = typeof input === "string" && input.trim() ? input.trim() : ".";
	// 绝对路径一律按"相对工作目录"重新解释，避免直接指向系统目录
	const target = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
	const base = resolve(root);
	const rel = relative(base, target);
	if (rel.startsWith("..") || (rel !== "" && rel.split(sep)[0] === "..")) {
		throw new Error(`路径越界：${raw} 不在工作目录 ${base} 内`);
	}
	return target;
}

/** 统一的正则安全编译：模型给的非法正则不该让工具崩掉。 */
function safeRegExp(pattern: string, flags = "i"): RegExp {
	try {
		return new RegExp(pattern, flags);
	} catch (error) {
		throw new Error(`正则表达式无效：${pattern}（${error instanceof Error ? error.message : String(error)}）`);
	}
}

function asString(args: Record<string, unknown>, key: string, fallback = ""): string {
	const value = args[key];
	return typeof value === "string" ? value : fallback;
}

/**
 * 创建编码工具集。
 *
 * @param root 工作目录（绝对路径）。所有文件操作都被锁在这里面。
 */
export function createCodingTools(root: string): ToolDef[] {
	const base = resolve(root);

	const readFileTool: ToolDef = {
		name: "fs_read",
		description: "读取工作目录内某个文件的全部内容（文本）。大文件请配合 fs_grep 定位后再读。",
		category: "编码",
		risk: "low",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "相对工作目录的文件路径" },
			},
			required: ["path"],
		},
		example: { path: "package.json" },
		execute: async (args) => {
			try {
				const target = resolveInside(base, args.path);
				const content = await readFile(target, "utf8");
				return clip(content);
			} catch (error) {
				return { content: `读取失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const writeFileTool: ToolDef = {
		name: "fs_write",
		description: "写入（覆盖或新建）工作目录内的文件。目录不存在会自动创建。这是高风险操作，需要人工审批。",
		category: "编码",
		// 高风险：写磁盘会真的改用户的仓库，必须走审批
		risk: "high",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "相对工作目录的文件路径" },
				content: { type: "string", description: "完整的新文件内容（覆盖写，不是追加）" },
			},
			required: ["path", "content"],
		},
		example: { path: "scratch/hello.txt", content: "hello" },
		execute: async (args) => {
			try {
				const target = resolveInside(base, args.path);
				await mkdir(dirname(target), { recursive: true });
				const existed = existsSync(target);
				const content = asString(args, "content");
				await writeFile(target, content, "utf8");
				return {
					content: `${existed ? "已覆盖" : "已创建"} ${relative(base, target)}（${content.length} 字符）`,
				};
			} catch (error) {
				return { content: `写入失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const listTool: ToolDef = {
		name: "fs_list",
		description: "列出工作目录内某个目录的直接子项（不递归），标出目录与文件。",
		category: "编码",
		risk: "low",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "相对工作目录的目录路径，缺省为工作目录根" },
			},
		},
		example: { path: "." },
		execute: async (args) => {
			try {
				const target = resolveInside(base, args.path ?? ".");
				const entries = await readdir(target, { withFileTypes: true });
				if (entries.length === 0) return { content: "（空目录）" };
				const lines = entries
					.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
				return clip(lines.join("\n"));
			} catch (error) {
				return { content: `列目录失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const grepTool: ToolDef = {
		name: "fs_grep",
		description: "在工作目录内按正则搜索文件内容，返回命中的文件、行号与该行文本。用于定位代码，比逐个读文件快得多。",
		category: "编码",
		risk: "low",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "正则表达式（不区分大小写）" },
				path: { type: "string", description: "限定搜索的子目录，缺省为工作目录根" },
			},
			required: ["pattern"],
		},
		example: { pattern: "createTools", path: "src" },
		execute: async (args) => {
			try {
				const re = safeRegExp(asString(args, "pattern"));
				const scope = resolveInside(base, args.path ?? ".");
				const hits: string[] = [];
				const skip = new Set(["node_modules", ".git", "dist", "data", "client\\dist"]);

				async function walk(dir: string): Promise<void> {
					if (hits.length >= 200) return;
					let entries;
					try {
						entries = await readdir(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of entries) {
						if (hits.length >= 200) return;
						if (skip.has(entry.name)) continue;
						const full = join(dir, entry.name);
						if (entry.isDirectory()) {
							await walk(full);
							continue;
						}
						const info = await stat(full).catch(() => null);
						// 跳过二进制/超大文件：读进来也没用，还慢
						if (!info || info.size > 512 * 1024) continue;
						const text = await readFile(full, "utf8").catch(() => "");
						if (!text) continue;
						const rows = text.split("\n");
						for (let i = 0; i < rows.length; i += 1) {
							if (re.test(rows[i]!)) {
								hits.push(`${relative(base, full)}:${i + 1}: ${rows[i]!.trim().slice(0, 200)}`);
								if (hits.length >= 200) break;
							}
						}
					}
				}

				await walk(scope);
				if (hits.length === 0) return { content: `没有匹配「${asString(args, "pattern")}」的内容` };
				return clip(hits.join("\n"));
			} catch (error) {
				return { content: `搜索失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const globTool: ToolDef = {
		name: "fs_glob",
		description: "按文件名模式查找文件（支持 * 与 **），返回相对路径列表。",
		category: "编码",
		risk: "low",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "文件名模式，例如 **/*.test.ts" },
			},
			required: ["pattern"],
		},
		example: { pattern: "**/*.ts" },
		execute: async (args) => {
			try {
				const pattern = asString(args, "pattern") || "**/*";
				// 把 glob 转成正则：** 跨目录、* 不跨目录、? 单字符
				const source = pattern
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*\*\//g, "\u0001")
					.replace(/\*\*/g, "\u0001")
					.replace(/\*/g, "[^/\\\\]*")
					.replace(/\?/g, "[^/\\\\]")
					.replace(/\u0001/g, "(?:.*/)?")
					.replace(/^\.\//, "");
				const re = new RegExp(`^${source}$`);
				const skip = new Set(["node_modules", ".git", "dist", "data"]);
				const found: string[] = [];

				async function walk(dir: string): Promise<void> {
					if (found.length >= 300) return;
					const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
					for (const entry of entries) {
						if (found.length >= 300) return;
						if (skip.has(entry.name)) continue;
						const full = join(dir, entry.name);
						if (entry.isDirectory()) {
							await walk(full);
							continue;
						}
						const rel = relative(base, full).split(sep).join("/");
						if (re.test(rel)) found.push(rel);
					}
				}

				await walk(base);
				if (found.length === 0) return { content: `没有匹配「${pattern}」的文件` };
				return clip(found.sort().join("\n"));
			} catch (error) {
				return { content: `查找失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const shellTool: ToolDef = {
		name: "shell_run",
		description:
			"在工作目录内执行一条 shell 命令（Windows 用 cmd），返回 stdout / stderr 与退出码。用于跑测试、构建、git 等。高风险，需要人工审批。",
		category: "编码",
		risk: "high",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "要执行的命令" },
			},
			required: ["command"],
		},
		example: { command: "git status --short" },
		execute: async (args) => {
			const command = asString(args, "command").trim();
			if (!command) return { content: "命令为空", isError: true };
			try {
				const { stdout, stderr } = await run(command, {
					cwd: base,
					timeout: SHELL_TIMEOUT_MS,
					maxBuffer: 8 * 1024 * 1024,
					windowsHide: true,
				});
				const parts = [];
				if (stdout.trim()) parts.push(stdout.trim());
				if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
				return clip(parts.join("\n") || "（命令没有输出，退出码 0）");
			} catch (error) {
				const e = error as { stdout?: string; stderr?: string; code?: number; message?: string; killed?: boolean };
				if (e.killed) {
					return { content: `命令超时（${SHELL_TIMEOUT_MS}ms）被终止：${command}`, isError: true };
				}
				const parts = [`退出码 ${e.code ?? "未知"}`];
				if (e.stdout?.trim()) parts.push(e.stdout.trim());
				if (e.stderr?.trim()) parts.push(`[stderr]\n${e.stderr.trim()}`);
				if (parts.length === 1) parts.push(e.message ?? "");
				return clip(parts.join("\n"));
			}
		},
	};

	const gitStatusTool: ToolDef = {
		name: "git_status",
		description: "查看当前仓库状态（分支、已暂存/未暂存/未跟踪的文件）。只读。",
		category: "编码",
		risk: "low",
		parameters: { type: "object", properties: {} },
		example: {},
		execute: async () => {
			try {
				const { stdout } = await run("git status --short --branch", { cwd: base, timeout: 30000, windowsHide: true });
				return clip(stdout.trim() || "（工作区干净）");
			} catch (error) {
				return { content: `git status 失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const gitDiffTool: ToolDef = {
		name: "git_diff",
		description: "查看未提交的改动（工作区 + 暂存区）。用于改完代码后自查。只读。",
		category: "编码",
		risk: "low",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "限定某个文件的 diff，缺省为全部" },
				staged: { type: "boolean", description: "true = 看已暂存的改动" },
			},
		},
		example: {},
		execute: async (args) => {
			try {
				const parts = args.staged ? ["git", "diff", "--staged"] : ["git", "diff"];
				if (typeof args.path === "string" && args.path.trim()) parts.push("--", args.path.trim());
				const { stdout } = await run(parts.join(" "), { cwd: base, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
				return clip(stdout.trim() || "（没有未提交改动）");
			} catch (error) {
				return { content: `git diff 失败：${error instanceof Error ? error.message : String(error)}`, isError: true };
			}
		},
	};

	const gitCommitTool: ToolDef = {
		name: "git_commit",
		description: "把已暂存的改动提交为一个 commit。命令本身需要人工审批；只提交，不自动 git add、不 push。",
		category: "编码",
		// 高风险：提交会真的写进仓库历史
		risk: "high",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "提交信息（中文，一句话说清改了什么）" } },
			required: ["message"],
		},
		example: { message: "fix: 修正某处逻辑" },
		execute: async (args) => {
			const message = asString(args, "message").trim();
			if (!message) return { content: "提交信息不能为空", isError: true };
			try {
				const { stdout } = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
					cwd: base,
					timeout: 60000,
					windowsHide: true,
				});
				return clip(stdout.trim() || "（提交完成，没有输出）");
			} catch (error) {
				const e = error as { stdout?: string; stderr?: string; message?: string };
				return {
					content: `git commit 失败：${(e.stderr || e.stdout || e.message || "").trim()}`,
					isError: true,
				};
			}
		},
	};

	return [readFileTool, writeFileTool, listTool, grepTool, globTool, shellTool, gitStatusTool, gitDiffTool, gitCommitTool];
}