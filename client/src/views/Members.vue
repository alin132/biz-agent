<script setup>
import { onMounted, ref } from "vue";
import { NAlert,NButton,NEmpty,NModal,NForm,NFormItem,NInput,NSelect,NTag,useDialog,useMessage } from "naive-ui";
import PageShell from "../components/PageShell.vue";
import Panel from "../components/Panel.vue";
import { membersApi } from "../api.js";
import { access,can } from "../access.js";
const users=ref([]),loading=ref(false),error=ref(""),open=ref(false),busy=ref(false),editing=ref(null);
const form=ref({name:"",email:"",password:"",role:"operator"});
const roles=[{label:"所有者",value:"owner"},{label:"开发者",value:"developer"},{label:"运营",value:"operator"},{label:"审计员",value:"auditor"}];
const message=useMessage(),dialog=useDialog();
async function load(){loading.value=true;error.value="";try{users.value=await membersApi.list();}catch(e){error.value=e.message;}finally{loading.value=false;}}
function edit(user){editing.value=user?.id??null;form.value={name:user?.name??"",email:user?.email??"",password:"",role:user?.role??"operator"};open.value=true;}
async function save(){busy.value=true;try{if(editing.value)await membersApi.patch(editing.value,{name:form.value.name,role:form.value.role});else await membersApi.create(form.value);form.value.password="";open.value=false;await load();message.success("成员已保存");}catch(e){message.error(e.message);}finally{busy.value=false;}}
async function change(user){busy.value=true;try{await membersApi.patch(user.id,{disabled:!user.disabled});await load();}catch(e){message.error(e.message);}finally{busy.value=false;}}
function remove(user){dialog.warning({title:"删除成员",content:`确定删除「${user.name||user.email}」？此操作不可撤销。`,positiveText:"删除",negativeText:"取消",onPositiveClick:async()=>{try{await membersApi.remove(user.id);await load();message.success("成员已删除");}catch(e){message.error(e.message);return false;}}});}
onMounted(load);
</script>
<template><PageShell title="成员" subtitle="管理工作空间成员、角色与账号状态" :loading="loading" :error="error"><template #actions><n-button v-if="can('member.manage')" type="primary" @click="edit(null)">添加成员</n-button></template>
<n-alert type="info" :bordered="false" style="margin-bottom:16px">账号停用后无法继续发起请求。自己的角色和状态不可修改，工作空间必须保留一位启用的所有者。</n-alert>
<Panel><div class="table-wrap"><table class="data-table"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="user in users" :key="user.id"><td>{{user.name||user.email}}<span class="secondary">{{user.email}} {{user.id===access.user?.id?'（我）':''}}</span></td><td>{{roles.find(r=>r.value===user.role)?.label}}</td><td><n-tag :type="user.disabled?'default':'success'">{{user.disabled?'已停用':'正常'}}</n-tag></td><td><div class="action-row"><n-button size="small" :disabled="user.id===access.user?.id" @click="edit(user)">编辑</n-button><n-button size="small" :disabled="user.id===access.user?.id||busy" @click="change(user)">{{user.disabled?'启用':'停用'}}</n-button><n-button size="small" :disabled="user.id===access.user?.id" quaternary type="error" @click="remove(user)">删除</n-button></div></td></tr></tbody></table></div><n-empty v-if="!users.length&&!loading" description="没有成员记录" /></Panel>
<n-modal v-model:show="open" preset="card" :title="editing?'编辑成员':'添加成员'" style="width:480px"><n-form label-placement="top"><n-form-item label="姓名"><n-input v-model:value="form.name" /></n-form-item><n-form-item label="邮箱" required><n-input v-model:value="form.email" :disabled="!!editing" /></n-form-item><n-form-item v-if="!editing" label="初始密码" required><n-input v-model:value="form.password" type="password" autocomplete="new-password" /></n-form-item><n-form-item label="角色"><n-select v-model:value="form.role" :options="roles" /></n-form-item></n-form><template #footer><div class="action-row"><n-button @click="open=false;form.password=''">取消</n-button><n-button type="primary" :loading="busy" @click="save">保存</n-button></div></template></n-modal></PageShell></template>
