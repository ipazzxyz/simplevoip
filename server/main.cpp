#include "crow.h"
#include "config.hpp"
#include "room_manager.hpp"
#include <string>
#include <fstream>
#include <sstream>
#include <iostream>

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
    RoomManager room_manager;

    // HTTP Routes
    CROW_ROUTE(app, "/")([]() {
        auto response = crow::response(read_file(config::CLIENT_DIR + "index.html"));
        response.set_header("Content-Type", "text/html; charset=utf-8");
        return response;
    });

    CROW_ROUTE(app, "/css/<string>")([](std::string filename) {
        auto response = crow::response(read_file(config::CLIENT_DIR + "css/" + filename));
        response.set_header("Content-Type", "text/css");
        return response;
    });

    CROW_ROUTE(app, "/js/<string>")([](std::string filename) {
        auto response = crow::response(read_file(config::CLIENT_DIR + "js/" + filename));
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
                return false;
            }
            std::string* room_str = new std::string(room);
            *userdata = room_str;
            return true;
        })
        .onopen([&](crow::websocket::connection& conn) {
            std::string* room_str = static_cast<std::string*>(conn.userdata());
            if (room_str) {
                std::string room_id = *room_str;
                if (!room_manager.join_room(room_id, &conn)) {
                    conn.close("Room full");
                }
            }
        })
        .onclose([&](crow::websocket::connection& conn, const std::string& reason, uint16_t status_code) {
            room_manager.leave_room(&conn);
            
            // Clean up allocated userdata memory
            std::string* room_str = static_cast<std::string*>(conn.userdata());
            if (room_str) {
                delete room_str;
                conn.userdata(nullptr);
            }
        })
        .onmessage([&](crow::websocket::connection& conn, const std::string& data, bool is_binary) {
            if (is_binary) return;
            room_manager.broadcast(&conn, data);
        });

    CROW_ROUTE(app, "/<string>")([](std::string room_id) {
        if (room_id == "ws") {
            return crow::response(404);
        }
        // Serve room calling page
        auto response = crow::response(read_file(config::CLIENT_DIR + "room.html"));
        response.set_header("Content-Type", "text/html; charset=utf-8");
        return response;
    });

    std::cout << "--------------------------------------------------" << std::endl;
    std::cout << "Starting C++ WebRTC Signaling Server on http://localhost:" << config::PORT << std::endl;
    std::cout << "--------------------------------------------------" << std::endl;

    app.port(config::PORT).multithreaded().run();
}
