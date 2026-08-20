@echo off
rem dsh-fleet 一键安装器入口（双击或命令行运行）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
