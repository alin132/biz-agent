export async function copyText(text) {
	if (!String(text ?? "")) throw new Error("没有可复制的内容");
	await navigator.clipboard.writeText(String(text));
}

export function lastAssistantText(messages = []) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant" && typeof message.text === "string" && message.text.trim()) return message.text;
	}
	return "";
}
