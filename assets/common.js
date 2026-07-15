const API = {
  async request(url, options = {}) {
    const token = localStorage.getItem('marketplaceToken');
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'حدث خطأ غير متوقع');
    return data;
  },
  get(url) { return this.request(url); },
  post(url, body) { return this.request(url, { method: 'POST', body: JSON.stringify(body) }); },
  put(url, body) { return this.request(url, { method: 'PUT', body: JSON.stringify(body) }); },
  patch(url, body) { return this.request(url, { method: 'PATCH', body: JSON.stringify(body) }); }
};

const State = {
  config: { currency: 'EGP', platform_name: 'Nest Marketplace' },
  user: JSON.parse(localStorage.getItem('marketplaceUser') || 'null'),
  cart: JSON.parse(localStorage.getItem('marketplaceCart') || '[]')
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function imageSrc(image) {
  if (!image) return 'category-1.png';
  if (/^(https?:|data:|\/)/.test(image)) return image;
  return encodeURI(image);
}
function money(value) {
  return `${Number(value || 0).toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${State.config.currency || 'EGP'}`;
}
function statusBadge(status) {
  const labels = {pending:'قيد المراجعة',approved:'معتمد',rejected:'مرفوض',suspended:'موقوف',active:'نشط',new:'جديد',processing:'قيد التجهيز',shipped:'تم الشحن',partially_shipped:'شحن جزئي',delivered:'تم التسليم',cancelled:'ملغي',paid:'مدفوع'};
  const cls = ['approved','delivered','paid','active'].includes(status) ? 'success' : ['pending','new','processing','partially_shipped'].includes(status) ? 'warning' : ['shipped'].includes(status) ? 'info' : 'danger';
  return `<span class="badge badge-${cls}">${labels[status] || esc(status)}</span>`;
}
function saveCart() {
  localStorage.setItem('marketplaceCart', JSON.stringify(State.cart));
  updateCartCount();
}
function updateCartCount() {
  const count = State.cart.reduce((n, i) => n + Number(i.quantity || 1), 0);
  document.querySelectorAll('[data-cart-count]').forEach(el => el.textContent = count);
}
function addToCart(product) {
  const existing = State.cart.find(i => Number(i.id) === Number(product.id));
  if (existing) existing.quantity = Math.min(Number(product.stock || 99), existing.quantity + 1);
  else State.cart.push({ id: product.id, name: product.name, price: product.price, image: product.image, store_name: product.store_name, stock: product.stock, quantity: 1 });
  saveCart();
  toast('تمت إضافة المنتج إلى السلة');
}
function toast(message, error = false) {
  let node = document.getElementById('globalToast');
  if (!node) { node = document.createElement('div'); node.id='globalToast'; Object.assign(node.style,{position:'fixed',bottom:'22px',left:'22px',zIndex:9999,padding:'13px 18px',borderRadius:'12px',color:'#fff',fontWeight:'700',boxShadow:'0 12px 30px #0003',transition:'.25s'}); document.body.appendChild(node); }
  node.style.background = error ? '#b42318' : '#087443'; node.textContent = message; node.style.opacity='1';
  clearTimeout(node._timer); node._timer=setTimeout(()=>node.style.opacity='0',2500);
}
function setAuth(token, user) {
  localStorage.setItem('marketplaceToken', token); localStorage.setItem('marketplaceUser', JSON.stringify(user)); State.user=user;
}
function logout() {
  API.post('/api/logout', {}).catch(()=>{}); localStorage.removeItem('marketplaceToken'); localStorage.removeItem('marketplaceUser'); location.href='account.html';
}
function dashboardFor(user = State.user) {
  if (!user) return 'account.html';
  if (user.role === 'owner') return 'owner.html';
  if (user.role === 'vendor') return 'vendor-dashboard.html';
  return 'customer-dashboard.html';
}
function renderHeader(active='') {
  const accountText = State.user ? `مرحبًا، ${esc(State.user.name.split(' ')[0])}` : 'تسجيل الدخول';
  return `<div class="topbar"><div class="container"><span>منصة متعددة البائعين — كل ما تحتاجه في مكان واحد</span><span>دعم البائعين والعملاء</span></div></div>
  <header class="site-header"><div class="container header-row">
    <a class="brand" href="index.html"><span class="brand-mark">N</span><span data-platform-name>${esc(State.config.platform_name)}</span></a>
    <nav class="main-nav"><a class="${active==='home'?'active':''}" href="index.html">الرئيسية</a><a class="${active==='shop'?'active':''}" href="shop.html">المنتجات</a><a class="${active==='vendors'?'active':''}" href="vendors.html">المتاجر</a><a href="account.html?mode=vendor">بع على المنصة</a></nav>
    <div class="nav-actions"><a class="btn btn-outline btn-sm" href="${dashboardFor()}">${accountText}</a><a class="btn btn-primary btn-sm cart-button" href="checkout.html">السلة <span class="cart-count" data-cart-count>0</span></a></div>
  </div></header>`;
}
async function initCommon() {
  try { State.config = await API.get('/api/config'); document.querySelectorAll('[data-platform-name]').forEach(e=>e.textContent=State.config.platform_name); } catch {}
  updateCartCount();
}
document.addEventListener('DOMContentLoaded', initCommon);
