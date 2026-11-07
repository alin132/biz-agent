<script setup>
import { h } from "vue";
console.log("PROBE-BEGIN");
try {
	const node = h("div", { innerHTML: '<path d="M4 4h7v7H4z" />' });
	console.log("PROBE-1 ok", typeof node);
} catch (e) {
	console.log("PROBE-1 ERR", e.message);
}
</script>
<template><div>probe</div></template>
