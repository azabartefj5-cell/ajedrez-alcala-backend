@echo off
echo Running Git Commands...
git config --local user.email "bot@example.com"
git config --local user.name "AI Bot"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/azabartefj5-cell/ajedrez-alcala-backend.git
git push origin main
echo Done.
