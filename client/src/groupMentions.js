// Duplicate display names need distinct tokens; routing always uses Agent IDs.
export function groupMentionOptions(members) {
	return members.map((member, index) => ({
		...member,
		token: `@${member.agentName}${members.some((other) => other.agentId !== member.agentId && other.agentName === member.agentName) ? `〔${index + 1}〕` : ""}`,
	}));
}

export function groupMentionTargets(text, members) {
	const options = groupMentionOptions(members).sort((a, b) => b.token.length - a.token.length);
	const targets = new Set();
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "@" || (index > 0 && !/[\s，。！？、,:;：；!?]/.test(text[index - 1]))) continue;
		const match = options.find(({ token }) => text.startsWith(token, index) && (index + token.length === text.length || /[\s，。！？、,:;：；!?]/.test(text[index + token.length])));
		if (match) { targets.add(match.agentId); index += match.token.length - 1; }
	}
	return [...targets];
}
