// This code is served as an external resource, so public pages need no inline event handlers.
export const blogReaderScript = `(() => {
  'use strict';
  const status = document.querySelector('[data-reader-status]');
  const report = message => { if (status) status.textContent = message; };
  const copy = async text => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text; field.setAttribute('readonly', '');
        field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.append(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('copy unavailable');
      }
      return true;
    } catch { return false; }
  };
  document.querySelectorAll('.article-body pre').forEach(pre => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'copy-code'; button.textContent = '复制代码';
    const code = pre.querySelector('code');
    button.addEventListener('click', async () => {
      const ok = await copy(code ? code.textContent : Array.from(pre.childNodes).filter(node => node !== button).map(node => node.textContent).join(''));
      button.textContent = ok ? '已复制' : '复制失败'; report(ok ? '代码已复制' : '无法复制，请手动选择代码');
      window.setTimeout(() => { button.textContent = '复制代码'; }, 2000);
    });
    pre.prepend(button);
  });
  const url = document.querySelector('link[rel="canonical"]')?.href || location.href;
  document.querySelector('[data-copy-link]')?.addEventListener('click', async () => report(await copy(url) ? '链接已复制' : '无法复制，请复制地址栏链接'));
  document.querySelector('[data-share]')?.addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title: document.querySelector('article h1')?.textContent || document.title, url });
      else report(await copy(url) ? '链接已复制，可以分享给朋友' : '请复制地址栏链接分享');
    } catch (error) { if (error.name !== 'AbortError') report('暂时无法分享，请复制链接'); }
  });
})();`;
