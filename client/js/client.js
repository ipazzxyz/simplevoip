// UI Elements
const localVideo = document.getElementById('localVideo');
const joinBtn = document.getElementById('joinBtn');
const muteAudioBtn = document.getElementById('muteAudio');
const muteVideoBtn = document.getElementById('muteVideo');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const localPlaceholder = document.getElementById('localPlaceholder');
const roomBadge = document.getElementById('roomBadge');
const roomText = document.getElementById('roomText');

// WebRTC & WS state
let localStream = null;
const peers = {}; // peerId -> { peerConnection, remoteStream, wrapperElement, iceQueue, remoteDescriptionSet }
let myPeerId = null;
let currentHostId = null;
let socket = null;
let isConnected = false;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Set Room ID in header
const room = window.location.pathname.substring(1);
if (roomText) {
    roomText.textContent = room;
}

// Event Listeners
joinBtn.addEventListener('click', () => {
    if (!isConnected) {
        startCall();
    } else {
        endCall();
    }
});

if (roomBadge) {
    roomBadge.addEventListener('click', () => {
        const roomUrl = window.location.href;
        navigator.clipboard.writeText(roomUrl).then(() => {
            roomBadge.classList.add('copied');
            setTimeout(() => {
                roomBadge.classList.remove('copied');
            }, 1500);
        }).catch(err => {
            console.error('Failed to copy room link:', err);
        });
    });
}

muteAudioBtn.addEventListener('click', toggleAudio);
muteVideoBtn.addEventListener('click', toggleVideo);

// Update Status indicators
function updateStatus(text, statusClass) {
    statusText.textContent = text;
    statusDot.className = 'status-dot';
    statusDot.classList.add(statusClass);
}

