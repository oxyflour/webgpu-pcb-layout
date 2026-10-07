@echo off
rem Build the native router with MSVC (Visual Studio 2022). Output: harness\native\router.exe
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d %~dp0
cl /nologo /O2 /fp:precise /EHsc /std:c++17 router.cpp /Fe:router.exe >build.log 2>&1 || (type build.log & exit /b 1)
