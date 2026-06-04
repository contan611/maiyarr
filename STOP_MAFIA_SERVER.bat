@echo off
set PORT=8787
powershell -NoProfile -ExecutionPolicy Bypass -Command "$listeners = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; foreach ($l in $listeners) { Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue }"
