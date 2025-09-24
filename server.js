require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');
const config = require('./mediasoup-config');

const app = express();
const server = http.createServer(app);

// CORS setup - Allow all origins
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} from ${req.headers.origin || 'unknown'}`);
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    res.header('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json({ limit: '50mb' }));

const io = socketIo(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
    allowEIO3: true
  },
  allowEIO3: true
});

// ✅ MULTI-WORKER CONFIGURATION
const NUM_WORKERS = 4;
const mediasoupWorkers = [];
const mediasoupRouters = [];
const roomWorkerMap = new Map(); // roomId → workerIndex
const rooms = new Map();
const peers = new Map();

// ✅ MULTI-WORKER INITIALIZATION
const initializeMediasoup = async () => {
  console.log(`🚀 INITIALIZING MEDIASOUP SFU WITH ${NUM_WORKERS} WORKERS`);
  
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = await mediasoup.createWorker(config.workerSettings);
    worker.on('died', () => {
      console.error(`MediaSoup worker ${i} died, exiting...`);
      process.exit(1);
    });

    const router = await worker.createRouter({
      mediaCodecs: config.routerOptions.mediaCodecs
    });

    mediasoupWorkers.push(worker);
    mediasoupRouters.push(router);
    
    console.log(`✅ Worker ${i}: PID ${worker.pid}, Router ID: ${router.id}`);
  }
  
  console.log('✅ All MediaSoup workers initialized successfully');
  console.log('📄 Fixed Pagination: 12 students per page (actual students only)');
  console.log(`🔧 Multi-worker setup: ${NUM_WORKERS} workers ready`);
};

// ✅ WORKER ASSIGNMENT LOGIC
function assignWorkerToRoom(roomId) {
  if (!roomWorkerMap.has(roomId)) {
    const nextWorkerIndex = roomWorkerMap.size % NUM_WORKERS;
    roomWorkerMap.set(roomId, nextWorkerIndex);
    console.log(`📌 Assigned room ${roomId} to worker ${nextWorkerIndex}`);
  }
  return roomWorkerMap.get(roomId);
}

function getRouterForRoom(roomId) {
  const workerIndex = assignWorkerToRoom(roomId);
  return mediasoupRouters[workerIndex];
}

// ✅ UPDATED TRANSPORT CREATION WITH ROOM-SPECIFIC ROUTER
const createWebRtcTransport = async (roomId) => {
  const router = getRouterForRoom(roomId);
  const transport = await router.createWebRtcTransport(config.webRtcTransportOptions);

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      console.log('Transport DTLS state closed');
      transport.close();
    }
  });

  transport.on('close', () => {
    console.log('Transport closed');
  });

  return transport;
};

// ✅ FIXED Room class - Only count ACTUAL STUDENTS
class Room {
  constructor(roomId) {
    this.id = roomId;
    this.peers = new Map();
    this.producers = new Map();
    this.STUDENTS_PER_PAGE = 12;
    console.log(`Room ${roomId} created with ${this.STUDENTS_PER_PAGE} students per page`);
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    console.log(`✅ Added peer ${peer.id} (${peer.role}) to room ${this.id}. Total peers: ${this.peers.size}`);
    
    const actualStudents = this.getActualStudents();
    console.log(`📊 Actual students in room: ${actualStudents.length}`);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      console.log(`❌ Removing peer ${peerId} (${peer.role}) from room ${this.id}`);
    }
    
    this.peers.delete(peerId);
    
    const producersToDelete = [];
    for (const [producerId, data] of this.producers) {
      if (data.peerId === peerId) {
        producersToDelete.push(producerId);
      }
    }
    
    producersToDelete.forEach(producerId => {
      this.producers.delete(producerId);
      console.log(`🗑️ Removed producer ${producerId} from peer ${peerId}`);
    });
    
    const actualStudents = this.getActualStudents();
    console.log(`📊 After removal - Actual students: ${actualStudents.length}, Total peers: ${this.peers.size}`);
    
    if (this.peers.size === 0) {
      rooms.delete(this.id);
      roomWorkerMap.delete(this.id); // ✅ CLEANUP WORKER MAPPING
      console.log(`🗑️ Room ${this.id} deleted (empty)`);
    }
  }

  getActualStudents() {
    const actualStudents = Array.from(this.peers.values()).filter(peer => {
      return peer.role === 'student' && 
             peer.socket && 
             peer.socket.connected;
    });
    
    console.log(`🔍 getActualStudents: Found ${actualStudents.length} actual connected students`);
    return actualStudents;
  }

  addProducer(producer, peerId, streamType) {
    this.producers.set(producer.id, { producer, peerId, streamType });
    
    const peer = this.peers.get(peerId);
    if (peer && peer.role === 'student' && (streamType === 'camera' || streamType === 'screen')) {
      console.log(`✅ Producer ${producer.id} (${streamType}) added from STUDENT ${peerId}`);
    } else {
      console.log(`⚠️ Producer ${producer.id} (${streamType}) added from NON-STUDENT ${peerId}`);
    }
    
    console.log(`📊 Room ${this.id} - Total producers: ${this.producers.size}`);
  }

  removeProducer(producerId) {
    const producerData = this.producers.get(producerId);
    if (producerData) {
      console.log(`❌ Removing producer ${producerId} from ${producerData.peerId}`);
    }
    
    this.producers.delete(producerId);
    console.log(`📊 Producer ${producerId} removed from room ${this.id}`);
  }

  getPaginatedProducersData(page = 1) {
    const actualStudents = this.getActualStudents();
    const totalActualStudents = actualStudents.length;
    
    console.log(`📄 getPaginatedProducersData: Page ${page}, Total actual students: ${totalActualStudents}`);
    
    if (totalActualStudents === 0) {
      return {
        producers: { camera: [], screen: [] },
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalStudents: 0,
          studentsPerPage: this.STUDENTS_PER_PAGE,
          currentPageStudents: 0,
          hasNextPage: false,
          hasPreviousPage: false
        }
      };
    }

    const totalPages = Math.ceil(totalActualStudents / this.STUDENTS_PER_PAGE);
    const startIndex = (page - 1) * this.STUDENTS_PER_PAGE;
    const endIndex = startIndex + this.STUDENTS_PER_PAGE;
    
    const currentPageStudents = actualStudents.slice(startIndex, endIndex);
    const currentPageStudentIds = currentPageStudents.map(student => student.id);
    
    console.log(`📄 Page ${page}/${totalPages} - Student IDs on page: ${currentPageStudentIds.join(', ')}`);

    const paginatedProducers = { camera: [], screen: [] };
    
    for (const [producerId, data] of this.producers) {
      if (currentPageStudentIds.includes(data.peerId)) {
        const producerInfo = {
          producerId,
          peerId: data.peerId,
          kind: data.producer.kind
        };
        
        if (data.streamType === 'camera') {
          paginatedProducers.camera.push(producerInfo);
        } else if (data.streamType === 'screen') {
          paginatedProducers.screen.push(producerInfo);
        }
      }
    }

    console.log(`📄 Page ${page} result: ${paginatedProducers.camera.length} camera + ${paginatedProducers.screen.length} screen = ${paginatedProducers.camera.length + paginatedProducers.screen.length} total producers`);

    return {
      producers: paginatedProducers,
      pagination: {
        currentPage: page,
        totalPages,
        totalStudents: totalActualStudents,
        studentsPerPage: this.STUDENTS_PER_PAGE,
        currentPageStudents: currentPageStudents.length,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    };
  }

  getActiveStudentsSummary() {
    const actualStudents = this.getActualStudents();
    const studentsWithStreams = actualStudents.filter(student => {
      return Array.from(this.producers.values()).some(p => p.peerId === student.id);
    });

    const students = actualStudents.map(student => ({
      peerId: student.id,
      hasStreams: studentsWithStreams.some(s => s.id === student.id),
      producerCount: Array.from(this.producers.values()).filter(p => p.peerId === student.id).length
    }));

    const result = {
      totalStudents: actualStudents.length,
      studentsWithStreams: studentsWithStreams.length,
      students: students,
      pagination: {
        studentsPerPage: this.STUDENTS_PER_PAGE,
        totalPages: Math.ceil(actualStudents.length / this.STUDENTS_PER_PAGE)
      }
    };

    console.log(`📊 Summary: ${result.totalStudents} actual students, ${result.studentsWithStreams} with streams`);
    return result;
  }

  getPeersByRole(role) {
    const peers = Array.from(this.peers.values()).filter(peer => {
      return peer.role === role && peer.socket && peer.socket.connected;
    });
    
    console.log(`🔍 getPeersByRole(${role}): Found ${peers.length} connected ${role}s`);
    return peers;
  }

  getProctors() {
    return this.getPeersByRole('proctor');
  }

  getStudents() {
    return this.getPeersByRole('student');
  }
}

// ✅ ENHANCED Peer class with connection tracking and room-specific transport
class Peer {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers = new Map();
    this.consumers = new Map();
    this.roomId = null;
    this.streamTypes = new Set();
    this.role = null;
    this.connected = true;
    
    if (socket) {
      socket.on('disconnect', () => {
        this.connected = false;
        console.log(`🔌 Peer ${this.id} socket disconnected`);
      });
    }
  }

  setRoom(roomId) { this.roomId = roomId; }
  setRole(role) { 
    this.role = role; 
    console.log(`👤 Peer ${this.id} role set to: ${role}`);
  }

  async getOrCreateSendTransport() {
    if (!this.sendTransport || this.sendTransport.closed) {
      this.sendTransport = await createWebRtcTransport(this.roomId); // ✅ ROOM-SPECIFIC
      console.log(`Created send transport ${this.sendTransport.id} for peer ${this.id} in room ${this.roomId}`);
    }
    return this.sendTransport;
  }

  async getOrCreateRecvTransport() {
    if (!this.recvTransport || this.recvTransport.closed) {
      this.recvTransport = await createWebRtcTransport(this.roomId); // ✅ ROOM-SPECIFIC
      console.log(`Created recv transport ${this.recvTransport.id} for peer ${this.id} in room ${this.roomId}`);
    }
    return this.recvTransport;
  }

  addProducer(producer, streamType = 'camera') {
    this.producers.set(producer.id, { producer, streamType });
    this.streamTypes.add(streamType);
  }

  removeProducer(producerId) {
    const producerData = this.producers.get(producerId);
    if (producerData) {
      const remainingOfSameType = Array.from(this.producers.values())
        .filter(p => p.streamType === producerData.streamType && p.producer.id !== producerId);
      
      if (remainingOfSameType.length === 0) {
        this.streamTypes.delete(producerData.streamType);
      }
    }
    this.producers.delete(producerId);
  }

  addConsumer(consumer) { this.consumers.set(consumer.id, consumer); }
  removeConsumer(consumerId) { this.consumers.delete(consumerId); }

  close() {
    console.log(`🔒 Closing peer ${this.id}`);
    
    this.connected = false;
    
    if (this.sendTransport && !this.sendTransport.closed) this.sendTransport.close();
    if (this.recvTransport && !this.recvTransport.closed) this.recvTransport.close();

    for (const { producer } of this.producers.values()) {
      if (!producer.closed) producer.close();
    }

    for (const consumer of this.consumers.values()) {
      if (!consumer.closed) consumer.close();
    }

    this.producers.clear();
    this.consumers.clear();
    this.streamTypes.clear();
    this.sendTransport = null;
    this.recvTransport = null;
  }
}

// ✅ UPDATED API ROUTES WITH MULTI-WORKER SUPPORT
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activePeers: peers.size,
    server: 'MediaSoup SFU Server v4.0 - MULTI-WORKER WITH GHOST STUDENTS FIXED',
    workers: {
      total: NUM_WORKERS,
      pids: mediasoupWorkers.map(w => w.pid),
      roomDistribution: Object.fromEntries(roomWorkerMap)
    },
    pagination: {
      studentsPerPage: 12,
      description: 'Fixed: Only actual connected students counted'
    },
    fixes: [
      '✅ Multi-Worker Support - 4 workers for better scalability',
      '✅ Ghost Students Fixed - Only count actual connected students',
      '✅ Producer-based Pagination Fixed - Use student-based pagination',
      '✅ Race Conditions Fixed - Proper cleanup on disconnect',
      '✅ Consistent Counting Fixed - All methods use same student detection',
      '✅ Proper Role Validation - Distinguish students from proctors',
      '✅ Connection Status Tracking - Track peer connection state'
    ]
  });
});

app.get('/api/rtp-capabilities', (req, res) => {
  try {
    const roomId = req.query.roomId || 'default-room';
    console.log('RTP Capabilities requested for room:', roomId);
    
    const router = getRouterForRoom(roomId); // ✅ ROOM-SPECIFIC ROUTER
    res.json({
      success: true,
      rtpCapabilities: router.rtpCapabilities,
      workerIndex: assignWorkerToRoom(roomId)
    });
  } catch (error) {
    console.error('Error getting RTP capabilities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/setup-transports', async (req, res) => {
  try {
    const { peerId, role } = req.body;
    console.log(`Setting up transports for ${role} peer ${peerId}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const sendTransport = await peer.getOrCreateSendTransport(); // ✅ USES ROOM-SPECIFIC ROUTER
    const recvTransport = await peer.getOrCreateRecvTransport(); // ✅ USES ROOM-SPECIFIC ROUTER

    const workerIndex = assignWorkerToRoom(peer.roomId);
    console.log(`✅ Transports created for peer ${peerId} using worker ${workerIndex}`);

    res.json({
      success: true,
      workerIndex,
      transports: {
        send: {
          id: sendTransport.id,
          iceParameters: sendTransport.iceParameters,
          iceCandidates: sendTransport.iceCandidates,
          dtlsParameters: sendTransport.dtlsParameters
        },
        recv: {
          id: recvTransport.id,
          iceParameters: recvTransport.iceParameters,
          iceCandidates: recvTransport.iceCandidates,
          dtlsParameters: recvTransport.dtlsParameters
        }
      }
    });
  } catch (error) {
    console.error('Error setting up transports:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/connect-transports', async (req, res) => {
  try {
    const { peerId, sendDtlsParameters, recvDtlsParameters } = req.body;
    console.log(`Connecting transports for peer ${peerId}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);

    if (sendDtlsParameters && peer.sendTransport) {
      await peer.sendTransport.connect({ dtlsParameters: sendDtlsParameters });
      console.log(`Send transport connected for peer ${peerId}`);
    }

    if (recvDtlsParameters && peer.recvTransport) {
      await peer.recvTransport.connect({ dtlsParameters: recvDtlsParameters });
      console.log(`Recv transport connected for peer ${peerId}`);
    }

    res.json({ success: true, message: 'Transports connected successfully' });
  } catch (error) {
    console.error('Error connecting transports:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/produce', async (req, res) => {
  try {
    const { peerId, kind, rtpParameters, streamType = 'camera' } = req.body;
    
    if (kind === 'audio') {
      return res.status(400).json({ 
        success: false, 
        error: 'Audio streaming is disabled in this system' 
      });
    }
    
    console.log(`Creating ${streamType} producer for peer ${peerId}, kind: ${kind}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);

    if (!peer.sendTransport) {
      throw new Error('Send transport not found for peer');
    }

    const producer = await peer.sendTransport.produce({ kind, rtpParameters });
    peer.addProducer(producer, streamType);

    const roomId = peer.roomId;
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.addProducer(producer, peerId, streamType);

      const proctors = room.getProctors();
      console.log(`Notifying ${proctors.length} proctors about new producer`);
      
      proctors.forEach(proctor => {
        proctor.socket.emit('newProducer', {
          producerId: producer.id,
          peerId: peerId,
          kind: kind,
          streamType: streamType
        });
      });
    }

    producer.on('close', () => {
      console.log(`${streamType} producer ${producer.id} closed`);
      peer.removeProducer(producer.id);
      if (rooms.has(roomId)) {
        rooms.get(roomId).removeProducer(producer.id);
      }
    });

    res.json({ success: true, producerId: producer.id, streamType: streamType });
  } catch (error) {
    console.error('Error creating producer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ UPDATED BATCH CONSUME WITH MULTI-WORKER SUPPORT
app.post('/api/batch-consume-paginated', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities, page = 1 } = req.body;
    console.log(`📄 MULTI-WORKER Paginated batch consuming page ${page} with ${producerIds.length} producers for peer ${peerId}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);

    if (!peer.recvTransport) {
      throw new Error('Recv transport not found for peer');
    }

    const roomId = peer.roomId;
    if (!rooms.has(roomId)) {
      throw new Error('Room not found');
    }

    const room = rooms.get(roomId);
    const router = getRouterForRoom(roomId); // ✅ ROOM-SPECIFIC ROUTER
    const consumers = [];

    console.log(`🎯 Processing ${producerIds.length} producers for page ${page} using worker ${assignWorkerToRoom(roomId)}`);

    for (const producerId of producerIds) {
      const producerData = room.producers.get(producerId);
      if (!producerData) {
        console.warn(`Producer ${producerId} not found, skipping`);
        continue;
      }

      const { producer } = producerData;

      if (producer.kind === 'audio') {
        console.log(`Skipping audio producer ${producerId}`);
        continue;
      }

      if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
        console.warn(`Cannot consume producer ${producerId}, skipping`);
        continue;
      }

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
      });

      peer.addConsumer(consumer);

      consumer.on('close', () => {
        console.log(`Consumer ${consumer.id} closed`);
        peer.removeConsumer(consumer.id);
      });

      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters
      });
    }

    console.log(`📄 Created ${consumers.length} consumers for page ${page} peer ${peerId}`);

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length,
      page: page,
      workerIndex: assignWorkerToRoom(roomId),
      message: `Page ${page} loaded with ${consumers.length} streams`
    });
  } catch (error) {
    console.error('Error paginated batch consuming:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/batch-consume', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities } = req.body;
    console.log(`Batch consuming ${producerIds.length} producers for peer ${peerId}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);

    if (!peer.recvTransport) {
      throw new Error('Recv transport not found for peer');
    }

    const roomId = peer.roomId;
    if (!rooms.has(roomId)) {
      throw new Error('Room not found');
    }

    const room = rooms.get(roomId);
    const router = getRouterForRoom(roomId); // ✅ ROOM-SPECIFIC ROUTER
    const consumers = [];

    for (const producerId of producerIds) {
      const producerData = room.producers.get(producerId);
      if (!producerData) {
        console.warn(`Producer ${producerId} not found, skipping`);
        continue;
      }

      const { producer } = producerData;

      if (producer.kind === 'audio') {
        console.log(`Skipping audio producer ${producerId}`);
        continue;
      }

      if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
        console.warn(`Cannot consume producer ${producerId}, skipping`);
        continue;
      }

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
      });

      peer.addConsumer(consumer);

      consumer.on('close', () => {
        console.log(`Consumer ${consumer.id} closed`);
        peer.removeConsumer(consumer.id);
      });

      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters
      });
    }

    console.log(`Created ${consumers.length} consumers for peer ${peerId}`);

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length
    });
  } catch (error) {
    console.error('Error batch consuming:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/batch-resume-consumers', async (req, res) => {
  try {
    const { peerId, consumerIds } = req.body;
    console.log(`Batch resuming ${consumerIds.length} consumers for peer ${peerId}`);

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const resumedConsumers = [];

    for (const consumerId of consumerIds) {
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) {
        console.warn(`Consumer ${consumerId} not found, skipping`);
        continue;
      }

      await consumer.resume();
      resumedConsumers.push(consumerId);
    }

    console.log(`Resumed ${resumedConsumers.length} consumers for peer ${peerId}`);

    res.json({
      success: true,
      resumedConsumers: resumedConsumers,
      totalResumed: resumedConsumers.length
    });
  } catch (error) {
    console.error('Error batch resuming consumers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ PAGINATED PRODUCERS ENDPOINTS (No changes needed)
app.get('/api/exam/:examId/producers/page/:page', (req, res) => {
  const { examId, page } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({ success: false, error: 'Room not found' });
  }

  const pageNum = parseInt(page) || 1;
  const paginatedData = room.getPaginatedProducersData(pageNum);
  const workerIndex = assignWorkerToRoom(roomId);

  console.log(`📄 GET /api/exam/${examId}/producers/page/${pageNum} - MULTI-WORKER`);
  console.log(`✅ Actual students: ${paginatedData.pagination.totalStudents}, Page: ${pageNum}/${paginatedData.pagination.totalPages}, Worker: ${workerIndex}`);

  res.json({
    success: true,
    examId,
    page: pageNum,
    workerIndex,
    producers: paginatedData.producers,
    pagination: paginatedData.pagination,
    totals: {
      camera: paginatedData.producers.camera.length,
      screen: paginatedData.producers.screen.length,
      total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
    }
  });
});

app.get('/api/exam/:examId/producers', (req, res) => {
  const { examId } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({ success: false, error: 'Room not found' });
  }

  const paginatedData = room.getPaginatedProducersData(1);
  const workerIndex = assignWorkerToRoom(roomId);

  console.log(`📄 GET /api/exam/${examId}/producers (default page 1) - MULTI-WORKER`);

  res.json({
    success: true,
    examId,
    workerIndex,
    producers: paginatedData.producers,
    pagination: paginatedData.pagination,
    totals: {
      camera: paginatedData.producers.camera.length,
      screen: paginatedData.producers.screen.length,
      total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
    }
  });
});

app.get('/api/exam/:examId/stats', (req, res) => {
  const { examId } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({
      examId,
      totalStudents: 0,
      connectedProctors: 0,
      students: [],
      producers: 0,
      consumers: 0
    });
  }

  const actualStudents = room.getActualStudents();
  const students = actualStudents.map(peer => ({
    peerId: peer.id,
    hasProducers: peer.producers.size > 0,
    producerCount: peer.producers.size,
    consumerCount: peer.consumers.size,
    streamTypes: Array.from(peer.streamTypes).filter(type => type !== 'audio'),
    connectionStatus: peer.connected ? 'connected' : 'disconnected'
  }));

  const proctors = room.getProctors();
  const summary = room.getActiveStudentsSummary();
  const workerIndex = assignWorkerToRoom(roomId);

  console.log(`📊 MULTI-WORKER Stats for exam ${examId}: ${actualStudents.length} actual students, ${proctors.length} proctors, Worker: ${workerIndex}`);

  res.json({
    examId,
    roomId,
    workerIndex,
    totalStudents: actualStudents.length,
    connectedProctors: proctors.length,
    students,
    totalProducers: room.producers.size,
    totalConsumers: actualStudents.reduce((sum, peer) => sum + peer.consumers.size, 0),
    streamTypes: ['camera', 'screen'],
    pagination: summary.pagination,
    lastUpdate: new Date().toISOString(),
    fixed: '✅ Multi-worker + Ghost students eliminated - only actual connected students counted'
  });
});

// ✅ SOCKET CONNECTION HANDLER WITH MULTI-WORKER SUPPORT
io.on('connection', (socket) => {
  console.log('🔌 NEW SOCKET CONNECTION');
  console.log('Socket ID:', socket.id);

  socket.on('joinExam', ({ examId, role, userId }) => {
    console.log('📝 JOIN EXAM REQUEST - MULTI-WORKER VERSION');
    console.log('Socket ID:', socket.id);
    console.log('Role:', role);
    console.log('User ID:', userId);
    console.log('Exam ID:', examId);

    const roomId = `exam-${examId}`;
    const peerId = `${userId}-${socket.id}`;

    try {
      // ✅ ASSIGN WORKER TO ROOM
      const workerIndex = assignWorkerToRoom(roomId);
      console.log(`🔧 Room ${roomId} assigned to worker ${workerIndex}`);

      const peer = new Peer(peerId, socket);
      peer.setRoom(roomId);
      peer.setRole(role);
      peers.set(peerId, peer);

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Room(roomId));
      }
      const room = rooms.get(roomId);
      room.addPeer(peer);

      socket.join(roomId);

      console.log(`✅ Peer ${peerId} joined room ${roomId} as ${role} on worker ${workerIndex}`);

      socket.emit('joinedExam', {
        examId,
        roomId,
        peerId,
        role,
        workerIndex,
        message: 'Successfully joined exam room'
      });

      // Proctor logic with FIXED PAGINATION
      if (role === 'proctor') {
        console.log(`👨‍🏫 PROCTOR JOINED - MULTI-WORKER PAGINATED STUDENT DETECTION (12 actual students per page) - Worker ${workerIndex}`);

        const studentsSummary = room.getActiveStudentsSummary();
        console.log('✅ MULTI-WORKER Room Summary:');
        console.log('- Actual connected students:', studentsSummary.totalStudents);
        console.log('- Students with streams:', studentsSummary.studentsWithStreams);
        console.log('- Total producers:', room.producers.size);
        console.log('- Pages available:', studentsSummary.pagination.totalPages);
        console.log('- Assigned worker:', workerIndex);

        const paginatedData = room.getPaginatedProducersData(1);
        if (paginatedData.producers.camera.length > 0 || paginatedData.producers.screen.length > 0) {
          console.log(`✅ IMMEDIATE MULTI-WORKER: Found ${paginatedData.producers.camera.length + paginatedData.producers.screen.length} producers from ${paginatedData.pagination.currentPageStudents} actual students on page 1`);
          socket.emit('batchProducers', {
            producers: paginatedData.producers,
            pagination: paginatedData.pagination,
            workerIndex,
            totals: {
              camera: paginatedData.producers.camera.length,
              screen: paginatedData.producers.screen.length,
              total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
            }
          });
        }

        setTimeout(() => {
          console.log('🔄 DELAYED COMPREHENSIVE CHECK - MULTI-WORKER PAGINATED');
          const delayedPaginatedData = room.getPaginatedProducersData(1);
          const delayedSummary = room.getActiveStudentsSummary();
          
          console.log(`✅ After delay - Actual students: ${delayedSummary.totalStudents}, Producers: ${room.producers.size}, Pages: ${delayedPaginatedData.pagination.totalPages}, Worker: ${workerIndex}`);
          
          if (delayedPaginatedData.producers.camera.length > 0 || delayedPaginatedData.producers.screen.length > 0) {
            console.log(`✅ DELAYED MULTI-WORKER: Found ${delayedPaginatedData.producers.camera.length + delayedPaginatedData.producers.screen.length} producers from ${delayedPaginatedData.pagination.currentPageStudents} actual students on page 1`);
            socket.emit('batchProducers', {
              producers: delayedPaginatedData.producers,
              pagination: delayedPaginatedData.pagination,
              workerIndex,
              totals: {
                camera: delayedPaginatedData.producers.camera.length,
                screen: delayedPaginatedData.producers.screen.length,
                total: delayedPaginatedData.producers.camera.length + delayedPaginatedData.producers.screen.length
              }
            });
          } else {
            console.log('🔍 FORCE CHECK: Triggering API-based producer fetch...');
            socket.emit('forceProducerCheck', {
              examId,
              roomId,
              workerIndex,
              message: 'Checking for existing students via API'
            });
          }
        }, 2000);

        console.log('📢 Notifying existing students to re-announce...');
        socket.to(roomId).emit('proctorJoined', {
          proctorId: peerId,
          workerIndex,
          message: 'Proctor joined - please refresh your streams'
        });
      }

      if (role === 'student') {
        console.log(`🧑‍🎓 STUDENT JOINED (MULTI-WORKER PAGINATED SYSTEM) - Worker ${workerIndex}`);
        console.log(`Student: ${peerId}`);

        const proctors = room.getProctors();
        console.log(`📢 Notifying ${proctors.length} proctors about new actual student`);
        
        proctors.forEach(proctor => {
          proctor.socket.emit('studentJoined', {
            peerId,
            userId,
            examId,
            workerIndex,
            message: `Student ${userId} joined the exam`
          });
        });
      }

    } catch (joinError) {
      console.error('Error during joinExam:', joinError.message);
      socket.emit('joinError', {
        error: joinError.message,
        examId,
        role
      });
    }

    socket.on('disconnect', () => {
      console.log('❌ PEER DISCONNECTED - MULTI-WORKER CLEANUP');
      console.log(`Peer ID: ${peerId}, Role: ${role}`);

      try {
        if (peers.has(peerId)) {
          const peer = peers.get(peerId);
          peer.close();
          peers.delete(peerId);
          console.log(`✅ Removed peer ${peerId} from global peers map`);

          if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.removePeer(peerId);
            
            socket.to(roomId).emit('peerLeft', { peerId, role });
            console.log(`✅ Cleaned up peer ${peerId} from room ${roomId}`);
            
            const actualStudents = room.getActualStudents();
            console.log(`📊 After cleanup - Actual students: ${actualStudents.length}`);
          }
        }
      } catch (disconnectError) {
        console.error('Error during disconnect cleanup:', disconnectError.message);
      }
    });
  });

  socket.on('refreshProducers', ({ examId, peerId, page = 1 }) => {
    console.log(`🔄 MULTI-WORKER PAGINATED PRODUCER REFRESH - Page ${page}`);
    const roomId = `exam-${examId}`;

    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const paginatedData = room.getPaginatedProducersData(page);
        const summary = room.getActiveStudentsSummary();
        const workerIndex = assignWorkerToRoom(roomId);

        console.log(`✅ Manual refresh page ${page} - Found ${summary.studentsWithStreams} actual students with streams on worker ${workerIndex}`);

        socket.emit('batchProducers', {
          producers: paginatedData.producers,
          pagination: paginatedData.pagination,
          workerIndex,
          totals: {
            camera: paginatedData.producers.camera.length,
            screen: paginatedData.producers.screen.length,
            total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
          }
        });
      } else {
        socket.emit('refreshError', { error: 'Room not found', examId });
      }
    } catch (refreshError) {
      console.error('Error during refresh:', refreshError.message);
      socket.emit('refreshError', { error: refreshError.message, examId });
    }
  });

  socket.on('changePage', ({ examId, peerId, page }) => {
    console.log(`📄 MULTI-WORKER PAGE CHANGE REQUEST - Page ${page}`);
    const roomId = `exam-${examId}`;

    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const paginatedData = room.getPaginatedProducersData(page);
        const workerIndex = assignWorkerToRoom(roomId);

        console.log(`✅ Page ${page} loaded - ${paginatedData.producers.camera.length + paginatedData.producers.screen.length} streams from ${paginatedData.pagination.currentPageStudents} actual students on worker ${workerIndex}`);

        socket.emit('pageChanged', {
          producers: paginatedData.producers,
          pagination: paginatedData.pagination,
          workerIndex,
          totals: {
            camera: paginatedData.producers.camera.length,
            screen: paginatedData.producers.screen.length,
            total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
          }
        });
      } else {
        socket.emit('pageChangeError', { error: 'Room not found', examId, page });
      }
    } catch (pageError) {
      console.error('Error during page change:', pageError.message);
      socket.emit('pageChangeError', { error: pageError.message, examId, page });
    }
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

