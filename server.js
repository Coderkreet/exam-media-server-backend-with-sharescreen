require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./mediasoup-config');

const app = express();
const server = http.createServer(app);

// ✅ FIXED CORS setup - Multiple origins
const corsOptions = {
  origin: [
    'http://localhost:3000',  // Student frontend
    'http://localhost:3001',  // Proctor frontend  
    'http://localhost:3002',  // Additional frontend
    'http://localhost:3003',  // More students
    'http://localhost:3004',  // More students
    process.env.CORS_ORIGIN || 'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// ✅ FIXED OPTIONS handler - No wildcard pattern
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url} from ${req.headers.origin || 'unknown'}`);
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    res.header('Access-Control-Allow-Credentials', true);
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json({ limit: '50mb' }));

// ✅ Socket.io setup
const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001', 
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:3004'
    ],
    methods: ['GET', 'POST'],
    credentials: true,
    allowEIO3: true
  },
  allowEIO3: true
});

// ✅ MediaSoup Implementation
let mediasoupWorker;
let mediasoupRouter;

// Storage for real SFU resources
const rooms = new Map();
const peers = new Map();

class Room {
  constructor(roomId) {
    this.id = roomId;
    this.peers = new Map();
    this.producers = new Map();
    console.log(`📋 Room ${roomId} created`);
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
  }

  removePeer(peerId) {
    this.peers.delete(peerId);
    if (this.peers.size === 0) {
      rooms.delete(this.id);
      console.log(`📋 Room ${this.id} deleted (empty)`);
    }
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  addProducer(producer, peerId) {
    this.producers.set(producer.id, { producer, peerId });
    console.log(`📺 Producer ${producer.id} added to room ${this.id}`);
  }

  removeProducer(producerId) {
    this.producers.delete(producerId);
    console.log(`📺 Producer ${producerId} removed from room ${this.id}`);
  }
}

class Peer {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.transport = null;
    this.producers = new Map();
    this.consumers = new Map();
    this.roomId = null;
    // ✅ NEW: Track different stream types
    this.streamTypes = new Set(); // Track camera, screen, audio
  }

  setRoom(roomId) {
    this.roomId = roomId;
  }

  addProducer(producer, streamType = 'camera') {
    this.producers.set(producer.id, { producer, streamType });
    this.streamTypes.add(streamType);
  }

  removeProducer(producerId) {
    const producerData = this.producers.get(producerId);
    if (producerData) {
      this.streamTypes.delete(producerData.streamType);
    }
    this.producers.delete(producerId);
  }

  addConsumer(consumer) {
    this.consumers.set(consumer.id, consumer);
  }

  removeConsumer(consumerId) {
    this.consumers.delete(consumerId);
  }

  close() {
    console.log(`👤 Closing peer ${this.id}`);
    
    // Close transport
    if (this.transport) {
      this.transport.close();
    }

    // Close all producers
    for (const { producer } of this.producers.values()) {
      producer.close();
    }

    // Close all consumers
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }

    this.producers.clear();
    this.consumers.clear();
    this.streamTypes.clear();
  }
}

// ✅ Initialize MediaSoup
const initializeMediasoup = async () => {
  console.log('🚀 === INITIALIZING MEDIASOUP SFU ===');
  
  // Create worker
  mediasoupWorker = await mediasoup.createWorker(config.workerSettings);
  
  mediasoupWorker.on('died', () => {
    console.error('❌ MediaSoup worker died, exiting...');
    process.exit(1);
  });

  // Create router
  mediasoupRouter = await mediasoupWorker.createRouter({
    mediaCodecs: config.routerOptions.mediaCodecs
  });

  console.log('✅ MediaSoup SFU initialized successfully');
  console.log(`📊 Worker PID: ${mediasoupWorker.pid}`);
  console.log(`📊 Router ID: ${mediasoupRouter.id}`);
};

// ✅ Create WebRTC Transport
const createWebRtcTransport = async () => {
  const transport = await mediasoupRouter.createWebRtcTransport(config.webRtcTransportOptions);
  
  transport.on('dtlsstatechange', dtlsState => {
    if (dtlsState === 'closed') {
      console.log('🔒 Transport DTLS state closed');
      transport.close();
    }
  });

  transport.on('close', () => {
    console.log('🔒 Transport closed');
  });

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    transport: transport
  };
};

// Routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activePeers: peers.size,
    server: 'MediaSoup SFU Server v1.1 - Screen Sharing Enabled',
    worker: mediasoupWorker ? {
      pid: mediasoupWorker.pid,
      died: mediasoupWorker.died
    } : null,
    cors: 'Multiple origins enabled'
  });
});

// ✅ Get Router RTP Capabilities
app.get('/api/rtp-capabilities', (req, res) => {
  try {
    console.log(`📊 RTP Capabilities requested from ${req.headers.origin}`);
    res.json({
      success: true,
      rtpCapabilities: mediasoupRouter.rtpCapabilities
    });
  } catch (error) {
    console.error('❌ Error getting RTP capabilities:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ Create WebRTC Transport
app.post('/api/create-transport', async (req, res) => {
  try {
    const { peerId, direction } = req.body;
    
    console.log(`🚛 Creating ${direction} transport for peer ${peerId}`);
    
    const transportData = await createWebRtcTransport();
    
    // Store transport reference
    if (peers.has(peerId)) {
      const peer = peers.get(peerId);
      peer.transport = transportData.transport;
    }

    res.json({
      success: true,
      transport: {
        id: transportData.id,
        iceParameters: transportData.iceParameters,
        iceCandidates: transportData.iceCandidates,
        dtlsParameters: transportData.dtlsParameters
      }
    });
  } catch (error) {
    console.error('❌ Error creating transport:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ Connect Transport
app.post('/api/connect-transport', async (req, res) => {
  try {
    const { peerId, dtlsParameters } = req.body;
    
    console.log(`🔌 Connecting transport for peer ${peerId}`);
    
    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    if (!peer.transport) {
      throw new Error('Transport not found for peer');
    }

    await peer.transport.connect({ dtlsParameters });

    res.json({
      success: true,
      message: 'Transport connected successfully'
    });
  } catch (error) {
    console.error('❌ Error connecting transport:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ UPDATED: Create Producer with stream type support
app.post('/api/produce', async (req, res) => {
  try {
    const { peerId, kind, rtpParameters, examId, streamType = 'camera' } = req.body;
    
    console.log(`📺 Creating ${streamType} producer for peer ${peerId}, kind: ${kind}`);
    
    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    if (!peer.transport) {
      throw new Error('Transport not found for peer');
    }

    const producer = await peer.transport.produce({
      kind,
      rtpParameters,
    });

    // ✅ NEW: Add producer with stream type
    peer.addProducer(producer, streamType);
    
    const roomId = peer.roomId;
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.addProducer(producer, peerId);

      // ✅ UPDATED: Notify all other peers about new producer with stream type
      const otherPeers = room.getPeers().filter(p => p.id !== peerId);
      otherPeers.forEach(otherPeer => {
        otherPeer.socket.emit('newProducer', {
          producerId: producer.id,
          peerId: peerId,
          kind: kind,
          streamType: streamType // ✅ Include stream type
        });
      });
    }

    producer.on('close', () => {
      console.log(`📺 ${streamType} producer ${producer.id} closed`);
      peer.removeProducer(producer.id);
      if (rooms.has(roomId)) {
        rooms.get(roomId).removeProducer(producer.id);
      }
    });

    res.json({
      success: true,
      producerId: producer.id,
      streamType: streamType
    });
  } catch (error) {
    console.error('❌ Error creating producer:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ Create Consumer (Proctor receives media)
app.post('/api/consume', async (req, res) => {
  try {
    const { peerId, producerId, rtpCapabilities } = req.body;
    
    console.log(`👁️ Creating consumer for peer ${peerId}, producer: ${producerId}`);
    
    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    if (!peer.transport) {
      throw new Error('Transport not found for peer');
    }

    // Find the producer in the room
    const roomId = peer.roomId;
    if (!rooms.has(roomId)) {
      throw new Error('Room not found');
    }

    const room = rooms.get(roomId);
    const producerData = room.producers.get(producerId);
    
    if (!producerData) {
      throw new Error('Producer not found in room');
    }

    const { producer } = producerData;

    // Check if router can consume
    if (!mediasoupRouter.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    })) {
      throw new Error('Cannot consume this producer');
    }

    // Create consumer
    const consumer = await peer.transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
    });

    peer.addConsumer(consumer);

    consumer.on('close', () => {
      console.log(`👁️ Consumer ${consumer.id} closed`);
      peer.removeConsumer(consumer.id);
    });

    res.json({
      success: true,
      consumer: {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      }
    });
  } catch (error) {
    console.error('❌ Error creating consumer:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ Resume Consumer
app.post('/api/resume-consumer', async (req, res) => {
  try {
    const { peerId, consumerId } = req.body;
    
    console.log(`▶️ Resuming consumer ${consumerId} for peer ${peerId}`);
    
    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const consumer = peer.consumers.get(consumerId);
    
    if (!consumer) {
      throw new Error('Consumer not found');
    }

    await consumer.resume();

    res.json({
      success: true,
      message: 'Consumer resumed successfully'
    });
  } catch (error) {
    console.error('❌ Error resuming consumer:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ UPDATED: Get exam statistics with stream types
app.get('/api/exam/:examId/stats', (req, res) => {
  const { examId } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({
      examId,
      totalStudents: 0,
      connectedAdmins: 0,
      students: [],
      producers: 0,
      consumers: 0
    });
  }

  const students = room.getPeers().map(peer => ({
    peerId: peer.id,
    hasProducers: peer.producers.size > 0,
    producerCount: peer.producers.size,
    consumerCount: peer.consumers.size,
    streamTypes: Array.from(peer.streamTypes), // ✅ Include stream types
    connectionStatus: 'connected'
  }));

  res.json({
    examId,
    roomId,
    totalStudents: room.peers.size,
    students,
    totalProducers: room.producers.size,
    totalConsumers: Array.from(room.peers.values()).reduce((sum, peer) => sum + peer.consumers.size, 0),
    lastUpdate: new Date().toISOString()
  });
});

// ✅ Enhanced debug endpoint
app.get('/api/debug/mediasoup', (req, res) => {
  const roomsData = {};
  for (const [roomId, room] of rooms) {
    roomsData[roomId] = {
      peerCount: room.peers.size,
      producerCount: room.producers.size,
      peers: Array.from(room.peers.keys())
    };
  }

  const peersData = {};
  for (const [peerId, peer] of peers) {
    peersData[peerId] = {
      roomId: peer.roomId,
      hasTransport: !!peer.transport,
      producerCount: peer.producers.size,
      consumerCount: peer.consumers.size,
      streamTypes: Array.from(peer.streamTypes)
    };
  }

  res.json({
    worker: mediasoupWorker ? {
      pid: mediasoupWorker.pid,
      died: mediasoupWorker.died
    } : null,
    router: mediasoupRouter ? {
      id: mediasoupRouter.id
    } : null,
    rooms: roomsData,
    peers: peersData,
    totalRooms: rooms.size,
    totalPeers: peers.size
  });
});

// ✅ Socket.io connections
io.on('connection', (socket) => {
  console.log(`\n🔌 === NEW SOCKET CONNECTION ===`);
  console.log(`Socket ID: ${socket.id}`);

  socket.on('joinExam', ({ examId, role, userId }) => {
    console.log(`\n👤 === JOIN EXAM REQUEST ===`);
    console.log(`Socket ID: ${socket.id}`);
    console.log(`Role: ${role}`);
    console.log(`User ID: ${userId}`);
    console.log(`Exam ID: ${examId}`);

    const roomId = `exam-${examId}`;
    const peerId = `${userId}-${socket.id}`;

    // Create peer
    const peer = new Peer(peerId, socket);
    peer.setRoom(roomId);
    peers.set(peerId, peer);

    // Create or get room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(roomId));
    }
    const room = rooms.get(roomId);
    room.addPeer(peer);

    // Join socket.io room for signaling
    socket.join(roomId);

    console.log(`✅ Peer ${peerId} joined room ${roomId} as ${role}`);

    socket.emit('joinedExam', {
      examId,
      roomId,
      peerId,
      role,
      message: 'Successfully joined exam room with SFU'
    });

    // ✅ NEW: If proctor joins, send existing producers with stream types
    if (role === 'proctor') {
      console.log(`🛡️ Proctor joined - notifying about existing producers`);
      
      // Send info about existing producers in this room
      room.producers.forEach((producerData, producerId) => {
        const producerPeer = peers.get(producerData.peerId);
        const producerInfo = producerPeer?.producers.get(producerId);
        
        console.log(`📺 Notifying proctor about existing producer: ${producerId} from ${producerData.peerId}`);
        
        socket.emit('newProducer', {
          producerId: producerId,
          peerId: producerData.peerId,
          kind: producerData.producer.kind,
          streamType: producerInfo?.streamType || 'camera' // ✅ Include stream type
        });
      });
      
      console.log(`📊 Sent ${room.producers.size} existing producers to proctor`);
    }

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`\n🔌 Peer ${peerId} disconnected`);
      
      if (peers.has(peerId)) {
        const peer = peers.get(peerId);
        peer.close();
        peers.delete(peerId);

        // Remove from room
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId);
          room.removePeer(peerId);
        }
      }

      socket.to(roomId).emit('peerLeft', { peerId, role });
    });
  });

  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// Start server
const startServer = async () => {
  try {
    await initializeMediasoup();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`\n🚀 === MEDIASOUP SFU SERVER STARTED ===`);
      console.log(`📡 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🌐 CORS enabled for multiple origins:`);
      console.log(`   ✅ http://localhost:3000 (Student)`);
      console.log(`   ✅ http://localhost:3001 (Proctor)`);
      console.log(`   ✅ http://localhost:3002+ (Additional)`);
      console.log(`✅ MediaSoup SFU ready with Screen Sharing!\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('\n🛑 === GRACEFUL SHUTDOWN INITIATED ===');
  
  for (const peer of peers.values()) {
    peer.close();
  }
  
  peers.clear();
  rooms.clear();
  
  if (mediasoupWorker) {
    mediasoupWorker.close();
  }
  
  server.close(() => {
    console.log('✅ Server shut down successfully');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('⚠️ Forcing exit after 10 seconds');
    process.exit(1);
  }, 10000);
}

// Start the server
startServer().catch(console.error);
