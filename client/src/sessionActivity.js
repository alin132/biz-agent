import { computed, onBeforeUnmount, ref } from "vue";
export function useSessionActivity(){
	const tools=ref([]),pending=ref([]),lastDurationMs=ref(0),runningSince=ref(0),now=ref(Date.now());
	let timer=null;
	const elapsedMs=computed(()=>runningSince.value?Math.max(0,now.value-runningSince.value):lastDurationMs.value);
	function hydrate(view){
		pending.value=view.pendingApprovals??[];
		const turns=(view.transcript??[]).filter(item=>item.role==='user');
		lastDurationMs.value=Number(turns.at(-1)?.durationMs??0);
		tools.value=turns.flatMap(turn=>(turn.tools??[]).map(tool=>({...tool,running:false}))).slice(-20);
		if(!tools.value.length)tools.value=(view.audit??[]).slice(-20).map((item,index)=>({id:`history-${index}`,name:item.toolName,args:item.args,ok:item.ok,running:false}));
		runningSince.value=view.running?Date.now():0;
		clearInterval(timer);timer=null;
		if(view.running)timer=setInterval(()=>{now.value=Date.now();},250);
	}
	function event(payload){
		if(payload.type==='tool_start')tools.value.push({id:payload.id,name:payload.name,args:payload.args,running:true});
		if(payload.type==='tool_end'){const row=tools.value.find(t=>t.id===payload.id);if(row)Object.assign(row,{running:false,ok:payload.ok,result:payload.result,durationMs:payload.durationMs});}
		if(payload.type==='busy'&&payload.running){runningSince.value=Date.now();lastDurationMs.value=0;clearInterval(timer);timer=setInterval(()=>{now.value=Date.now();},250);}
		if(payload.type==='busy'&&!payload.running){if(runningSince.value)lastDurationMs.value=Date.now()-runningSince.value;runningSince.value=0;clearInterval(timer);timer=null;}
		if(payload.type==='approval'&&!pending.value.some(p=>p.requestId===payload.requestId))pending.value.push(payload);
		if(payload.type==='done'||payload.type==='error')pending.value=[];
	}
	function resolved(id){pending.value=pending.value.filter(p=>p.requestId!==id);}
	onBeforeUnmount(()=>clearInterval(timer));
	return {tools,pending,elapsedMs,hydrate,event,resolved};
}