const startServer = async () => {
  try {
    await initializeMediasoup();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log('🚀 MULTI-WORKER MEDIASOUP SFU SERVER STARTED');
      console.log(`🌐 Server running on port ${PORT}`);
      console.log(`🏥 Health check: http://192.168.0.112:${PORT}/api/health`);
      console.log('🔧 CORS enabled for multiple origins');
      console.log('\n✨ MULTI-WORKER FIXES APPLIED:');
      console.log(`- ✅ ${NUM_WORKERS} Workers - Better scalability and load distribution`);
      console.log('- ✅ Ghost Students Fixed - Only count actual connected students');
      console.log('- ✅ Producer-based Pagination Fixed - Use student-based pagination');
      console.log('- ✅ Race Conditions Fixed - Proper cleanup on disconnect');
      console.log('- ✅ Consistent Counting Fixed - All methods use same student detection');
      console.log('- ✅ Proper Role Validation - Distinguish students from proctors');
      console.log('- ✅ Connection Status Tracking - Track peer connection state');
      console.log('- ✅ Room-Worker Mapping - Optimal load distribution across workers');
      console.log('- 📄 12 Actual Students Per Page Pagination');
      console.log(`📊 MediaSoup Multi-Worker SFU ready with ${NUM_WORKERS} workers!`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('🛑 GRACEFUL SHUTDOWN INITIATED');
  
  for (const peer of peers.values()) {
    peer.close();
  }
  peers.clear();
  rooms.clear();
  roomWorkerMap.clear(); // ✅ CLEANUP WORKER MAPPINGS

  // ✅ CLOSE ALL WORKERS
  for (let i = 0; i < mediasoupWorkers.length; i++) {
    if (mediasoupWorkers[i]) {
      mediasoupWorkers[i].close();
      console.log(`✅ Worker ${i} closed`);
    }
  }

  server.close(() => {
    console.log('✅ Multi-worker server shut down successfully');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('⚠️ Forcing exit after 10 seconds');
    process.exit(1);
  }, 10000);
}

startServer().catch(console.error);
