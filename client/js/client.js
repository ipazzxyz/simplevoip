// UI Elements
const localVideo = document.getElementById('localVideo');
const deafenBtn = document.getElementById('deafenBtn');
const muteAudioBtn = document.getElementById('muteAudio');
const muteVideoBtn = document.getElementById('muteVideo');
const switchCameraBtn = document.getElementById('switchCamera');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const localPlaceholder = document.getElementById('localPlaceholder');
const roomBadge = document.getElementById('roomBadge');
const roomText = document.getElementById('roomText');

// WebRTC & WS state
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let originalVideoTrack = null;
const peers = {}; // peerId -> { peerConnection, remoteStream, wrapperElement, iceQueue, remoteDescriptionSet }
let myPeerId = null;
let currentHostId = null;
let socket = null;
let isConnected = false;
let isDeafened = false;

// Audio context & video device state
let audioContext = null;
let videoDevices = [];
let currentVideoDeviceIndex = 0;

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
deafenBtn.addEventListener('click', toggleDeafen);

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
if (switchCameraBtn) {
    switchCameraBtn.addEventListener('click', switchCamera);
}
if (shareScreenBtn) {
    shareScreenBtn.addEventListener('click', toggleScreenShare);
}

// Initialize AudioContext on first user interaction to satisfy autoplay policies
document.addEventListener('click', () => {
    getAudioContext();
}, { once: true });

