#pragma once
#include "crow.h"
#include "config.hpp"
#include <unordered_map>
#include <mutex>
#include <string>
#include <iostream>
#include <vector>
#include <sstream>
#include <chrono>

struct RoomState {
    std::string host_peer_id;
    std::unordered_map<std::string, crow::websocket::connection*> peers;
};

struct JoinResult {
    bool success;
    std::string peer_id;
    std::string host_id;
    std::vector<std::string> existing_peers;
    std::vector<crow::websocket::connection*> peers_to_notify;
};

struct LeaveResult {
    bool success;
    std::string room_id;
    std::string peer_id;
    std::string new_host_id;
    std::vector<crow::websocket::connection*> peers_to_notify;
};

class RoomManager {
public:
    // Try to add a connection to a room. Returns a JoinResult.
    JoinResult join_room(const std::string& room_id, crow::websocket::connection* conn) {
        std::lock_guard<std::mutex> lock(mutex_);
        JoinResult result;
        result.success = false;

        auto& room_state = rooms_[room_id];
        if (room_state.peers.size() >= config::MAX_ROOM_PEERS) {
            std::cout << "[WS] Rejected connection: Room " << room_id << " is full." << std::endl;
            // Clean up if it was a newly created empty state in the map
            if (room_state.peers.empty()) {
                rooms_.erase(room_id);
            }
            return result;
        }

        // Generate peer ID from connection memory address
        std::ostringstream ss;
        ss << "peer_" << std::hex << reinterpret_cast<uintptr_t>(conn);
        std::string peer_id = ss.str();

        result.peer_id = peer_id;
        for (const auto& pair : room_state.peers) {
            result.existing_peers.push_back(pair.first);
            result.peers_to_notify.push_back(pair.second);
        }

        room_state.peers[peer_id] = conn;
        conn_to_room_[conn] = room_id;
        conn_to_peer_id_[conn] = peer_id;
        conn_last_seen_[conn] = std::chrono::steady_clock::now();

        // First peer is the host
        if (room_state.host_peer_id.empty()) {
            room_state.host_peer_id = peer_id;
        }
        result.host_id = room_state.host_peer_id;

        result.success = true;
        std::cout << "[WS] Peer " << peer_id << " joined room: " << room_id 
                  << " (Host is: " << room_state.host_peer_id << "). Total peers: " 
                  << room_state.peers.size() << std::endl;
        return result;
    }

    // Remove connection from room. Returns a LeaveResult.
    LeaveResult leave_room(crow::websocket::connection* conn) {
        std::lock_guard<std::mutex> lock(mutex_);
        LeaveResult result;
        result.success = false;

        auto it = conn_to_room_.find(conn);
        if (it != conn_to_room_.end()) {
            result.room_id = it->second;
            result.peer_id = conn_to_peer_id_[conn];
            result.success = true;

            auto& room_state = rooms_[result.room_id];
            room_state.peers.erase(result.peer_id);
            
            if (room_state.peers.empty()) {
                rooms_.erase(result.room_id);
            } else {
                if (room_state.host_peer_id == result.peer_id) {
                    // Transfer host role to the next remaining peer
                    auto next_host_pair = room_state.peers.begin();
                    room_state.host_peer_id = next_host_pair->first;
                    result.new_host_id = room_state.host_peer_id;
                }
                for (const auto& pair : room_state.peers) {
                    result.peers_to_notify.push_back(pair.second);
                }
            }

            conn_to_room_.erase(it);
            conn_to_peer_id_.erase(conn);
            conn_last_seen_.erase(conn);
            std::cout << "[WS] Peer " << result.peer_id << " left room: " << result.room_id << std::endl;
        }
        return result;
    }

    // Process and route signaling / control messages.
    void handle_message(crow::websocket::connection* sender, const std::string& data) {
        std::lock_guard<std::mutex> lock(mutex_);
        
        conn_last_seen_[sender] = std::chrono::steady_clock::now();
        
        auto it = conn_to_peer_id_.find(sender);
        if (it == conn_to_peer_id_.end()) return;
        std::string sender_id = it->second;

        auto room_it = conn_to_room_.find(sender);
        if (room_it == conn_to_room_.end()) return;
        std::string room_id = room_it->second;

        auto& room_state = rooms_[room_id];

        auto msg = crow::json::load(data);
        if (!msg) {
            std::cerr << "[WS] Failed to parse message JSON from " << sender_id << std::endl;
            return;
        }

        // Intercept and ignore heartbeat pings (silently update timestamp and return)
        if (msg.has("type") && msg["type"].s() == "ping") {
            return;
        }

        // Process kick command from host
        if (msg.has("type") && msg["type"].s() == "kick") {
            if (sender_id == room_state.host_peer_id) {
                if (msg.has("target")) {
                    std::string target_id = msg["target"].s();
                    auto target_it = room_state.peers.find(target_id);
                    if (target_it != room_state.peers.end()) {
                        std::cout << "[WS] Host " << sender_id << " is kicking " << target_id << std::endl;
                        target_it->second->close("Kicked by host");
                    }
                }
            } else {
                std::cout << "[WS] Unauthorized kick attempt by non-host peer " << sender_id << std::endl;
            }
            return;
        }

        // Route signaling messages
        std::string forwarded = data;
        size_t open_brace = forwarded.find('{');
        if (open_brace != std::string::npos) {
            forwarded.insert(open_brace + 1, "\"sender\":\"" + sender_id + "\",");
        }

        if (msg.has("target")) {
            std::string target_id = msg["target"].s();
            auto target_it = room_state.peers.find(target_id);
            if (target_it != room_state.peers.end()) {
                target_it->second->send_text(forwarded);
            }
        } else {
            // Broadcast to other peers in the room
            for (const auto& pair : room_state.peers) {
                if (pair.first != sender_id) {
                    pair.second->send_text(forwarded);
                }
            }
        }
    }

    // Check for idle connections and close them
    void cleanup_inactive_connections() {
        std::vector<crow::websocket::connection*> to_close;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto now = std::chrono::steady_clock::now();
            for (const auto& pair : conn_last_seen_) {
                auto duration = std::chrono::duration_cast<std::chrono::seconds>(now - pair.second).count();
                if (duration > 30) {
                    std::cout << "[WS] Connection idle for " << duration << " seconds. Scheduling cleanup." << std::endl;
                    to_close.push_back(pair.first);
                }
            }
        }

        // Close outside the lock to prevent deadlock
        for (auto* conn : to_close) {
            conn->close("Heartbeat timeout");
        }
    }

private:
    std::unordered_map<std::string, RoomState> rooms_;
    std::unordered_map<crow::websocket::connection*, std::string> conn_to_room_;
    std::unordered_map<crow::websocket::connection*, std::string> conn_to_peer_id_;
    std::unordered_map<crow::websocket::connection*, std::chrono::steady_clock::time_point> conn_last_seen_;
    std::mutex mutex_;
};


