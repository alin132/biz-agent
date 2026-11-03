/* biz-agent 控制台 —— 原生 JS，无构建步骤。 */

const els = {
	pinnedList: document.getElementById("pinned-list"),
	flowGroups: document.getElementById("flow-groups"),
	title: document.getElementById("session-title"),
	modeChip: document.getElementById("mode-chip"),
	modelName: document.getElementById("model-name"),
	stepbar: document.getElementById("stepbar"),
	threadInner: document.getElementById("thread-inner"),
	messages: document.getElementById("messages"),
	empty: document.getElementById("empty"),
	composer: document.getElementById("composer"),
	input: document.getElementById("input"),
	send: document.getElementById("send"),
	drawer: document.getElementById("drawer"),
	drawerClose: document.getElementById("drawer-close"),
	drawerSessions: document.getElementById("drawer-sessions"),
	steps: document.getElementById("steps"),
	audit: document.getElementById("audit"),
	menu: document.getElementById("menu"),
	searchRow: document.getElementById("search-row"),
	searchInput: document.getElementById("search-input"),
	permissionChip: document.getElementById("permission-chip"),
	permissionLabel: document.getElementById("permission-label"),
	modelSelect: document.getElementById("model-select"),
	attachBtn: document.getElementById("btn-attach"),
	fileInput: document.getElementById("file-input"),
	attachments: document.getElementById("attachments"),
	micBtn: document.getElementById("btn-mic"),
	workspace: document.getElementById("workspace"),
};

const PIN_KEY = "biz-agent.pinned";

const state = {
	workflows: [],
	sessions: [],
	currentId: null,
	currentView: null,
	es: null,
	runEl: null,
	answerEl: null,
	busy: false,
	pinned: new Set(JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]")),
	searchQuery: "",
	attachments: [],
	menuAnchor: null,
};

/* ---------------- markdown ---------------- */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function inline(text) {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(source) {
	const codeBlocks = [];
	const withPlaceholders = String(source).replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code) => {
		codeBlocks.push(escapeHtml(String(code).replace(/\n$/, "")));
		return `@@B${codeBlocks.length - 1}@@`;
	});

	const lines = withPlaceholders.split("\n");
	const html = [];
	let listType = null;
	let listItems = [];
	let paragraph = [];

	const flushList = () => {
		if (listType) {
			html.push(`<${listType}>${listItems.join("")}</${listType}>`);
			listType = null;
			listItems = [];
		}
	};
	const flushParagraph = () => {
		if (paragraph.length > 0) {
			html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
			paragraph = [];
		}
	};
	const flushAll = () => {
		flushList();
		flushParagraph();
	};

	for (const rawLine of lines) {
		const trimmed = rawLine.replace(/\s+$/, "").trim();
		if (trimmed === "") {
			flushAll();
			continue;
		}

		const placeholder = /^@@B(\d+)@@$/.exec(trimmed);
		if (placeholder) {
			flushAll();
			html.push(`<pre><code>${codeBlocks[Number(placeholder[1])]}</code></pre>`);
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			flushAll();
			const level = Math.min(heading[1].length, 4);
			html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}

		if (/^>\s?/.test(trimmed)) {
			flushAll();
			html.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
			continue;
		}

		const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
		if (ordered) {
			flushParagraph();
			if (listType !== "ol") {
				flushList();
				listType = "ol";
			}
			listItems.push(`<li>${inline(ordered[2])}</li>`);
			continue;
		}

		const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flushParagraph();
			if (listType !== "ul") {
				flushList();
				listType = "ul";
			}
			listItems.push(`<li>${inline(bullet[1])}</li>`);
			continue;
		}

		flushList();
		paragraph.push(trimmed);
	}

	flushAll();
	return html.join("");
}

/* ---------------- 基础 ---------------- */

