@echo off
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\install-agent-model.ps1"
if errorlevel 1 (
  echo AgentJev model installation failed. XLDB was not started.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" -Mode Tavern -OpenTavern %*
if errorlevel 1 pause
