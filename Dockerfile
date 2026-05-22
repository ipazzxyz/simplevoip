# === STAGE 1: Build the C++ Signaling Server ===
FROM ubuntu:22.04 AS builder

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install essential compilation tools and libraries
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    git \
    libasio-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy CMake configuration and source code
COPY CMakeLists.txt ./
COPY server/ ./server/

# Configure and compile the Release target binary
RUN cmake -B build -S . -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build

# === STAGE 2: Lightweight Runtime Environment ===
FROM ubuntu:22.04

WORKDIR /app

# Copy the compiled executable from the build stage
COPY --from=builder /app/build/webrtc_server ./webrtc_server

# Copy the client application folder (HTML, CSS, JS)
COPY client/ ./client/

# Expose port 8080 (matching server configuration)
EXPOSE 8080

# Run the signaling server
CMD ["./webrtc_server"]
