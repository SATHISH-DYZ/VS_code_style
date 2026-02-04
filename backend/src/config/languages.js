/**
 * Language execution configuration
 * Add new languages by adding entries to this object
 */
export const LANGUAGES = {
    python: {
        image: 'python:3.11-slim',
        workDir: '/workspace',
        file: 'main.py',
        command: ['python3', '-u', 'main.py'],
        localCommand: ['python3', '-X', 'utf8', '-u', 'main.py'],
        piston: { language: 'python', version: '3.10.0' },
        timeout: 30000
    },
    javascript: {
        image: 'node:18-slim',
        workDir: '/workspace',
        file: 'main.js',
        command: ['node', 'main.js'],
        localCommand: ['node', 'main.js'],
        piston: { language: 'javascript', version: '18.15.0' },
        timeout: 30000
    },
    typescript: {
        image: 'node:18-slim',
        workDir: '/workspace',
        file: 'main.ts',
        command: ['bash', '-c', 'npm install -g typescript ts-node && ts-node main.ts'],
        localCommand: ['ts-node', 'main.ts'],
        piston: { language: 'typescript', version: '5.0.3' },
        timeout: 45000
    },
    java: {
        image: 'openjdk:21-slim',
        workDir: '/workspace',
        file: 'Main.java',
        command: ['bash', '-c', 'javac Main.java && java Main'],
        localCommand: ['javac -encoding UTF-8 Main.java && java -Dfile.encoding=UTF-8 Main'],
        piston: { language: 'java', version: '15.0.2' },
        timeout: 45000
    },
    c: {
        image: 'gcc:12',
        workDir: '/workspace',
        file: 'main.c',
        command: ['bash', '-c', 'gcc -o main main.c && ./main'],
        localCommand: ['gcc -o main main.c && ./main'],
        piston: { language: 'c', version: '10.2.1' },
        timeout: 30000
    },
    cpp: {
        image: 'gcc:12',
        workDir: '/workspace',
        file: 'main.cpp',
        command: ['bash', '-c', 'g++ -o main main.cpp && ./main'],
        localCommand: ['g++ -o main main.cpp && ./main'],
        piston: { language: 'cpp', version: '10.2.1' },
        timeout: 30000
    },
    csharp: {
        image: 'mcr.microsoft.com/dotnet/sdk:7.0',
        workDir: '/workspace',
        file: 'Program.cs',
        command: ['bash', '-c', 'dotnet script Program.cs'],
        localCommand: ['dotnet', 'script', 'Program.cs'],
        piston: { language: 'csharp', version: '6.12.0' },
        timeout: 45000
    },
    go: {
        image: 'golang:1.21-alpine',
        workDir: '/workspace',
        file: 'main.go',
        command: ['go', 'run', 'main.go'],
        localCommand: ['go', 'run', 'main.go'],
        piston: { language: 'go', version: '1.16.2' },
        timeout: 30000
    },
    rust: {
        image: 'rust:1.75-slim',
        workDir: '/workspace',
        file: 'main.rs',
        command: ['bash', '-c', 'rustc main.rs && ./main'],
        localCommand: ['rustc main.rs && ./main'],
        piston: { language: 'rust', version: '1.68.2' },
        timeout: 45000
    },
    php: {
        image: 'php:8.2-cli',
        workDir: '/workspace',
        file: 'main.php',
        command: ['php', 'main.php'],
        localCommand: ['php-cgi', 'main.php'],
        piston: { language: 'php', version: '8.2.3' },
        timeout: 30000
    },
    ruby: {
        image: 'ruby:3.2-slim',
        workDir: '/workspace',
        file: 'main.rb',
        command: ['ruby', 'main.rb'],
        localCommand: ['ruby', 'main.rb'],
        piston: { language: 'ruby', version: '3.0.1' },
        timeout: 30000
    },
    swift: {
        image: 'swift:5.9',
        workDir: '/workspace',
        file: 'main.swift',
        command: ['swift', 'main.swift'],
        localCommand: ['swift', 'main.swift'],
        piston: { language: 'swift', version: '5.3.3' },
        timeout: 45000
    },
    kotlin: {
        image: 'zenika/kotlin:1.9-jdk21',
        workDir: '/workspace',
        file: 'main.kt',
        command: ['bash', '-c', 'kotlinc main.kt -include-runtime -d main.jar && java -jar main.jar'],
        localCommand: ['kotlinc main.kt -include-runtime -d main.jar && java -jar main.jar'],
        piston: { language: 'kotlin', version: '1.8.20' },
        timeout: 45000
    },
    scala: {
        image: 'hseeberger/scala-sbt:11.0.16_1.8.0_2.13.10',
        workDir: '/workspace',
        file: 'Main.scala',
        command: ['scala', 'Main.scala'],
        localCommand: ['scala', 'Main.scala'],
        timeout: 45000
    },
    bash: {
        image: 'bash:5.2',
        workDir: '/workspace',
        file: 'script.sh',
        command: ['bash', 'script.sh'],
        localCommand: ['bash', 'script.sh'],
        timeout: 30000
    },
    powershell: {
        image: 'mcr.microsoft.com/powershell:latest',
        workDir: '/workspace',
        file: 'script.ps1',
        command: ['pwsh', '-File', 'script.ps1'],
        localCommand: ['powershell', '-File', 'script.ps1'],
        timeout: 30000
    },
    sql: {
        image: 'postgres:16-alpine',
        workDir: '/workspace',
        file: 'query.sql',
        command: ['bash', '-c', 'psql -U postgres -f query.sql'],
        localCommand: ['echo "SQL execution requires configured database connection"'],
        timeout: 30000
    }
};
