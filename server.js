'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'marketplace.db');
const SESSION_DAYS = 7;
const MAX_BODY = 8 * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','vendor','customer')) DEFAULT 'customer',
      status TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
      phone TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      platform_name TEXT NOT NULL DEFAULT 'Nest Marketplace',
      default_commission REAL NOT NULL DEFAULT 8,
      currency TEXT NOT NULL DEFAULT 'EGP',
      support_email TEXT NOT NULL DEFAULT 'support@nest.local'
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      logo TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      city TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','suspended')) DEFAULT 'pending',
      commission_rate REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      category_id INTEGER,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      price REAL NOT NULL CHECK(price >= 0),
      compare_price REAL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
      image TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(store_id) REFERENCES stores(id) ON DELETE CASCADE,
      FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
      subtotal REAL NOT NULL,
      shipping REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('new','processing','partially_shipped','shipped','delivered','cancelled')) DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vendor_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      store_id INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      commission_rate REAL NOT NULL,
      commission_amount REAL NOT NULL,
      vendor_net REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('new','processing','shipped','delivered','cancelled')) DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(store_id) REFERENCES stores(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      vendor_order_id INTEGER NOT NULL,
      product_id INTEGER,
      store_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      image TEXT DEFAULT '',
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(vendor_order_id) REFERENCES vendor_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL,
      FOREIGN KEY(store_id) REFERENCES stores(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      method TEXT NOT NULL,
      account_details TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','paid','rejected')) DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT,
      FOREIGN KEY(store_id) REFERENCES stores(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, user_id),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, active);
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_store ON vendor_orders(store_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  `);
  db.prepare(`INSERT OR IGNORE INTO platform_settings(id) VALUES(1)`).run();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function verifyPassword(password, user) {
  const attempted = Buffer.from(hashPassword(password, user.password_salt).hash, 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  return attempted.length === stored.length && crypto.timingSafeEqual(attempted, stored);
}

function slugify(input, fallback = 'item') {
  const normalized = String(input || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return normalized || fallback;
}

function uniqueSlug(table, input, fallback) {
  const base = slugify(input, fallback);
  let slug = base;
  let i = 2;
  while (db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(slug)) slug = `${base}-${i++}`;
  return slug;
}

function createUser({ name, email, password, role = 'customer', phone = '' }) {
  const { salt, hash } = hashPassword(password);
  const result = db.prepare(`
    INSERT INTO users(name,email,password_hash,password_salt,role,phone)
    VALUES(?,?,?,?,?,?)
  `).run(name.trim(), email.trim().toLowerCase(), hash, salt, role, phone.trim());
  return Number(result.lastInsertRowid);
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return;

  const ownerEmail = String(process.env.OWNER_EMAIL || (IS_PRODUCTION ? '' : 'owner@nest.local')).trim().toLowerCase();
  const ownerPassword = String(process.env.OWNER_PASSWORD || (IS_PRODUCTION ? '' : 'Owner123!'));
  const ownerName = String(process.env.OWNER_NAME || 'Platform Owner').trim();

  if (!ownerEmail || !ownerPassword) {
    throw new Error('OWNER_EMAIL and OWNER_PASSWORD are required for the first production deployment.');
  }
  if (IS_PRODUCTION && ownerPassword.length < 12) {
    throw new Error('OWNER_PASSWORD must contain at least 12 characters in production.');
  }

  createUser({ name: ownerName, email: ownerEmail, password: ownerPassword, role: 'owner' });

  const categories = ['أجهزة كهربائية', 'خضار وفاكهة', 'أطعمة ومشروبات', 'ملابس وأزياء', 'المنزل والمطبخ', 'الصحة والجمال'];
  const catStmt = db.prepare('INSERT INTO categories(name,slug) VALUES(?,?)');
  categories.forEach((name, idx) => catStmt.run(name, `category-${idx + 1}`));

  const includeDemo = envFlag('SEED_DEMO_DATA', !IS_PRODUCTION);
  if (!includeDemo) {
    console.log(`Initial owner created: ${ownerEmail}`);
    return;
  }

  // Public production deployments never use the documented demo passwords.
  const demoPassword = IS_PRODUCTION ? crypto.randomBytes(32).toString('base64url') : 'Vendor123!';
  const customerPassword = IS_PRODUCTION ? crypto.randomBytes(32).toString('base64url') : 'Customer123!';
  const vendorId = createUser({ name: 'Fresh Market Vendor', email: 'vendor@fresh.local', password: demoPassword, role: 'vendor', phone: '01000000001' });
  const techVendorId = createUser({ name: 'Tech World Vendor', email: 'vendor@tech.local', password: demoPassword, role: 'vendor', phone: '01000000003' });
  createUser({ name: 'Demo Customer', email: 'customer@demo.local', password: customerPassword, role: 'customer', phone: '01000000002' });

  const storeResult = db.prepare(`
    INSERT INTO stores(owner_user_id,name,slug,description,logo,phone,city,status,commission_rate)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(vendorId, 'Fresh Market', 'fresh-market', 'منتجات غذائية وطازجة مختارة يوميًا.', 'category-1.png', '01000000001', 'القاهرة', 'approved', 7);
  const storeId = Number(storeResult.lastInsertRowid);
  const techStoreResult = db.prepare(`
    INSERT INTO stores(owner_user_id,name,slug,description,logo,phone,city,status,commission_rate)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(techVendorId, 'Tech World', 'tech-world', 'أجهزة كهربائية وإلكترونيات مختارة بضمان المتجر.', 'category-10.png', '01000000003', 'الجيزة', 'approved', 10);
  const techStoreId = Number(techStoreResult.lastInsertRowid);

  const products = [
    [storeId, 2, 'سلة خضار موسمية', 'seasonal-vegetable-basket', 'خضار طازجة مختارة من السوق.', 220, 250, 30, 'basket-with-fresh-seasonal-vegetables-from-farmer-s-market-fresh-natural-seasonal-products-with-delivery-healthy-varied-diet-basis-fulfilling-life-top-view.jpg'],
    [storeId, 3, 'حبوب قهوة فاخرة', 'premium-coffee-beans', 'حبوب قهوة محمصة بطعم غني.', 340, 390, 45, 'coffee-beans-black-background-with-cups-drink.jpg'],
    [storeId, 3, 'آيس كريم كراميل', 'caramel-ice-cream', 'آيس كريم كراميل كريمي.', 175, 190, 25, 'آيس كريم هاجن داز كراميل كون.png'],
    [storeId, 3, 'بيض عضوي', 'organic-eggs', 'بيض عضوي خالٍ من الأقفاص.', 145, 0, 50, 'بيض عضوي خالي من الأقفاص.png'],
    [techStoreId, 1, 'خلاط كهربائي ذكي', 'smart-electric-blender', 'خلاط متعدد السرعات للاستخدام اليومي.', 1200, 1400, 18, 'product-11-1.jpg'],
    [techStoreId, 1, 'شاشة منزلية عالية الدقة', 'home-hd-display', 'شاشة مناسبة للمنزل والترفيه.', 8900, 9600, 8, 'product-15-1.jpg'],
    [techStoreId, 1, 'سماعة لاسلكية', 'wireless-headphones', 'سماعة لاسلكية خفيفة بصوت واضح.', 950, 1100, 25, 'product-20-2-min.jpg']
  ];
  const productStmt = db.prepare(`
    INSERT INTO products(store_id,category_id,name,slug,description,price,compare_price,stock,image,status)
    VALUES(?,?,?,?,?,?,?,?,?,'approved')
  `);
  products.forEach(p => productStmt.run(...p));
  console.log(`Initial owner created: ${ownerEmail}`);
}


migrate();
seed();

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function text(res, status, data, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function xmlEscape(value) {
  return String(value).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function requestBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.expires_at, u.id,u.name,u.email,u.role,u.status,u.phone
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?
  `).get(token);
  if (!session || session.expires_at < Date.now() || session.status !== 'active') return null;
  if (session.role === 'vendor') {
    session.store = db.prepare('SELECT * FROM stores WHERE owner_user_id=?').get(session.id) || null;
  }
  return session;
}

function requireRole(req, res, roles) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { error: 'يجب تسجيل الدخول أولًا.' }); return null; }
  if (!roles.includes(user.role)) { json(res, 403, { error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' }); return null; }
  return user;
}

function publicProductWhere(query) {
  const clauses = ["p.status='approved'", 'p.active=1', 'p.stock>0', "s.status='approved'"];
  const params = [];
  if (query.get('category')) { clauses.push('c.slug=?'); params.push(query.get('category')); }
  if (query.get('store')) { clauses.push('s.slug=?'); params.push(query.get('store')); }
  if (query.get('q')) { clauses.push('(p.name LIKE ? OR p.description LIKE ? OR s.name LIKE ?)'); const q = `%${query.get('q')}%`; params.push(q, q, q); }
  return { where: clauses.join(' AND '), params };
}

function storeBalance(storeId) {
  const earned = Number(db.prepare(`SELECT COALESCE(SUM(vendor_net),0) AS total FROM vendor_orders WHERE store_id=? AND status='delivered'`).get(storeId).total);
  const reserved = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM payouts WHERE store_id=? AND status IN ('pending','approved','paid')`).get(storeId).total);
  return { earned, reserved, available: Math.max(0, earned - reserved) };
}

function updateMainOrderStatus(orderId) {
  const rows = db.prepare('SELECT status FROM vendor_orders WHERE order_id=?').all(orderId);
  if (!rows.length) return;
  const statuses = rows.map(r => r.status);
  let status = 'processing';
  if (statuses.every(s => s === 'cancelled')) status = 'cancelled';
  else if (statuses.every(s => s === 'delivered' || s === 'cancelled')) status = 'delivered';
  else if (statuses.every(s => ['shipped', 'delivered', 'cancelled'].includes(s))) status = statuses.includes('delivered') ? 'partially_shipped' : 'shipped';
  else if (statuses.every(s => s === 'new')) status = 'new';
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, orderId);
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function serveStatic(reqPath, res) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return text(res, 404, 'Not found');
  const ext = path.extname(target).toLowerCase();
  if (!mime[ext]) return text(res, 403, 'Forbidden');
  res.writeHead(200, {
    'Content-Type': mime[ext],
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/robots.txt' && req.method === 'GET') {
      const base = requestBaseUrl(req);
      return text(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /owner.html\nDisallow: /admin.html\nDisallow: /vendor-dashboard.html\nDisallow: /customer-dashboard.html\nSitemap: ${base}/sitemap.xml\n`);
    }

    if (pathname === '/sitemap.xml' && req.method === 'GET') {
      const base = requestBaseUrl(req);
      const pages = ['/', '/shop.html', '/vendors.html', '/about.html', '/contact.html'];
      const stores = db.prepare(`SELECT slug FROM stores WHERE status='approved' ORDER BY id`).all();
      const products = db.prepare(`SELECT id FROM products WHERE status='approved' AND active=1 ORDER BY id`).all();
      const urls = [
        ...pages.map(item => `${base}${item}`),
        ...stores.map(item => `${base}/vendor-details.html?store=${encodeURIComponent(item.slug)}`),
        ...products.map(item => `${base}/product.html?id=${item.id}`)
      ];
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(loc => `  <url><loc>${xmlEscape(loc)}</loc></url>`).join('\n')}\n</urlset>`;
      return text(res, 200, body, 'application/xml; charset=utf-8');
    }

    if (pathname === '/api/health'  && req.method === 'GET') return json(res, 200, { ok: true, database: path.basename(DB_FILE) });

    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM platform_settings WHERE id=1').get());
    }

    if (pathname === '/api/categories' && req.method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY name').all());
    }

    if (pathname === '/api/stores' && req.method === 'GET') {
      const stores = db.prepare(`
        SELECT s.id,s.name,s.slug,s.description,s.logo,s.city,
               COUNT(DISTINCT p.id) AS products_count,
               COALESCE(ROUND(AVG(r.rating),1),0) AS rating
        FROM stores s
        LEFT JOIN products p ON p.store_id=s.id AND p.status='approved' AND p.active=1
        LEFT JOIN reviews r ON r.product_id=p.id AND r.status='approved'
        WHERE s.status='approved'
        GROUP BY s.id ORDER BY s.id DESC
      `).all();
      return json(res, 200, stores);
    }

    const storeMatch = pathname.match(/^\/api\/stores\/([^/]+)$/);
    if (storeMatch && req.method === 'GET') {
      const store = db.prepare(`SELECT id,name,slug,description,logo,phone,city FROM stores WHERE slug=? AND status='approved'`).get(storeMatch[1]);
      if (!store) return json(res, 404, { error: 'المتجر غير موجود.' });
      store.products = db.prepare(`
        SELECT p.*,c.name AS category_name,c.slug AS category_slug,
               COALESCE(ROUND(AVG(r.rating),1),0) AS rating,COUNT(r.id) AS reviews_count
        FROM products p LEFT JOIN categories c ON c.id=p.category_id
        LEFT JOIN reviews r ON r.product_id=p.id AND r.status='approved'
        WHERE p.store_id=? AND p.status='approved' AND p.active=1
        GROUP BY p.id ORDER BY p.id DESC
      `).all(store.id);
      return json(res, 200, store);
    }

    if (pathname === '/api/products' && req.method === 'GET') {
      const { where, params } = publicProductWhere(url.searchParams);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
      const products = db.prepare(`
        SELECT p.*,s.name AS store_name,s.slug AS store_slug,c.name AS category_name,c.slug AS category_slug,
               COALESCE(ROUND(AVG(r.rating),1),0) AS rating,COUNT(r.id) AS reviews_count
        FROM products p JOIN stores s ON s.id=p.store_id
        LEFT JOIN categories c ON c.id=p.category_id
        LEFT JOIN reviews r ON r.product_id=p.id AND r.status='approved'
        WHERE ${where}
        GROUP BY p.id ORDER BY p.id DESC LIMIT ?
      `).all(...params, limit);
      return json(res, 200, products);
    }

    const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
    if (productMatch && req.method === 'GET') {
      const product = db.prepare(`
        SELECT p.*,s.name AS store_name,s.slug AS store_slug,c.name AS category_name,
               COALESCE(ROUND(AVG(r.rating),1),0) AS rating,COUNT(r.id) AS reviews_count
        FROM products p JOIN stores s ON s.id=p.store_id
        LEFT JOIN categories c ON c.id=p.category_id
        LEFT JOIN reviews r ON r.product_id=p.id AND r.status='approved'
        WHERE p.id=? AND p.status='approved' AND p.active=1 AND s.status='approved'
        GROUP BY p.id
      `).get(Number(productMatch[1]));
      if (!product) return json(res, 404, { error: 'المنتج غير موجود.' });
      product.reviews = db.prepare(`
        SELECT r.rating,r.comment,r.created_at,u.name FROM reviews r JOIN users u ON u.id=r.user_id
        WHERE r.product_id=? AND r.status='approved' ORDER BY r.id DESC
      `).all(product.id);
      return json(res, 200, product);
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const role = body.role === 'vendor' ? 'vendor' : 'customer';
      if (!body.name || !body.email || !body.password) return json(res, 400, { error: 'الاسم والبريد وكلمة المرور مطلوبة.' });
      if (String(body.password).length < 8) return json(res, 400, { error: 'كلمة المرور يجب ألا تقل عن 8 أحرف.' });
      if (role === 'vendor' && !body.storeName) return json(res, 400, { error: 'اسم المتجر مطلوب لحساب البائع.' });
      try {
        db.exec('BEGIN');
        const userId = createUser({ name: body.name, email: body.email, password: body.password, role, phone: body.phone || '' });
        if (role === 'vendor') {
          db.prepare(`INSERT INTO stores(owner_user_id,name,slug,description,phone,city,status) VALUES(?,?,?,?,?,?,'pending')`)
            .run(userId, body.storeName.trim(), uniqueSlug('stores', body.storeName, `store-${userId}`), body.description || '', body.phone || '', body.city || '');
        }
        db.exec('COMMIT');
        return json(res, 201, { message: role === 'vendor' ? 'تم إنشاء حساب البائع وهو الآن بانتظار موافقة مالك المنصة.' : 'تم إنشاء الحساب بنجاح.' });
      } catch (error) {
        db.exec('ROLLBACK');
        if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'البريد الإلكتروني مستخدم بالفعل.' });
        throw error;
      }
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(body.email || '').trim().toLowerCase());
      if (!user || !verifyPassword(body.password || '', user)) return json(res, 401, { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
      if (user.status !== 'active') return json(res, 403, { error: 'الحساب موقوف.' });
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
      db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, user.id, Date.now() + SESSION_DAYS * 86400000);
      const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone };
      if (user.role === 'vendor') safeUser.store = db.prepare('SELECT * FROM stores WHERE owner_user_id=?').get(user.id);
      return json(res, 200, { token, user: safeUser });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = bearer(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = currentUser(req);
      return user ? json(res, 200, user) : json(res, 401, { error: 'غير مسجل الدخول.' });
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      const user = currentUser(req);
      if (!Array.isArray(body.items) || !body.items.length) return json(res, 400, { error: 'السلة فارغة.' });
      if (!body.customerName || !body.email || !body.phone || !body.address) return json(res, 400, { error: 'بيانات العميل والعنوان مطلوبة.' });

      const requested = new Map();
      for (const item of body.items) {
        const id = Number(item.productId || item.id);
        const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
        if (!Number.isInteger(id)) return json(res, 400, { error: 'بيانات منتج غير صالحة.' });
        requested.set(id, (requested.get(id) || 0) + quantity);
      }

      const ids = [...requested.keys()];
      const placeholders = ids.map(() => '?').join(',');
      const products = db.prepare(`
        SELECT p.*,s.status AS store_status,s.commission_rate,ps.default_commission
        FROM products p JOIN stores s ON s.id=p.store_id CROSS JOIN platform_settings ps
        WHERE p.id IN (${placeholders}) AND p.status='approved' AND p.active=1
      `).all(...ids);
      if (products.length !== ids.length) return json(res, 409, { error: 'بعض المنتجات لم تعد متاحة.' });
      for (const p of products) {
        const qty = requested.get(p.id);
        if (p.store_status !== 'approved' || p.stock < qty) return json(res, 409, { error: `الكمية المتاحة من ${p.name} غير كافية.` });
      }

      const groups = new Map();
      for (const p of products) {
        const item = { ...p, quantity: requested.get(p.id) };
        if (!groups.has(p.store_id)) groups.set(p.store_id, []);
        groups.get(p.store_id).push(item);
      }

      const subtotal = products.reduce((sum, p) => sum + p.price * requested.get(p.id), 0);
      const shipping = 0;
      const total = subtotal + shipping;
      const orderNumber = `NM-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(100, 999)}`;

      db.exec('BEGIN IMMEDIATE');
      try {
        const orderResult = db.prepare(`
          INSERT INTO orders(order_number,user_id,customer_name,email,phone,address,city,notes,payment_method,subtotal,shipping,total)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(orderNumber, user?.id || null, body.customerName.trim(), body.email.trim(), body.phone.trim(), body.address.trim(), body.city || '', body.notes || '', body.paymentMethod || 'cash_on_delivery', subtotal, shipping, total);
        const orderId = Number(orderResult.lastInsertRowid);
        const vendorOrderStmt = db.prepare(`
          INSERT INTO vendor_orders(order_id,store_id,subtotal,commission_rate,commission_amount,vendor_net)
          VALUES(?,?,?,?,?,?)
        `);
        const itemStmt = db.prepare(`
          INSERT INTO order_items(order_id,vendor_order_id,product_id,store_id,name,price,quantity,image)
          VALUES(?,?,?,?,?,?,?,?)
        `);
        const stockStmt = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?');

        for (const [storeId, items] of groups) {
          const vendorSubtotal = items.reduce((sum, p) => sum + p.price * p.quantity, 0);
          const rate = Number(items[0].commission_rate ?? items[0].default_commission);
          const commission = Number((vendorSubtotal * rate / 100).toFixed(2));
          const net = Number((vendorSubtotal - commission).toFixed(2));
          const vo = vendorOrderStmt.run(orderId, storeId, vendorSubtotal, rate, commission, net);
          const vendorOrderId = Number(vo.lastInsertRowid);
          for (const p of items) {
            const stockChange = stockStmt.run(p.quantity, p.id, p.quantity);
            if (stockChange.changes !== 1) throw new Error(`Insufficient stock for ${p.name}`);
            itemStmt.run(orderId, vendorOrderId, p.id, storeId, p.name, p.price, p.quantity, p.image || '');
          }
        }
        db.exec('COMMIT');
        return json(res, 201, { orderNumber, subtotal, shipping, total, vendors: groups.size, status: 'new' });
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    if (pathname === '/api/customer/orders' && req.method === 'GET') {
      const user = requireRole(req, res, ['customer']); if (!user) return;
      const orders = db.prepare(`
        SELECT o.*,
               (SELECT COUNT(*) FROM vendor_orders vo WHERE vo.order_id=o.id) AS stores_count,
               (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS items_count
        FROM orders o WHERE o.user_id=? ORDER BY o.id DESC
      `).all(user.id);
      return json(res, 200, orders);
    }

    const reviewMatch = pathname.match(/^\/api\/products\/(\d+)\/reviews$/);
    if (reviewMatch && req.method === 'POST') {
      const user = requireRole(req, res, ['customer']); if (!user) return;
      const body = await readBody(req);
      const productId = Number(reviewMatch[1]);
      const bought = db.prepare(`SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.user_id=? LIMIT 1`).get(productId, user.id);
      if (!bought) return json(res, 403, { error: 'يمكن تقييم المنتجات التي اشتريتها فقط.' });
      const rating = Math.max(1, Math.min(5, Number(body.rating || 0)));
      db.prepare(`
        INSERT INTO reviews(product_id,user_id,rating,comment,status) VALUES(?,?,?,?,'pending')
        ON CONFLICT(product_id,user_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,status='pending',created_at=CURRENT_TIMESTAMP
      `).run(productId, user.id, rating, body.comment || '');
      return json(res, 201, { message: 'تم إرسال التقييم للمراجعة.' });
    }

    // Vendor API
    if (pathname === '/api/vendor/dashboard' && req.method === 'GET') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const store = user.store;
      const productStats = db.prepare(`SELECT COUNT(*) AS total,SUM(status='approved') AS approved,SUM(status='pending') AS pending,COALESCE(SUM(stock),0) AS stock FROM products WHERE store_id=?`).get(store.id);
      const orderStats = db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(subtotal),0) AS sales,COALESCE(SUM(vendor_net),0) AS net FROM vendor_orders WHERE store_id=?`).get(store.id);
      const recentOrders = db.prepare(`
        SELECT vo.*,o.order_number,o.customer_name,o.city,o.created_at,COUNT(oi.id) AS items_count
        FROM vendor_orders vo JOIN orders o ON o.id=vo.order_id LEFT JOIN order_items oi ON oi.vendor_order_id=vo.id
        WHERE vo.store_id=? GROUP BY vo.id ORDER BY vo.id DESC LIMIT 8
      `).all(store.id);
      return json(res, 200, { store, productStats, orderStats, balance: storeBalance(store.id), recentOrders });
    }

    if (pathname === '/api/vendor/store' && req.method === 'PUT') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const body = await readBody(req);
      db.prepare(`UPDATE stores SET name=?,description=?,logo=?,phone=?,city=? WHERE id=?`)
        .run(body.name || user.store.name, body.description || '', body.logo || '', body.phone || '', body.city || '', user.store.id);
      return json(res, 200, { message: 'تم تحديث بيانات المتجر.' });
    }

    if (pathname === '/api/vendor/products' && req.method === 'GET') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      return json(res, 200, db.prepare(`
        SELECT p.*,c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
        WHERE p.store_id=? ORDER BY p.id DESC
      `).all(user.store.id));
    }

    if (pathname === '/api/vendor/products' && req.method === 'POST') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      if (user.store.status !== 'approved') return json(res, 403, { error: 'يجب اعتماد المتجر قبل إضافة المنتجات.' });
      const body = await readBody(req);
      if (!body.name || Number(body.price) < 0) return json(res, 400, { error: 'اسم المنتج والسعر مطلوبان.' });
      const result = db.prepare(`
        INSERT INTO products(store_id,category_id,name,slug,description,price,compare_price,stock,image,status)
        VALUES(?,?,?,?,?,?,?,?,?,'pending')
      `).run(user.store.id, body.categoryId || null, body.name.trim(), uniqueSlug('products', body.name, `product-${Date.now()}`), body.description || '', Number(body.price), Number(body.comparePrice || 0), Math.max(0, Number(body.stock || 0)), body.image || '');
      return json(res, 201, { id: Number(result.lastInsertRowid), message: 'تمت إضافة المنتج وهو بانتظار موافقة الإدارة.' });
    }

    const vendorProductMatch = pathname.match(/^\/api\/vendor\/products\/(\d+)$/);
    if (vendorProductMatch && req.method === 'PUT') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const body = await readBody(req);
      const product = db.prepare('SELECT * FROM products WHERE id=? AND store_id=?').get(Number(vendorProductMatch[1]), user.store.id);
      if (!product) return json(res, 404, { error: 'المنتج غير موجود.' });
      db.prepare(`
        UPDATE products SET category_id=?,name=?,description=?,price=?,compare_price=?,stock=?,image=?,active=?,status='pending' WHERE id=?
      `).run(body.categoryId || null, body.name || product.name, body.description ?? product.description, Number(body.price ?? product.price), Number(body.comparePrice ?? product.compare_price), Math.max(0, Number(body.stock ?? product.stock)), body.image ?? product.image, body.active === false ? 0 : 1, product.id);
      return json(res, 200, { message: 'تم تحديث المنتج وإرساله للمراجعة.' });
    }

    if (pathname === '/api/vendor/orders' && req.method === 'GET') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const orders = db.prepare(`
        SELECT vo.*,o.order_number,o.customer_name,o.phone,o.address,o.city,o.notes,o.payment_method,o.created_at,
               COUNT(oi.id) AS items_count
        FROM vendor_orders vo JOIN orders o ON o.id=vo.order_id LEFT JOIN order_items oi ON oi.vendor_order_id=vo.id
        WHERE vo.store_id=? GROUP BY vo.id ORDER BY vo.id DESC
      `).all(user.store.id);
      for (const order of orders) order.items = db.prepare('SELECT * FROM order_items WHERE vendor_order_id=?').all(order.id);
      return json(res, 200, orders);
    }

    const vendorOrderMatch = pathname.match(/^\/api\/vendor\/orders\/(\d+)$/);
    if (vendorOrderMatch && req.method === 'PATCH') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const body = await readBody(req);
      const allowed = ['new','processing','shipped','delivered','cancelled'];
      if (!allowed.includes(body.status)) return json(res, 400, { error: 'حالة الطلب غير صالحة.' });
      const order = db.prepare('SELECT * FROM vendor_orders WHERE id=? AND store_id=?').get(Number(vendorOrderMatch[1]), user.store.id);
      if (!order) return json(res, 404, { error: 'الطلب غير موجود.' });
      const transitions = { new:['processing','cancelled'], processing:['shipped','cancelled'], shipped:['delivered'], delivered:[], cancelled:[] };
      if (body.status !== order.status && !transitions[order.status].includes(body.status)) return json(res, 409, { error: 'لا يمكن الانتقال إلى هذه الحالة من حالة الطلب الحالية.' });
      db.exec('BEGIN IMMEDIATE');
      try {
        if (body.status === 'cancelled' && order.status !== 'cancelled') {
          const items = db.prepare('SELECT product_id,quantity FROM order_items WHERE vendor_order_id=?').all(order.id);
          const restore = db.prepare('UPDATE products SET stock=stock+? WHERE id=?');
          items.forEach(item => { if (item.product_id) restore.run(item.quantity, item.product_id); });
        }
        db.prepare('UPDATE vendor_orders SET status=? WHERE id=?').run(body.status, order.id);
        updateMainOrderStatus(order.order_id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, { message: 'تم تحديث حالة الطلب.' });
    }

    if (pathname === '/api/vendor/payouts' && req.method === 'GET') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      return json(res, 200, { balance: storeBalance(user.store.id), payouts: db.prepare('SELECT * FROM payouts WHERE store_id=? ORDER BY id DESC').all(user.store.id) });
    }

    if (pathname === '/api/vendor/payouts' && req.method === 'POST') {
      const user = requireRole(req, res, ['vendor']); if (!user) return;
      const body = await readBody(req);
      const amount = Number(body.amount);
      const balance = storeBalance(user.store.id);
      if (!amount || amount <= 0 || amount > balance.available) return json(res, 400, { error: 'المبلغ المطلوب أكبر من الرصيد المتاح أو غير صالح.' });
      db.prepare('INSERT INTO payouts(store_id,amount,method,account_details) VALUES(?,?,?,?)').run(user.store.id, amount, body.method || 'bank_transfer', body.accountDetails || '');
      return json(res, 201, { message: 'تم إرسال طلب سحب الأرباح.' });
    }

    // Owner API
    if (pathname === '/api/owner/dashboard' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const settings = db.prepare('SELECT * FROM platform_settings WHERE id=1').get();
      const stats = {
        vendors: db.prepare("SELECT COUNT(*) AS c FROM stores WHERE status='approved'").get().c,
        pendingVendors: db.prepare("SELECT COUNT(*) AS c FROM stores WHERE status='pending'").get().c,
        customers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='customer'").get().c,
        products: db.prepare("SELECT COUNT(*) AS c FROM products WHERE status='approved'").get().c,
        pendingProducts: db.prepare("SELECT COUNT(*) AS c FROM products WHERE status='pending'").get().c,
        orders: db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
        sales: Number(db.prepare('SELECT COALESCE(SUM(total),0) AS n FROM orders').get().n),
        commission: Number(db.prepare("SELECT COALESCE(SUM(commission_amount),0) AS n FROM vendor_orders WHERE status='delivered'").get().n)
      };
      const recentOrders = db.prepare(`SELECT id,order_number,customer_name,total,status,created_at FROM orders ORDER BY id DESC LIMIT 8`).all();
      return json(res, 200, { settings, stats, recentOrders });
    }

    if (pathname === '/api/owner/settings' && req.method === 'PUT') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      const rate = Math.max(0, Math.min(50, Number(body.defaultCommission)));
      db.prepare('UPDATE platform_settings SET platform_name=?,default_commission=?,currency=?,support_email=? WHERE id=1')
        .run(body.platformName || 'Nest Marketplace', rate, body.currency || 'EGP', body.supportEmail || '');
      return json(res, 200, { message: 'تم حفظ إعدادات المنصة.' });
    }

    if (pathname === '/api/owner/stores' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const status = url.searchParams.get('status');
      const where = status ? 'WHERE s.status=?' : '';
      const params = status ? [status] : [];
      return json(res, 200, db.prepare(`
        SELECT s.*,u.name AS owner_name,u.email AS owner_email,COUNT(p.id) AS products_count
        FROM stores s JOIN users u ON u.id=s.owner_user_id LEFT JOIN products p ON p.store_id=s.id
        ${where} GROUP BY s.id ORDER BY s.id DESC
      `).all(...params));
    }

    const ownerStoreMatch = pathname.match(/^\/api\/owner\/stores\/(\d+)$/);
    if (ownerStoreMatch && req.method === 'PATCH') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      const allowed = ['pending','approved','rejected','suspended'];
      if (!allowed.includes(body.status)) return json(res, 400, { error: 'حالة المتجر غير صالحة.' });
      const commission = body.commissionRate === '' || body.commissionRate == null ? null : Math.max(0, Math.min(50, Number(body.commissionRate)));
      db.prepare('UPDATE stores SET status=?,commission_rate=? WHERE id=?').run(body.status, commission, Number(ownerStoreMatch[1]));
      return json(res, 200, { message: 'تم تحديث المتجر.' });
    }

    if (pathname === '/api/owner/products' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const status = url.searchParams.get('status');
      const where = status ? 'WHERE p.status=?' : '';
      const params = status ? [status] : [];
      return json(res, 200, db.prepare(`
        SELECT p.*,s.name AS store_name,c.name AS category_name FROM products p
        JOIN stores s ON s.id=p.store_id LEFT JOIN categories c ON c.id=p.category_id
        ${where} ORDER BY p.id DESC
      `).all(...params));
    }

    const ownerProductMatch = pathname.match(/^\/api\/owner\/products\/(\d+)$/);
    if (ownerProductMatch && req.method === 'PATCH') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      if (!['pending','approved','rejected'].includes(body.status)) return json(res, 400, { error: 'حالة المنتج غير صالحة.' });
      db.prepare('UPDATE products SET status=? WHERE id=?').run(body.status, Number(ownerProductMatch[1]));
      return json(res, 200, { message: 'تم تحديث حالة المنتج.' });
    }

    if (pathname === '/api/owner/categories' && req.method === 'POST') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'اسم القسم مطلوب.' });
      const result = db.prepare('INSERT INTO categories(name,slug) VALUES(?,?)').run(body.name.trim(), uniqueSlug('categories', body.name, `category-${Date.now()}`));
      return json(res, 201, { id: Number(result.lastInsertRowid), message: 'تمت إضافة القسم.' });
    }

    if (pathname === '/api/owner/orders' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const orders = db.prepare(`
        SELECT o.*,
               (SELECT COUNT(*) FROM vendor_orders vo WHERE vo.order_id=o.id) AS stores_count,
               (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id=o.id) AS items_count,
               (SELECT COALESCE(SUM(vo.commission_amount),0) FROM vendor_orders vo WHERE vo.order_id=o.id) AS platform_commission
        FROM orders o ORDER BY o.id DESC
      `).all();
      return json(res, 200, orders);
    }

    if (pathname === '/api/owner/payouts' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      return json(res, 200, db.prepare(`SELECT p.*,s.name AS store_name,u.email AS vendor_email FROM payouts p JOIN stores s ON s.id=p.store_id JOIN users u ON u.id=s.owner_user_id ORDER BY p.id DESC`).all());
    }

    const payoutMatch = pathname.match(/^\/api\/owner\/payouts\/(\d+)$/);
    if (payoutMatch && req.method === 'PATCH') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      if (!['approved','paid','rejected'].includes(body.status)) return json(res, 400, { error: 'حالة السحب غير صالحة.' });
      db.prepare(`UPDATE payouts SET status=?,processed_at=CASE WHEN ? IN ('paid','rejected') THEN CURRENT_TIMESTAMP ELSE processed_at END WHERE id=?`)
        .run(body.status, body.status, Number(payoutMatch[1]));
      return json(res, 200, { message: 'تم تحديث طلب السحب.' });
    }

    if (pathname === '/api/owner/reviews' && req.method === 'GET') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      return json(res, 200, db.prepare(`SELECT r.*,p.name AS product_name,u.name AS customer_name FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id ORDER BY r.id DESC`).all());
    }

    const reviewOwnerMatch = pathname.match(/^\/api\/owner\/reviews\/(\d+)$/);
    if (reviewOwnerMatch && req.method === 'PATCH') {
      const user = requireRole(req, res, ['owner']); if (!user) return;
      const body = await readBody(req);
      if (!['approved','rejected'].includes(body.status)) return json(res, 400, { error: 'حالة التقييم غير صالحة.' });
      db.prepare('UPDATE reviews SET status=? WHERE id=?').run(body.status, Number(reviewOwnerMatch[1]));
      return json(res, 200, { message: 'تم تحديث التقييم.' });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found' });
    return serveStatic(pathname, res);
  } catch (error) {
    console.error(error);
    return json(res, error.status || 500, { error: error.status ? error.message : 'حدث خطأ داخلي في الخادم.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nest Marketplace running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});

process.on('SIGTERM', () => server.close(() => { try { db.close(); } finally { process.exit(0); } }));
