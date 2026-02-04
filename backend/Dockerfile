FROM node:18-bookworm

# Install build dependencies and compilers/interpreters for supported languages
# We include Python, C/C++, Java, PHP, Ruby, Go, and Rust.
# .NET and Swift are omitted to keep image size manageable and setup simple, 
# but can be added via specific installation scripts if needed.
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    g++ \
    gcc \
    make \
    default-jdk \
    php-cli \
    php-cgi \
    ruby-full \
    golang-go \
    rustc \
    cargo \
    curl \
    wget \
    git \
    locales \
 && rm -rf /var/lib/apt/lists/*

# Fix Locale
RUN echo "en_US.UTF-8 UTF-8" > /etc/locale.gen && \
    locale-gen en_US.UTF-8 && \
    update-locale LANG=en_US.UTF-8
ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# Symlink python -> python3
RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./

# Install dependencies (ensure node-pty builds correctly with python3/make/g++)
RUN npm install

COPY . .

EXPOSE 3001

CMD ["npm", "start"]
