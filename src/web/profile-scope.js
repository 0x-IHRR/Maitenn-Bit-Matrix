// 页面固定到加载时的范围；cookie 被其他标签页切换后，拒绝旧页 API 请求。
(() => {
  const readScope = () => {
    const value = document.cookie.match(/(?:^|;\s*)bt_profile=([^;]*)/)?.[1];
    try { const decoded=value ? decodeURIComponent(value) : 'matrix'; return decoded==='legacy' ? 'matrix' : decoded; } catch { return 'matrix'; }
  };
  const initialScope = readScope();
  const savedScope=document.cookie.match(/(?:^|;\s*)bt_profile=([^;]*)/)?.[1];
  if (!savedScope || savedScope==='legacy') document.cookie='bt_profile=matrix; Path=/; SameSite=Strict; Max-Age=31536000';
  const nativeFetch = window.fetch.bind(window);
  window.MaitianProfileScope = Object.freeze({scope:initialScope});
  function conflict() {
    const message = '查看范围已在其他标签页改变，请刷新本页后再操作。';
    if (document.body && !document.getElementById('bt-scope-conflict')) {
      const banner = document.createElement('div'); banner.id='bt-scope-conflict';banner.className='bt-scope-conflict';banner.setAttribute('role','alert');
      banner.append(document.createTextNode(message + ' '));
      const button=document.createElement('button');button.type='button';button.className='btn';button.textContent='刷新本页';button.addEventListener('click',()=>location.reload());banner.append(button);document.body.prepend(banner);
    }
    return new Error(message);
  }
  window.fetch = function(input, init) {
    let url;
    try {url=new URL(input instanceof Request ? input.url : input, location.href);} catch {return nativeFetch(input,init);}
    if (url.origin!==location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input,init);
    if (readScope()!==initialScope) return Promise.reject(conflict());
    // init.headers replaces Request headers, matching native fetch semantics.
    const headers=new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Maitian-Profile',initialScope);
    return nativeFetch(input,{...init,headers}).then(response=>{
      if (readScope()!==initialScope) throw conflict();
      return response;
    });
  };
})();
