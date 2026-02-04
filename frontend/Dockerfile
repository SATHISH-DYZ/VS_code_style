# Development Dockerfile for React Frontend
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

# Start development server
CMD ["npm", "start"]
