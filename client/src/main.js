/**
 * 应用入口：装配 Naive UI 主题、CSS 变量、路由，挂到 #app。
 */
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.js";
import { applyCssVariables, themeOverrides } from "./theme.js";
import "./styles.css";

// 主题 token 先落成 CSS 变量：原生元素和 Naive 组件共用同一套颜色
applyCssVariables();

const app = createApp(App);

// Naive UI 的按需组件不需要 app.use，themeOverrides 通过 n-config-provider 传。
// 但如果每个页面都要写一层 provider，漏写就会掉回默认蓝——所以由 App.vue 统一包。
app.provide("themeOverrides", themeOverrides);

app.use(router);
app.mount("#app");
