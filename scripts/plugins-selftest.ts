import assert from "node:assert/strict";
import { fetchGitHubPiSkill, githubSkillUrls, parsePiSkillManifest, PluginError } from "../server/plugins/service.js";

const skillMarkdown = "---\nname: sales-review\ndescription: Review sales records\n---\n\nUse the available sales tools and report evidence.";
let passed = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
	await run();
	passed++;
	console.log(`  ✓ ${name}`);
}

async function rejectsWithStatus(run: () => unknown | Promise<unknown>, status: number): Promise<void> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof PluginError && error.status === status);
		return;
	}
	assert.fail(`期望 PluginError status=${status}`);
}

await check("GitHub 技能文件链接规范化为目录 API 与可见来源", () => {
	const urls = githubSkillUrls("https://github.com/acme/agent-skills/blob/main/sales/SKILL.md");
	assert.equal(urls.sourceUrl, "https://github.com/acme/agent-skills/blob/main/sales/SKILL.md");
	assert.equal(urls.rawUrl, "https://raw.githubusercontent.com/acme/agent-skills/main/sales/SKILL.md");
	assert.equal(urls.apiUrl, "https://api.github.com/repos/acme/agent-skills/contents/sales?ref=main");
	assert.equal(githubSkillUrls("https://github.com/acme/agent-skills/tree/main/sales").skillPath, "sales");
});

await check("仅允许 GitHub 文件页或 raw 主机上的 SKILL.md", async () => {
	for (const url of [
		"http://github.com/acme/skills/blob/main/SKILL.md",
		"https://example.com/acme/skills/blob/main/SKILL.md",
		"https://github.com/acme/skills/blob/main/README.md",
		"https://github.com/acme/skills/tree/main/../outside",
		"https://github.com/acme/skills/blob/main/SKILL.md?raw=1",
	]) await rejectsWithStatus(() => githubSkillUrls(url), 400);
});

await check("导入完整技能目录并保留 references、scripts 与二进制 assets", async () => {
	const requests: string[] = [];
	const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
	const entry = (path: string, type: string, content?: Uint8Array, parent = "") => ({
		name: path.split("/").at(-1), path: `sales/${parent}${path}`, type,
		...(type === "dir" ? { url: `https://api.github.com/repos/acme/agent-skills/contents/sales/${parent}${path}` } : {
			size: content!.length,
			url: `https://api.github.com/repos/acme/agent-skills/contents/sales/${parent}${path}`,
		}),
	});
	const skillBytes = Buffer.from(skillMarkdown);
	const sourceBytes = Buffer.from("Revenue is net of refunds.");
	const assetBytes = Buffer.from([0, 255, 3, 4]);
	const loaded = await fetchGitHubPiSkill("https://github.com/acme/agent-skills/tree/main/sales", async (input) => {
		const url = String(input);
		requests.push(url);
		if (url.endsWith("/contents/sales?ref=main")) return json([
			entry("SKILL.md", "file", skillBytes), entry("references", "dir"), entry("scripts", "dir"), entry("assets", "dir"),
		]);
		if (url.endsWith("/contents/sales/references?ref=main")) return json([entry("source.md", "file", sourceBytes, "references/")]);
		if (url.endsWith("/contents/sales/scripts?ref=main")) return json([entry("inspect.py", "file", Buffer.from("print('read only')"), "scripts/")]);
		if (url.endsWith("/contents/sales/assets?ref=main")) return json([entry("sample.bin", "file", assetBytes, "assets/")]);
		const contents = url.endsWith("/SKILL.md") ? skillBytes : url.endsWith("/source.md") ? sourceBytes : url.endsWith("/inspect.py") ? Buffer.from("print('read only')") : assetBytes;
		return json({ type: "file", encoding: "base64", content: contents.toString("base64") });
	});
	assert.ok(requests.every((url) => new URL(url).hostname === "api.github.com"));
	assert.equal(loaded.sourceUrl, "https://github.com/acme/agent-skills/tree/main/sales");
	assert.equal(parsePiSkillManifest(loaded.markdown).skills[0]?.id, "sales-review");
	const manifest = parsePiSkillManifest(loaded.markdown, loaded.sourceUrl, loaded.files);
	const files = manifest.skills[0]?.files ?? [];
	assert.deepEqual(files.map((file) => file.path).sort(), ["assets/sample.bin", "references/source.md", "scripts/inspect.py"]);
	assert.deepEqual(Buffer.from(files.find((file) => file.path === "assets/sample.bin")!.contentBase64, "base64"), assetBytes);
	assert.ok(files.some((file) => Buffer.from(file.contentBase64, "base64").toString("utf8").includes("Revenue is net")));
});

