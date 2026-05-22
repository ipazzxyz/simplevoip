// UI Elements
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const joinBtn = document.getElementById('joinBtn');
const muteAudioBtn = document.getElementById('muteAudio');
const muteVideoBtn = document.getElementById('muteVideo');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const localPlaceholder = document.getElementById('localPlaceholder');
const remotePlaceholder = document.getElementById('remotePlaceholder');
const remotePlaceholderText = document.getElementById('remotePlaceholderText');
const remoteSpinner = document.getElementById('remoteSpinner');
const remoteUserIcon = document.getElementById('remoteUserIcon');

// WebRTC & WS state
let localStream = null;
let peerConnection = null;
let socket = null;
let isConnected = false;

// Candidate Queue to prevent WebRTC race conditions
let remoteDescriptionSet = false;
let iceCandidateQueue = [];

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Event Listeners
joinBtn.addEventListener('click', () => {
    if (!isConnected) {
        startCall();
    } else {
        endCall();
    }
});

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
    
    if (hasVideo) {
        localVideo.classList.add('active');
        localPlaceholder.classList.add('hidden');
    } else {
        localVideo.classList.remove('active');
        localPlaceholder.classList.remove('hidden');
    }
    
    // Enable controls only for active tracks
    muteAudioBtn.disabled = !hasAudio;
    muteVideoBtn.disabled = !hasVideo;
    muteAudioBtn.classList.remove('muted');
    muteVideoBtn.classList.remove('muted');

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

        initPeerConnection();
        // Send a message notifying other peers we are ready
        sendMessage({ type: 'ready' });
    };

    socket.onclose = (event) => {
        if (event && (event.reason === 'Room full' || event.code === 1008)) {
            alert('This room is full (max 2 participants). Redirecting to homepage.');
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

// Initialize RTCPeerConnection and track listeners
function initPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Add local stream tracks to PC
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Capture remote stream tracks
    peerConnection.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.classList.add('active');
            remotePlaceholder.classList.add('hidden');
            updateStatus('Connected to Peer', 'success');

            // Listen to mute/unmute events on the remote video track
            if (event.track.kind === 'video') {
                const handleMute = () => {
                    console.log('Remote video muted');
                    remoteVideo.classList.remove('active');
                    remotePlaceholderText.textContent = 'Remote camera is off';
                    remoteSpinner.style.display = 'none';
                    remoteUserIcon.style.display = 'flex';
                    remotePlaceholder.classList.remove('hidden');
                };

                const handleUnmute = () => {
                    console.log('Remote video unmuted');
                    remoteVideo.classList.add('active');
                    remotePlaceholder.classList.add('hidden');
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
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendMessage({ type: 'candidate', candidate: event.candidate });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state change:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
            updateStatus('Connected to Peer', 'success');
            
            // Check if we have remote video receiver. If not or if muted, show user icon.
            const videoReceiver = peerConnection.getReceivers().find(r => r.track && r.track.kind === 'video');
            if (!videoReceiver) {
                remotePlaceholderText.textContent = 'Remote is audio-only';
                remoteSpinner.style.display = 'none';
                remoteUserIcon.style.display = 'flex';
                remotePlaceholder.classList.remove('hidden');
            } else if (videoReceiver.track.muted) {
                remotePlaceholderText.textContent = 'Remote camera is off';
                remoteSpinner.style.display = 'none';
                remoteUserIcon.style.display = 'flex';
                remotePlaceholder.classList.remove('hidden');
            }
        } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            updateStatus('Peer disconnected', 'connecting');
            remoteVideo.srcObject = null;
            remoteVideo.classList.remove('active');
            remotePlaceholderText.textContent = 'Waiting for remote peer...';
            remoteSpinner.style.display = 'flex';
            remoteUserIcon.style.display = 'none';
            remotePlaceholder.classList.remove('hidden');
        }
    };
}

// Handle incoming WebRTC signaling messages
async function handleSignalingMessage(msg) {
    if (!peerConnection) return;

    if (msg.type === 'ready') {
        console.log('Received: ready. Creating offer.');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        sendMessage({ type: 'offer', sdp: offer.sdp });
        updateStatus('Calling...', 'connecting');
    } 
    else if (msg.type === 'offer') {
        console.log('Received: offer. Setting remote description & creating answer.');
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
        remoteDescriptionSet = true;
        await processQueuedCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendMessage({ type: 'answer', sdp: answer.sdp });
        updateStatus('Connecting...', 'connecting');
    } 
    else if (msg.type === 'answer') {
        console.log('Received: answer. Setting remote description.');
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        remoteDescriptionSet = true;
        await processQueuedCandidates();
        updateStatus('Connected to Peer', 'success');
    } 
    else if (msg.type === 'candidate') {
        const candidate = new RTCIceCandidate(msg.candidate);
        if (remoteDescriptionSet) {
            try {
                await peerConnection.addIceCandidate(candidate);
            } catch (err) {
                console.error('Error adding ICE candidate:', err);
            }
        } else {
            console.log('Queueing ICE candidate until remote description is set.');
            iceCandidateQueue.push(candidate);
        }
    }
}

// Process candidates that arrived before the Remote Description was set
async function processQueuedCandidates() {
    while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (err) {
            console.error('Error applying queued ICE candidate:', err);
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

    remoteVideo.srcObject = null;
    remoteVideo.classList.remove('active');
    remotePlaceholderText.textContent = 'Waiting for remote peer...';
    remoteSpinner.style.display = 'flex';
    remoteUserIcon.style.display = 'none';
    remotePlaceholder.classList.remove('hidden');

    muteAudioBtn.disabled = true;
    muteVideoBtn.disabled = true;
    muteAudioBtn.classList.remove('muted');
    muteVideoBtn.classList.remove('muted');

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (socket) {
        socket.onclose = null; // prevent recursive trigger
        socket.close();
        socket = null;
    }

    iceCandidateQueue = [];
    remoteDescriptionSet = false;

    // Redirect to home page
    window.location.href = '/';
}
