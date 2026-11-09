import type { IncomingMessage, ServerResponse } from "node:http";
import { can, denyMessage } from "../auth/roles.js";
import type { AuthRuntime } from "../auth/service.js";
import type { PluginRecord, Storage, WorkflowRow } from "../db/types.js";
import type { McpRegistry, McpServerDraft } from "../mcp/registry.js";
import type { WorkflowRepo } from "../workflows.js";
import type { SessionHub } from "../session.js";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const PREFIX = "/api/plugins";
const MAX_BODY = 1024 * 1024;
export type PiSkillFile = { path: string; contentBase64: string };
type SkillManifest = { id: string; name: string; systemPrompt: string; description: string; instructions?: string; files?: PiSkillFile[]; steps?: { title: string; hint?: string; via: string[] }[] };
type PluginManifest = { schemaVersion: "biz-agent.plugin.v1"; id: string; name: string; version: string; description?: string; sourceUrl?: string; skills: SkillManifest[]; mcpServers?: Omit<McpServerDraft, "enabled" | "headers" | "env">[] };

export class PluginError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginError(label + " 必须是对象"); return value as Record<string, unknown>; }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new PluginError(label + " 必须是 1 到 " + max + " 个字符"); return value.trim(); }
function safeId(value: unknown, label: string): string { const id = text(value, label, 48); if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new PluginError(label + " 只能使用小写字母、数字、点、下划线和连字符"); return id; }
function parseManifest(raw: unknown): PluginManifest {
 const input = record(raw, "插件清单"); if (input.schemaVersion !== "biz-agent.plugin.v1") throw new PluginError("schemaVersion 必须是 biz-agent.plugin.v1");
 const id = safeId(input.id, "插件 id"), name = text(input.name, "插件名称", 80), version = text(input.version, "插件版本", 40), description = input.description === undefined ? "" : text(input.description, "插件说明", 500);
 if (!Array.isArray(input.skills) || input.skills.length > 50) throw new PluginError("skills 必须是数组，最多 50 项"); const seen = new Set<string>();
 const skills = input.skills.map((value, i) => { const s = record(value, "第 " + (i + 1) + " 个技能"), skillId = safeId(s.id, "技能 id"); for (const key of Object.keys(s)) if (!["id", "name", "systemPrompt", "description", "instructions", "files", "steps"].includes(key)) throw new PluginError("技能清单包含不支持的字段: " + key); if (seen.has(skillId)) throw new PluginError("技能 id 重复: " + skillId); seen.add(skillId); if (s.steps !== undefined && !Array.isArray(s.steps)) throw new PluginError("技能 steps 必须是数组"); const steps = (s.steps ?? []) as unknown[]; if (steps.length > 20) throw new PluginError("每个技能最多 20 步"); const files = validateSkillFiles(s.files); return { id: skillId, name: text(s.name, "技能名称", 40), systemPrompt: text(s.systemPrompt, "技能提示词", 4000), description: text(s.description, "技能说明", 200), ...(s.instructions === undefined ? {} : { instructions: text(s.instructions, "技能正文", 4000) }), ...(files.length ? { files } : {}), steps: steps.map((step, j) => { const x = record(step, "第 " + (j + 1) + " 步"); if (!Array.isArray(x.via) || x.via.length < 1 || x.via.length > 8 || x.via.some((n) => typeof n !== "string")) throw new PluginError("技能步骤 via 必须是 1 到 8 个工具名"); return { title: text(x.title, "步骤标题", 40), hint: x.hint === undefined ? "" : text(x.hint, "步骤提示", 200), via: [...new Set(x.via as string[])] }; }) }; });
 if (input.mcpServers !== undefined && (!Array.isArray(input.mcpServers) || input.mcpServers.length > 20)) throw new PluginError("mcpServers 必须是数组，最多 20 项");
 const mcpServers = ((input.mcpServers ?? []) as unknown[]).map((value, i) => { const s = record(value, "第 " + (i + 1) + " 个 MCP 服务"); if ("headers" in s || "env" in s || "apiKey" in s) throw new PluginError("插件清单不能包含请求头、环境变量或密钥；请在 MCP 页面单独配置"); if (s.transport !== "http" && s.transport !== "sse") throw new PluginError("插件只允许声明 http / sse MCP 服务"); for (const key of Object.keys(s)) if (!["name", "transport", "url"].includes(key)) throw new PluginError("MCP 服务声明包含不支持的字段: " + key); if (typeof s.url !== "string") throw new PluginError("MCP 服务必须填写 url"); let url: URL; try { url = new URL(s.url); } catch { throw new PluginError("MCP 服务 url 格式不正确"); } if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new PluginError("远程 MCP 服务必须使用 HTTPS"); return { name: text(s.name, "MCP 服务名称", 80), transport: s.transport, url: url.toString(), command: null, args: [], enabled: true }; }) as PluginManifest["mcpServers"];
 const sourceUrl = input.sourceUrl === undefined ? undefined : text(input.sourceUrl, "sourceUrl", 1000);
 if (sourceUrl && githubSkillUrls(sourceUrl).sourceUrl !== sourceUrl) throw new PluginError("sourceUrl 必须是标准 GitHub SKILL.md 文件链接");
 for (const key of Object.keys(input)) if (!["schemaVersion", "id", "name", "version", "description", "sourceUrl", "skills", "mcpServers"].includes(key)) throw new PluginError("插件清单包含不支持的字段: " + key);
 return { schemaVersion: "biz-agent.plugin.v1", id, name, version, description, ...(sourceUrl ? { sourceUrl } : {}), skills, mcpServers };
}

