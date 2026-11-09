import assert from "node:assert/strict";
import {
	readPinnedSessionIds,
	sessionPinStorageKey,
	sortPinnedSessions,
	togglePinnedSession,
	writePinnedSessionIds,
} from "../client/src/sessionPins.js";

class MemoryStorage {
	values = new Map();
	getItem(key) { return this.values.get(key) ?? null; }
	setItem(key, value) { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();
assert.notEqual(sessionPinStorageKey("agent-a"), sessionPinStorageKey("agent-b"));
assert.notEqual(sessionPinStorageKey(), sessionPinStorageKey("agent-a"));
assert.deepEqual(writePinnedSessionIds("agent-a", ["s1", "s1", "", 3], storage), ["s1"]);
assert.deepEqual(readPinnedSessionIds("agent-a", storage), ["s1"]);
assert.deepEqual(togglePinnedSession("s2", "agent-a", storage), ["s1", "s2"]);
assert.deepEqual(togglePinnedSession("s1", "agent-a", storage), ["s2"]);

const sessions = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];
assert.deepEqual(sortPinnedSessions(sessions, ["s3", "s1"]), [sessions[0], sessions[2], sessions[1], sessions[3]]);
assert.deepEqual(sortPinnedSessions(sessions, []), sessions);

console.log("会话置顶自检：8 项通过");
