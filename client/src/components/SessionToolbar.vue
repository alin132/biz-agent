<script setup>
import { ref } from "vue";
import { NButton,NInput,NModal,NSelect,useDialog,useMessage } from "naive-ui";
import { http } from "../api.js";import { can } from "../access.js";
const props=defineProps({session:Object,busy:Boolean});const emit=defineEmits(['updated','removed','busy']);
const message=useMessage(),dialog=useDialog(),renameOpen=ref(false),title=ref(''),working=ref(false);
async function update(path,body,method='POST'){working.value=true;emit('busy',true);try{await http[method.toLowerCase()](`/api/sessions/${props.session.id}${path}`,body);const result=await http.get(`/api/sessions/${props.session.id}`);emit('updated',result);renameOpen.value=false;}catch(e){message.error(e.message);}finally{working.value=false;emit('busy',false);}}
function remove(){dialog.warning({title:'删除对话',content:'这将永久删除当前对话及其历史记录，确定继续？',positiveText:'删除',negativeText:'取消',onPositiveClick:async()=>{try{await http.delete(`/api/sessions/${props.session.id}`);emit('removed');}catch(e){message.error(e.message);return false;}}});}
</script>
<template><div v-if="session" class="action-row chat-operations">
 <template v-if="can('session.run')"><n-select :value="session.activeSkillId" :options="[{label:'不加载技能',value:null},...(session.skills??[]).map(s=>({label:s.name,value:s.id}))]" placeholder="选择技能" :disabled="busy||working" style="width:180px" @update:value="value=>update('/skills',{skillId:value})"/></template>
 <details v-if="can('session.write')" class="more-actions"><summary>会话操作</summary><div class="more-menu"><n-button :disabled="busy" @click="title=session.title||'';renameOpen=true">重命名</n-button><n-button :disabled="busy||working" @click="update('',{archived:!session.archived},'PATCH')">{{session.archived?'取消归档':'归档'}}</n-button><n-button :disabled="busy" type="error" @click="remove">删除对话</n-button></div></details><n-modal v-model:show="renameOpen" preset="card" title="重命名对话" style="width:460px"><n-input v-model:value="title" placeholder="输入标题，留空恢复自动标题" :maxlength="80"/><template #footer><n-button type="primary" :loading="working" @click="update('',{title},'PATCH')">保存标题</n-button></template></n-modal>
</div></template>
