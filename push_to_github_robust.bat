@echo off
setlocal enabledelayedexpansion
echo --- Starting Git Push --- > git_log.txt

cd /d "e:\nueva web ajedrez\migracion-ajedrez" >> git_log.txt 2>&1
git config --local user.email "bot@example.com" >> git_log.txt 2>&1
git config --local user.name "AI Bot" >> git_log.txt 2>&1
git init >> git_log.txt 2>&1
git add . >> git_log.txt 2>&1
git commit -m "Initial commit from AI" >> git_log.txt 2>&1
git branch -M main >> git_log.txt 2>&1
git remote remove origin >> git_log.txt 2>&1
git remote add origin https://github.com/azabartefj5-cell/ajedrez-alcala-backend.git >> git_log.txt 2>&1
echo --- Attempting Push --- >> git_log.txt
git push -u origin main >> git_log.txt 2>&1

echo --- COMPLETED --- >> git_log.txt
