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
  const peerAudioNodes = new Map(); // userId -> MediaStreamAudioSourceNode
  let audioCtx = null;

  // Ensure at least one user gesture unlocks audio context globally
  document.addEventListener('click', () => {
    try { unlockAudio(); } catch(_){}
  }, { once: true });

  // Release media on page unload to allow other browsers to access devices
  window.addEventListener('beforeunload', () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    window.removeEventListener('beforeunload', arguments.callee);
  });

  // SDP munging to improve latency and echo resilience
  function tuneSDP(sdp) {
    try {
      const lines = sdp.split(/\r?\n/);
      const ptToCodec = new Map();
      for (const l of lines) {
        const m = l.match(/^a=rtpmap:(\d+)\s+([^\/]+)/i);
        if (m) ptToCodec.set(m[1], m[2].toLowerCase());
      }
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const m = l.match(/^a=fmtp:(\d+)\s*(.*)$/i);
        if (!m) continue;
        const pt = m[1];
        const codec = ptToCodec.get(pt) || '';
        const params = m[2] ? m[2].split(';').map(s=>s.trim()).filter(Boolean) : [];
        const pushIfMissing = (k,v) => { if (!params.some(p=>p.toLowerCase().startsWith(k+'='))) params.push(`${k}=${v}`); };
        if (codec.includes('opus')) {
          pushIfMissing('stereo','0');
          pushIfMissing('sprop-stereo','0');
          pushIfMissing('maxaveragebitrate','24000');
          pushIfMissing('useinbandfec','1');
          pushIfMissing('usedtx','1');
          pushIfMissing('ptime','20');
          lines[i] = `a=fmtp:${pt} ${params.join(';')}`;
        } else if (codec.includes('vp8') || codec.includes('h264')) {
          pushIfMissing('x-google-start-bitrate','1200');
          pushIfMissing('x-google-max-bitrate','1500');
          pushIfMissing('x-google-min-bitrate','300');
          pushIfMissing('x-google-max-framerate','30');
          lines[i] = `a=fmtp:${pt} ${params.join(';')}`;
        }
      }
      return lines.join('\r\n');
    } catch(_){ return sdp; }
  }

  // Adapt bitrate/framerate based on live stats
  function startAdaptiveController(pc) {
    try {
      if (!pc.getSenders) return;
      const videoSenders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
      if (videoSenders.length === 0) return;
      let level = 3; // 3:1200kbps@30fps, 2:900@24, 1:600@24, 0:300@15
      const apply = async () => {
        for (const s of videoSenders) {
          try {
            const p = s.getParameters();
            p.encodings = p.encodings || [{}];
            const e = p.encodings[0];
            if (level >= 3) { e.maxBitrate = 1200*1000; e.maxFramerate = 30; }
            else if (level === 2) { e.maxBitrate = 900*1000; e.maxFramerate = 24; }
            else if (level === 1) { e.maxBitrate = 600*1000; e.maxFramerate = 24; }
            else { e.maxBitrate = 300*1000; e.maxFramerate = 15; }
            await s.setParameters(p);
          } catch(_){}
        }
      };
      apply();

      let improvingTicks = 0, degradingTicks = 0;
      const t = setInterval(async () => {
        if (pc.connectionState !== 'connected') return;
        try {
          const stats = await pc.getStats();
          const pair = [...stats.values()].find(s => s.type==='candidate-pair' && s.nominated);
          const rtt = pair?.currentRoundTripTime || 0;
          const inVideo = [...stats.values()].find(s => s.type==='inbound-rtp' && s.kind==='video');
          const lossRatio = inVideo && inVideo.packetsReceived ? (inVideo.packetsLost||0) / inVideo.packetsReceived : 0;
          const fps = inVideo?.framesPerSecond || 0;

          // Degrade if RTT>300ms or loss>3% or FPS<15
          if (rtt > 0.3 || lossRatio > 0.03 || fps < 15) { degradingTicks++; improvingTicks = 0; }
          else { improvingTicks++; degradingTicks = 0; }

          if (degradingTicks >= 2 && level > 0) { level--; degradingTicks = 0; apply(); }
          if (improvingTicks >= 10 && level < 3) { level++; improvingTicks = 0; apply(); }
        } catch(_){}
      }, 1000);

      // Stop when closed
      const stop = () => clearInterval(t);
      const origClose = pc.close.bind(pc);
      pc.close = () => { try { stop(); } catch(_){} origClose(); };
    } catch(_){}
  }
  });

  // ICE configuration: default STUN + dynamic TURN from /ice
  const defaultStun = [
    { urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302'
    ]}
  ];
  let dynamicIce = [];
  async function loadIce() {
    try {
      const resp = await fetch('/ice');
      if (!resp.ok) throw new Error('ice fetch ' + resp.status);
      const data = await resp.json();
      if (Array.isArray(data.iceServers)) {
        dynamicIce = data.iceServers;
        console.log('[ice] Loaded', dynamicIce);
      }
    } catch (e) {
      console.warn('[ice] Using default STUN only', e && (e.name + ': ' + e.message));
    }
  }
  function getRtcConfig() {
    return {
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 2,
      iceServers: [...defaultStun, ...dynamicIce]
    };
  }

  // Initialize media (re-acquire if existing tracks are ended)
  async function ensureLocalStream() {
    try {
      // Require secure context on mobile for camera/mic
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      if (!window.isSecureContext && isMobile) {
        throw new Error('SECURE_CONTEXT_REQUIRED');
      }
      if (localStream) {
        const allEnded = localStream.getTracks().every(t => t.readyState === 'ended');
        if (!allEnded) return localStream;
        console.warn('[media] Existing localStream tracks ended; re-acquiring media');
      }
      console.log('[media] Requesting user media (video+audio)');
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16
        }
      });
      // Ensure audio tracks are enabled
      try {
        localStream.getAudioTracks().forEach(t => t.enabled = true);
      } catch(_){}
      console.log('[media] Got user media');
      return localStream;
    } catch (err) {
      if (err && err.message === 'SECURE_CONTEXT_REQUIRED') {
        console.error('[media] getUserMedia blocked: insecure context on mobile');
        alert('Camera/mic require HTTPS on mobile. Use the Render URL or an HTTPS tunnel (e.g., ngrok) instead of http://LAN-IP:3000');
      } else {
        console.error('[media] Failed to get user media:', err && (err.name + ': ' + err.message));
        alert('Could not access camera/microphone (' + (err && err.name ? err.name : 'Error') + '). Please allow permissions and try again.');
      }
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
    title.textContent = `Call with ${peerUser.name}${peerUser.role ? ' (' + peerUser.role + ')' : ''}`;

    const controls = document.createElement('div');
    controls.className = 'call-controls';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'btn';
    muteBtn.textContent = 'Mute';
    muteBtn.dataset.state = 'unmuted';
    muteBtn.addEventListener('click', () => toggleMute(muteBtn));

    const speakerBtn = document.createElement('button');
    speakerBtn.className = 'btn';
    speakerBtn.textContent = 'Speaker On';
    speakerBtn.addEventListener('click', () => toggleSpeaker(peerUser._id, speakerBtn));

    const endBtn = document.createElement('button');
    endBtn.className = 'end-call';
    endBtn.textContent = 'End';
    endBtn.addEventListener('click', () => endCall(peerUser._id, 'hangup'));

    controls.appendChild(speakerBtn);
    controls.appendChild(muteBtn);
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
    localLbl.textContent = `${currentUser.name} (${currentUser.role || ''}) (You)`;
    leftWrap.appendChild(localVideo);
    leftWrap.appendChild(localLbl);

    const rightWrap = document.createElement('div');
    rightWrap.className = 'video-wrapper';
    const remoteVideo = document.createElement('video');
    remoteVideo.autoplay = true; remoteVideo.playsInline = true; remoteVideo.muted = false; remoteVideo.volume = 1.0;
    remoteVideo.dataset.kind = 'remote';
    const remoteAudio = document.createElement('audio');
    remoteAudio.autoplay = true; remoteAudio.dataset.kind = 'remote-audio'; remoteAudio.volume = 1.0; remoteAudio.controls = false; remoteAudio.style.display = 'none';
    const remoteLbl = document.createElement('div');
    remoteLbl.className = 'video-label';
    remoteLbl.textContent = `${peerUser.name}${peerUser.role ? ' (' + peerUser.role + ')' : ''}`;
    rightWrap.appendChild(remoteVideo);
    remoteVideo.addEventListener('loadedmetadata', () => safePlay(remoteVideo));
    rightWrap.appendChild(remoteLbl);
    // Hidden audio element to ensure audio plays even if video element is blocked
    tile.appendChild(remoteAudio);

    panes.appendChild(leftWrap);
    panes.appendChild(rightWrap);

    // Mobile tap-to-start overlay
    const tapOverlay = document.createElement('div');
    tapOverlay.className = 'tap-to-start hidden';
    tapOverlay.textContent = 'Tap to start audio/video';
    tapOverlay.addEventListener('click', () => {
      unlockAudio();
      const a = tile.querySelector('audio[data-kind="remote-audio"]');
      const v = tile.querySelector('video[data-kind="remote"]');
      if (a) { a.muted = false; safePlay(a); }
      if (v) { safePlay(v); }
      tapOverlay.classList.add('hidden');
    });

    tile.appendChild(header);
    tile.appendChild(panes);
    tile.appendChild(tapOverlay);

    videoGridEl.appendChild(tile);

    return tile;
  }

  function safePlay(video) {
    if (!video) return;
    // Delay play to ensure element is stable in DOM
    setTimeout(() => {
      if (!video.isConnected) return; // Element removed from DOM
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('[media] video.play blocked', err && (err.name + ': ' + err.message)));
      }
    }, 100);
  }

  function toggleMute(btn) {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const currentlyUnmuted = btn.dataset.state === 'unmuted';
    audioTracks.forEach(t => t.enabled = !currentlyUnmuted);
    btn.dataset.state = currentlyUnmuted ? 'muted' : 'unmuted';
    btn.textContent = currentlyUnmuted ? 'Unmute' : 'Mute';
  }

  // Speaker/mic and audio unlocking helpers (top-level)
  function toggleSpeaker(peerUserId, btn) {
    const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
    if (!tile) return;
    const audioEl = tile.querySelector('audio[data-kind="remote-audio"]');
    if (!audioEl) return;
    const muted = audioEl.muted;
    audioEl.muted = !muted;
    btn.textContent = audioEl.muted ? 'Speaker Off' : 'Speaker On';
    if (!audioEl.muted) {
      unlockAudio();
      safePlay(audioEl);
    }
  }

  function unlockAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      console.log('[media] audio context state:', audioCtx && audioCtx.state);
    } catch (e) {
      console.warn('[media] unlockAudio failed', e && (e.name + ': ' + e.message));
    }
  }

  function attachAudioFallback(peerUserId, stream) {
    if (!audioCtx) return;
    try {
      let node = peerAudioNodes.get(peerUserId);
      if (node) {
        // No standard replace on node; recreate to ensure binding
        try { node.disconnect(); } catch(_){}
        peerAudioNodes.delete(peerUserId);
      }
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(audioCtx.destination);
      peerAudioNodes.set(peerUserId, source);
      console.log('[media] connected remote audio via WebAudio for', peerUserId);
    } catch (e) {
      console.warn('[media] attachAudioFallback error', e && (e.name + ': ' + e.message));
    }
  }

  function deleteCallTile(peerUserId) {
    const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
    if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
  }

  // WebRTC helpers
  function createPeerConnection(peerUserId) {
    const pc = new RTCPeerConnection(getRtcConfig());

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('ice-candidate', { toUserId: peerUserId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const fromStream = e.streams && e.streams[0];
      const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
      if (!tile) return;
      const video = tile.querySelector('video[data-kind="remote"]');
      let audioEl = tile.querySelector('audio[data-kind="remote-audio"]');
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.dataset.kind = 'remote-audio';
        audioEl.controls = false;
        audioEl.volume = 1.0;
        audioEl.muted = false;
        audioEl.style.display = 'none';
        tile.appendChild(audioEl);
      }

      if (fromStream) {
        // Use the provided stream (includes both audio+video tracks)
        if (video && video.srcObject !== fromStream) {
          console.log('[webrtc] ontrack stream tracks', fromStream.getTracks().map(t => t.kind));
          video.srcObject = fromStream;
          if (audioEl) {
            audioEl.srcObject = fromStream;
            audioEl.muted = false; // Ensure not muted
          }
          if (video.readyState >= 1) safePlay(video);
          if (audioEl) safePlay(audioEl);
        }
        attachAudioFallback(peerUserId, fromStream);
      } else {
        // Fallback: accumulate tracks into a single MediaStream
        let stream = remoteStreams.get(peerUserId);
        if (!stream) {
          stream = new MediaStream();
          remoteStreams.set(peerUserId, stream);
        }
        stream.addTrack(e.track);
        if (video && video.srcObject !== stream) {
          console.log('[webrtc] ontrack (fallback) track', e.track.kind);
          video.srcObject = stream;
          if (audioEl) {
            audioEl.srcObject = stream;
            audioEl.muted = false; // Ensure not muted
          }
          if (video.readyState >= 1) safePlay(video);
          if (audioEl) safePlay(audioEl);
        }
        attachAudioFallback(peerUserId, stream);
      }

      // Rebind retry after a short delay in case the element was attached late
      setTimeout(() => {
        const t = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
        if (!t) return;
        const a = t.querySelector('audio[data-kind="remote-audio"]');
        if (a && !a.srcObject) {
          const src = fromStream || remoteStreams.get(peerUserId);
          if (src) { a.srcObject = src; a.muted = false; safePlay(a); }
        }
      }, 200);
    };

    pc.onconnectionstatechange = () => {
      console.log('[webrtc] connectionState', peerUserId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endCall(peerUserId, 'connectionstate:' + pc.connectionState);
      }
      if (pc.connectionState === 'connected') {
        // Force audio resume/play on successful connection
        unlockAudio();
        const tile = document.querySelector(`.call-tile[data-user-id="${peerUserId}"]`);
        if (tile) {
          const audioEl = tile.querySelector('audio[data-kind="remote-audio"]');
          if (audioEl) safePlay(audioEl);
          const videoEl = tile.querySelector('video[data-kind="remote"]');
          if (videoEl) safePlay(videoEl);
          // On mobile, show tap overlay to guarantee a user gesture
          const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
          const overlay = tile.querySelector('.tap-to-start');
          if (isMobile && overlay) overlay.classList.remove('hidden');
          // Start lightweight stats logger to diagnose latency/jitter
          startStatsLogger(pc, peerUserId);
          // Start adaptive controller
          startAdaptiveController(pc);
        }
      }
    };

    // If we drop to disconnected/failed for >2s, try ICE restart
    let disconnectTimer = null;
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'disconnected' || st === 'failed') {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(async () => {
            try {
              console.warn('[webrtc] ICE restart due to', st);
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              // Re-signal depending on who initiated
              const peerId = peerUserId;
              if (peers.get(peerId)) {
                socket.emit('call-user', { toUserId: peerId, offer });
              }
            } catch (e) {
              console.warn('[webrtc] ICE restart error', e && (e.name + ': ' + e.message));
            }
            disconnectTimer = null;
          }, 2000);
        }
      } else if (st === 'connected' || st === 'completed') {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
      }
    };

    function startStatsLogger(pc, peerId) {
      try {
        if (!pc.getStats) return;
        let ticks = 0;
        const interval = setInterval(async () => {
          if (pc.connectionState !== 'connected' || ticks++ > 60) { clearInterval(interval); return; }
          try {
            const stats = await pc.getStats();
            let outAudio, outVideo, inAudio, inVideo;
            stats.forEach(r => {
              if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
              if (r.type === 'outbound-rtp' && r.kind === 'video') outVideo = r;
              if (r.type === 'inbound-rtp' && r.kind === 'audio') inAudio = r;
              if (r.type === 'inbound-rtp' && r.kind === 'video') inVideo = r;
            });
            if (ticks % 10 === 0) {
              console.log('[stats]', peerId, {
                rtt: [...stats.values()].find(s=>s.type==='candidate-pair'&&s.nominated)?.currentRoundTripTime,
                outA_bps: outAudio && outAudio.bitrateMean,
                outV_bps: outVideo && outVideo.bitrateMean,
                inA_jitter: inAudio && inAudio.jitter,
                inV_frames: inVideo && inVideo.framesPerSecond
              });
            }
          } catch(_){}
        }, 1000);
      } catch(_){}
    }

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
      if (video && video.srcObject !== stream) {
        video.srcObject = stream;
        safePlay(video); // preview
      }
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
      tracks.forEach(track => {
        // Content hints help the encoder pick settings
        try {
          if (track.kind === 'video' && 'contentHint' in track) track.contentHint = 'motion';
          if (track.kind === 'audio' && 'contentHint' in track) track.contentHint = 'speech';
        } catch(_){}
        const sender = pc.addTrack(track, stream);
        // Tune sender encodings for low latency
        try {
          const params = sender.getParameters();
          params.degradationPreference = 'balanced';
          params.encodings = params.encodings || [{}];
          const enc = params.encodings[0];
          if (track.kind === 'video') {
            // ~1.2Mbps cap, 30fps
            if (enc.maxBitrate == null) enc.maxBitrate = 1200 * 1000;
            if (enc.maxFramerate == null) enc.maxFramerate = 30;
            // Prefer temporal scalability if available
            if (enc.scalabilityMode == null) enc.scalabilityMode = 'L1T2';
          } else if (track.kind === 'audio') {
            // Opus DTX lowers jitter/latency in silence
            if (enc.dtx == null) enc.dtx = true;
          }
          sender.setParameters(params).catch(()=>{});
        } catch (e) {
          console.warn('[webrtc] setParameters not supported', e && (e.name + ': ' + e.message));
        }
      });

      // Prefer codecs when supported (Opus/VP8 widely compatible; H264-first on iOS Safari)
      try {
        if (pc.getTransceivers) {
          pc.getTransceivers().forEach(tr => {
            if (!tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
            const caps = RTCRtpReceiver.getCapabilities(tr.receiver.track.kind);
            if (!caps) return;
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
            let preferred = caps.codecs;
            if (tr.receiver.track.kind === 'audio') {
              preferred = caps.codecs.filter(c => /opus/i.test(c.mimeType)).concat(caps.codecs.filter(c => !/opus/i.test(c.mimeType)));
            } else {
              if (isIOS) {
                preferred = caps.codecs.filter(c => /H264/i.test(c.mimeType)).concat(caps.codecs.filter(c => !/H264/i.test(c.mimeType)));
              } else {
                preferred = caps.codecs.filter(c => /VP8/i.test(c.mimeType)).concat(caps.codecs.filter(c => !/VP8/i.test(c.mimeType)));
              }
            }
            if (preferred && preferred.length) tr.setCodecPreferences(preferred);
          });
        }
      } catch (e) {
        console.warn('[webrtc] codec preference not applied', e && (e.name + ': ' + e.message));
      }
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
      unlockAudio();
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
      unlockAudio();
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
      // SDP munging for low-latency Opus/Video
      offer.sdp = tuneSDP(offer.sdp);
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
      let answer = await pc.createAnswer();
      // SDP munging for low-latency Opus/Video
      answer.sdp = tuneSDP(answer.sdp);
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
    // Ensure ICE (TURN) is loaded as soon as we connect
    loadIce();
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
  loadIce();
  fetchUsersAndRender();
})();
