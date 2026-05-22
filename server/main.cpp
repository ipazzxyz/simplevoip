#include "crow.h"
#include <unordered_set>
#include <mutex>
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>

// Helper function to read file contents
std::string read_file(const std::string& path) {
    std::ifstream file(path, std::ios::in | std::ios::binary);
    if (!file.is_open()) {
        std::cerr << "[Error] Failed to open file: " << path << std::endl;
        return "";
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

int main() {
    crow::SimpleApp app;

    // Track active WebSocket connections
    std::unordered_set<crow::websocket::connection*> active_connections;
    std::mutex connections_mutex;

    // HTTP Routes
    CROW_ROUTE(app, "/")([]() {
        auto response = crow::response(read_file("client/index.html"));
        response.set_header("Content-Type", "text/html; charset=utf-8");
        return response;
    });

    CROW_ROUTE(app, "/style.css")([]() {
        auto response = crow::response(read_file("client/style.css"));
        response.set_header("Content-Type", "text/css");
        return response;
    });

    CROW_ROUTE(app, "/client.js")([]() {
        auto response = crow::response(read_file("client/client.js"));
        response.set_header("Content-Type", "application/javascript");
        return response;
    });

    // WebSocket Signaling Endpoint
    CROW_ROUTE(app, "/ws")
        .websocket(&app)
        .onopen([&](crow::websocket::connection& conn) {
            std::lock_guard<std::mutex> lock(connections_mutex);
            active_connections.insert(&conn);
            std::cout << "[WS] Peer connected. Total active peers: " << active_connections.size() << std::endl;
        })
        .onclose([&](crow::websocket::connection& conn, const std::string& reason, uint16_t status_code) {
            std::lock_guard<std::mutex> lock(connections_mutex);
            active_connections.erase(&conn);
            std::cout << "[WS] Peer disconnected. Code: " << status_code 
                      << ", Reason: " << (reason.empty() ? "None" : reason) 
                      << ". Total active peers: " << active_connections.size() << std::endl;
        })
        .onmessage([&](crow::websocket::connection& conn, const std::string& data, bool is_binary) {
            if (is_binary) return;

            // Broadcast message to all other connected clients
            std::lock_guard<std::mutex> lock(connections_mutex);
            for (auto* peer : active_connections) {
                if (peer != &conn) {
                    peer->send_text(data);
                }
            }
        });

    std::cout << "--------------------------------------------------" << std::endl;
    std::cout << "Starting C++ WebRTC Signaling Server on http://localhost:8080" << std::endl;
    std::cout << "--------------------------------------------------" << std::endl;

    app.port(8080).multithreaded().run();
}
