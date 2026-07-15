# Architecture

## التقنية الحالية
- Frontend: HTML + CSS + Vanilla JavaScript، واجهة عربية RTL ومتجاوبة.
- Backend: Node.js HTTP server بدون مكتبات خارجية.
- Database: SQLite عبر `node:sqlite`.
- Authentication: Bearer sessions محفوظة في قاعدة البيانات لمدة 7 أيام.
- Passwords: `scrypt` مع salt مستقل لكل مستخدم.

## الكيانات الأساسية
- `users`: مالك المنصة، البائعون، والعملاء.
- `stores`: متجر مستقل لكل بائع وحالة اعتماد وعمولة خاصة اختيارية.
- `categories`: أقسام المنتجات.
- `products`: منتجات مرتبطة بمتجر وقسم وحالة مراجعة.
- `orders`: الطلب الرئيسي الخاص بالعميل.
- `vendor_orders`: الأجزاء المنفصلة من الطلب لكل متجر، مع العمولة وصافي البائع.
- `order_items`: عناصر الطلب وربطها بالطلب الرئيسي والطلب الفرعي.
- `payouts`: طلبات سحب أرباح البائعين.
- `reviews`: تقييمات العملاء التي تحتاج مراجعة الإدارة.
- `platform_settings`: اسم المنصة والعملة والعمولة الافتراضية.

## منطق الطلب متعدد البائعين
1. الخادم يعيد قراءة أسعار المنتجات والمخزون من قاعدة البيانات، ولا يثق في سعر المتصفح.
2. تُجمع العناصر حسب `store_id`.
3. يُنشأ طلب رئيسي واحد.
4. يُنشأ `vendor_order` لكل متجر.
5. تُحسب العمولة من العمولة الخاصة بالمتجر أو العمولة الافتراضية.
6. يُخفض المخزون داخل transaction واحدة.
7. عند إلغاء طلب فرعي، يُعاد مخزونه تلقائيًا.
8. تصبح أرباح البائع متاحة للسحب بعد حالة `delivered`.

## انتقالات حالة الطلب الفرعي
- `new` → `processing` أو `cancelled`
- `processing` → `shipped` أو `cancelled`
- `shipped` → `delivered`
- `delivered` و`cancelled` حالات نهائية.

## التوسع المقترح
- فصل الواجهة إلى React/Next.js أو Vue/Nuxt.
- فصل API إلى NestJS أو Laravel.
- PostgreSQL مع migrations وconnection pooling.
- Redis للجلسات والكاش والـ queues.
- S3-compatible storage للصور.
- Webhooks للدفع والشحن.
- Background workers للإشعارات والتقارير.
