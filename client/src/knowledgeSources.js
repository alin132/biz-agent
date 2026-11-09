const SOURCE_MARKER = /\[kb:([A-Za-z0-9._-]+) doc:([A-Za-z0-9._-]+) chunk:(\d+)\]/g;

export function knowledgeSourcesOf(text) {
	const sources = [];
	for (const match of String(text ?? "").matchAll(SOURCE_MARKER)) {
		const [, kbId, docId, chunkId] = match;
		if (!sources.some((source) => source.kbId === kbId && source.docId === docId && source.chunkId === chunkId)) {
			sources.push({ kbId, docId, chunkId, marker: match[0] });
		}
	}
	return sources;
}

export function linkifyKnowledgeSources(text) {
	return String(text ?? "").replace(SOURCE_MARKER, (marker, kbId, docId, chunkId) => {
		const query = new URLSearchParams({ kbId, docId, chunkId });
		return `[${marker}](#/knowledge?${query})`;
	});
}
