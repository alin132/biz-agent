/** Display token counts in thousands, keeping sub-1000 values readable. */
export function formatTokens(count: number): string {
	const value = Math.max(0, Math.round(Number(count) || 0));
	return (Math.round((value / 1000) * 10) / 10).toFixed(1) + "k";
}

export function contextRingDash(used: number, total: number): string {
	const circumference = 2 * Math.PI * 15.5;
	const ratio = total > 0 ? Math.min(Math.max(used / total, 0), 1) : 0;
	return `${circumference * ratio} ${circumference}`;
}
