@echo off
REM ============================================================
REM  A.B.D. - Build de l'executable Windows portable (double-clic)
REM  Resultat : dist\ABD.exe (fichier unique et autonome)
REM ============================================================
title A.B.D. - Build executable
cd /d "%~dp0"

echo [A.B.D.] Installation des dependances...
python -m pip install -r requirements.txt pyinstaller
if errorlevel 1 (
    echo.
    echo [A.B.D.] ERREUR : installation impossible. Python est-il installe ?
    pause
    exit /b 1
)

echo.
echo [A.B.D.] Construction de l'executable (quelques minutes)...
python build_exe.py
if errorlevel 1 (
    echo.
    echo [A.B.D.] ERREUR : le build a echoue. Voir les messages ci-dessus.
    pause
    exit /b 1
)

if exist .env (
    copy /y .env dist\.env >nul
    echo [A.B.D.] Fichier .env copie a cote de l'executable.
) else (
    echo [A.B.D.] ATTENTION : pas de fichier .env trouve.
    echo            Creez dist\.env avec : GROQ_API_KEY=votre_cle
)

echo.
echo ============================================================
echo  [A.B.D.] TERMINE : double-cliquez sur  dist\ABD.exe
echo ============================================================
pause
