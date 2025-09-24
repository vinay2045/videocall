/*
  Frontend app logic for presence, calls, and UI rendering.
  - Renders user list with online/offline
  - Manages multiple concurrent calls with tiles
  - Uses WebRTC for media and Socket.IO for signaling
*/

(() => {
  const socket = io();
  const currentUser = window.__APP_USER__;

  // DOM refs
  const userListEl = document.getElementById('user-list');
  const videoGridEl = document.getElementById('video-grid');

  // State
  const peers = new Map(); // userId -> RTCPeerConnection
  const remoteStreams = new Map(); // userId -> MediaStream
  let localStream = null; // MediaStream
  let usersCache = []; // fetched users
  const incomingPrompts = new Map(); // userId -> DOM element

  // STUN servers for ICE
  const rtcConfig = {
    iceServers: [
      { urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302'
      ] }
      // If you add TURN, use a valid turn: URL from your provider, e.g.
      // { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' }
    ]
  };

  // Initialize media (re-acquire if existing tracks are ended)
  async function ensureLocalStream() {
    try {
      if (localStream) {
        const allEnded = localStream.getTracks().every(t => t.readyState === 'ended');
        if (!allEnded) return localStream;
        console.warn('[media] Existing localStream tracks ended; re-acquiring media');
      }
      console.log('[media] Requesting user media (video+audio)');
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      console.log('[media] Got user media');
      return localStream;
    } catch (err) {
      console.error('[media] Failed to get user media:', err && (err.name + ': ' + err.message));
      alert('Could not access camera/microphone (' + (err && err.name ? err.name : 'Error') + '). Please allow permissions and try again.');
      throw err;
    }
  }

  // Render users list
  async function fetchUsersAndRender() {
    try {
      const res = await fetch('/users/online');
      const data = await res.json();
      usersCache = data.users || [];
      renderUserList();
    } catch (e) {
      console.error('Failed to fetch users', e);
    }
  }

  function renderUserList() {
    userListEl.innerHTML = '';
    usersCache.forEach(u => {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.dataset.userId = u._id;

      const meta = document.createElement('div');
      meta.className = 'user-meta';

      const dot = document.createElement('div');
      dot.className = 'status-dot ' + (u.online ? 'online' : 'offline');

      const name = document.createElement('div');
      name.className = 'user-name';
      name.textContent = u.name;

      const role = document.createElement('div');
      role.className = 'user-role';
      role.textContent = u.role;

      meta.appendChild(dot);
      meta.appendChild(name);
      meta.appendChild(role);

      const actions = document.createElement('div');
      actions.className = 'user-actions';

      const callBtn = document.createElement('button');
      callBtn.className = 'call-btn' + (u.online ? '' : ' disabled');
      callBtn.textContent = 'Call';
      callBtn.disabled = !u.online;
      callBtn.addEventListener('click', () => startCall(u));

      actions.appendChild(callBtn);

      li.appendChild(meta);
      li.appendChild(actions);

      userListEl.appendChild(li);
    });
  }

  // Call Tile UI
  function ensureCallTile(peerUser) {
    let tile = document.querySelector(`.call-tile[data-user-id="${peerUser._id}"]`);
    if (tile) return tile;

    tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.userId = peerUser._id;

    const header = document.createElement('div');
    header.className = 'call-header';

    const title = document.createElement('div');
    title.className = 'call-title';
    title.textContent = `Call with ${peerUser.name}`;

    const controls = document.createElement('div');
    controls.className = 'call-controls';

    const endBtn = document.createElement('button');
    endBtn.className = 'end-call';
    endBtn.textContent = 'End';
    endBtn.addEventListener('click', () => endCall(peerUser._id, 'hangup'));

    controls.appendChild(endBtn);
    header.appendChild(title);
    header.appendChild(controls);

    const panes = document.createElement('div');
    panes.className = 'video-panes';

    const leftWrap = document.createElement('div');
    leftWrap.className = 'video-wrapper';
    const localVideo = document.createElement('video');
    localVideo.autoplay = true; localVideo.muted = true; localVideo.playsInline = true;
    localVideo.dataset.kind = 'local';
    const localLbl = document.createElement('div');
    localLbl.className = 'video-label';
    localLbl.textContent = `${currentUser.name} (You)`;
    leftWrap.appendChild(localVideo);
    leftWrap.appendChild(localLbl);

    const rightWrap = document.createElement('div');
    rightWrap.className = 'video-wrapper';
    const remoteVideo = document.createElement('video');
    remoteVideo.autoplay = true; remoteVideo.playsInline = true;
    remoteVideo.dataset.kind = 'remote';
    const remoteLbl = document.createElement('div');
    remoteLbl.className = 'video-label';
    remoteLbl.textContent = `${peerUser.name}`;
    rightWrap.appendChild(remoteVideo);
    rightWrap.appendChild(remoteLbl);

    panes.appendChild(leftWrap);
    panes.appendChild(rightWrap);

    tile.appendChild(header);
    tile.appendChild(panes);

    videoGridEl.appendChild(tile);

    return tile;
  }

  function deleteCallTile(peerUserId) {
    const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
    if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
  }

  // WebRTC helpers
  function createPeerConnection(peerUserId) {
    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice-candidate', { toUserId: peerUserId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      let stream = remoteStreams.get(peerUserId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreams.set(peerUserId, stream);
      }
      stream.addTrack(e.track);
      const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
      if (tile) {
        const video = tile.querySelector('video[data-kind="remote"]');
        if (video && video.srcObject !== stream) {
          video.srcObject = stream;
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[webrtc] connectionState', peerUserId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endCall(peerUserId, 'connectionstate:' + pc.connectionState);
      }
    };

    pc.onnegotiationneeded = async () => {
      console.log('[webrtc] negotiationneeded for', peerUserId);
    };

    peers.set(peerUserId, pc);
    return pc;
  }

  async function attachLocalStreamToTile(tile) {
    const video = tile.querySelector('video[data-kind="local"]');
    try {
      const stream = await ensureLocalStream();
      if (video && video.srcObject !== stream) video.srcObject = stream;
    } catch (_) {
      // If user media is unavailable, we still allow receive-only calls.
      console.warn('[media] attachLocalStreamToTile: continuing without local media');
    }
  }

  async function addLocalTracks(pc) {
    try {
      const stream = await ensureLocalStream();
      const tracks = stream.getTracks();
      if (tracks.length === 0) {
        console.warn('[media] No local tracks available, adding recvonly transceivers');
        ensureRecvOnly(pc);
        return;
      }
      tracks.forEach(track => pc.addTrack(track, stream));
    } catch (e) {
      console.warn('[media] Could not get local media, using recvonly transceivers', e && (e.name + ': ' + e.message));
      ensureRecvOnly(pc);
    }
  }

  function ensureRecvOnly(pc) {
    // Ensure at least audio/video transceivers exist once
    const tr = pc.getTransceivers();
    const kinds = new Set(
      tr.map(t => (t.receiver && t.receiver.track && t.receiver.track.kind) || (t.sender && t.sender.track && t.sender.track.kind))
    );
    if (!kinds.has('audio')) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!kinds.has('video')) pc.addTransceiver('video', { direction: 'recvonly' });
  }

  // Incoming call prompt UI
  function showIncomingCallPrompt({ fromUserId, fromName, offer }) {
    // Prevent duplicate prompts
    if (incomingPrompts.has(fromUserId)) return;

    const wrap = document.createElement('div');
    wrap.className = 'call-toast';
    wrap.dataset.userId = fromUserId;

    const text = document.createElement('div');
    text.className = 'call-toast-text';
    text.innerHTML = `<div class="title">Incoming call</div><div class="sub">from ${fromName}</div>`;

    const actions = document.createElement('div');
    actions.className = 'call-toast-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn btn-accept';
    acceptBtn.textContent = 'Accept';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-reject';
    rejectBtn.textContent = 'Reject';

    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);
    wrap.appendChild(text);
    wrap.appendChild(actions);

    document.body.appendChild(wrap);
    incomingPrompts.set(fromUserId, wrap);

    const cleanup = () => {
      if (incomingPrompts.has(fromUserId)) {
        const el = incomingPrompts.get(fromUserId);
        try { el.remove(); } catch(_){}
        incomingPrompts.delete(fromUserId);
      }
    };

    acceptBtn.addEventListener('click', async () => {
      cleanup();
      await handleIncomingCall({ fromUserId, fromName, offer });
    });
    rejectBtn.addEventListener('click', () => {
      cleanup();
      socket.emit('end-call', { toUserId: fromUserId, reason: 'rejected' });
    });
  }

  // Call flows
  async function startCall(peerUser) {
    try {
      if (peers.has(peerUser._id)) {
        console.log('Already calling this user');
        return;
      }

      const tile = ensureCallTile(peerUser);
      await attachLocalStreamToTile(tile);

      const pc = createPeerConnection(peerUser._id);
      await addLocalTracks(pc);

      console.log('[webrtc] creating offer ->', peerUser._id);
      let offer;
      try {
        offer = await pc.createOffer();
      } catch (err) {
        console.warn('[webrtc] createOffer failed once, ensuring recvonly transceivers then retry. Error:', err && (err.name + ': ' + err.message));
        ensureRecvOnly(pc);
        offer = await pc.createOffer();
      }
      console.log('[webrtc] setLocalDescription(offer)');
      await pc.setLocalDescription(offer);
      console.log('[signal] emit call-user ->', peerUser._id);
      socket.emit('call-user', { toUserId: peerUser._id, offer });
    } catch (e) {
      console.error('[call] startCall error', e && (e.name + ': ' + e.message));
      alert('Failed to start call. ' + (e && e.name ? '(' + e.name + ')' : ''));
      endCall(peerUser._id, 'error');
    }
  }

  async function handleIncomingCall({ fromUserId, fromName, offer }) {
    try {
      // Find user object for tile labels
      const peerUser = usersCache.find(u => u._id === fromUserId) || { _id: fromUserId, name: fromName };
      const tile = ensureCallTile(peerUser);
      await attachLocalStreamToTile(tile);

      let pc = peers.get(fromUserId);
      if (!pc) pc = createPeerConnection(fromUserId);

      // Set remote first to establish transceivers reliably across browsers
      console.log('[webrtc] setRemoteDescription(offer) from', fromUserId);
      await pc.setRemoteDescription(offer);
      await addLocalTracks(pc);
      const answer = await pc.createAnswer();
      console.log('[webrtc] setLocalDescription(answer)');
      await pc.setLocalDescription(answer);
      console.log('[signal] emit answer-call ->', fromUserId);
      socket.emit('answer-call', { toUserId: fromUserId, answer });
    } catch (e) {
      console.error('[call] handleIncomingCall error', e && (e.name + ': ' + e.message));
    }
  }

  async function handleCallAnswered({ fromUserId, answer }) {
    try {
      const pc = peers.get(fromUserId);
      if (!pc) return;
      console.log('[webrtc] setRemoteDescription(answer) from', fromUserId);
      await pc.setRemoteDescription(answer);
    } catch (e) {
      console.error('[call] handleCallAnswered error', e && (e.name + ': ' + e.message));
    }
  }

  async function handleIceCandidate({ fromUserId, candidate }) {
    try {
      const pc = peers.get(fromUserId);
      if (!pc) return;
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[call] handleIceCandidate error', e && (e.name + ': ' + e.message));
    }
  }

  function endCall(peerUserId, reason) {
    const pc = peers.get(peerUserId);
    if (pc) {
      // Do not stop local tracks here; keep camera for possible subsequent calls
      try {
        pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch(_){} });
      } catch(_){}
      try { pc.close(); } catch(_){}
      peers.delete(peerUserId);
    }
    remoteStreams.delete(peerUserId);
    deleteCallTile(peerUserId);
    socket.emit('end-call', { toUserId: peerUserId, reason: reason || 'ended' });
  }

  function handleCallEnded({ fromUserId }) {
    const pc = peers.get(fromUserId);
    if (pc) {
      try { pc.close(); } catch(_){}
      peers.delete(fromUserId);
    }
    remoteStreams.delete(fromUserId);
    deleteCallTile(fromUserId);
  }

  // Socket wiring
  socket.on('connect', () => {
    socket.emit('presence:refresh');
    fetchUsersAndRender();
  });

  socket.on('online-status', () => {
    fetchUsersAndRender();
  });

  socket.on('incoming-call', (payload) => {
    // Show accept/reject prompt instead of auto-answering
    showIncomingCallPrompt(payload);
  });
  socket.on('call-answered', handleCallAnswered);
  socket.on('ice-candidate', handleIceCandidate);
  socket.on('call-ended', handleCallEnded);

  // Initial load
  fetchUsersAndRender();
})();
