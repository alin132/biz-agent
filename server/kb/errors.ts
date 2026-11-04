/**
 * 知识库专属错误：自带 HTTP 状态码，路由层直接照着回，不用靠字符串猜状态。
 *
 * 为什么不用 `server/index.ts` 里那个 `BadRequestError`：知识库要把路由挂载进去的最小改动
 * 控制在「3 行」，所以状态码必须跟错误一起走，不能依赖宿主的路由层再判一次。
 */
export class KbError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "KbError";
		this.status = status;
	}
}

/** 入参不合法（400）：文案会直接上界面，写人话。 */
export function badRequest(message: string): KbError {
	return new KbError(400, message);
}

/** 资源不存在（404）。 */
export function notFound(message: string): KbError {
	return new KbError(404, message);
}

/** 文件太大（413）。 */
export function tooLarge(message: string): KbError {
	return new KbError(413, message);
}

/** 把任意异常转成一句中文（HTTP 层兜底用）。 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
