import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-cli-session-selftest-"));
const sessionDir = join(root, "sessions");

try {
	const first = SessionManager.create(root, sessionDir);
	const firstId = first.getSessionId();
	first.appendMessage({ role: "user", content: "持久化会话消息", timestamp: Date.now() });
	first.appendMessage({ role: "user", content: "第二条持久消息", timestamp: Date.now() });
	assert.ok(first.getSessionFile(), "Pi writes a session file after the first conversation message");

	const continued = SessionManager.continueRecent(root, sessionDir);
	assert.equal(continued.getSessionId(), firstId, "continueRecent restores the latest session");
	assert.equal(continued.buildSessionContext().messages.length, 2, "restored session context contains prior messages");

	const listed = await SessionManager.list(root, sessionDir);
	assert.equal(listed.length, 1, "session list includes the persisted conversation");
	assert.equal(listed[0]?.id, firstId);
	assert.ok(listed[0]?.firstMessage.includes("持久化会话消息"));

	const secondPath = SessionManager.create(root, sessionDir).getSessionFile();
	assert.ok(secondPath);
	const second = SessionManager.open(secondPath!, sessionDir, root);
	assert.equal(second.buildSessionContext().messages.length, 0, "a new session starts with isolated context");
	second.appendMessage({ role: "user", content: "第二个会话", timestamp: Date.now() });
	assert.notEqual(second.getSessionId(), firstId, "new session has an independent Pi session id");
	assert.equal((await SessionManager.list(root, sessionDir)).length, 2, "both sessions remain resumable");

	const reopened = SessionManager.open(listed[0]!.path, sessionDir, root);
	assert.equal(reopened.getSessionId(), firstId, "open restores the explicitly selected session");
	assert.equal(reopened.buildSessionContext().messages.length, 2, "selected session history is intact");
	console.log("Pi CLI session selftest passed (10 assertions)");
} finally {
	await rm(root, { recursive: true, force: true });
}
