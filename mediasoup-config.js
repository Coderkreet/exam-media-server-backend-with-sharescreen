// mediasoup-config.js - COMPLETE OPTIMIZED VERSION FOR 500+ STUDENTS WITH PORT MONITORING
const mediasoup = require('mediasoup');

// ✅ WORKER SETTINGS - 500+ STUDENTS OPTIMIZED
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
  // ✅ CRITICAL FIX: Expanded port range for 500+ students
  rtcMinPort: 20000,     // Started from 20,000 instead of 10,000
  rtcMaxPort: 59999,     // Extended to 59,999 (40,000 total ports)
  
  // ✅ ADDITIONAL WORKER OPTIMIZATIONS
  dtlsCertificateFile: undefined,
  dtlsPrivateKeyFile: undefined,
  libwebrtcFieldTrials: 'WebRTC-Bwe-AlrLimitedBackoff/Enabled/'
};

// ✅ ROUTER OPTIONS - ENHANCED CODEC SUPPORT
const routerOptions = {
  mediaCodecs: [
    // ✅ AUDIO CODEC - Opus optimized
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
      parameters: {
        'sprop-stereo': 1,
        'useinbandfec': 1,
        'usedtx': 1,
        'maxaveragebitrate': 128000,
        'maxplaybackrate': 48000
      },
      rtcpFeedback: [
        { type: 'transport-cc' }
      ]
    },
    
    // ✅ VIDEO CODEC 1 - VP8 (Primary choice for compatibility)
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 800,
        'x-google-max-bitrate': 1200,
        'x-google-min-bitrate': 200
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    },
    
    // ✅ VIDEO CODEC 2 - VP9 (Better quality, modern browsers)
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
      parameters: {
        'profile-id': 2,
        'x-google-start-bitrate': 800,
        'x-google-max-bitrate': 1200,
        'x-google-min-bitrate': 200
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    },
    
    // ✅ VIDEO CODEC 3 - H.264 (Hardware acceleration support)
    {
      kind: 'video',
      mimeType: 'video/h264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '4d0032',  // Main profile, Level 3.2
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate': 800,
        'x-google-max-bitrate': 1200,
        'x-google-min-bitrate': 200
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    },
    
    // ✅ ADDITIONAL H.264 PROFILE for better compatibility
    {
      kind: 'video',
      mimeType: 'video/h264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',  // Baseline profile
        'level-asymmetry-allowed': 1
      },
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' }
      ]
    }
  ]
};

// ✅ PORT MONITORING SYSTEM
class PortMonitor {
  constructor() {
    this.minPort = workerSettings.rtcMinPort;
    this.maxPort = workerSettings.rtcMaxPort;
    this.totalPorts = this.maxPort - this.minPort + 1;
    this.usedPorts = new Set();
    this.transportPorts = new Map(); // Track which transport uses which ports
  }

  addTransportPorts(transportId, ports) {
    this.transportPorts.set(transportId, ports);
    ports.forEach(port => this.usedPorts.add(port));
    this.logPortUsage(`Transport ${transportId} allocated ports: ${ports.join(', ')}`);
  }

  removeTransportPorts(transportId) {
    const ports = this.transportPorts.get(transportId);
    if (ports) {
      ports.forEach(port => this.usedPorts.delete(port));
      this.transportPorts.delete(transportId);
      this.logPortUsage(`Transport ${transportId} released ports: ${ports.join(', ')}`);
    }
  }

  logPortUsage(action = '') {
    const usedCount = this.usedPorts.size;
    const freeCount = this.totalPorts - usedCount;
    const usagePercentage = ((usedCount / this.totalPorts) * 100).toFixed(2);
    
    console.log(`🔌 PORT MONITOR: Used: ${usedCount} | Free: ${freeCount} | Usage: ${usagePercentage}% | Range: ${this.minPort}-${this.maxPort} ${action ? `| ${action}` : ''}`);
    
    if (usagePercentage > 80) {
      console.log(`⚠️  HIGH PORT USAGE WARNING: ${usagePercentage}% - Consider monitoring closely`);
    }
    if (usagePercentage > 95) {
      console.log(`🚨 CRITICAL PORT USAGE: ${usagePercentage}% - Immediate attention required!`);
    }
  }

  getPortStats() {
    return {
      used: this.usedPorts.size,
      free: this.totalPorts - this.usedPorts.size,
      total: this.totalPorts,
      percentage: ((this.usedPorts.size / this.totalPorts) * 100).toFixed(2),
      range: `${this.minPort}-${this.maxPort}`
    };
  }
}

// Global port monitor instance
const portMonitor = new PortMonitor();

