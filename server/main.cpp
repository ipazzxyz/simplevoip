#include "crow.h"
#include <unordered_set>
#include <unordered_map>
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

    // Track active WebSocket connections by room
    std::unordered_map<std::string, std::unordered_set<crow::websocket::connection*>> rooms;
    std::unordered_map<crow::websocket::connection*, std::string> conn_to_room;
    std::mutex rooms_mutex;

    // HTTP Routes
    CROW_ROUTE(app, "/")([]() {
        auto response = crow::response(read_file("client/home.html"));
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
        .onaccept([&](const crow::request& req, void** userdata) {
            auto room = req.url_params.get("room");
            if (!room) {
                std::cout << "[WS] Rejected: Connection request has no room parameter." << std::endl;
                return false; // Reject connection
            }
            std::string* room_str = new std::string(room);
            *userdata = room_str;
            return true; // Accept connection
        })
        .onopen([&](crow::websocket::connection& conn) {
            std::string* room_str = static_cast<std::string*>(conn.userdata());
            if (room_str) {
                std::lock_guard<std::mutex> lock(rooms_mutex);
                std::string room_id = *room_str;
                
                // Enforce room size limit of 2 (1-to-1 WebRTC)
                if (rooms[room_id].size() >= 2) {
                    std::cout << "[WS] Rejected connection: Room " << room_id << " is full." << std::endl;
                    conn.close("Room full");
                    return;
                }
                
                rooms[room_id].insert(&conn);
                conn_to_room[&conn] = room_id;
                std::cout << "[WS] Peer connected to room: " << room_id 
                          << ". Total active peers in room: " << rooms[room_id].size() << std::endl;
            }
        })
        .onclose([&](crow::websocket::connection& conn, const std::string& reason, uint16_t status_code) {
            std::lock_guard<std::mutex> lock(rooms_mutex);
            auto it = conn_to_room.find(&conn);
            if (it != conn_to_room.end()) {
                std::string room_id = it->second;
                rooms[room_id].erase(&conn);
                if (rooms[room_id].empty()) {
                    rooms.erase(room_id);
                }
                conn_to_room.erase(it);
                std::cout << "[WS] Peer disconnected from room: " << room_id 
                          << ". Code: " << status_code 
                          << ", Reason: " << (reason.empty() ? "None" : reason) << std::endl;
            }
            
            // Clean up allocated userdata memory
            std::string* room_str = static_cast<std::string*>(conn.userdata());
            if (room_str) {
                delete room_str;
                conn.userdata(nullptr);
            }
        })
        .onmessage([&](crow::websocket::connection& conn, const std::string& data, bool is_binary) {
            if (is_binary) return;
            
            std::lock_guard<std::mutex> lock(rooms_mutex);
            auto it = conn_to_room.find(&conn);
            if (it != conn_to_room.end()) {
                std::string room_id = it->second;
                for (auto* peer : rooms[room_id]) {
                    if (peer != &conn) {
                        peer->send_text(data);
                    }
                }
            }
        });

    CROW_ROUTE(app, "/<string>")([](std::string room_id) {
        if (room_id == "ws") {
            return crow::response(404);
        }
        // Serve room calling page
        auto response = crow::response(read_file("client/index.html"));
        response.set_header("Content-Type", "text/html; charset=utf-8");
        return response;
    });

    std::cout << "--------------------------------------------------" << std::endl;
    std::cout << "Starting C++ WebRTC Signaling Server on http://localhost:8080" << std::endl;
    std::cout << "--------------------------------------------------" << std::endl;

    app.port(8080).multithreaded().run();
}
