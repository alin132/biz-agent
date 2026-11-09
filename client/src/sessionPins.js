const KEY_PREFIX = "biz-agent:pinned-sessions:v1:";

function storageOf(storage) {
	if (storage) return storage;
	try {
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

function scopeKey(scope) {
	const value = String(scope ?? "").trim();
	return value ? `agent:${encodeURIComponent(value)}` : "chat";
}

export function sessionPinStorageKey(scope = "") {
	return KEY_PREFIX + scopeKey(scope);
}

export function readPinnedSessionIds(scope = "", storage) {
	try {
		const raw = storageOf(storage)?.getItem(sessionPinStorageKey(scope));
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? [...new Set(parsed.filter((id) => typeof id === "string" && id.length > 0))]
			: [];
	} catch {
		return [];
	}
}

export function writePinnedSessionIds(scope = "", ids = [], storage) {
	try {
		const normalized = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
		storageOf(storage)?.setItem(sessionPinStorageKey(scope), JSON.stringify(normalized));
		return normalized;
	} catch {
		return readPinnedSessionIds(scope, storage);
	}
}

export function togglePinnedSession(sessionId, scope = "", storage) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return readPinnedSessionIds(scope, storage);
	const current = readPinnedSessionIds(scope, storage);
	const next = current.includes(sessionId)
		? current.filter((id) => id !== sessionId)
		: [...current, sessionId];
	return writePinnedSessionIds(scope, next, storage);
}

export function sortPinnedSessions(sessions, pinnedIds = []) {
	const pinned = new Set(pinnedIds);
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((a, b) => Number(pinned.has(b.session.id)) - Number(pinned.has(a.session.id)) || a.index - b.index)
		.map(({ session }) => session);
}
