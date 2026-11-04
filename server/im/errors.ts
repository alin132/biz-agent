/**
 * IM Bot 网关的错误类型：带 HTTP 状态码，路由层直接映射（与 ModelError / WorkflowHttpError 同一套路）。
 * 文案一律中文、面向控制台使用者，别把底层英文错误直接抛给前端。
 */

export class ImError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ImError";
	}
}