await check("路径穿越、重复路径和资源数量/大小超限均拒绝", async () => {
	const valid = Buffer.from("ok").toString("base64");
	for (const files of [
		[{ path: "../escape.txt", contentBase64: valid }],
		[{ path: "refs/a.md", contentBase64: valid }, { path: "refs/a.md", contentBase64: valid }],
	]) await rejectsWithStatus(() => parsePiSkillManifest(skillMarkdown, undefined, files), 400);
	for (const files of [
		Array.from({ length: 41 }, (_, i) => ({ path: `refs/${i}.md`, contentBase64: valid })),
		[{ path: "assets/large.bin", contentBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") }],
	]) await rejectsWithStatus(() => parsePiSkillManifest(skillMarkdown, undefined, files), 413);
	await rejectsWithStatus(() => parsePiSkillManifest(skillMarkdown, undefined, [{ path: "assets/big.bin", contentBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") }]), 413);
});

await check("GitHub 拒绝重定向、HTTP 错误、超量目录项与符号链接", async () => {
	await rejectsWithStatus(() => fetchGitHubPiSkill("https://github.com/acme/skills/tree/main/sales", async () => new Response(null, { status: 302 })), 502);
	await rejectsWithStatus(() => fetchGitHubPiSkill("https://github.com/acme/skills/tree/main/sales", async () => new Response("", { status: 404 })), 502);
	await rejectsWithStatus(() => fetchGitHubPiSkill("https://github.com/acme/skills/tree/main/sales", async (input) => {
		const url = String(input);
		if (url.endsWith("/contents/sales?ref=main")) return new Response(JSON.stringify(Array.from({ length: 41 }, (_, i) => ({ type: "file", name: `${i}.txt`, path: `sales/${i}.txt`, size: 1, url: `https://api.github.com/repos/acme/skills/contents/sales/${i}.txt` }))), { status: 200 });
		return new Response(JSON.stringify({ type: "file", encoding: "base64", content: "eA==" }), { status: 200 });
	}), 413);
	await rejectsWithStatus(() => fetchGitHubPiSkill("https://github.com/acme/skills/tree/main/sales", async () => new Response(JSON.stringify([{ type: "symlink", name: "escape", path: "sales/escape" }]), { status: 200 })), 400);
	await rejectsWithStatus(() => fetchGitHubPiSkill("https://github.com/acme/skills/tree/main/sales", async (input) => {
		if (String(input).endsWith("/contents/sales?ref=main")) return new Response(JSON.stringify([{ type: "file", name: "SKILL.md", path: "sales/SKILL.md", size: Buffer.byteLength(skillMarkdown), url: "https://api.github.com/repos/acme/skills/contents/sales/other.md" }]), { status: 200 });
		return new Response("{}", { status: 200 });
	}), 502);
});

await check("sourceUrl 进入插件清单时仍须是规范 GitHub 技能地址", () => {
	const parsed = parsePiSkillManifest(skillMarkdown, "https://github.com/acme/agent-skills/blob/main/sales/SKILL.md");
	assert.equal(parsed.sourceUrl, "https://github.com/acme/agent-skills/blob/main/sales/SKILL.md");
	assert.throws(() => parsePiSkillManifest(skillMarkdown, "https://evil.example/SKILL.md"), PluginError);
});

console.log(`插件导入自检：${passed} 项通过`);