const MAX_SKILL_FILES = 40;
const MAX_SKILL_DIRECTORY_ENTRIES = 80;
const MAX_SKILL_DIRECTORY_DEPTH = 10;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;

function validateSkillPath(value: unknown, allowSkillMarkdown = false): string {
 if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new PluginError("技能资源路径必须是相对路径");
 const parts = value.split("/");
 if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw new PluginError("技能资源路径包含不允许的目录或隐藏文件");
	if (!allowSkillMarkdown && parts.at(-1)?.toLowerCase() === "skill.md") throw new PluginError("SKILL.md 由技能正文单独保存，资源列表不能重复包含它");
 return parts.join("/");
}

function validateSkillFiles(input: unknown): PiSkillFile[] {
 if (input === undefined) return [];
 if (!Array.isArray(input) || input.length > MAX_SKILL_FILES) throw new PluginError(`技能资源最多 ${MAX_SKILL_FILES} 个文件`, 413);
 let total = 0;
 const seen = new Set<string>();
 return input.map((value) => {
  const item = record(value, "技能资源");
  for (const key of Object.keys(item)) if (key !== "path" && key !== "contentBase64") throw new PluginError("技能资源包含不支持的字段: " + key);
  const path = validateSkillPath(item.path);
  if (seen.has(path.toLowerCase())) throw new PluginError("技能资源路径重复: " + path);
  seen.add(path.toLowerCase());
  if (typeof item.contentBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.contentBase64)) throw new PluginError("技能资源必须是合法的 base64 文件内容");
  const bytes = Buffer.from(item.contentBase64, "base64");
  if (bytes.length > MAX_SKILL_FILE_BYTES) throw new PluginError("单个技能资源不能超过 512 KB", 413);
  total += bytes.length;
  if (total > MAX_SKILL_TOTAL_BYTES) throw new PluginError("技能资源总大小不能超过 2 MB", 413);
  return { path, contentBase64: bytes.toString("base64") };
 });
}

