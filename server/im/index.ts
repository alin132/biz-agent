/**
 * IM Bot 网关入口（P8）：把「凭证存储 + 钉钉回调 + 出站」组装成一个可挂载的运行时。
 *
 * `server/index.ts` 只做一行 `if (await im.handle(req, res, url)) return;`：
 * 回调路径在 `auth.guard` 的公开白名单里（钉钉服务器没有内部令牌），
 * 其余 `/api/im/*` 仍走鉴权 + `server/auth/roles.ts` 的权限矩阵。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Storage } from "../db/types.js";
import type { SessionHub } from "../session.js";
import { DingTalkGateway } from "./dingtalk.js";
import { WeComGateway } from "./wecom.js";
import type { DingTalkTransport } from "./outbound.js";
import { OutboundService } from "./outbound.js";
import { handleImRoute } from "./routes.js";
import { ImStore } from "./store.js";

export interface InitImOptions {
	storage: Storage;
	hub: Pick<SessionHub, "create" | "get">;
	/** 显式指定传输（测试/自检）；不传按 DINGTALK_TRANSPORT / NODE_ENV 决定 */
	transport?: DingTalkTransport;
	/** 注入时钟（自检用） */
	now?: () => number;
	/** 回调等一轮回复的上限（默认 60 秒） */
	callbackTimeoutMs?: number;
}

export interface ImRuntime {
	handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
	store: ImStore;
	outbound: OutboundService;
	gateway: DingTalkGateway;
}

export function initIm(options: InitImOptions): ImRuntime {
	const store = new ImStore(options.storage);
	const outbound = new OutboundService({ storage: options.storage, transport: options.transport });
	const gateway = new DingTalkGateway({
		store,
		hub: options.hub,
		outbound,
		now: options.now,
		timeoutMs: options.callbackTimeoutMs,
	});
	const wecom = new WeComGateway({ store, hub: options.hub, outbound, now: options.now, timeoutMs: options.callbackTimeoutMs });
	return {
		handle: (req, res, url) => handleImRoute(req, res, url, { store, outbound, gateway, wecom }),
		store,
		outbound,
		gateway,
	};
}

export { ImError } from "./errors.js";
export { ImStore, IM_DEFAULT_WORKFLOW } from "./store.js";
export { OutboundService, resolveDingTalkTransport } from "./outbound.js";
export {
	cleanDingText,
	collectSessionReply,
	decryptDingTalkEncrypt,
	dingTalkMsgSignature,
	dingTalkSign,
	isTimestampExpired,
	MsgIdLru,
	parseDingTalkMessage,
	verifyEncryptedRequest,
	verifySignedRequest,
} from "./dingtalk.js";