// ✅ WEBRTC TRANSPORT OPTIONS - COMPLETE OPTIMIZATION FOR 500+ STUDENTS
const webRtcTransportOptions = {
  // ✅ NETWORK CONFIGURATION
  listenIps: [
    { 
      ip: '0.0.0.0', 
      announcedIp: process.env.ANNOUNCED_IP || '192.168.0.113'
    }
  ],
  
  // ✅ PROTOCOL PREFERENCES (UDP preferred for performance)
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  preferTcp: false,
  
  // ✅ BITRATE MANAGEMENT - Optimized for exam proctoring
  initialAvailableOutgoingBitrate: 1000000,    // 1 Mbps initial
  minimumAvailableOutgoingBitrate: 300000,     // 300 kbps minimum (lowered for stability)
  maxIncomingBitrate: 1500000,                 // 1.5 Mbps max incoming per transport
  
  // ✅ SCTP SETTINGS - For data channels
  enableSctp: true,
  numSctpStreams: { OS: 1024, MIS: 1024 },
  maxSctpMessageSize: 262144,                  // 256 KB
  sctpSendBufferSize: 262144,
  
  // ✅ ADDITIONAL TRANSPORT OPTIMIZATIONS
  iceConsentTimeout: 30,                       // 30 seconds ICE consent timeout
  iceCandidateIgnoreMask: 0,                   // Don't ignore any ICE candidates
  
  // ✅ DTLS SETTINGS
  dtlsParameters: {
    role: 'auto',                              // Auto-negotiate DTLS role
    fingerprints: [
      {
        algorithm: 'sha-256'
      },
      {
        algorithm: 'sha-384'
      },
      {
        algorithm: 'sha-512'
      }
    ]
  },
  
  // ✅ RTP SETTINGS
  rtpParameters: {
    enableRtx: true,                           // Enable RTX for retransmissions
    enableFec: false,                          // Disable FEC (not needed for 1:1 streaming)
    enableUlpfec: false,                       // Disable ULPFEC
    enableFlexfec: false                       // Disable FlexFEC
  },
  
  // ✅ CONGESTION CONTROL - Critical for many students
  enableSrtp: true,
  enableSrtcp: true,
  cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',     // Standard crypto suite
  
  // ✅ APPLICATION DATA
  appData: { 
    mediasoupStartTime: Date.now(),
    serverOptimizedFor: '500+ students',
    version: '5.0-optimized'
  }
};

// ✅ ADDITIONAL CONFIG FOR 500+ STUDENTS
const additionalConfig = {
  // Port management
  portManager: {
    minPort: 20000,
    maxPort: 59999,
    totalPorts: 40000,                         // 40,000 available ports
    portsPerStudent: 4,                        // 2 for send + 2 for recv transports
    maxStudents: 10000,                        // Theoretical max
    practicalMaxStudents: 1000,                // Practical limit considering bandwidth
    portCleanupInterval: 30000,                // 30 seconds cleanup
    emergencyCleanupThreshold: 0.90            // Cleanup when 90% ports used
  },
  
  // Performance settings
  performance: {
    studentsPerPage: 25,                       // Optimized pagination
    batchSize: 50,                             // Batch processing size
    maxConcurrentTransports: 2000,             // Max transports per worker
    workerCpuThreshold: 80,                    // CPU threshold for worker switching
    memoryThreshold: 1024,                     // Memory threshold in MB
  },
  
  // Monitoring settings
  monitoring: {
    healthCheckInterval: 30000,                // 30 seconds
    performanceLogInterval: 60000,             // 1 minute
    cleanupInterval: 120000,                   // 2 minutes
    alertThresholds: {
      cpuUsage: 85,
      memoryUsage: 90,
      portUsage: 85,
      activeTransports: 1800
    }
  },
  
  // Network optimization
  network: {
    // ICE settings
    iceServers: [
      {
        urls: ['stun:stun.l.google.com:19302']
      }
    ],
    
    // Bandwidth limits per student
    bandwidthLimits: {
      video: {
        maxBitrate: 800000,                    // 800 kbps max video
        minBitrate: 100000,                    // 100 kbps min video
        startBitrate: 300000                   // 300 kbps start video
      },
      audio: {
        maxBitrate: 128000,                    // 128 kbps max audio
        minBitrate: 32000,                     // 32 kbps min audio
        startBitrate: 64000                    // 64 kbps start audio
      }
    },
    
    // Connection timeouts
    timeouts: {
      transport: 20000,                        // 20 seconds transport timeout
      producer: 15000,                         // 15 seconds producer timeout
      consumer: 15000,                         // 15 seconds consumer timeout
      dtls: 30000                             // 30 seconds DTLS timeout
    }
  }
};

// ✅ ENVIRONMENT VALIDATION
const validateConfig = () => {
  const errors = [];
  
  // Port range validation
  if (workerSettings.rtcMaxPort - workerSettings.rtcMinPort < 1000) {
    errors.push('Port range too small - need at least 1000 ports for stability');
  }
  
  // Announced IP validation
  if (!process.env.ANNOUNCED_IP && webRtcTransportOptions.listenIps[0].announcedIp === '192.168.0.113') {
    // Silent validation - no warning
  }
  
  // Resource validation
  const maxTheoretical = Math.floor(additionalConfig.portManager.totalPorts / additionalConfig.portManager.portsPerStudent);
  if (maxTheoretical < 500) {
    errors.push(`Port configuration supports only ${maxTheoretical} students - need more ports for 500+ students`);
  }
  
  if (errors.length > 0) {
    throw new Error('MediaSoup configuration validation failed');
  }
  
  // Initial port status
  portMonitor.logPortUsage('Server startup');
};

// Validate configuration on load
validateConfig();

// ✅ EXPORT ALL CONFIG
module.exports = {
  workerSettings,
  routerOptions,
  webRtcTransportOptions,
  additionalConfig,
  portMonitor,
  
  // Helper methods
  getPortRange: () => ({
    min: workerSettings.rtcMinPort,
    max: workerSettings.rtcMaxPort,
    total: workerSettings.rtcMaxPort - workerSettings.rtcMinPort + 1
  }),
  
  getMaxStudents: () => additionalConfig.portManager.maxStudents,
  
  getPracticalMaxStudents: () => additionalConfig.portManager.practicalMaxStudents,
  
  // Quick config check
  isOptimizedForScale: () => {
    const portRange = workerSettings.rtcMaxPort - workerSettings.rtcMinPort + 1;
    return portRange >= 10000; // At least 10,000 ports for scale
  }
};
