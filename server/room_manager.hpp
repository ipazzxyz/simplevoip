#pragma once
#include "crow.h"
#include <unordered_set>
#include <unordered_map>
#include <mutex>
#include <string>
#include <iostream>

class RoomManager {
public:
    // Try to add a connection to a room. Returns true if successful, false if room is full.
    bool join_room(const std::string& room_id, crow::websocket::connection* conn) {
        std::lock_guard<std::mutex> lock(mutex_);
        
        auto& room_peers = rooms_[room_id];
        if (room_peers.size() >= 2) {
            std::cout << "[WS] Rejected connection: Room " << room_id << " is full." << std::endl;
            return false;
        }
        
        room_peers.insert(conn);
        conn_to_room_[conn] = room_id;
        std::cout << "[WS] Peer connected to room: " << room_id 
                  << ". Total active peers in room: " << room_peers.size() << std::endl;
        return true;
    }

    // Remove connection from room. Returns true if connection was in a room.
    bool leave_room(crow::websocket::connection* conn) {
        std::lock_guard<std::mutex> lock(mutex_);
        
        auto it = conn_to_room_.find(conn);
        if (it != conn_to_room_.end()) {
            std::string room_id = it->second;
            rooms_[room_id].erase(conn);
            if (rooms_[room_id].empty()) {
                rooms_.erase(room_id);
            }
            conn_to_room_.erase(it);
            std::cout << "[WS] Peer disconnected from room: " << room_id << std::endl;
            return true;
        }
        return false;
    }

    // Broadcast message to all other peers in the same room.
    void broadcast(crow::websocket::connection* sender, const std::string& message) {
        std::lock_guard<std::mutex> lock(mutex_);
        
        auto it = conn_to_room_.find(sender);
        if (it != conn_to_room_.end()) {
            std::string room_id = it->second;
            for (auto* peer : rooms_[room_id]) {
                if (peer != sender) {
                    peer->send_text(message);
                }
            }
        }
    }

private:
    std::unordered_map<std::string, std::unordered_set<crow::websocket::connection*>> rooms_;
    std::unordered_map<crow::websocket::connection*, std::string> conn_to_room_;
    std::mutex mutex_;
};