// Start call automatically on page load
window.addEventListener('DOMContentLoaded', () => {
    startCall();
});

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
// Start user media and open socket connection
async function startCall() {
    updateStatus('Accessing media...', 'connecting');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateStatus('Media Error', 'disconnected');
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
            alert('Could not access camera or microphone. Please verify they are plugged in and permissions are granted.');
            return;
        }
    }

    let hasRealVideo = localStream.getVideoTracks().length > 0;
    const hasAudio = localStream.getAudioTracks().length > 0;

    if (!hasRealVideo) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const dummyStream = canvas.captureStream(1);
            const dummyTrack = dummyStream.getVideoTracks()[0];
            dummyTrack.enabled = false;
            localStream.addTrack(dummyTrack);
            console.log("Added dummy video track to localStream for screen share compatibility.");
        } catch (e) {
            console.error("Failed to create dummy video track:", e);
        }
    }

    const hasVideo = localStream.getVideoTracks().length > 0;

    localVideo.srcObject = localStream;
    
    // Disable camera by default
    if (hasVideo) {
        localStream.getVideoTracks()[0].enabled = false;
    }
    
    localVideo.classList.remove('active');
    localPlaceholder.classList.remove('hidden');
    updateLocalPlaceholderText();
    
    // Enable controls only for active tracks
    muteAudioBtn.disabled = !hasAudio;
    muteVideoBtn.disabled = !hasRealVideo;
    if (shareScreenBtn) {
        shareScreenBtn.disabled = false;
    }
    deafenBtn.disabled = false;
    muteAudioBtn.classList.remove('muted');
    deafenBtn.classList.remove('muted');
    
    if (hasRealVideo) {
        muteVideoBtn.classList.add('muted');
    } else {
        muteVideoBtn.classList.remove('muted');
    }

    if (switchCameraBtn) {
        switchCameraBtn.disabled = !hasRealVideo;
    }

    await updateVideoDevices();
    updateSwitchCameraButtonVisibility();

    if (hasAudio) {
        monitorSpeech(localStream, document.getElementById('localVideoWrapper'));
    }

    updateStatus('Connecting to server...', 'connecting');
    
    const room = window.location.pathname.substring(1);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(room)}`;
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        updateStatus('Waiting for peer...', 'connecting');
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
        remoteDescriptionSet: false,
        micMuted: false,
        deafened: false
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

            if (event.track.kind === 'audio') {
                monitorSpeech(remoteStream, wrapper);
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
    video.muted = isDeafened;
    
    videoContainer.appendChild(wrapper);
    peers[peerId].wrapperElement = wrapper;
    
    updateLayout();
    updateHostButtons();
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
    updatePeerVisuals();
    
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

// Update labels with crown icons for host and mute/deafen status icons
function updatePeerVisuals() {
    const isHost = (myPeerId && currentHostId && myPeerId === currentHostId);
    
    // Update local label
    const localLabel = document.querySelector('#localVideoWrapper .video-label');
    if (localLabel) {
        let content = 'You';
        if (isHost) {
            content += ` <svg class="crown-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 14h14v2H5v-2z"/></svg>`;
        }
        
        const audioTrack = localStream ? localStream.getAudioTracks()[0] : null;
        const isMicMuted = audioTrack ? !audioTrack.enabled : true;
        
        if (isMicMuted) {
            content += ` <svg class="status-icon mic-muted-icon" viewBox="0 0 24 24" width="14" height="14" style="color: var(--accent-red); filter: drop-shadow(0 0 4px rgba(255, 51, 102, 0.4)); overflow: visible;"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--accent-red)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
        }
        if (isDeafened) {
            content += ` <svg class="status-icon deafened-icon" viewBox="0 0 24 24" width="14" height="14" style="color: var(--accent-red); filter: drop-shadow(0 0 4px rgba(255, 51, 102, 0.4)); overflow: visible;"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h2v-8H5v-2a7 7 0 0 1 14 0v2h-3v8h2a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9z"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--accent-red)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
        }
        
        localLabel.innerHTML = content;
    }

    // Update remote labels
    Object.keys(peers).forEach(peerId => {
        const peerState = peers[peerId];
        if (!peerState.wrapperElement) return;
        const label = peerState.wrapperElement.querySelector('.video-label');
        if (label) {
            let content = `User (${peerId.substring(5, 9)})`;
            const isPeerHost = (peerId === currentHostId);
            if (isPeerHost) {
                content += ` <svg class="crown-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 14h14v2H5v-2z"/></svg>`;
            }
            if (peerState.micMuted) {
                content += ` <svg class="status-icon mic-muted-icon" viewBox="0 0 24 24" width="14" height="14" style="color: var(--accent-red); filter: drop-shadow(0 0 4px rgba(255, 51, 102, 0.4)); overflow: visible;"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--accent-red)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
            }
            if (peerState.deafened) {
                content += ` <svg class="status-icon deafened-icon" viewBox="0 0 24 24" width="14" height="14" style="color: var(--accent-red); filter: drop-shadow(0 0 4px rgba(255, 51, 102, 0.4)); overflow: visible;"><path fill="currentColor" d="M12 3a9 9 0 0 0-9 9v7a3 3 0 0 0 3 3h2v-8H5v-2a7 7 0 0 1 14 0v2h-3v8h2a3 3 0 0 0 3-3v-7a9 9 0 0 0-9-9z"/><line x1="3" y1="3" x2="21" y2="21" stroke="var(--accent-red)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
            }
            
            label.innerHTML = content;
        }
    });
}

// Toggle Deafen (Mute remote sound and auto-mute local microphone and video)
function toggleDeafen() {
    isDeafened = !isDeafened;
    deafenBtn.classList.toggle('muted', isDeafened);

    // Mute/unmute all remote audio streams
    Object.keys(peers).forEach(peerId => {
        const wrapper = peers[peerId].wrapperElement;
        if (wrapper) {
            const video = wrapper.querySelector('video');
            if (video) {
                video.muted = isDeafened;
            }
        }
    });

    // Auto-mute microphone and camera if deafen is enabled
    if (isDeafened) {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack && audioTrack.enabled) {
                audioTrack.enabled = false;
                muteAudioBtn.classList.add('muted');
            }
            
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack && videoTrack.enabled) {
                videoTrack.enabled = false;
                muteVideoBtn.classList.add('muted');
                localVideo.classList.remove('active');
                localPlaceholder.classList.remove('hidden');
                updateLocalPlaceholderText();
            }
        }
    }
    updatePeerVisuals();
    broadcastLocalState();
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
        broadcastLocalState();
    }
    else if (msg.type === 'peer-joined') {
        console.log(`Peer joined: ${msg.peerId}`);
        initPeerConnection(msg.peerId, false);
        updateLayout();
        updateHostButtons();
        broadcastLocalState();
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
    else if (msg.type === 'state-update') {
        const peerState = peers[sender];
        if (peerState) {
            peerState.micMuted = msg.micMuted;
            peerState.deafened = msg.deafened;
            updatePeerVisuals();
        }
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
            updatePeerVisuals();
            broadcastLocalState();
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
                updateLocalPlaceholderText();
            }
            updateSwitchCameraButtonVisibility();
        }
    }
}

// Reset client UI state and release resources
function endCall() {
    updateStatus('Disconnected', 'disconnected');
    
    isConnected = false;

    if (isScreenSharing) {
        stopScreenShare();
    }

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
    if (shareScreenBtn) {
        shareScreenBtn.disabled = true;
        shareScreenBtn.classList.remove('sharing');
        shareScreenBtn.title = 'Share Screen';
    }
    deafenBtn.disabled = true;
    if (switchCameraBtn) {
        switchCameraBtn.disabled = true;
        switchCameraBtn.classList.add('hidden');
    }
    muteAudioBtn.classList.remove('muted');
    muteVideoBtn.classList.remove('muted');
    deafenBtn.classList.remove('muted');
    isDeafened = false;

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

// Helper to initialize or resume AudioContext on user interaction
function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(err => console.error('Error resuming AudioContext:', err));
    }
    return audioContext;
}

// Monitor audio levels to detect speaking (voice activation border)
function monitorSpeech(stream, wrapperElement) {
    if (!stream || stream.getAudioTracks().length === 0 || !wrapperElement) return;

    // Clean up any existing monitor on this wrapper element to prevent leaks/conflicts
    if (wrapperElement.__speechMonitorCleanup) {
        wrapperElement.__speechMonitorCleanup();
    }

    try {
        const ctx = getAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const bufferLength = analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);
        
        let speakingTimeout = null;
        let isSpeaking = false;
        
        const intervalId = setInterval(() => {
            // Stop loop if stream is no longer active or wrapper is deleted
            if (!stream.active || !wrapperElement.isConnected) {
                cleanup();
                return;
            }
            
            // Check if audio track is active and enabled
            const audioTrack = stream.getAudioTracks()[0];
            if (!audioTrack || !audioTrack.enabled || audioTrack.muted) {
                if (isSpeaking) {
                    isSpeaking = false;
                    wrapperElement.classList.remove('speaking');
                }
                return;
            }

            // Using Root Mean Square (RMS) on time domain data is significantly more
            // robust than averaging frequency bins, preventing background comfort noise,
            // static hiss, or low frequency fan hums from triggering voice outlines.
            analyser.getFloatTimeDomainData(dataArray);
            let sumSquares = 0;
            for (let i = 0; i < bufferLength; i++) {
                sumSquares += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sumSquares / bufferLength);

            // A threshold of 0.025 (approx -32dB) represents active speech,
            // while ignoring silent room environments or device static.
            if (rms > 0.025) {
                if (!isSpeaking) {
                    isSpeaking = true;
                    wrapperElement.classList.add('speaking');
                }
                if (speakingTimeout) clearTimeout(speakingTimeout);
                speakingTimeout = setTimeout(() => {
                    isSpeaking = false;
                    wrapperElement.classList.remove('speaking');
                }, 400); // Hold glow for 400ms
            }
        }, 100);

        const cleanup = () => {
            clearInterval(intervalId);
            if (speakingTimeout) clearTimeout(speakingTimeout);
            try {
                source.disconnect();
                analyser.disconnect();
            } catch (e) {}
            if (wrapperElement.classList.contains('speaking')) {
                wrapperElement.classList.remove('speaking');
            }
            delete wrapperElement.__speechMonitorCleanup;
        };

        wrapperElement.__speechMonitorCleanup = cleanup;

    } catch (e) {
        console.error('Error setting up speech monitor:', e);
    }
}

// Enumerate available video input devices
async function updateVideoDevices() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devices.filter(device => device.kind === 'videoinput');
        console.log('Available video input devices:', videoDevices);
        
        // Find current device index based on localStream's video track
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                const settings = videoTrack.getSettings();
                const currentDeviceId = settings.deviceId;
                if (currentDeviceId) {
                    const idx = videoDevices.findIndex(d => d.deviceId === currentDeviceId);
                    if (idx !== -1) {
                        currentVideoDeviceIndex = idx;
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error enumerating video devices:', err);
    }
}

// Toggle visibility of the Switch Camera button
function updateSwitchCameraButtonVisibility() {
    if (!switchCameraBtn) return;
    if (isScreenSharing) {
        switchCameraBtn.classList.add('hidden');
        return;
    }
    const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;
    const isCameraEnabled = videoTrack && videoTrack.enabled;
    
    // Only show switcher if camera is enabled AND multiple cameras exist
    if (isCameraEnabled && videoDevices.length > 1) {
        switchCameraBtn.classList.remove('hidden');
    } else {
        switchCameraBtn.classList.add('hidden');
    }
}

// Switch/flip local camera track
async function switchCamera() {
    if (!localStream || videoDevices.length <= 1) return;
    
    const oldTrack = localStream.getVideoTracks()[0];
    if (!oldTrack) return;
    
    // Cycle to next video device
    currentVideoDeviceIndex = (currentVideoDeviceIndex + 1) % videoDevices.length;
    const newDevice = videoDevices[currentVideoDeviceIndex];
    console.log(`Switching camera to: ${newDevice.label || newDevice.deviceId}`);
    
    try {
        // Stop current track to release hardware
        oldTrack.stop();
        
        // Get new track constraints
        const constraints = {
            video: {
                deviceId: { exact: newDevice.deviceId }
            },
            audio: false
        };
        
        const tempStream = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = tempStream.getVideoTracks()[0];
        
        if (newTrack) {
            newTrack.enabled = true;
            
            // Replace track in localStream
            localStream.removeTrack(oldTrack);
            localStream.addTrack(newTrack);
            
            // Re-assign local video source
            localVideo.srcObject = localStream;
            
            // Replace track on all peer connections
            Object.keys(peers).forEach(peerId => {
                const pc = peers[peerId].peerConnection;
                if (pc) {
                    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(newTrack).then(() => {
                            console.log(`Replaced video track for peer: ${peerId}`);
                        }).catch(err => {
                            console.error(`Error replacing video track for peer ${peerId}:`, err);
                        });
                    }
                }
            });
        }
    } catch (err) {
        console.error('Error switching camera:', err);
        alert('Failed to switch camera device. Please ensure it is not in use by another app.');
    }
}

// Watch for connected/disconnected devices dynamically
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
        await updateVideoDevices();
        updateSwitchCameraButtonVisibility();
    });
}

// Update local video placeholder status text dynamically
function updateLocalPlaceholderText() {
    const placeholderText = document.getElementById('localPlaceholderText');
    if (!placeholderText) return;

    if (!localStream) {
        placeholderText.textContent = 'Camera is off';
        return;
    }

    if (isScreenSharing) {
        placeholderText.textContent = '';
        return;
    }

    const hasRealVideo = videoDevices.length > 0;
    if (!hasRealVideo) {
        placeholderText.textContent = 'Audio-only';
    } else {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack && videoTrack.enabled) {
            placeholderText.textContent = '';
        } else {
            placeholderText.textContent = 'Camera is off';
        }
    }
}

// Broadcast local mic and deafen states to other participants
function broadcastLocalState() {
    const audioTrack = localStream ? localStream.getAudioTracks()[0] : null;
    const isMicMuted = audioTrack ? !audioTrack.enabled : true;
    sendMessage({
        type: 'state-update',
        micMuted: isMicMuted,
        deafened: isDeafened
    });
}

// Toggle Screen Sharing State
async function toggleScreenShare() {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        await startScreenShare();
    }
}

// Start screen sharing
async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert('Screen sharing is not supported by your browser.');
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Track when screen sharing ends via browser UI
        screenTrack.onended = () => {
            console.log('Screen sharing ended via browser UI');
            stopScreenShare();
        };

        isScreenSharing = true;
        if (shareScreenBtn) {
            shareScreenBtn.classList.add('sharing');
            shareScreenBtn.title = 'Stop Screen Share';
        }

        // Keep track of the original video track in localStream
        const localVideoTracks = localStream.getVideoTracks();
        if (localVideoTracks.length > 0) {
            originalVideoTrack = localVideoTracks[0];
            // Remove the webcam/dummy track from localStream
            localStream.removeTrack(originalVideoTrack);
        }

        // Add screenTrack to localStream
        localStream.addTrack(screenTrack);

        // Update local video element
        localVideo.srcObject = localStream;
        localVideo.classList.add('active');
        localPlaceholder.classList.add('hidden');
        updateLocalPlaceholderText();

        // Update other controls visibility/states
        updateSwitchCameraButtonVisibility();
        muteVideoBtn.disabled = true;

        // Replace track for all peer connections
        Object.keys(peers).forEach(peerId => {
            const pc = peers[peerId].peerConnection;
            if (pc) {
                const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(screenTrack).then(() => {
                        console.log(`Replaced video track with screen track for peer: ${peerId}`);
                    }).catch(err => {
                        console.error(`Error replacing track for peer ${peerId}:`, err);
                    });
                }
            }
        });

    } catch (err) {
        console.error('Error starting screen share:', err);
        isScreenSharing = false;
        if (shareScreenBtn) {
            shareScreenBtn.classList.remove('sharing');
            shareScreenBtn.title = 'Share Screen';
        }
    }
}

// Stop screen sharing
function stopScreenShare() {
    if (!isScreenSharing) return;

    isScreenSharing = false;
    if (shareScreenBtn) {
        shareScreenBtn.classList.remove('sharing');
        shareScreenBtn.title = 'Share Screen';
    }

    // Stop screen share stream tracks
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }

    // Remove screen track from localStream
    const localVideoTracks = localStream.getVideoTracks();
    localVideoTracks.forEach(track => {
        if (track !== originalVideoTrack) {
            localStream.removeTrack(track);
            track.stop();
        }
    });

    // Restore original video track
    if (originalVideoTrack) {
        localStream.addTrack(originalVideoTrack);

        if (originalVideoTrack.enabled) {
            localVideo.classList.add('active');
            localPlaceholder.classList.add('hidden');
        } else {
            localVideo.classList.remove('active');
            localPlaceholder.classList.remove('hidden');
        }

        // Replace track back for all peer connections
        Object.keys(peers).forEach(peerId => {
            const pc = peers[peerId].peerConnection;
            if (pc) {
                const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(originalVideoTrack).then(() => {
                        console.log(`Restored webcam track for peer: ${peerId}`);
                    }).catch(err => {
                        console.error(`Error restoring track for peer ${peerId}:`, err);
                    });
                }
            }
        });
    } else {
        localVideo.classList.remove('active');
        localPlaceholder.classList.remove('hidden');
    }

    // Restore controls states
    const hasRealVideo = videoDevices.length > 0;
    muteVideoBtn.disabled = !hasRealVideo;

    updateLocalPlaceholderText();
    updateSwitchCameraButtonVisibility();
    originalVideoTrack = null;
}
