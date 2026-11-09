import assert from "node:assert/strict";
import {
	createPiSessionHistory,
	piSessionIdOf,
	serializePiSessionBranch,
	serializePiSessionHistory,
	piSessionTreeView,
	derivePiSessionHistory,
} from "../server/piSessionHistory.js";

const oldMessages = [
	{ role: "system", content: "old prompt", timestamp: 1 },
	{ role: "user", content: "hello", timestamp: 2 },
	{ role: "assistant", content: [{ type: "text", text: "world" }], timestamp: 3 },
	{ role: "custom", customType: "business-note", content: "keep me", timestamp: 4 },
];

const imported = createPiSessionHistory({ sessionId: "legacy/session:one", agentMessages: oldMessages });
assert.equal(imported.getBranch().length, 3, "imports legacy conversation messages and omits the stale system prompt");
assert.equal(imported.getSessionId(), piSessionIdOf("legacy/session:one"));
assert.equal(piSessionIdOf("legacy/session:one"), piSessionIdOf("legacy/session:one"), "invalid ID mapping is stable");
const importedBranch = imported.getBranch();
const customEntry = importedBranch[2];
assert.equal(customEntry?.type === "message" ? customEntry.message.role : "", "custom");

const exported = serializePiSessionHistory(imported);
const restored = createPiSessionHistory({
	sessionId: "legacy/session:one",
	piSessionEntries: JSON.parse(JSON.stringify(exported)) as unknown[],
	agentMessages: [{ role: "user", content: "must not be duplicated", timestamp: 5 }],
});
assert.deepEqual(
	JSON.parse(JSON.stringify(serializePiSessionHistory(restored))),
	JSON.parse(JSON.stringify(exported)),
	"restores the Pi entry tree without reimporting legacy messages",
);

restored.appendMessage({ role: "user", content: "next", timestamp: 6 });
const afterAppend = serializePiSessionHistory(restored);
assert.equal(afterAppend.length, exported.length + 1, "exports Pi entries appended after restoration");
assert.equal(restored.buildSessionContext().messages.at(-1)?.role, "user");

const damagedFallback = createPiSessionHistory({
	sessionId: "damaged-history",
	piSessionEntries: [{ type: "invalid-entry" }],
	agentMessages: [{ role: "user", content: "legacy fallback", timestamp: 7 }],
});
const fallbackMessage = damagedFallback.buildSessionContext().messages.at(-1);
assert.equal(fallbackMessage?.role === "user" ? fallbackMessage.content : undefined, "legacy fallback",
	"an invalid Pi snapshot falls back to legacy AgentMessage history");

const firstLeaf = imported.getLeafId()!;
imported.appendMessage({ role: "user", content: "branch continuation", timestamp: 8 });
imported.branch(firstLeaf);
const branchSnapshot = serializePiSessionHistory(imported);
const branchRestored = createPiSessionHistory({
	sessionId: "legacy/session:one",
	piSessionEntries: JSON.parse(JSON.stringify(branchSnapshot)) as unknown[],
	piSessionLeafId: firstLeaf,
});
assert.equal(branchRestored.getLeafId(), firstLeaf, "restores the active Pi branch head");

