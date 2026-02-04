@echo off
echo Starting TeachGrid Project Locally...

:: Navigate to backend and start
start cmd /k "cd backend && (if not exist node_modules npm install) & npm run dev"

:: Navigate to frontend and start
start cmd /k "cd frontend && (if not exist node_modules npm install) & npm start"


echo Project is starting in separate windows.
pause
