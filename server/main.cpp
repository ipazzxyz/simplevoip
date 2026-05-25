#include "crow.h"
#include "config.hpp"
#include "room_manager.hpp"
#include <string>
#include <fstream>
#include <sstream>
#include <iostream>
#include <thread>
#include <chrono>

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

    // Start background thread to clean up inactive connections
    std::thread cleanup_thread([&room_manager]() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(10));
            room_manager.cleanup_inactive_connections();
        }
    });
    cleanup_thread.detach();

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
                JoinResult res = room_manager.join_room(room_id, &conn);
                if (!res.success) {
                    conn.close("Room full");
                    return;
                }

                // Send init to the joining peer
                crow::json::wvalue init_msg;
                init_msg["type"] = "init";
                init_msg["peerId"] = res.peer_id;
                init_msg["hostId"] = res.host_id;
                
                std::vector<crow::json::wvalue> peers_arr;
                for (const auto& peer : res.existing_peers) {
                    peers_arr.push_back(peer);
                }
                init_msg["peers"] = std::move(peers_arr);
                conn.send_text(init_msg.dump());

                // Broadcast peer-joined to all other peers in the room
                crow::json::wvalue joined_msg;
                joined_msg["type"] = "peer-joined";
                joined_msg["peerId"] = res.peer_id;
                std::string joined_str = joined_msg.dump();

                for (auto* peer_conn : res.peers_to_notify) {
                    peer_conn->send_text(joined_str);
                }
            }
        })
        .onclose([&](crow::websocket::connection& conn, const std::string& reason, uint16_t status_code) {
            LeaveResult res = room_manager.leave_room(&conn);
            if (res.success) {
                // Broadcast peer-left to remaining peers
                crow::json::wvalue left_msg;
                left_msg["type"] = "peer-left";
                left_msg["peerId"] = res.peer_id;
                std::string left_str = left_msg.dump();

                for (auto* peer_conn : res.peers_to_notify) {
                    peer_conn->send_text(left_str);
                }

                // Broadcast host-changed if host transferred
                if (!res.new_host_id.empty()) {
                    crow::json::wvalue host_msg;
                    host_msg["type"] = "host-changed";
                    host_msg["hostId"] = res.new_host_id;
                    std::string host_str = host_msg.dump();

                    for (auto* peer_conn : res.peers_to_notify) {
                        peer_conn->send_text(host_str);
                    }
                }
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
            room_manager.handle_message(&conn, data);
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
