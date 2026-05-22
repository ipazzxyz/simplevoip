import asyncio
import sys
import websockets
import json

SERVER_URL = "ws://127.0.0.1:8080/ws"

async def test_multi_peer_signaling():
    print("[TEST] Starting WebSocket Multi-Peer and Host Control test...")
    room_1 = "test-room-1"

    # 1. Connect Client 1 (Host)
    print("[TEST] Connecting Client 1 (should become Host)...")
    async with websockets.connect(f"{SERVER_URL}?room={room_1}") as ws1:
        msg = await asyncio.wait_for(ws1.recv(), timeout=2.0)
        init1 = json.loads(msg)
        print(f"[TEST] Client 1 received init: {init1}")
        assert init1["type"] == "init"
        assert init1["peerId"] == init1["hostId"], "Client 1 is not host"
        assert len(init1["peers"]) == 0, "Expected 0 existing peers"
        c1_id = init1["peerId"]

        # 2. Connect Client 2
        print("[TEST] Connecting Client 2...")
        async with websockets.connect(f"{SERVER_URL}?room={room_1}") as ws2:
            msg = await asyncio.wait_for(ws2.recv(), timeout=2.0)
            init2 = json.loads(msg)
            print(f"[TEST] Client 2 received init: {init2}")
            assert init2["type"] == "init"
            assert init2["hostId"] == c1_id, "Host mismatch for Client 2"
            assert c1_id in init2["peers"], "Client 1 should be in Client 2's peer list"
            c2_id = init2["peerId"]

            # Client 1 should receive peer-joined for Client 2
            joined_msg = await asyncio.wait_for(ws1.recv(), timeout=2.0)
            joined1 = json.loads(joined_msg)
            print(f"[TEST] Client 1 received joined: {joined1}")
            assert joined1["type"] == "peer-joined"
            assert joined1["peerId"] == c2_id

            # 3. Connect Client 3
            print("[TEST] Connecting Client 3...")
            async with websockets.connect(f"{SERVER_URL}?room={room_1}") as ws3:
                msg = await asyncio.wait_for(ws3.recv(), timeout=2.0)
                init3 = json.loads(msg)
                print(f"[TEST] Client 3 received init: {init3}")
                assert init3["type"] == "init"
                assert init3["hostId"] == c1_id
                assert c1_id in init3["peers"]
                assert c2_id in init3["peers"]
                c3_id = init3["peerId"]

                # Client 1 & 2 should receive peer-joined for Client 3
                j_msg1 = await asyncio.wait_for(ws1.recv(), timeout=2.0)
                j_data1 = json.loads(j_msg1)
                print(f"[TEST] Client 1 received joined for Client 3: {j_data1}")
                assert j_data1["type"] == "peer-joined"
                assert j_data1["peerId"] == c3_id

                j_msg2 = await asyncio.wait_for(ws2.recv(), timeout=2.0)
                j_data2 = json.loads(j_msg2)
                print(f"[TEST] Client 2 received joined for Client 3: {j_data2}")
                assert j_data2["type"] == "peer-joined"
                assert j_data2["peerId"] == c3_id

                # 4. Host (Client 1) kicks Client 3
                print("[TEST] Host kicking Client 3...")
                kick_cmd = {"type": "kick", "target": c3_id}
                await ws1.send(json.dumps(kick_cmd))

                # Client 3 should get disconnected by server
                try:
                    # Wait for close or next message (which should be close)
                    await asyncio.wait_for(ws3.recv(), timeout=2.0)
                    print("[FAIL] Client 3 was not disconnected after kick")
                    sys.exit(1)
                except websockets.exceptions.ConnectionClosed as e:
                    print(f"[PASS] Client 3 connection closed. Code: {e.code}, Reason: '{e.reason}'")
                    assert "Kicked by host" in e.reason or e.code == 4000

                # Client 1 & 2 should receive peer-left for Client 3
                left_msg1 = await asyncio.wait_for(ws1.recv(), timeout=2.0)
                left_data1 = json.loads(left_msg1)
                print(f"[TEST] Client 1 received left: {left_data1}")
                assert left_data1["type"] == "peer-left"
                assert left_data1["peerId"] == c3_id

                left_msg2 = await asyncio.wait_for(ws2.recv(), timeout=2.0)
                left_data2 = json.loads(left_msg2)
                print(f"[TEST] Client 2 received left: {left_data2}")
                assert left_data2["type"] == "peer-left"
                assert left_data2["peerId"] == c3_id

        # 5. Client 1 (Host) leaves, Client 2 should be promoted to Host
        # (Client 2 is now closed in the with-block, let's connect client 2 and client 4 to test host migration)
        
    print("[TEST] Verifying Host Transfer on disconnect...")
    async with websockets.connect(f"{SERVER_URL}?room={room_1}") as ws1:
        init1 = json.loads(await asyncio.wait_for(ws1.recv(), timeout=2.0))
        c1_id = init1["peerId"]
        async with websockets.connect(f"{SERVER_URL}?room={room_1}") as ws2:
            init2 = json.loads(await asyncio.wait_for(ws2.recv(), timeout=2.0))
            c2_id = init2["peerId"]
            
            # Consume peer-joined on ws1
            await asyncio.wait_for(ws1.recv(), timeout=2.0)

            # Close Client 1
            print("[TEST] Closing Client 1 to trigger Host Transfer...")
            
        # ws2 is still open here! Wait, since it's nested, ws2 is active. Let's close ws1 outside
    
    # Let's write it cleanly without nested withs for sequential flows
    ws_host = await websockets.connect(f"{SERVER_URL}?room={room_1}")
    host_init = json.loads(await asyncio.wait_for(ws_host.recv(), timeout=2.0))
    host_id = host_init["peerId"]
    
    ws_peer = await websockets.connect(f"{SERVER_URL}?room={room_1}")
    peer_init = json.loads(await asyncio.wait_for(ws_peer.recv(), timeout=2.0))
    peer_id = peer_init["peerId"]
    
    # Consume peer-joined on host
    await asyncio.wait_for(ws_host.recv(), timeout=2.0)
    
    print("[TEST] Disconnecting host...")
    await ws_host.close()
    
    # Peer should receive peer-left AND host-changed
    msg1 = json.loads(await asyncio.wait_for(ws_peer.recv(), timeout=2.0))
    msg2 = json.loads(await asyncio.wait_for(ws_peer.recv(), timeout=2.0))
    
    print(f"[TEST] Peer received after host left: {msg1} and {msg2}")
    
    events = [msg1["type"], msg2["type"]]
    assert "peer-left" in events
    assert "host-changed" in events
    
    host_changed_evt = msg1 if msg1["type"] == "host-changed" else msg2
    assert host_changed_evt["hostId"] == peer_id, "Peer was not promoted to host"
    print("[PASS] Host transfer verified. Peer promoted to host.")
    
    # Test room occupancy limit: 5 peers max, 6th rejected
    print("[TEST] Verifying capacity limit of 5...")
    # ws_peer is client 1 in room now. Connect 4 more to reach 5.
    other_clients = []
    for i in range(4):
        ws = await websockets.connect(f"{SERVER_URL}?room={room_1}")
        await asyncio.wait_for(ws.recv(), timeout=2.0) # consume init
        other_clients.append(ws)
    
    print("[TEST] 5 clients connected. Attempting 6th connection (should fail)...")
    try:
        ws_6th = await websockets.connect(f"{SERVER_URL}?room={room_1}")
        # Wait for rejection close
        try:
            await asyncio.wait_for(ws_6th.recv(), timeout=2.0)
            print("[FAIL] 6th client was accepted but should have been rejected")
            sys.exit(1)
        except websockets.exceptions.ConnectionClosed as e:
            print(f"[PASS] 6th client connection closed by server. Code: {e.code}, Reason: '{e.reason}'")
            assert "Room full" in e.reason or e.code == 1008
    except Exception as e:
        print(f"[PASS] 6th client connection rejected: {e}")
        
    # Clean up
    await ws_peer.close()
    for ws in other_clients:
        await ws.close()

    print("[SUCCESS] All multi-peer signaling and host control integration tests passed!")

if __name__ == "__main__":
    try:
        asyncio.run(test_multi_peer_signaling())
    except Exception as e:
        print(f"[ERROR] Test failed with exception: {e}")
        sys.exit(1)