export function parsePiSkillManifest(markdown: string, sourceUrl?: string, files: PiSkillFile[] = []): PluginManifest {
 let parsed: ReturnType<typeof parseFrontmatter>;
 try { parsed = parseFrontmatter(markdown); } catch { throw new PluginError("Pi 技能的 YAML frontmatter 格式不正确"); }
 const name = parsed.frontmatter.name;
 const description = parsed.frontmatter.description;
 if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 40) {
  throw new PluginError("Pi 技能 name 必须是最多 40 个字符的小写字母、数字和连字符");
 }
 if (typeof description !== "string" || !description.trim() || description.trim().length > 200) {
  throw new PluginError("Pi 技能 description 必须是 1 到 200 个字符");
 }
 const instructions = parsed.body.trim();
 if (!instructions) throw new PluginError("Pi 技能正文不能为空");
 if (instructions.length > 4000) throw new PluginError("Pi 技能正文最多 4000 个字符");
 return {
  schemaVersion: "biz-agent.plugin.v1",
  ...(sourceUrl ? { sourceUrl: githubSkillUrls(sourceUrl).sourceUrl } : {}),
  id: `pi-skill-${name}`,
  name: `Pi 技能：${name}`,
  version: "1.0.0",
  description: description.trim(),
  skills: [{
   id: name,
   name,
   systemPrompt: "遵循已加载的 Pi 技能指导书，根据需要调用当前会话中可用的业务工具。",
   description: description.trim(),
    instructions,
    ...(files.length ? { files: validateSkillFiles(files) } : {}),
   steps: [],
  }],
 };
}

const MAX_GITHUB_SKILL_BYTES = 64 * 1024;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function githubSkillUrls(value: string): { sourceUrl: string; rawUrl: string; apiUrl: string; skillPath: string } {
	if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(value)) throw new PluginError("GitHub 技能文件路径格式不正确");
 let url: URL;
 try { url = new URL(value); } catch { throw new PluginError("请输入有效的 GitHub SKILL.md 文件链接"); }
 if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new PluginError("GitHub 技能链接必须使用不带参数的 HTTPS 地址");
 let parts: string[];
 try { parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); } catch { throw new PluginError("GitHub 技能文件路径编码不正确"); }
 let owner: string, repo: string, ref: string, skillPath: string, sourceKind: "blob" | "tree";
 if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
  [owner, repo, ref] = parts;
  sourceKind = "blob";
  const fileParts = parts.slice(3);
  if (fileParts.at(-1)?.toLowerCase() !== "skill.md") throw new PluginError("只允许导入文件名为 SKILL.md 的 Pi 技能");
  skillPath = fileParts.slice(0, -1).join("/");
 } else if (url.hostname === "github.com" && parts.length >= 5 && parts[2] === "blob") {
  [owner, repo] = parts;
  ref = parts[3]!;
  sourceKind = "blob";
  const fileParts = parts.slice(4);
  if (fileParts.at(-1)?.toLowerCase() !== "skill.md") throw new PluginError("只允许导入文件名为 SKILL.md 的 Pi 技能");
  skillPath = fileParts.slice(0, -1).join("/");
 } else if (url.hostname === "github.com" && parts.length >= 4 && parts[2] === "tree") {
  [owner, repo] = parts;
  ref = parts[3]!;
  sourceKind = "tree";
  skillPath = parts.slice(4).join("/");
 } else {
  throw new PluginError("只支持 GitHub 的 SKILL.md 文件页或技能目录链接");
 }
 if (!owner || !repo || !ref || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_.-]+$/.test(ref) || (skillPath && skillPath.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")))) {
  throw new PluginError("GitHub 技能文件路径格式不正确");
 }
 const encodedPath = skillPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
 const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedPath ? `/${encodedPath}` : ""}?ref=${encodeURIComponent(ref)}`;
 const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}${encodedPath ? `/${encodedPath}` : ""}/SKILL.md`;
 const sourceUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sourceKind}/${encodeURIComponent(ref)}${encodedPath ? `/${encodedPath}${sourceKind === "blob" ? "/SKILL.md" : ""}` : sourceKind === "blob" ? "/SKILL.md" : ""}`;
 return { sourceUrl, rawUrl, apiUrl, skillPath };
}

function isGitHubContentsUrl(value: string, owner: string, repo: string, path: string): boolean {
 try {
  const url = new URL(value);
  const expectedPath = `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  return url.protocol === "https:" && url.hostname === "api.github.com" && !url.username && !url.password && !url.port && url.pathname === expectedPath;
 } catch { return false; }
}

