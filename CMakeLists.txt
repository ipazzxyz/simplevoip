cmake_minimum_required(VERSION 3.15)
project(webrtc_signaling_server CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Disable Crow tests and examples to speed up build
set(CROW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CROW_BUILD_TESTS OFF CACHE BOOL "" FORCE)

# Fetch Crow
include(FetchContent)
FetchContent_Declare(
    crow
    GIT_REPOSITORY https://github.com/CrowCpp/Crow.git
    GIT_TAG        master
)
FetchContent_MakeAvailable(crow)

add_executable(webrtc_server 
    server/main.cpp
    server/config.hpp
    server/room_manager.hpp
)

# Define standalone ASIO and CROW_USE_ASIO flags
target_compile_definitions(webrtc_server PRIVATE CROW_USE_ASIO=1 ASIO_STANDALONE=1)

# Link Crow
target_link_libraries(webrtc_server PRIVATE Crow::Crow)

# Link to Winsock on Windows
if(WIN32)
    target_link_libraries(webrtc_server PRIVATE ws2_32 wsock32)
endif()
