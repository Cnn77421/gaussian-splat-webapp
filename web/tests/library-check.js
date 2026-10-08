import { WorkGallery } from '../work-gallery.js';
import { LocalWorkStore } from '../library-store.js';
import { SuperSplatPreview } from '../supersplat-preview.js';
const report = { checks: [], errors: [] };
const result = document.querySelector('#results'), status = document.querySelector('#status');
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function until(fn) { for (let i=0;i<600;i++) { if (fn()) return; await frame(); } throw new Error('等待操作完成超时'); }
function check(ok,name) { report.checks.push({ok:!!ok,name}); const li=document.createElement('li');li.className=ok?'pass':'fail';li.textContent=`${ok?'PASS':'FAIL'} · ${name}`;result.append(li); }
window.addEventListener('unhandledrejection',event=>report.errors.push(String(event.reason)));
document.querySelector('#run').onclick=async()=>{
  document.querySelector('#run').disabled=true; result.replaceChildren();report.checks.length=report.errors.length=0;status.textContent='验证中';
  const suffix=crypto.randomUUID(), store=new LocalWorkStore(`splat-library-test-${suffix}`);
  const dialog=document.querySelector('#gallery');let deleted=[],selected=[],calls=[],failDelete=true;
  const gallery=new WorkGallery({dialog,trigger:document.querySelector('#galleryOpen'),store,onSelect:work=>selected.push(work.id),onDelete:work=>deleted.push(work.id),
    fetcher:async(url,options)=>{calls.push({url,method:options.method});return failDelete?new Response(JSON.stringify({error:'测试删除失败'}),{status:409}):new Response(JSON.stringify({ok:true}),{status:200});}});
  const remote={id:`test-job-${suffix}`,filename:'TEST_GENERATED.ply',status:'done',createdAt:1,stats:{splatCount:4800}};
  let preview;
  try {
    await gallery.render([remote]);
    check(gallery.cards.size===1,'生成作品保留在作品库中');
    const bytes=await(await fetch('./interaction.ply')).arrayBuffer();
    const file=new File([bytes],`TEST_LOCAL_${suffix}.ply`,{lastModified:1});
    preview=new SuperSplatPreview({rootElement:document.querySelector('#preview')});
    const handle=await preview.load('./interaction.ply',{modelKey:`test:cover-${suffix}`,auxiliary:true});
    await gallery.saveCover(remote.id,handle);preview.dispose();
    await gallery.addFiles([file]);
    const local=(await store.list())[0];
    check(!!local&&local.stats.splatCount===4800,'添加真实 PLY 经原生解码后保存全部高斯数量');
    const stored=await store.get(local.id);
    check(stored.file.size===bytes.byteLength&&gallery.cards.size===2,'模型字节提交到 IndexedDB 并显示新增卡片');
    await until(()=>!!gallery.cards.get(local.id).querySelector('img'));
    check(gallery.cards.get(local.id).querySelector('img').getAttribute('src').startsWith('blob:'),'新增作品带实际模型封面');
    await gallery.addFiles([file]);
    check((await store.list()).length===1&&dialog.querySelector('[data-message]').textContent.includes('已存在'),'重复添加同一文件不会产生重复卡片');
    await gallery.addFiles([new File(['not a PLY'],'INVALID.ply')]);
    check((await store.list()).length===1&&dialog.querySelector('[data-message]').classList.contains('error'),'无效 PLY 显示错误且不产生虚假作品');
    const fresh=new LocalWorkStore(`splat-library-test-${suffix}`);
    check((await fresh.get(local.id)).file.size===bytes.byteLength,'重新连接存储仍可读取完整 PLY');
    (await fresh.database).close();
    dialog.showModal();
    dialog.querySelector('[data-search]').value='TEST_LOCAL';dialog.querySelector('[data-search]').dispatchEvent(new Event('input'));
    check(!gallery.cards.get(local.id).hidden&&gallery.cards.get(remote.id).hidden,'搜索仍能筛选添加的本地作品');
    gallery.cards.get(local.id).querySelector('.work-open').click();
    check(selected[0]===local.id&&!dialog.open,'新增卡片可点击展示');
    dialog.showModal();
    const pref=`splat.view.v2.${encodeURIComponent(`library:${local.id}`)}`;localStorage.setItem(pref,JSON.stringify({pose:{test:true}}));
    gallery.cards.get(local.id).querySelector('.work-delete').click();
    check(!dialog.querySelector('[data-delete-confirmation]').hidden&&(await store.list()).length===1&&selected.length===1,'点击删除仅展示确认，不误打开或直接删除作品');
    dialog.querySelector('[data-cancel-delete]').click();
    check(dialog.querySelector('[data-delete-confirmation]').hidden&&(await store.list()).length===1,'取消删除保持模型和卡片');
    gallery.cards.get(local.id).querySelector('.work-delete').click();dialog.querySelector('[data-confirm-delete]').click();await until(()=>!gallery.busy);
    check(!(await store.get(local.id))&&!gallery.cards.has(local.id)&&deleted[0]===local.id,'确认后删除本地模型，更新卡片并通知当前预览');
    check(!localStorage.getItem(pref)&&!gallery.urls.has(local.id),'删除清除默认视角与封面 URL');
    const oldFile=stored.file;check(oldFile.size===bytes.byteLength,'导入的原始文件保持可用');
    dialog.querySelector('[data-search]').value='';gallery.filter();
    gallery.cards.get(remote.id).querySelector('.work-delete').click();dialog.querySelector('[data-confirm-delete]').click();await until(()=>!gallery.busy);
    check(calls[0].method==='DELETE'&&calls[0].url===`/api/jobs?id=${encodeURIComponent(remote.id)}`,'生成作品确认删除调用既有后端接口');
    check(gallery.cards.has(remote.id)&&dialog.querySelector('[data-message]').textContent==='测试删除失败'&&deleted.length===1,'后端删除失败保留作品并显示错误');
    failDelete=false;dialog.querySelector('[data-confirm-delete]').click();await until(()=>!gallery.busy);
    check(!gallery.cards.has(remote.id)&&deleted.includes(remote.id)&&gallery.jobs.length===0,'重试成功后移除生成作品并显示空状态');
    await gallery.render([remote]);
    check(!gallery.cards.has(remote.id),'删除后过期列表响应不会复活作品');
    check(report.errors.length===0,'添加、取消、失败、删除与封面生成无未处理异常');
  } catch(error) { check(false,error.stack||String(error)); }
  finally {
    preview?.dispose();gallery.dispose();dialog.close();
    for(const work of await store.list())await store.remove(work.id);
    const db=await store.database;db.close();
    report.passed=report.checks.filter(c=>c.ok).length;report.failed=report.checks.length-report.passed;
    document.querySelector('#report').textContent=JSON.stringify(report,null,2);status.textContent=`${report.passed} 项通过，${report.failed} 项失败`;document.querySelector('#run').disabled=false;
  }
};
