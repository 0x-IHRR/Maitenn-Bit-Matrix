@echo off
cd /d "%~dp0\..\.."
echo 方正矩阵助手启动后打开 http://127.0.0.1:8790/
echo 只读监控：不发帖、不点赞、不关注、不评论、不转发、不私信。
echo 关掉这个窗口就会停止服务。
npm start
pause
