<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin } from "naive-ui";
import { authApi, healthApi, setAuthToken, setUnauthorizedHandler } from "../api.js";
import { updateAccess } from "../access.js";

const ready = ref(false);
const authenticated = ref(false);
const mode = ref("required");
const user = ref(null);
const email = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const roleLabels = { owner: "所有者", developer: "开发者", operator: "运营", auditor: "审计员" };

function expired() {
	setAuthToken("");
	authenticated.value = false;
	user.value = null;
	updateAccess(null);
}
async function initialize() {
	error.value = "";
	try {
		mode.value = (await healthApi.get()).auth;
		const result = await authApi.me();
		user.value = result.user;
		updateAccess(result);
		authenticated.value = true;
	} catch (cause) {
		if (cause.status !== 401) error.value = cause.message;
	} finally { ready.value = true; }
}
async function login() {
	if (busy.value) return;
	busy.value = true;
	error.value = "";
	try {
		const result = await authApi.login(email.value, password.value);
		setAuthToken(result.token);
		password.value = "";
		user.value = result.user;
		updateAccess(result);
		authenticated.value = true;
	} catch (cause) { error.value = cause.message; }
	finally { busy.value = false; }
}
async function logout() {
	try { await authApi.logout(); expired(); }
	catch (cause) { error.value = cause.message; }
}
setUnauthorizedHandler(expired);
onMounted(initialize);
onBeforeUnmount(() => setUnauthorizedHandler(() => {}));
</script>

<template>
	<div v-if="!ready" class="auth-screen"><n-spin size="large" /></div>
	<template v-else-if="authenticated">
		<n-alert v-if="error" type="error">{{ error }}</n-alert>
		<slot :user="user" :role-label="roleLabels[user?.role] ?? ''" :logout="logout" :auth-required="mode === 'required'" />
	</template>
	<div v-else class="auth-screen">
		<n-card title="登录 biz-agent" style="width: 400px; max-width: 90vw">
			<p class="auth-intro">企业业务智能体工作空间</p>
			<n-alert v-if="error" type="error" style="margin-bottom: 16px">{{ error }}</n-alert>
			<n-form @submit.prevent="login">
				<n-form-item label="邮箱"><n-input v-model:value="email" placeholder="请输入邮箱" autocomplete="username" /></n-form-item>
				<n-form-item label="密码"><n-input v-model:value="password" type="password" placeholder="请输入密码" autocomplete="current-password" show-password-on="click" /></n-form-item>
				<n-button type="primary" attr-type="submit" block :loading="busy">登录</n-button>
			</n-form>
			<n-button v-if="error" text style="margin-top: 12px" @click="initialize">重新连接</n-button>
		</n-card>
	</div>
</template>

<style scoped>
.auth-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
</style>