// Send JSON data to Signaling server
function sendMessage(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

// Start user media and open socket connection
async function startCall() {
    joinBtn.disabled = true;
    updateStatus('Accessing media...', 'connecting');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateStatus('Media Error', 'disconnected');
        joinBtn.disabled = false;
        alert('WebRTC media APIs are not supported or blocked in this browser context. Please ensure you are opening the page via http://localhost:8080 (or https:// if accessing remotely).');
        return;
    }

    let streamSuccess = false;
    
    // Fallback chain for media acquisition
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        streamSuccess = true;
    } catch (err) {
        console.warn('Could not acquire both video and audio. Trying video-only...', err);
    }

    if (!streamSuccess) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            streamSuccess = true;
        } catch (err) {
            console.warn('Could not acquire video. Trying audio-only...', err);
        }
    }

    if (!streamSuccess) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            streamSuccess = true;
        } catch (err) {
            console.error('All media acquisition attempts failed:', err);
            updateStatus('Media Error', 'disconnected');
            joinBtn.disabled = false;
            alert('Could not access camera or microphone. Please verify they are plugged in and permissions are granted.');
            return;
        }
    }

    const hasVideo = localStream.getVideoTracks().length > 0;
    const hasAudio = localStream.getAudioTracks().length > 0;

    localVideo.srcObject = localStream;
    
    // Disable camera by default
    if (hasVideo) {
        localStream.getVideoTracks()[0].enabled = false;
    }
    
    localVideo.classList.remove('active');
    localPlaceholder.classList.remove('hidden');
    
    // Enable controls only for active tracks
    muteAudioBtn.disabled = !hasAudio;
    muteVideoBtn.disabled = !hasVideo;
    muteAudioBtn.classList.remove('muted');
    
    if (hasVideo) {
        muteVideoBtn.classList.add('muted');
    } else {
        muteVideoBtn.classList.remove('muted');
    }

    updateStatus('Connecting to server...', 'connecting');
    
    const room = window.location.pathname.substring(1);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(room)}`;
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        updateStatus('Waiting for peer...', 'connecting');
        joinBtn.disabled = false;
        joinBtn.classList.remove('connect-btn');
        joinBtn.classList.add('disconnect-btn');
        joinBtn.title = "Disconnect from call";
        isConnected = true;
        updateLayout();
    };

    socket.onclose = (event) => {
        if (event && (event.reason === 'Room full' || event.code === 1008)) {
            alert('This room is full (max 5 participants). Redirecting to homepage.');
            window.location.href = '/';
            return;
        }
        if (event && (event.reason === 'Kicked by host' || event.code === 4000)) {
            alert('You have been kicked from the room by the host.');
            window.location.href = '/';
            return;
        }
        endCall();
    };

    socket.onerror = (err) => {
        console.error('WebSocket Error:', err);
    };

    socket.onmessage = async (event) => {
        try {
            const msg = JSON.parse(event.data);
            await handleSignalingMessage(msg);
        } catch (err) {
            console.error('Error handling websocket message:', err);
        }
    };
}

// Initialize RTCPeerConnection and track listeners for a specific peer
function initPeerConnection(peerId, isInitiator) {
    console.log(`Initializing peer connection with ${peerId}, isInitiator: ${isInitiator}`);
    
    const pc = new RTCPeerConnection(rtcConfig);
    
    const peerState = {
        peerConnection: pc,
        remoteStream: new MediaStream(),
        wrapperElement: null,
        iceQueue: [],
        remoteDescriptionSet: false
    };
    
    peers[peerId] = peerState;
    
    // Add local tracks to PC
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // Capture remote stream tracks
    pc.ontrack = (event) => {
        console.log(`Received track from ${peerId}:`, event.track.kind);
        if (event.streams && event.streams[0]) {
            const remoteStream = event.streams[0];
            peerState.remoteStream = remoteStream;
            
            if (!peerState.wrapperElement) {
                createPeerVideoWrapper(peerId, remoteStream);
            }
            
            const wrapper = peerState.wrapperElement;
            const video = wrapper.querySelector('video');
            const placeholder = wrapper.querySelector('.video-placeholder');
            const spinner = wrapper.querySelector('.spinner-icon');
            const userIcon = wrapper.querySelector('.placeholder-icon');
            const placeholderText = wrapper.querySelector('.placeholder-text');
            
            video.srcObject = remoteStream;
            video.classList.add('active');
            placeholder.classList.add('hidden');

            // Listen to mute/unmute events on the remote video track
            if (event.track.kind === 'video') {
                const handleMute = () => {
                    console.log(`Remote video muted for ${peerId}`);
                    video.classList.remove('active');
                    placeholderText.textContent = 'Camera is off';
                    spinner.style.display = 'none';
                    userIcon.style.display = 'flex';
                    placeholder.classList.remove('hidden');
                };

                const handleUnmute = () => {
                    console.log(`Remote video unmuted for ${peerId}`);
                    video.classList.add('active');
                    placeholder.classList.add('hidden');
                };

                event.track.onmute = handleMute;
                event.track.onunmute = handleUnmute;

                // Check initial state
                if (event.track.muted) {
                    handleMute();
                }
            }
        }
    };

    // Forward ICE candidates to signaling server
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendMessage({
                type: 'candidate',
                target: peerId,
                candidate: event.candidate
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerId}:`, pc.connectionState);
        if (pc.connectionState === 'connected') {
            updateStatusText();
            
            const videoReceiver = pc.getReceivers().find(r => r.track && r.track.kind === 'video');
            if (peerState.wrapperElement) {
                const placeholder = peerState.wrapperElement.querySelector('.video-placeholder');
                const spinner = peerState.wrapperElement.querySelector('.spinner-icon');
                const userIcon = peerState.wrapperElement.querySelector('.placeholder-icon');
                const placeholderText = peerState.wrapperElement.querySelector('.placeholder-text');
                
                if (!videoReceiver) {
                    placeholderText.textContent = 'Audio-only';
                    spinner.style.display = 'none';
                    userIcon.style.display = 'flex';
                    placeholder.classList.remove('hidden');
                } else if (videoReceiver.track.muted) {
                    placeholderText.textContent = 'Camera is off';
                    spinner.style.display = 'none';
                    userIcon.style.display = 'flex';
                    placeholder.classList.remove('hidden');
                }
            }
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            console.warn(`Connection with ${peerId} disconnected/failed. Cleaning up.`);
            closePeer(peerId);
        }
    };

    if (isInitiator) {
        // Direct offer creation (initiator starts negotiation)
        (async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendMessage({
                    type: 'offer',
                    target: peerId,
                    sdp: offer.sdp
                });
            } catch (err) {
                console.error(`Error creating offer for peer ${peerId}:`, err);
            }
        })();
    }
}

