import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 前端构建配置。
 *
 * 两个要点：
 *  1. base 用相对路径 "./"：产物要能被 server/index.ts 按 `web-dist` 目录直接读出来发，
 *     部署路径不固定（本地 / 反代 / 子目录都可能），绝对路径 /assets 会 404。
 *  2. /api 与 /v1 走开发代理：开发时前端跑 5173、后端跑 4317，同源假象由 Vite 代理提供，
 *     省掉后端开 CORS（生产同源也不需要 CORS）。
 */
export default defineConfig({
	plugins: [vue()],
	// root 必须显式指到 client/：配置文件在 client/ 下，但 vite 从"进程 cwd"找 root，
	// 不写这行它会在项目根找 index.html（那里只有后端代码），报 UNRESOLVED_ENTRY
	root: fileURLToPath(new URL(".", import.meta.url)),
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
			"/v1": { target: "http://127.0.0.1:4317", changeOrigin: true },
		},
	},
});
