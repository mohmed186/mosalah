@echo off
chcp 65001 >nul
echo تأكد من إغلاق الخادم قبل المتابعة.
del /q marketplace.db 2>nul
del /q marketplace.db-wal 2>nul
del /q marketplace.db-shm 2>nul
echo تم حذف قاعدة البيانات. ستُنشأ نسخة تجريبية جديدة عند التشغيل التالي.
pause