function make(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function scrollToBottom() {
	els.messages.scrollTop = els.messages.scrollHeight;
}

function clearEmpty() {
	if (els.empty && els.empty.parentNode) els.empty.remove();
}

function sessionTitle(session) {
	const first = session.transcript?.find((turn) => turn.role === "user");
	if (first && first.text) {
		return first.text.length > 24 ? `${first.text.slice(0, 24)}…` : first.text;
	}
	return session.workflowName ?? `会话 #${session.id}`;
}

/* ---------------- 浮动菜单 ---------------- */

function closeMenu() {
	els.menu.hidden = true;
	els.menu.innerHTML = "";
	state.menuAnchor = null;
}

function openMenu(anchor, items) {
	// 再次点击同一个触发按钮 = 收起菜单
	if (state.menuAnchor === anchor && !els.menu.hidden) {
		closeMenu();
		return;
	}

	els.menu.innerHTML = "";
	for (const item of items) {
		if (item.separator) {
			els.menu.appendChild(make("div", "menu-sep"));
			continue;
		}
		if (item.title) {
			els.menu.appendChild(make("div", "menu-title", item.title));
			continue;
		}
		const button = make("button", "menu-item");
		if (item.checked) {
			const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			check.setAttribute("viewBox", "0 0 24 24");
			check.setAttribute("fill", "none");
			check.setAttribute("stroke", "currentColor");
			check.setAttribute("stroke-width", "2.2");
			check.setAttribute("stroke-linecap", "round");
			check.setAttribute("class", "menu-check");
			check.innerHTML = '<path d="m5 13 4 4L19 7"/>';
			button.appendChild(check);
		}
		button.appendChild(make("span", "menu-label", item.label));
		if (item.hint) button.appendChild(make("span", "menu-hint", item.hint));
		button.addEventListener("click", () => {
			closeMenu();
			item.onClick();
		});
		els.menu.appendChild(button);
	}

	state.menuAnchor = anchor;
	els.menu.hidden = false;
	const rect = anchor.getBoundingClientRect();
	const width = els.menu.offsetWidth;
	const height = els.menu.offsetHeight;
	let left = rect.left;
	if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
	let top = rect.bottom + 6;
	if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
	els.menu.style.left = `${Math.max(8, left)}px`;
	els.menu.style.top = `${top}px`;
}

function flowMenuItems() {
	return [
		{ title: "新建会话" },
		...state.workflows.map((workflow) => ({
			label: workflow.name,
			hint: `${workflow.steps.length} 步`,
			onClick: () => void createSession(workflow.id),
		})),
	];
}

/* ---------------- 侧边栏 ---------------- */

function matchesSearch(session) {
	if (!state.searchQuery) return true;
	return sessionTitle(session).toLowerCase().includes(state.searchQuery.toLowerCase());
}

function sessionItem(session, nested) {
	const wrap = make("div", nested ? "item nested" : "item");
	wrap.dataset.sessionId = session.id;
	wrap.setAttribute("role", "button");
	wrap.tabIndex = 0;

	wrap.appendChild(make("span", "dot"));
	wrap.appendChild(make("span", "label", sessionTitle(session)));

	const pin = make("button", "icon-btn");
	pin.title = state.pinned.has(session.id) ? "取消置顶" : "置顶";
	pin.style.marginLeft = "auto";
	pin.style.width = "20px";
	pin.style.height = "20px";
	pin.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M12 17v5"/><path d="M9 10.8V4.5"/><path d="M15 10.8V4.5"/><path d="M12 3v4"/><path d="M8 10.8h8v4a4 4 0 0 1-8 0z"/></svg>';
	pin.addEventListener("click", (event) => {
		event.stopPropagation();
		if (state.pinned.has(session.id)) state.pinned.delete(session.id);
		else state.pinned.add(session.id);
		localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned]));
		renderSidebar();
	});
	wrap.appendChild(pin);

	if (session.id === state.currentId) wrap.classList.add("active");
	wrap.addEventListener("click", () => void openSession(session.id));
	return wrap;
}

function renderSidebar() {
	els.pinnedList.innerHTML = "";
	const pinned = state.sessions.filter((session) => state.pinned.has(session.id) && matchesSearch(session));
	if (pinned.length === 0) {
		els.pinnedList.appendChild(
			make("div", "placeholder", state.searchQuery ? "没有匹配的置顶会话" : "把常看的会话置顶到这里"),
		);
	} else {
		for (const session of pinned) els.pinnedList.appendChild(sessionItem(session, false));
	}

	els.flowGroups.innerHTML = "";
	for (const workflow of state.workflows) {
		const row = make("div", "flow-row");
		row.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.2h7.8a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
		row.appendChild(make("span", "label", workflow.name));

		const add = make("button", "add");
		add.title = `新建「${workflow.name}」会话`;
		add.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
		add.addEventListener("click", (event) => {
			event.stopPropagation();
			void createSession(workflow.id);
		});
		row.appendChild(add);
		row.addEventListener("click", () => void createSession(workflow.id));
		els.flowGroups.appendChild(row);

		const sessions = state.sessions.filter(
			(session) => session.workflowId === workflow.id && matchesSearch(session),
		);
		for (const session of sessions) els.flowGroups.appendChild(sessionItem(session, true));
	}
}

