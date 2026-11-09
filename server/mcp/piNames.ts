import { createHash } from "node:crypto";

const MAX_PI_TOOL_NAME_LENGTH = 64;

/** Mirrors Pi's public MCP tool-name normalization so persisted business aliases can map to Pi names. */
export function piMcpToolName(server: string, tool: string, isTaken: (candidate: string) => boolean = () => false): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_PI_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_PI_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}
