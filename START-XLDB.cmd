@echo off
rem AgentJev is optional and never holds the launch: -Launch returns within seconds. When the model is not verified yet
rem it starts a detached download bounded to 600 s per start, and the core starts at once in degraded mode.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0tools\install-agent-model.ps1" -Launch
if errorlevel 1 (
  echo AgentJev is not ready yet. XLDB starts now in degraded mode: NPC emotion ranking uses the deterministic order.
  echo The background download resumes from the verified parts and the core switches to AgentJev once it is ready.
  echo To stop trying, create the file .local\agentjev\skip
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" -Mode Tavern -OpenTavern %*
if errorlevel 1 pause