export async function fetchGitHubPiSkill(value: string, fetchLike: FetchLike = fetch): Promise<{ markdown: string; sourceUrl: string; files: PiSkillFile[] }> {
 const { apiUrl, sourceUrl, skillPath } = githubSkillUrls(value);
 const parsedApiUrl = new URL(apiUrl);
 const owner = decodeURIComponent(parsedApiUrl.pathname.split("/")[2] ?? "");
 const repo = decodeURIComponent(parsedApiUrl.pathname.split("/")[3] ?? "");
 const deadline = AbortSignal.timeout(10_000);
 const requestJson = async (requestUrl: string, maxResponseBytes = 128 * 1024): Promise<unknown> => {
  let response: Response;
  try { response = await fetchLike(requestUrl, { signal: deadline, redirect: "error", headers: { Accept: "application/vnd.github+json" } }); }
  catch (error) { throw new PluginError(`读取 GitHub 技能失败：${error instanceof Error ? error.message : String(error)}`, 502); }
  if (!response.ok) throw new PluginError(`GitHub 返回 ${response.status}，无法读取技能资源`, 502);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxResponseBytes) throw new PluginError("GitHub 技能响应超出大小限制", 413);
  const body = await response.text();
  if (Buffer.byteLength(body) > maxResponseBytes) throw new PluginError("GitHub 技能响应超出大小限制", 413);
  try { return JSON.parse(body) as unknown; } catch { throw new PluginError("GitHub 技能目录返回了无效 JSON", 502); }
 };
 const files: PiSkillFile[] = [];
 let totalBytes = 0;
 let totalEntries = 0;
 let markdown = "";
 const rootPrefix = skillPath ? `${skillPath}/` : "";
 const walk = async (directoryUrl: string, prefix: string): Promise<void> => {
  if (prefix.split("/").filter(Boolean).length > MAX_SKILL_DIRECTORY_DEPTH) throw new PluginError("Pi 技能目录嵌套不能超过 10 层", 413);
  const listing = await requestJson(directoryUrl);
  if (!Array.isArray(listing)) throw new PluginError("GitHub 技能目录不是文件列表", 502);
  totalEntries += listing.length;
  if (totalEntries > MAX_SKILL_DIRECTORY_ENTRIES) throw new PluginError("Pi 技能目录项不能超过 80 个", 413);
  for (const rawEntry of listing) {
   const entry = record(rawEntry, "GitHub 技能目录项");
   if (typeof entry.path !== "string" || typeof entry.name !== "string" || typeof entry.type !== "string") throw new PluginError("GitHub 技能目录项缺少路径或类型", 502);
			const fullPath = validateSkillPath(entry.path, true);
			const expectedPrefix = prefix ? `${rootPrefix}${prefix}/` : rootPrefix;
			if (expectedPrefix && !fullPath.startsWith(expectedPrefix)) throw new PluginError("GitHub 返回了技能目录之外的路径", 502);
   const relativePath = fullPath.slice(rootPrefix.length);
   if (entry.type === "dir") {
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!isGitHubContentsUrl(url, owner, repo, fullPath)) throw new PluginError("GitHub 技能子目录 URL 不安全", 502);
    const ref = new URL(apiUrl).searchParams.get("ref")!;
    await walk(`${url}${url.includes("?") ? "&" : "?"}ref=${encodeURIComponent(ref)}`, relativePath);
    continue;
   }
   if (entry.type !== "file") throw new PluginError("Pi 技能目录不能包含符号链接或子模块", 400);
   if (files.length >= MAX_SKILL_FILES) throw new PluginError(`Pi 技能资源最多 ${MAX_SKILL_FILES} 个文件`, 413);
   const size = Number(entry.size);
   if (!Number.isFinite(size) || size < 0 || size > MAX_SKILL_FILE_BYTES) throw new PluginError("单个 Pi 技能资源不能超过 512 KB", 413);
   totalBytes += size;
   if (totalBytes > MAX_SKILL_TOTAL_BYTES + MAX_GITHUB_SKILL_BYTES) throw new PluginError("Pi 技能目录总大小不能超过 2 MB", 413);
   const fileUrl = typeof entry.url === "string" ? entry.url : "";
   if (!isGitHubContentsUrl(fileUrl, owner, repo, fullPath)) throw new PluginError("GitHub 技能文件 URL 不安全", 502);
   const payload = record(await requestJson(fileUrl, 700 * 1024), "GitHub 技能文件");
   if (payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") throw new PluginError("GitHub 未返回 base64 文件内容", 502);
   const contentBase64 = payload.content.replace(/\s/g, "");
   if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) throw new PluginError("GitHub 文件内容不是合法 base64", 502);
   const bytes = Buffer.from(contentBase64, "base64");
   if (bytes.length !== size) throw new PluginError("GitHub 文件大小与目录记录不一致", 502);
   if (entry.name.toLowerCase() === "skill.md" && prefix === "") {
    if (bytes.length > MAX_GITHUB_SKILL_BYTES) throw new PluginError("Pi 技能文件不能超过 64 KB", 413);
    markdown = bytes.toString("utf8");
   } else {
    files.push({ path: relativePath, contentBase64: bytes.toString("base64") });
   }
  }
 };
 await walk(apiUrl, "");
 if (!markdown) throw new PluginError("所选 GitHub 目录中没有 SKILL.md", 400);
 return { markdown, sourceUrl, files: validateSkillFiles(files) };
}

