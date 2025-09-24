// mediasoup-config.js - COMPLETE FIXED VERSION
const mediasoup = require('mediasoup');

const workerSettings = {
  logLevel: 'warn',
  logTags: [
    'info',
    'ice',
    'dtls',
    'rtp',
    'srtp',
    'rtcp'
  ],
  rtcMinPort: 10000,
  rtcMaxPort: 10100
};

const routerOptions = {
  mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000
      }
    },
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
      parameters: {
        'profile-id': 2
      }
    },
    {
      kind: 'video',
      mimeType: 'video/h264',  // ✅ FIXED: Correct case 'h264' not 'H264'
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '4d0032',
        'level-asymmetry-allowed': 1
      }
    }
  ]
};

// ✅ FIXED: Complete WebRTC transport options with proper IP handling
const webRtcTransportOptions = {
  listenIps: [
    { 
      ip: '0.0.0.0', 
      announcedIp: process.env.ANNOUNCED_IP || '192.168.9.210'  // ✅ Fixed default IP
    }
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1000000,
  minimumAvailableOutgoingBitrate: 600000,  // ✅ FIXED: Correct property name
  maxSctpMessageSize: 262144,
  maxIncomingBitrate: 1500000,
  // ✅ NEW: Additional important options for network connectivity
  enableSctp: true,
  numSctpStreams: { OS: 1024, MIS: 1024 },
  maxSctpMessageSize: 262144,
  sctpSendBufferSize: 262144,
  appData: { mediasoupStartTime: Date.now() }
};

module.exports = {
  workerSettings,
  routerOptions,
  webRtcTransportOptions
};