function renderDrawerSessions() {
	els.drawerSessions.innerHTML = "";
	if (state.sessions.length === 0) {
		els.drawerSessions.appendChild(make("div", "placeholder", "还没有会话"));
		return;
	}
	for (const session of [...state.sessions].reverse()) {
		const row = make("button", "session-row");
		if (session.id === state.currentId) row.classList.add("active");
		row.appendChild(make("span", "row-title", sessionTitle(session)));
		row.appendChild(
			make(
				"span",
				"row-meta",
				`${session.workflowName} · ${session.done ? "已完成" : `${session.current}/${session.steps.length}`}`,
			),
		);
		row.addEventListener("click", () => {
			void openSession(session.id);
		});
		els.drawerSessions.appendChild(row);
	}
}

/* ---------------- 步骤 / 审计 ---------------- */

function renderStepbar(steps) {
	els.stepbar.innerHTML = "";
	if (!steps || steps.length === 0) return;
	for (const step of steps) els.stepbar.appendChild(make("span", `step-chip ${step.status}`, step.title));
}

function renderSteps(steps) {
	els.steps.innerHTML = "";
	if (!steps || steps.length === 0) {
		els.steps.appendChild(make("li", "placeholder", "尚未开始"));
		return;
	}
	for (const step of steps) els.steps.appendChild(make("li", step.status, step.title));
}

function renderAudit(entries) {
	els.audit.innerHTML = "";
	if (!entries || entries.length === 0) {
		els.audit.appendChild(make("div", "placeholder", "暂无调用"));
		return;
	}
	for (const entry of entries) appendAudit(entry);
}

function appendAudit(entry) {
	const stale = els.audit.querySelector(".placeholder");
	if (stale) stale.remove();
	const row = make("div", `row ${entry.ok ? "ok" : "err"}`);
	row.appendChild(make("span", "name", entry.toolName));
	row.appendChild(document.createTextNode(entry.ok ? "  ok" : "  err"));
	if (entry.truncated) row.appendChild(document.createTextNode("  截断"));
	els.audit.appendChild(row);
}

/* ---------------- 消息区 ---------------- */

function ensureRun() {
	clearEmpty();
	if (!state.runEl) {
		state.runEl = make("div", "run");
		els.threadInner.appendChild(state.runEl);
	}
	return state.runEl;
}

function addUserMessage(text) {
	clearEmpty();
	const wrap = make("div", "msg-user");
	wrap.appendChild(make("div", "bubble", text));
	els.threadInner.appendChild(wrap);
	state.runEl = null;
	state.answerEl = null;
	scrollToBottom();
}

function appendText(delta) {
	ensureRun();
	if (!state.answerEl) {
		state.answerEl = make("div", "answer");
		state.answerEl.style.whiteSpace = "pre-wrap";
		state.runEl.appendChild(state.answerEl);
	}
	state.answerEl.textContent += delta;
	scrollToBottom();
}

function finalizeAnswer(text) {
	if (!state.answerEl) {
		if (!text) return;
		ensureRun();
		state.answerEl = make("div", "answer");
		state.runEl.appendChild(state.answerEl);
	}
	state.answerEl.style.whiteSpace = "";
	state.answerEl.innerHTML = renderMarkdown(text || state.answerEl.textContent);
	scrollToBottom();
}

function addToolStart(event) {
	ensureRun();
	state.answerEl = null;

	const card = make("div", "tool");
	card.dataset.id = event.id;

	const head = make("div", "tool-head");
	head.appendChild(make("span", "tool-name", event.name));
	const args = JSON.stringify(event.args ?? {});
	head.appendChild(make("span", "tool-args", args.length > 110 ? `${args.slice(0, 110)}…` : args));
	const status = make("span", "tool-status run", "运行中");
	status.dataset.role = "status";
	head.appendChild(status);

	const body = make("div", "tool-body");
	body.dataset.role = "body";

	card.append(head, body);
	state.runEl.appendChild(card);
	scrollToBottom();
}

function findToolCard(id) {
	if (!state.runEl) return null;
	return [...state.runEl.querySelectorAll(".tool")].find((node) => node.dataset.id === id) ?? null;
}

