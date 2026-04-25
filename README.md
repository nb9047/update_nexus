# Nexus Chat v2.0 — Enhanced Edition

Real-time messaging platform with audio/video calling, push notifications, and responsive design.

## ✨ New Features

### 1. Responsive Design
- Full mobile-first responsive layout
- Hamburger menu for sidebar on mobile/tablet
- Touch-optimized call controls and buttons
- Adapts seamlessly from 360px phones to 4K desktops

### 2. Real-Time Audio & Video Calling (WhatsApp-style)
- **Audio Call** (📞) and **Video Call** (🎥) buttons in every DM header
- Calls are **disabled in General** (public channel)
- Full-screen incoming call overlay with caller avatar and pulsing animation
- **Green button** = Accept, **Red button** = Decline
- Audio ringtone (tit-tit-tit beeps) via Web Audio API
- Peer-to-peer via WebRTC (STUN servers for NAT traversal)

### 3. Call Logic
- **30-second timeout** — auto-cancels if unanswered
- **No time limit** on connected calls
- In-call red End button always visible
- Mute microphone and toggle camera during video calls
- Real-time call duration timer

### 4. Notifications
- In-app toast notifications for new messages
- Browser push notifications when window is hidden
- Service Worker for offline/background notification support
- Call notifications via OS notification API

## 🚀 Setup

```bash
# Install dependencies
npm install

# Start the server
npm start

# Development mode (auto-restart)
npm run dev
```

Server runs at http://localhost:3000

## 👑 Admin

Register with username `owner` to get admin privileges.
Admin can view all conversations via the Admin Panel.

## 🔧 Architecture

- **Backend**: Node.js + Express + WebSocket (ws)
- **Calling**: WebRTC (browser-native P2P)
- **Signaling**: WebSocket relay on server
- **Push**: Service Worker + Notification API
- **Storage**: File-based JSON (no database required)

## 📱 Browser Support

- Chrome/Edge 88+ ✅
- Firefox 85+ ✅  
- Safari 15+ ✅ (iOS 15+)
- Mobile browsers ✅

## 🌐 Deployment Notes

For production calling to work across different networks:
- Deploy behind HTTPS (required for getUserMedia on non-localhost)
- Optionally add TURN server credentials to `ICE_SERVERS` in index.html
  for reliable connectivity through strict NAT/firewalls
