import{j as H,K,N as Q,w as W,n as x,O as o,r as n,v as X,m as l,H as r,q as f,p as j,o as Y,f as Z,G as i,l as J,A as c,M as h,k as $,y as v}from"./index.js";const ee={style:{width:"100%"}},te={style:{display:"flex","justify-content":"space-between",gap:"8px","align-items":"center"}},ae={style:{"font-weight":"600","word-break":"break-all"}},oe={style:{"font-size":"12px",color:"#8c8c8c","margin-top":"4px"}},ne={style:{"font-size":"12px",color:"#8c8c8c","margin-top":"4px"}},le={key:0,style:{"font-size":"12px",color:"#ff4d4f","margin-top":"4px","word-break":"break-all"}},se={class:"schema-panel"},ie={class:"schema-json"},re={class:"schema-json"},ue={__name:"adapters",setup(de){const p=K(),w=c(!1),b=c(!1),k=c(!1),t=c(""),u=c(""),_=c(!1),y=c(""),d=J(()=>p.adaptersMeta),S=J(()=>d.value.find(a=>a.id===t.value)||null);function I(a){return`export const manifest = {
  id: '${a}',
  name: '${a}',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        title: 'Prompt',
        description: '输入提示词',
        'x-ui': 'textarea'
      }
    }
  },
  outputJsonSchema: {
    type: 'object',
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        title: 'Message'
      }
    }
  },
  async execute(ctx, input) {
    const { page, api } = ctx;
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    api.log('info', '开始执行适配器', { promptLength: String(input.prompt || '').length });
    return { message: '请编辑脚本后再调用 /api/${a}' };
  }
};
`}async function m(){w.value=!0;try{await p.fetchAdaptersMeta(),!t.value&&d.value.length>0?t.value=d.value[0].id:t.value&&!d.value.some(a=>a.id===t.value)&&(t.value=d.value[0]?.id||"")}finally{w.value=!1}}async function C(a){if(!a){u.value="";return}b.value=!0;try{u.value=await p.fetchAdapterSource(a)}catch(e){$.error(e.message),u.value=""}finally{b.value=!1}}async function O(){if(t.value){k.value=!0;try{await p.saveAdapterSource(t.value,u.value),await m(),await C(t.value)}catch(a){h.error({title:"保存失败",content:a.message})}finally{k.value=!1}}}function T(){y.value="",_.value=!0}async function V(){const a=y.value.trim();if(!a){$.warning("请输入适配器 ID");return}try{await p.saveAdapterSource(a,I(a)),_.value=!1,await m(),t.value=a}catch(e){h.error({title:"创建失败",content:e.message})}}function B(){t.value&&h.confirm({title:"删除适配器脚本",content:`确定要删除 ${t.value} 吗？`,okText:"删除",okType:"danger",cancelText:"取消",async onOk(){await p.deleteAdapterSource(t.value),t.value="",u.value="",await m()}})}return Q(t,async a=>{await C(a)}),W(async()=>{await m()}),(a,e)=>{const g=i("a-button"),A=i("a-space"),M=i("a-empty"),D=i("a-tag"),U=i("a-list-item"),q=i("a-list"),z=i("a-card"),N=i("a-col"),L=i("a-alert"),R=i("a-textarea"),F=i("a-row"),P=i("a-input"),E=i("a-modal"),G=i("a-layout");return v(),x(G,{style:{background:"transparent",gap:"16px"}},{default:o(()=>[n(F,{gutter:16},{default:o(()=>[n(N,{xs:24,lg:7},{default:o(()=>[n(z,{title:"适配器脚本",bordered:!1},{extra:o(()=>[n(A,null,{default:o(()=>[n(g,{type:"link",onClick:m,loading:w.value},{default:o(()=>[...e[3]||(e[3]=[f("刷新",-1)])]),_:1},8,["loading"]),n(g,{type:"primary",size:"small",onClick:T},{default:o(()=>[...e[4]||(e[4]=[f("新建",-1)])]),_:1})]),_:1})]),default:o(()=>[d.value.length===0?(v(),x(M,{key:0,description:"暂无适配器脚本，请先新建"})):(v(),x(q,{key:1,"data-source":d.value,size:"small",bordered:""},{renderItem:o(({item:s})=>[n(U,{onClick:ce=>t.value=s.id,style:X({cursor:"pointer",background:t.value===s.id?"#e6f4ff":""})},{default:o(()=>[l("div",ee,[l("div",te,[l("span",ae,r(s.id),1),n(D,{color:s.valid?"success":"error"},{default:o(()=>[f(r(s.valid?"有效":"无效"),1)]),_:2},1032,["color"])]),l("div",oe,r(s.name||s.id),1),l("div",ne,[l("code",null,r(s.endpoint),1)]),s.error?(v(),j("div",le,r(s.error),1)):Y("",!0)])]),_:2},1032,["onClick","style"])]),_:1},8,["data-source"]))]),_:1})]),_:1}),n(N,{xs:24,lg:17},{default:o(()=>[n(z,{title:t.value?`编辑脚本 - ${t.value}`:"适配器脚本编辑器",bordered:!1},{extra:o(()=>[n(A,null,{default:o(()=>[n(g,{danger:"",onClick:B,disabled:!t.value},{default:o(()=>[...e[5]||(e[5]=[f("删除",-1)])]),_:1},8,["disabled"]),n(g,{type:"primary",onClick:O,loading:k.value,disabled:!t.value},{default:o(()=>[...e[6]||(e[6]=[f("保存",-1)])]),_:1},8,["loading","disabled"])]),_:1})]),default:o(()=>[t.value?(v(),j(Z,{key:1},[l("div",se,[l("div",null,[e[7]||(e[7]=l("div",{class:"schema-title"},"接口路径",-1)),l("code",null,r(S.value?.endpoint),1)]),l("div",null,[e[8]||(e[8]=l("div",{class:"schema-title"},"输入 Schema",-1)),l("pre",ie,r(JSON.stringify(S.value?.inputJsonSchema,null,2)),1)]),l("div",null,[e[9]||(e[9]=l("div",{class:"schema-title"},"输出 Schema",-1)),l("pre",re,r(JSON.stringify(S.value?.outputJsonSchema,null,2)),1)])]),n(L,{type:"info","show-icon":"",style:{"margin-bottom":"12px"},message:"保存时仅做静态校验。接口测试请前往“请求 API”，页面级排障请使用 /admin/debug/run。"}),n(R,{value:u.value,"onUpdate:value":e[0]||(e[0]=s=>u.value=s),"auto-size":{minRows:24,maxRows:32},disabled:b.value,style:{"font-family":"'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"}},null,8,["value","disabled"])],64)):(v(),x(M,{key:0,description:"请选择或创建一个适配器脚本"}))]),_:1},8,["title"])]),_:1})]),_:1}),n(E,{open:_.value,"onUpdate:open":e[2]||(e[2]=s=>_.value=s),title:"新建适配器脚本","ok-text":"创建","cancel-text":"取消",onOk:V},{default:o(()=>[e[10]||(e[10]=l("div",{style:{"font-size":"12px",color:"#8c8c8c","margin-bottom":"8px"}}," 适配器 ID 将同时作为文件名、manifest.id 与接口路径 /api/{adapter_id}。 ",-1)),n(P,{value:y.value,"onUpdate:value":e[1]||(e[1]=s=>y.value=s),placeholder:"例如: chatgpt"},null,8,["value"])]),_:1},8,["open"])]),_:1})}}},ve=H(ue,[["__scopeId","data-v-543770fb"]]);export{ve as default};
