import { reactive } from "vue";

export const access = reactive({ user: null, permissions: [] });
export function updateAccess(result) {
	access.user = result?.user ?? null;
	access.permissions = result?.permissions ?? [];
}
export function can(permission) {
	return access.permissions.includes(permission);
}
