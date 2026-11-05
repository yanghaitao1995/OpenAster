export function normalizeGateway(value, { native = false } = {}) {
  if (!String(value).trim()) return '';
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('请输入完整的 HTTPS 网关地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !native)) throw new Error('网关必须使用 HTTPS；仅桌面浏览器允许本机 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('网关地址不能包含用户名、密码、查询参数或锚点。');
  if (url.pathname !== '/') throw new Error('请使用网关根地址，不要附加路径。');
  return url.origin;
}