export class PluginService {
 constructor(private readonly storage: Storage, private readonly repo: WorkflowRepo, private readonly mcp: McpRegistry, private readonly hub: SessionHub) {}
 list(): (PluginRecord & { skills: string[]; tools: string[]; sourceUrl?: string })[] { return this.storage.listPlugins().map((p) => this.view(p)); }
 private view(p: PluginRecord) { const m = p.manifest as unknown as PluginManifest; return { ...p, skills: m.skills.map((s) => s.name), tools: m.mcpServers?.map((s) => s.name) ?? [], ...(m.sourceUrl ? { sourceUrl: m.sourceUrl } : {}) }; }
 async import(raw: unknown): Promise<PluginRecord & { skills: string[]; tools: string[] }> {
  const manifest = parseManifest(raw); if (manifest.skills.length + this.storage.listWorkflows().filter((row) => !row.pluginId).length > 50) throw new PluginError("本地技能数量已达上限，无法安装更多插件技能"); if (this.storage.getPlugin(manifest.id)) throw new PluginError("插件已安装: " + manifest.id, 409); const now = Date.now();
  const p: PluginRecord = { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description ?? "", manifest: manifest as unknown as Record<string, unknown>, enabled: true, createdAt: now, updatedAt: now }; this.storage.createPlugin(p);
  try { for (const server of manifest.mcpServers ?? []) { await this.mcp.create({ ...server, name: "plugin:" + manifest.id + ":" + server.name, headers: {}, env: {}, enabled: true }); }
   for (const skill of manifest.skills) { const row: WorkflowRow = { id: "plugin-" + manifest.id + "-" + skill.id, pluginId: manifest.id, name: skill.name, systemPrompt: skill.systemPrompt, steps: skill.steps!.map((step, i) => ({ id: "step-" + (i + 1), title: step.title, via: step.via, hint: step.hint ?? "" })), skill: { description: skill.description, ...(skill.instructions ? { instructions: skill.instructions } : {}) }, createdAt: now, updatedAt: now }; this.storage.saveWorkflow(row); }
   this.repo.refresh(); return this.view(p);
  } catch (error) { await this.removeContributions(p); this.storage.removePlugin(p.id); this.repo.refresh(); throw error; }
 }
 async importPiSkill(markdown: string): Promise<PluginRecord & { skills: string[]; tools: string[] }> {
  return this.import(parsePiSkillManifest(markdown));
 }
 async importGitHubPiSkill(url: string): Promise<PluginRecord & { skills: string[]; tools: string[]; sourceUrl?: string }> {
  const fetched = await fetchGitHubPiSkill(url);
  return this.import(parsePiSkillManifest(fetched.markdown, fetched.sourceUrl, fetched.files));
 }
 async setEnabled(id: string, enabled: boolean): Promise<PluginRecord & { skills: string[]; tools: string[] }> { const p = this.storage.getPlugin(id); if (!p) throw new PluginError("插件不存在", 404); const next = this.storage.updatePlugin(id, { enabled, updatedAt: Date.now() })!; if (!enabled) for (const w of this.storage.listWorkflows().filter((x) => x.pluginId === id)) this.hub.detachSkill(w.id); for (const s of this.mcp.listServers().filter((x) => x.name.startsWith("plugin:" + id + ":"))) await this.mcp.update(s.id, { enabled }); this.repo.refresh(); return this.view(next); }
 async remove(id: string): Promise<boolean> { const p = this.storage.getPlugin(id); if (!p) return false; await this.removeContributions(p); this.storage.removePlugin(id); this.repo.refresh(); return true; }
 private async removeContributions(p: PluginRecord): Promise<void> { for (const w of this.storage.listWorkflows().filter((x) => x.pluginId === p.id)) { this.hub.detachSkill(w.id); this.storage.removeWorkflow(w.id); } for (const s of this.mcp.listServers().filter((x) => x.name.startsWith("plugin:" + p.id + ":"))) await this.mcp.remove(s.id); }
}
function sendJson(res: ServerResponse, status: number, body: unknown): void { const payload = JSON.stringify(body); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) }); res.end(payload); }
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const part of req) { size += (part as Buffer).length; if (size > MAX_BODY) throw new PluginError("请求体超过 1 MB", 413); chunks.push(part as Buffer); } try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "请求体"); } catch (error) { if (error instanceof PluginError) throw error; throw new PluginError("请求体不是合法 JSON"); } }
export async function handlePluginRoute(req: IncomingMessage, res: ServerResponse, url: URL, service: PluginService, auth: AuthRuntime): Promise<boolean> {
 if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) return false; const method = req.method ?? "GET", user = auth.userOf(req) ?? auth.authenticate(req); if (!user) { sendJson(res, 401, { error: "未登录或登录已过期" }); return true; } const permission = method === "GET" ? "workflow.read" : "workflow.write"; if (!can(user.role, permission)) { sendJson(res, 403, { error: denyMessage(user.role, permission) }); return true; }
 try { if (url.pathname === PREFIX && method === "GET") { sendJson(res, 200, { items: service.list() }); return true; } if (url.pathname === PREFIX + "/import" && method === "POST") { const body = await readBody(req); sendJson(res, 201, await service.import(body.manifest)); return true; } if (url.pathname === PREFIX + "/import-pi-skill" && method === "POST") { const body = await readBody(req); if (typeof body.markdown !== "string") throw new PluginError("markdown 必须是字符串"); sendJson(res, 201, await service.importPiSkill(body.markdown)); return true; } if (url.pathname === PREFIX + "/import-github-skill" && method === "POST") { const body = await readBody(req); if (typeof body.url !== "string") throw new PluginError("url 必须是字符串"); sendJson(res, 201, await service.importGitHubPiSkill(body.url)); return true; } const match = /^\/api\/plugins\/([^/]+)$/.exec(url.pathname); if (match && method === "PATCH") { const body = await readBody(req); if (typeof body.enabled !== "boolean") throw new PluginError("enabled 必须是布尔值"); sendJson(res, 200, await service.setEnabled(decodeURIComponent(match[1]!), body.enabled)); return true; } if (match && method === "DELETE") { const removed = await service.remove(decodeURIComponent(match[1]!)); sendJson(res, removed ? 200 : 404, { removed }); return true; } sendJson(res, 405, { error: "不支持的插件接口或请求方法" }); return true; } catch (error) { sendJson(res, error instanceof PluginError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }); return true; }
}
