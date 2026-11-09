import { computed, onBeforeUnmount, ref } from "vue";

export function useSessionActivity() {
	const pending = ref([]);
	const activeTurn = ref(null);
	const now = ref(Date.now());
	let timer = null;
	const elapsedMs = computed(() => {
		const turn = activeTurn.value;
		if (!turn) return 0;
		return turn.startedAt ? Math.max(0, now.value - turn.startedAt) : Number(turn.durationMs ?? 0);
	});

	function hydrate(view, turns = view.transcript ?? []) {
		pending.value = view.pendingApprovals ?? [];
		activeTurn.value = [...turns].reverse().find((item) => item.role === "user") ?? null;
		if (activeTurn.value && view.running) activeTurn.value.startedAt = Date.now();
		clearInterval(timer);
		timer = view.running ? setInterval(() => { now.value = Date.now(); }, 250) : null;
	}

	function beginTurn(turn) {
		activeTurn.value = turn;
		turn.tools ??= [];
		turn.durationMs = 0;
		turn.startedAt = Date.now();
		clearInterval(timer);
		timer = setInterval(() => { now.value = Date.now(); }, 250);
	}

	function event(payload) {
		const turn = activeTurn.value;
		if (payload.type === "tool_start" && turn) {
			turn.tools ??= [];
			if (!turn.tools.some((tool) => tool.id === payload.id)) turn.tools.push({ id: payload.id, name: payload.name, args: payload.args, running: true });
		}
		if (payload.type === "tool_end" && turn) {
			const tool = (turn.tools ?? []).find((item) => item.id === payload.id);
			if (tool) Object.assign(tool, { running: false, ok: payload.ok, result: payload.result, durationMs: payload.durationMs });
		}
		if (payload.type === "approval" && !pending.value.some((item) => item.requestId === payload.requestId)) pending.value.push(payload);
		if ((payload.type === "done" || payload.type === "error") && turn?.startedAt) {
			turn.durationMs = Date.now() - turn.startedAt;
			delete turn.startedAt;
			clearInterval(timer);
			timer = null;
			pending.value = [];
		}
	}

	function resolved(id) { pending.value = pending.value.filter((item) => item.requestId !== id); }
	onBeforeUnmount(() => clearInterval(timer));
	return { pending, activeTurn, elapsedMs, hydrate, beginTurn, event, resolved };
}