// Create remote video wrapper element dynamically
function createPeerVideoWrapper(peerId, stream) {
    const videoContainer = document.getElementById('videoContainer');
    
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper remote-wrapper';
    wrapper.id = `wrapper_${peerId}`;
    
    // Check if we should render Kick button
    const isHost = (myPeerId && currentHostId && myPeerId === currentHostId);
    const kickHtml = isHost ? `
        <button class="kick-btn" onclick="window.kickUser('${peerId}')" title="Kick participant">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>
    ` : '';

    wrapper.innerHTML = `
        <video autoplay playsinline></video>
        <div class="video-placeholder">
            <div class="spinner-icon">
                <svg class="spinner-svg" viewBox="0 0 24 24" width="48" height="48">
                    <circle class="spinner-path" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3"></circle>
                </svg>
            </div>
            <div class="placeholder-icon" style="display: none;">
                <svg viewBox="0 0 24 24" width="48" height="48">
                    <path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                </svg>
            </div>
            <p class="placeholder-text">Connecting...</p>
        </div>
        <span class="video-label">User (${peerId.substring(5, 9)})</span>
        ${kickHtml}
    `;
    
    const video = wrapper.querySelector('video');
    video.srcObject = stream;
    
    videoContainer.appendChild(wrapper);
    peers[peerId].wrapperElement = wrapper;
    
    updateLayout();
}

// Global Kick Action
window.kickUser = function(peerId) {
    if (confirm(`Are you sure you want to kick participant ${peerId.substring(5, 9)}?`)) {
        sendMessage({
            type: 'kick',
            target: peerId
        });
    }
};

// Update video layout based on active peers count
function updateLayout() {
    const videoContainer = document.getElementById('videoContainer');
    const waitingPlaceholder = document.getElementById('waitingPlaceholder');
    const activePeerIds = Object.keys(peers);
    
    if (activePeerIds.length === 0) {
        waitingPlaceholder.classList.remove('hidden');
    } else {
        waitingPlaceholder.classList.add('hidden');
    }
    
    const remoteCount = activePeerIds.length;
    if (remoteCount >= 2) {
        videoContainer.classList.add('grid-mode');
    } else {
        videoContainer.classList.remove('grid-mode');
    }
}

// Update status panel text & dot color
function updateStatusText() {
    const activePeerIds = Object.keys(peers);
    const remoteCount = activePeerIds.length;
    
    if (!isConnected) {
        updateStatus('Disconnected', 'disconnected');
    } else if (remoteCount === 0) {
        updateStatus('Waiting for peers...', 'connecting');
    } else {
        const isHost = (myPeerId === currentHostId);
        const hostLabel = isHost ? ' (Host)' : '';
        updateStatus(`Connected (${remoteCount + 1} users)${hostLabel}`, 'success');
    }
}

