@echo off
rem Build the native router and detail pass with MSVC. Output: harness\native\router.exe, detail.exe
rem VCVARS: path of vcvars64.bat; default: the latest Visual Studio found by vswhere.
if not defined VCVARS for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do set "VCVARS=%%i\VC\Auxiliary\Build\vcvars64.bat"
call "%VCVARS%" >nul || exit /b 1
cd /d %~dp0
cl /nologo /O2 /fp:precise /EHsc /std:c++17 router.cpp /Fe:router.exe >build.log 2>&1 || (type build.log & exit /b 1)
cl /nologo /O2 /fp:precise /EHsc /std:c++17 detail.cpp /Fe:detail.exe >>build.log 2>&1 || (type build.log & exit /b 1)