function finishTool(event) {
	const card = findToolCard(event.id);
	if (!card) return;
	const status = card.querySelector('[data-role="status"]');
	const body = card.querySelector('[data-role="body"]');
	const cost = event.durationMs ? ` · ${event.durationMs}ms` : "";
	status.className = `tool-status ${event.ok ? "ok" : "err"}`;
	status.textContent = event.ok ? `完成${cost}` : "失败";
	body.textContent = event.result ?? "";
	scrollToBottom();
}

function addApproval(event) {
	ensureRun();
	state.answerEl = null;

	const card = make("div", "approval");
	card.appendChild(make("h4", null, `需要人工审批 · ${event.toolName}`));
	card.appendChild(make("pre", null, JSON.stringify(event.args ?? {}, null, 2)));

	const actions = make("div", "actions");
	const approve = make("button", "btn-primary", "同意并继续");
	const reject = make("button", "btn-ghost danger", "拒绝");
	actions.append(approve, reject);
	card.appendChild(actions);
	state.runEl.appendChild(card);
	scrollToBottom();

	const decide = async (approved) => {
		approve.disabled = true;
		reject.disabled = true;
		await fetch(`/api/sessions/${state.currentId}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: event.requestId, approved }),
		});
		card.appendChild(make("div", "notice", approved ? "已同意，继续执行。" : "已拒绝，流程中断。"));
	};

	approve.addEventListener("click", () => void decide(true));
	reject.addEventListener("click", () => void decide(false));
}

function addNotice(text, isError) {
	ensureRun();
	state.runEl.appendChild(make("div", isError ? "notice err" : "notice", text));
	scrollToBottom();
}

/* ---------------- 会话 ---------------- */

async function refreshSessions() {
	state.sessions = await (await fetch("/api/sessions")).json();
	renderSidebar();
	renderDrawerSessions();
}

async function createSession(workflowId, modelId) {
	const payload = { workflowId };
	if (modelId) payload.modelId = modelId;

	const response = await fetch("/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		alert("创建会话失败");
		return;
	}
	const view = await response.json();
	state.currentId = view.id;
	setupSession(view);
	els.threadInner.innerHTML =
		'<div class="empty"><h2>开始一个新任务</h2><p>在下方描述你要处理的事情，Agent 会按内置流程一步步执行。</p></div>';
	els.empty = els.threadInner.querySelector(".empty");
	connect(view.id);
	await refreshSessions();
}

async function openSession(id) {
	const view = await (await fetch(`/api/sessions/${id}`)).json();
	state.currentId = id;
	setupSession(view);

	els.threadInner.innerHTML = "";
	state.runEl = null;
	state.answerEl = null;
	for (const turn of view.transcript) {
		if (turn.role === "user") {
			addUserMessage(turn.text);
		} else {
			ensureRun();
			const block = make("div", "answer");
			block.innerHTML = renderMarkdown(turn.text);
			state.runEl.appendChild(block);
		}
	}
	if (view.transcript.length === 0) {
		const empty = make("div", "empty", "这个会话还没有消息，在下方输入任务开始。");
		els.threadInner.appendChild(empty);
		els.empty = empty;
	}
	connect(id);
	// 历史会话可能很长，打开时直接定位到最新一条
	requestAnimationFrame(() => scrollToBottom());
	await refreshSessions();
}

function setupSession(view) {
	state.currentView = view;
	els.title.textContent = view.workflowName;
	const label = view.modeLabel ?? (view.mode === "live" ? "真实模型" : "模拟模型");
	els.modeChip.textContent = label;
	els.modelName.textContent = view.modelId ?? "模拟模型";
	els.permissionLabel.textContent = view.permissionMode === "readonly" ? "只读" : "完全访问";
	els.permissionChip.classList.toggle("readonly", view.permissionMode === "readonly");
	renderStepbar(view.steps);
	renderSteps(view.steps);
	renderAudit(view.audit);
}

function connect(id) {
	if (state.es) state.es.close();
	const source = new EventSource(`/api/sessions/${id}/events`);
	state.es = source;
	source.onmessage = (message) => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		handle(event);
	};
}

function handle(event) {
	switch (event.type) {
		case "ready":
			setupSession(event.session);
			break;
		case "text":
			appendText(event.delta);
			break;
		case "tool_start":
			addToolStart(event);
			break;
		case "tool_end":
			finishTool(event);
			break;
		case "audit":
			appendAudit(event.entry);
			break;
		case "approval":
			addApproval(event);
			break;
		case "workflow":
			renderStepbar(event.steps);
			renderSteps(event.steps);
			break;
		case "done":
			finalizeAnswer(event.text);
			state.runEl = null;
			state.answerEl = null;
			void refreshSessions();
			break;
		case "error":
			addNotice(event.message, true);
			break;
		case "busy":
			state.busy = event.running;
			els.send.disabled = event.running;
			break;
		default:
			break;
	}
}

/* ---------------- 抽屉 ---------------- */

function toggleDrawer(force) {
	const open = force ?? !els.drawer.classList.contains("open");
	els.drawer.classList.toggle("open", open);
	if (open) renderDrawerSessions();
}

/* ---------------- 附件 ---------------- */

function renderAttachments() {
	els.attachments.innerHTML = "";
	if (state.attachments.length === 0) {
		els.attachments.hidden = true;
		return;
	}
	els.attachments.hidden = false;
	state.attachments.forEach((attachment, index) => {
		const chip = make("span", "attach-chip");
		chip.appendChild(make("span", null, `${attachment.name}（${attachment.content.length} 字）`));
		const remove = make("button", null, "×");
		remove.title = "移除";
		remove.addEventListener("click", () => {
			state.attachments.splice(index, 1);
			renderAttachments();
		});
		chip.appendChild(remove);
		els.attachments.appendChild(chip);
	});
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", async () => {
	const file = els.fileInput.files?.[0];
	if (!file) return;
	if (file.size > 400_000) {
		alert("文件太大（上限 400KB）");
		return;
	}
	const content = await file.text();
	state.attachments.push({ name: file.name, content: content.slice(0, 60_000) });
	renderAttachments();
	els.fileInput.value = "";
});

function buildOutgoingText(value) {
	if (state.attachments.length === 0) return value;
	const blocks = state.attachments.map(
		(attachment) => `<附件 name="${attachment.name}">\n${attachment.content}\n</附件>`,
	);
	return `${value}\n\n${blocks.join("\n\n")}`.trim();
}

/* ---------------- 语音输入 ---------------- */

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionCtor) {
	els.micBtn.classList.add("hidden");
} else {
	let recognition = null;
	els.micBtn.addEventListener("click", () => {
		if (recognition) {
			recognition.stop();
			return;
		}
		recognition = new SpeechRecognitionCtor();
		recognition.lang = "zh-CN";
		recognition.interimResults = true;
		recognition.continuous = false;
		const base = els.input.value;
		recognition.onresult = (event) => {
			let transcript = "";
			for (let index = event.resultIndex; index < event.results.length; index++) {
				transcript += event.results[index][0].transcript;
			}
			els.input.value = `${base}${base ? " " : ""}${transcript}`;
			els.input.dispatchEvent(new Event("input"));
		};
		recognition.onerror = () => {
			addNotice("语音识别不可用（需要浏览器麦克风权限）", true);
		};
		recognition.onend = () => {
			recognition = null;
			els.micBtn.classList.remove("recording");
		};
		els.micBtn.classList.add("recording");
		recognition.start();
	});
}

/* ---------------- 交互绑定 ---------------- */

els.input.addEventListener("input", () => {
	els.input.style.height = "auto";
	els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
});

els.input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		els.composer.requestSubmit();
	}
});

els.composer.addEventListener("submit", async (event) => {
	event.preventDefault();
	const raw = els.input.value.trim();
	if ((!raw && state.attachments.length === 0) || !state.currentId || state.busy) return;

	const text = buildOutgoingText(raw || "（见附件）");
	els.input.value = "";
	els.input.style.height = "auto";
	state.attachments = [];
	renderAttachments();
	addUserMessage(text);

	await fetch(`/api/sessions/${state.currentId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
});

document.getElementById("btn-new").addEventListener("click", (event) => {
	openMenu(event.currentTarget, flowMenuItems());
});
document.getElementById("rail-new").addEventListener("click", (event) => {
	openMenu(event.currentTarget, flowMenuItems());
});
els.workspace.addEventListener("click", (event) => {
	openMenu(event.currentTarget, flowMenuItems());
});

document.getElementById("btn-search").addEventListener("click", () => {
	const showing = !els.searchRow.hidden;
	els.searchRow.hidden = showing;
	if (!showing) {
		els.searchInput.value = state.searchQuery;
		els.searchInput.focus();
	} else {
		state.searchQuery = "";
		els.searchInput.value = "";
		renderSidebar();
	}
});
els.searchInput.addEventListener("input", () => {
	state.searchQuery = els.searchInput.value.trim();
	renderSidebar();
});

for (const id of ["btn-audit", "rail-audit", "btn-audit-top"]) {
	document.getElementById(id).addEventListener("click", () => toggleDrawer(true));
}
els.drawerClose.addEventListener("click", () => toggleDrawer(false));

document.getElementById("rail-history").addEventListener("click", () => {
	toggleDrawer(true);
	const body = els.drawer.querySelector(".drawer-body");
	if (body) body.scrollTop = 0;
});

document.getElementById("rail-more").addEventListener("click", (event) => {
	openMenu(event.currentTarget, [
		{ title: "操作" },
		{
			label: "复制当前会话 ID",
			onClick: () => {
				if (!state.currentId) return;
				void navigator.clipboard.writeText(state.currentId);
			},
		},
		{ label: "刷新会话列表", onClick: () => void refreshSessions() },
		{ separator: true },
		{
			label: "清空全部会话",
			hint: `${state.sessions.length} 个`,
			onClick: async () => {
				if (state.sessions.length === 0) return;
				if (!confirm(`确定清空全部 ${state.sessions.length} 个会话？`)) return;
				await fetch("/api/sessions", { method: "DELETE" });
				await refreshSessions();
				if (state.workflows.length > 0) await createSession(state.workflows[0].id);
			},
		},
	]);
});

els.permissionChip.addEventListener("click", (event) => {
	const current = state.currentView?.permissionMode ?? "full";
	openMenu(event.currentTarget, [
		{ title: "权限模式" },
		{
			label: "完全访问",
			hint: "可调用全部工具",
			checked: current === "full",
			onClick: () => void setPermission("full"),
		},
		{
			label: "只读",
			hint: "仅低风险工具",
			checked: current === "readonly",
			onClick: () => void setPermission("readonly"),
		},
	]);
});

async function setPermission(mode) {
	if (!state.currentId) return;
	await fetch(`/api/sessions/${state.currentId}/permissions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode }),
	});
	els.permissionLabel.textContent = mode === "readonly" ? "只读" : "完全访问";
	els.permissionChip.classList.toggle("readonly", mode === "readonly");
	if (state.currentView) state.currentView.permissionMode = mode;
	addNotice(mode === "readonly" ? "已切换为只读模式：中高风险工具会被拦截。" : "已切换为完全访问模式。", false);
}

els.modelSelect.addEventListener("click", async (event) => {
	const data = await (await fetch("/api/models")).json();
	const anchor = event.currentTarget;

	if (data.mode === "simulated") {
		openMenu(anchor, [
			{ title: "当前模型" },
			{ label: "模拟模型", hint: "未配置 API key", checked: true, onClick: () => {} },
			{ separator: true },
			{ label: "在 .env 配置 key 后可切换", onClick: () => {} },
		]);
		return;
	}

	const items = [{ title: `可用模型（${data.options.length}）` }];
	for (const option of data.options) {
		items.push({
			label: option.label,
			hint: option.id,
			checked: option.id === state.currentView?.modelId,
			onClick: () => {
				if (option.id === state.currentView?.modelId) return;
				void createSession(state.currentView?.workflowId ?? state.workflows[0].id, option.id);
			},
		});
	}
	items.push({ separator: true });
	items.push({ label: "切换模型会新建会话", onClick: () => {} });
	openMenu(anchor, items);
});

document.addEventListener("click", (event) => {
	if (els.menu.hidden) return;
	// 点击触发菜单的按钮本身不算"点外部"，交给 openMenu 的 toggle 逻辑处理
	if (state.menuAnchor && state.menuAnchor.contains(event.target)) return;
	if (!els.menu.contains(event.target)) closeMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		closeMenu();
		toggleDrawer(false);
	}
});

/* ---------------- 启动 ---------------- */

async function init() {
	state.workflows = await (await fetch("/api/workflows")).json();
	await refreshSessions();

	if (state.sessions.length > 0) {
		await openSession(state.sessions[state.sessions.length - 1].id);
	} else if (state.workflows.length > 0) {
		await createSession(state.workflows[0].id);
	}
}

void init();