const branchOriginal = createPiSessionHistory({ sessionId: "branch-export" });
branchOriginal.appendMessage({ role: "user", content: "first path", timestamp: 10 });
const firstPathLeaf = branchOriginal.getLeafId()!;
branchOriginal.appendMessage({ role: "user", content: "abandoned path", timestamp: 11 });
branchOriginal.branch(firstPathLeaf);
branchOriginal.appendMessage({ role: "user", content: "second path", timestamp: 12 });
branchOriginal.appendCustomEntry("biz-agent.runtime-state.v1", { activeSkillId: null });
const activeBranchExport = serializePiSessionBranch(branchOriginal);
assert.equal(activeBranchExport.length, 4, "Pi JSONL export includes only the active branch and its business state snapshot");
assert.equal(activeBranchExport[1]?.type === "message" && activeBranchExport[1].message.role === "user" ? activeBranchExport[1].message.content : "", "first path");
assert.equal(activeBranchExport[2]?.type === "message" && activeBranchExport[2].message.role === "user" ? activeBranchExport[2].message.content : "", "second path");
assert.equal(activeBranchExport[2]?.type === "message" ? activeBranchExport[2].parentId : undefined, activeBranchExport[1]?.type === "message" ? activeBranchExport[1].id : undefined, "exported entries are re-linked linearly");
assert.equal(serializePiSessionHistory(branchOriginal).length, 5, "persisted history still retains both branches and the state snapshot");
const treeView = piSessionTreeView(branchOriginal);
assert.equal(treeView.leafId, branchOriginal.getLeafId(), "tree view identifies the active leaf");
assert.equal(treeView.nodes.length, 1, "tree view preserves the root node");
assert.equal(treeView.nodes[0]?.active, true, "current path root is marked active");
assert.equal(treeView.nodes[0]?.children.length, 2, "tree view retains sibling branches");
assert.deepEqual(treeView.nodes[0]?.children.map((node) => node.active), [false, true], "only the selected branch path is marked active");
assert.equal(treeView.nodes[0]?.children[1]?.preview, "second path", "tree view exposes a plain text preview");
assert.equal(treeView.nodes[0]?.children[1]?.children.length, 0, "business runtime snapshots stay hidden from the navigable Pi tree");
assert.equal(treeView.leafId, branchOriginal.getLeafId(), "hidden snapshots do not change the native active leaf id");
assert.ok(!("message" in (treeView.nodes[0]?.children[1] ?? {})), "tree view does not expose raw Pi message metadata");

const clonedHistory = derivePiSessionHistory(branchOriginal, "clone", "independent-clone");
assert.equal(clonedHistory.entries[0]?.type === "session" ? clonedHistory.entries[0].id : "", "independent-clone");
assert.equal(clonedHistory.entries[0]?.type === "session" ? clonedHistory.entries[0].parentSession : "", branchOriginal.getSessionId());
const textMessages = (entries: typeof clonedHistory.entries) => entries.flatMap((entry) => {
	if (entry.type !== "message" || entry.message.role !== "user") return [];
	const content = entry.message.content;
	return [typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("")];
});
assert.deepEqual(textMessages(clonedHistory.entries), ["first path", "second path"], "clone copies only the active Pi branch");
assert.equal(clonedHistory.leafId, branchOriginal.getLeafId(), "clone keeps the active branch leaf");

const forkTarget = branchOriginal.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
const forkedHistory = derivePiSessionHistory(branchOriginal, "fork", "independent-fork", forkTarget.id);
assert.deepEqual(textMessages(forkedHistory.entries), ["first path"], "fork stops before the selected user message");
assert.equal(forkedHistory.editorText, "second path", "fork returns the selected text for editing/resubmission");
assert.equal(forkedHistory.leafId, clonedHistory.entries[1]?.id, "fork leaf remains at the selected message parent");
const nonUserHistory = createPiSessionHistory({ sessionId: "non-user-fork" });
nonUserHistory.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 14 } as Parameters<typeof nonUserHistory.appendMessage>[0]);
assert.throws(() => derivePiSessionHistory(nonUserHistory, "fork", "invalid-fork", nonUserHistory.getLeafId()!), /用户消息节点/);

const labeled = createPiSessionHistory({ sessionId: "labeled-history" });
labeled.appendMessage({ role: "user", content: "bookmark this", timestamp: 13 });
const labeledEntryId = labeled.getLeafId()!;
labeled.appendLabelChange(labeledEntryId, "关键节点");
const labeledTree = piSessionTreeView(labeled);
assert.equal(labeledTree.nodes[0]?.bookmark, "关键节点", "Pi label is exposed as a bookmark on its target node");
const labelRestored = createPiSessionHistory({
	sessionId: "labeled-history",
	piSessionEntries: JSON.parse(JSON.stringify(serializePiSessionHistory(labeled))) as unknown[],
	piSessionLeafId: labeled.getLeafId(),
});
assert.equal(piSessionTreeView(labelRestored).nodes[0]?.bookmark, "关键节点", "Pi bookmarks survive persistence and restore");

console.log("Pi session history selftest passed (32 assertions)");
