@echo off
rem HtmlDeck from this plugin's own copy: htmldeck-run [notes] [args...]
setlocal
set "HD_PY="
for %%P in (python3 python) do if not defined HD_PY (
  %%P -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "HD_PY=%%P"
)
if not defined HD_PY (
  py -3 -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "HD_PY=py -3"
)
if not defined HD_PY (
  echo htmldeck: requires Python 3.11+ - install from https://www.python.org/downloads/ or run: uv python install 3.12 1>&2
  exit /b 127
)
%HD_PY% "%~dp0launcher.py" %*
exit /b %errorlevel%