// Enable/Disable Kick buttons based on current host status
function updateHostButtons() {
    const isHost = (myPeerId && currentHostId && myPeerId === currentHostId);
    
    updateStatusText();
    
    Object.keys(peers).forEach(peerId => {
        const peerState = peers[peerId];
        if (!peerState.wrapperElement) return;
        
        let kickBtn = peerState.wrapperElement.querySelector('.kick-btn');
        if (isHost && !kickBtn) {
            const btn = document.createElement('button');
            btn.className = 'kick-btn';
            btn.title = 'Kick participant';
            btn.onclick = () => window.kickUser(peerId);
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            `;
            peerState.wrapperElement.appendChild(btn);
        } else if (!isHost && kickBtn) {
            kickBtn.remove();
        }
    });
}

// Close and clean up a peer connection
function closePeer(peerId) {
    const peerState = peers[peerId];
    if (peerState) {
        console.log(`Closing peer connection for ${peerId}`);
        if (peerState.peerConnection) {
            peerState.peerConnection.close();
        }
        if (peerState.wrapperElement) {
            peerState.wrapperElement.remove();
        }
        delete peers[peerId];
    }
    updateLayout();
    updateStatusText();
}

// Process candidates that arrived before the Remote Description was set
async function processQueuedCandidates(sender) {
    const peerState = peers[sender];
    if (!peerState) return;
    
    while (peerState.iceQueue.length > 0) {
        const candidate = peerState.iceQueue.shift();
        try {
            await peerState.peerConnection.addIceCandidate(candidate);
        } catch (err) {
            console.error(`Error applying queued ICE candidate for ${sender}:`, err);
        }
    }
}

// Handle incoming WebRTC signaling messages
async function handleSignalingMessage(msg) {
    if (!isConnected) return;
    
    const sender = msg.sender;
    
    if (msg.type === 'init') {
        myPeerId = msg.peerId;
        currentHostId = msg.hostId;
        console.log(`My Peer ID: ${myPeerId}, Current Host ID: ${currentHostId}`);
        
        if (msg.peers) {
            msg.peers.forEach(peerId => {
                if (peerId !== myPeerId) {
                    initPeerConnection(peerId, true);
                }
            });
        }
        updateLayout();
        updateHostButtons();
    }
    else if (msg.type === 'peer-joined') {
        console.log(`Peer joined: ${msg.peerId}`);
        initPeerConnection(msg.peerId, false);
        updateLayout();
        updateHostButtons();
    }
    else if (msg.type === 'peer-left') {
        console.log(`Peer left: ${msg.peerId}`);
        closePeer(msg.peerId);
        updateLayout();
        updateHostButtons();
    }
    else if (msg.type === 'host-changed') {
        console.log(`Host changed: ${msg.hostId}`);
        currentHostId = msg.hostId;
        updateHostButtons();
    }
    else if (sender) {
        const peerState = peers[sender];
        if (!peerState) {
            console.warn(`Received signaling message ${msg.type} from unknown sender ${sender}`);
            return;
        }
        
        const pc = peerState.peerConnection;
        
        if (msg.type === 'offer') {
            console.log(`Received offer from ${sender}. Setting remote description & answering.`);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
            peerState.remoteDescriptionSet = true;
            await processQueuedCandidates(sender);
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendMessage({
                type: 'answer',
                target: sender,
                sdp: answer.sdp
            });
        }
        else if (msg.type === 'answer') {
            console.log(`Received answer from ${sender}. Setting remote description.`);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
            peerState.remoteDescriptionSet = true;
            await processQueuedCandidates(sender);
        }
        else if (msg.type === 'candidate') {
            const candidate = new RTCIceCandidate(msg.candidate);
            if (peerState.remoteDescriptionSet) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.error(`Error adding ICE candidate from ${sender}:`, err);
                }
            } else {
                console.log(`Queueing ICE candidate from ${sender} until remote description is set.`);
                peerState.iceQueue.push(candidate);
            }
        }
    }
}

// Mute / Unmute Microphone
function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            muteAudioBtn.classList.toggle('muted', !audioTrack.enabled);
        }
    }
}

// Enable / Disable Webcam
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            muteVideoBtn.classList.toggle('muted', !videoTrack.enabled);
            
            if (videoTrack.enabled) {
                localVideo.classList.add('active');
                localPlaceholder.classList.add('hidden');
            } else {
                localVideo.classList.remove('active');
                localPlaceholder.classList.remove('hidden');
            }
        }
    }
}

// Reset client UI state and release resources
function endCall() {
    updateStatus('Disconnected', 'disconnected');
    
    joinBtn.classList.remove('disconnect-btn');
    joinBtn.classList.add('connect-btn');
    joinBtn.disabled = false;
    joinBtn.title = "Connect to call";
    isConnected = false;

    // Release local media
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    localVideo.srcObject = null;
    localVideo.classList.remove('active');
    localPlaceholder.classList.remove('hidden');

    // Close all peer connections
    Object.keys(peers).forEach(peerId => {
        closePeer(peerId);
    });

    muteAudioBtn.disabled = true;
    muteVideoBtn.disabled = true;
    muteAudioBtn.classList.remove('muted');
    muteVideoBtn.classList.remove('muted');

    if (socket) {
        socket.onclose = null; // prevent recursive trigger
        socket.close();
        socket = null;
    }

    myPeerId = null;
    currentHostId = null;

    updateLayout();

    // Redirect to home page
    window.location.href = '/';
}
