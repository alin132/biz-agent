import { sessionApi } from "./api.js";

export async function downloadPiSession(sessionId) {
	const { blob, filename } = await sessionApi.exportPiJsonl(sessionId);
	downloadBlob(blob, filename);
}

export async function downloadPiSessionHtml(sessionId) {
	const { blob, filename } = await sessionApi.exportPiHtml(sessionId);
	downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
