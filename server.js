require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os'); // ✅ Added for CPU detection
const config = require('./mediasoup-config');
const { getAssignedStudents } = require('./learner');

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

// ✅ MULTI-WORKER ARCHITECTURE
const NUM_WORKERS = 4; // Fixed 4 workers for optimal performance
const mediasoupWorkers = [];
const mediasoupRouters = [];
const roomWorkerMap = new Map(); // Maps rooms to specific workers
let nextWorkerIndex = 0; // Round-robin worker assignment

const rooms = new Map();
const peers = new Map();

// ✅ ENHANCED Room class with STRICT PAGINATION FIXES
class Room {
constructor(examId, workerIndex = 0) {
  this.examId = examId;
  this.workerIndex = workerIndex;
  this.STUDENTS_PER_PAGE = 12; // ✅ CHANGE: 12 students per page
  this.peers = new Map();
  this.producers = new Map();
  this.consumers = new Map();
  this.router = null;
  this.lastActivity = Date.now();
}


  // ✅ NEW: Get the assigned worker and router for this room
  getAssignedWorker() {
    return mediasoupWorkers[this.workerIndex];
  }

  getAssignedRouter() {
    return mediasoupRouters[this.workerIndex];
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    const actualStudents = this.getActualStudents();
    console.log(`📊 Room ${this.id} [Worker ${this.workerIndex}]: ${actualStudents.length} students`);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    this.peers.delete(peerId);
    
    // ✅ Clean up ALL producers from this peer
    const producersToDelete = [];
    for (const [producerId, data] of this.producers) {
      if (data.peerId === peerId) {
        producersToDelete.push(producerId);
      }
    }
    
    producersToDelete.forEach(producerId => {
      this.producers.delete(producerId);
    });
    
    const actualStudents = this.getActualStudents();
    console.log(`📉 Room ${this.id} [Worker ${this.workerIndex}]: ${actualStudents.length} students remaining`);
    
    if (this.peers.size === 0) {
      rooms.delete(this.id);
      roomWorkerMap.delete(this.id); // ✅ Clean up worker mapping
      console.log(`🗑️ Room ${this.id} deleted from Worker ${this.workerIndex}`);
    }
  }

  // ✅ Get only ACTUAL STUDENTS (not proctors, clients, or disconnected peers)
  getActualStudents() {
    const actualStudents = Array.from(this.peers.values()).filter(peer => {
      return peer.role === 'student' && 
             peer.socket && 
             peer.socket.connected;
    });
    
    return actualStudents;
  }

  // ✅ FIXED: Student position tracking
  getStudentPagePosition(peerId) {
    const actualStudents = this.getActualStudents();
    const studentIndex = actualStudents.findIndex(student => student.id === peerId);
    
    if (studentIndex === -1) return null;
    
    const pageNumber = Math.floor(studentIndex / this.STUDENTS_PER_PAGE) + 1;
    const positionInPage = (studentIndex % this.STUDENTS_PER_PAGE) + 1;
    
    return {
      studentIndex: studentIndex + 1,
      pageNumber,
      positionInPage,
      belongsToPage: (pageNum) => pageNumber === pageNum
    };
  }

  // ✅ FIXED: Check if student belongs to specific page
  isStudentInPage(peerId, page) {
    const position = this.getStudentPagePosition(peerId);
    return position ? position.belongsToPage(page) : false;
  }

  addProducer(producer, peerId, streamType) {
    this.producers.set(producer.id, { producer, peerId, streamType });
    const peer = this.peers.get(peerId);
    console.log(`🎥 Producer added [Worker ${this.workerIndex}]: ${streamType} from ${peerId}`);
  }

  removeProducer(producerId) {
    const producerData = this.producers.get(producerId);
    this.producers.delete(producerId);
    if (producerData) {
      console.log(`🚫 Producer removed [Worker ${this.workerIndex}]: ${producerData.streamType} from ${producerData.peerId}`);
    }
  }

  // ✅ Get peer userName by peerId
  getPeerUserName(peerId) {
    const peer = this.peers.get(peerId);
    return peer ? peer.getUserName() : peerId;
  }

  // ✅ FIXED: STRICT Paginated data with EXACT limits
  getPaginatedProducersData(page = 1) {
    const actualStudents = this.getActualStudents();
    const totalActualStudents = actualStudents.length;
    
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
          hasPreviousPage: false,
          workerIndex: this.workerIndex // ✅ Include worker info
        }
      };
    }

    const totalPages = Math.ceil(totalActualStudents / this.STUDENTS_PER_PAGE);
    
    // ✅ STRICT: Page validation
    if (page < 1 || page > totalPages) {
      return {
        producers: { camera: [], screen: [] },
        pagination: {
          currentPage: Math.min(Math.max(page, 1), totalPages),
          totalPages,
          totalStudents: totalActualStudents,
          studentsPerPage: this.STUDENTS_PER_PAGE,
          currentPageStudents: 0,
          hasNextPage: false,
          hasPreviousPage: false,
          workerIndex: this.workerIndex
        }
      };
    }

    const startIndex = (page - 1) * this.STUDENTS_PER_PAGE;
    const endIndex = startIndex + this.STUDENTS_PER_PAGE;
    
    // ✅ STRICT: Only exact page students
    const currentPageStudents = actualStudents.slice(startIndex, endIndex);
    
    // ✅ CRITICAL: Enforce maximum limit per page
    const strictPageStudents = currentPageStudents.slice(0, this.STUDENTS_PER_PAGE);
    const currentPageStudentIds = strictPageStudents.map(student => student.id);

    const paginatedProducers = { camera: [], screen: [] };

    // ✅ STRICT: Only include producers for EXACT page students
    for (const [producerId, data] of this.producers) {
      if (currentPageStudentIds.includes(data.peerId)) {
        const peer = this.peers.get(data.peerId);
        const producerInfo = {
          producerId,
          peerId: data.peerId,
          kind: data.producer.kind,
          userName: peer ? peer.getUserName() : data.peerId
        };

        if (data.streamType === 'camera') {
          paginatedProducers.camera.push(producerInfo);
        } else if (data.streamType === 'screen') {
          paginatedProducers.screen.push(producerInfo);
        }
      }
    }

    return {
      producers: paginatedProducers,
      pagination: {
        currentPage: page,
        totalPages,
        totalStudents: totalActualStudents,
        studentsPerPage: this.STUDENTS_PER_PAGE,
        currentPageStudents: strictPageStudents.length,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
        workerIndex: this.workerIndex // ✅ Include worker info
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
      userId: student.getUserId(),
      userName: student.getUserName(),
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
      },
      workerInfo: {
        workerIndex: this.workerIndex,
        totalWorkers: NUM_WORKERS
      }
    };

    return result;
  }

  getPeersByRole(role) {
    const peers = Array.from(this.peers.values()).filter(peer => {
      return peer.role === role && peer.socket && peer.socket.connected;
    });
    
    return peers;
  }

  // ✅ NEW: Get clients
  getClients() {
    return this.getPeersByRole('client');
  }

  getProctors() {
    return this.getPeersByRole('proctor');
  }

  getStudents() {
    return this.getPeersByRole('student');
  }

  // ✅ NEW: Get viewers (proctors + clients)
  getViewers() {
    return [...this.getProctors(), ...this.getClients()];
  }
}

// ✅ UPDATED Peer class with WORKER SUPPORT + Page Tracking
class Peer {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.sendTransport = null;
    this.recvTransport = null;
    this.producers = new Map();
    this.consumers = new Map();
    this.roomId = null;
    this.workerIndex = null; // ✅ NEW: Track which worker this peer uses
    this.streamTypes = new Set();
    this.role = null;
    this.userId = null;
    this.userName = null;
    this.clientId = null;
    this.connected = true;
    this.currentPage = 1; // ✅ NEW: Track viewer's current page
    
    if (socket) {
      socket.on('disconnect', () => {
        this.connected = false;
      });
    }
  }

  setRoom(roomId) { this.roomId = roomId; }
  setRole(role) { this.role = role; }
  setUserId(userId) { this.userId = userId; }
  getUserId() { return this.userId; }
  setUserName(userName) { this.userName = userName; }
  getUserName() { return this.userName; }
  
  // ✅ NEW: Worker assignment
  setWorkerIndex(workerIndex) { this.workerIndex = workerIndex; }
  getWorkerIndex() { return this.workerIndex; }
  
  // ✅ NEW: Client ID methods
  setClientId(clientId) { this.clientId = clientId; }
  getClientId() { return this.clientId; }

  // ✅ NEW: Page tracking methods
  setCurrentPage(page) { this.currentPage = page; }
  getCurrentPage() { return this.currentPage; }

  // ✅ NEW: Check if peer is a viewer (proctor or client)
  isViewer() {
    return this.role === 'proctor' || this.role === 'client';
  }

  async getOrCreateSendTransport() {
    if (!this.sendTransport || this.sendTransport.closed) {
      this.sendTransport = await createWebRtcTransport(this.workerIndex);
    }
    return this.sendTransport;
  }

  async getOrCreateRecvTransport() {
    if (!this.recvTransport || this.recvTransport.closed) {
      this.recvTransport = await createWebRtcTransport(this.workerIndex);
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
    this.connected = false;
    
    if (this.sendTransport && !this.sendTransport.closed) {
      config.portMonitor.removeTransportPorts(this.sendTransport.id);
      this.sendTransport.close();
    }
    if (this.recvTransport && !this.recvTransport.closed) {
      config.portMonitor.removeTransportPorts(this.recvTransport.id);
      this.recvTransport.close();
    }

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

// ✅ MULTI-WORKER INITIALIZATION
const initializeMediasoup = async () => {
  console.log(`🚀 Initializing ${NUM_WORKERS} MediaSoup workers...`);
  
  for (let i = 0; i < NUM_WORKERS; i++) {
    try {
      const worker = await mediasoup.createWorker({
        ...config.workerSettings,
        // ✅ Distribute port ranges across workers to avoid conflicts
        rtcMinPort: config.workerSettings.rtcMinPort + (i * 1000),
        rtcMaxPort: config.workerSettings.rtcMinPort + (i * 1000) + 999
      });
      
      worker.on('died', () => {
        console.error(`💀 MediaSoup worker ${i} died`);
        process.exit(1);
      });

      const router = await worker.createRouter({
        mediaCodecs: config.routerOptions.mediaCodecs
      });

      mediasoupWorkers.push(worker);
      mediasoupRouters.push(router);
      
      console.log(`✅ Worker ${i} initialized with ports ${config.workerSettings.rtcMinPort + (i * 1000)}-${config.workerSettings.rtcMinPort + (i * 1000) + 999}`);
    } catch (error) {
      console.error(`❌ Failed to initialize worker ${i}:`, error);
      process.exit(1);
    }
  }
  
  console.log(`🎯 All ${NUM_WORKERS} workers initialized successfully!`);
};

// ✅ INTELLIGENT WORKER ASSIGNMENT
function assignWorkerToRoom(roomId) {
  if (roomWorkerMap.has(roomId)) {
    return roomWorkerMap.get(roomId);
  }

  // ✅ Load balancing: Choose least loaded worker
  let leastLoadedWorkerIndex = 0;
  let minLoad = Infinity;

  for (let i = 0; i < NUM_WORKERS; i++) {
    const workerLoad = Array.from(rooms.values())
      .filter(room => room.workerIndex === i)
      .reduce((total, room) => total + room.getActualStudents().length, 0);
    
    if (workerLoad < minLoad) {
      minLoad = workerLoad;
      leastLoadedWorkerIndex = i;
    }
  }

  roomWorkerMap.set(roomId, leastLoadedWorkerIndex);
  console.log(`🎯 Room ${roomId} assigned to Worker ${leastLoadedWorkerIndex} (load: ${minLoad} students)`);
  
  return leastLoadedWorkerIndex;
}

// ✅ WORKER-SPECIFIC TRANSPORT CREATION
const createWebRtcTransport = async (workerIndex = 0) => {
  const router = mediasoupRouters[workerIndex];
  const transport = await router.createWebRtcTransport(config.webRtcTransportOptions);

  const transportId = transport.id;
  const estimatedPorts = [];
  
  // ✅ Worker-specific port allocation
  const workerPortBase = config.workerSettings.rtcMinPort + (workerIndex * 1000);
  const basePort = workerPortBase + (Math.random() * 900); // Leave room for port range
  estimatedPorts.push(Math.floor(basePort), Math.floor(basePort) + 1);
  
  config.portMonitor.addTransportPorts(transportId, estimatedPorts);

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('close', () => {
    config.portMonitor.removeTransportPorts(transportId);
  });

  return transport;
};

// ✅ ENHANCED HEALTH ENDPOINT WITH WORKER STATS
app.get('/api/health', (req, res) => {
  const portStats = config.portMonitor.getPortStats();
  
  // ✅ Calculate per-worker statistics
  const workerStats = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    const workerRooms = Array.from(rooms.values()).filter(room => room.workerIndex === i);
    const workerStudents = workerRooms.reduce((total, room) => total + room.getActualStudents().length, 0);
    const workerProducers = workerRooms.reduce((total, room) => total + room.producers.size, 0);
    
    workerStats.push({
      workerIndex: i,
      activeRooms: workerRooms.length,
      activeStudents: workerStudents,
      totalProducers: workerProducers,
      portRange: `${config.workerSettings.rtcMinPort + (i * 1000)}-${config.workerSettings.rtcMinPort + (i * 1000) + 999}`,
      loadPercentage: Math.round((workerStudents / 75) * 100) // 75 students = 100% load per worker
    });
  }

  const totalStudents = workerStats.reduce((sum, worker) => sum + worker.activeStudents, 0);
  const averageLoad = Math.round(totalStudents / (NUM_WORKERS * 75) * 100);

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    server: `MediaSoup SFU Server v3.0 - Multi-Worker (${NUM_WORKERS} Workers)`,
    
    // ✅ Overall statistics
    overview: {
      totalWorkers: NUM_WORKERS,
      activeRooms: rooms.size,
      totalStudents: totalStudents,
      activePeers: peers.size,
      averageLoadPercentage: averageLoad,
      recommendedMaxStudents: NUM_WORKERS * 75 // 75 per worker
    },
    
    // ✅ Per-worker breakdown
    workers: workerStats,
    
    // ✅ Room distribution
    roomDistribution: Array.from(roomWorkerMap.entries()).map(([roomId, workerIndex]) => ({
      roomId,
      workerIndex,
      students: rooms.has(roomId) ? rooms.get(roomId).getActualStudents().length : 0
    })),
    
    portStats: portStats,
    pagination: {
      studentsPerPage: 1,
      description: 'Multi-Worker architecture with intelligent load balancing'
    },
    
    // ✅ Performance recommendations
    recommendations: {
      status: averageLoad < 60 ? 'OPTIMAL' : averageLoad < 80 ? 'GOOD' : averageLoad < 95 ? 'HIGH_LOAD' : 'CRITICAL',
      message: averageLoad < 60 ? 'System running optimally' :
               averageLoad < 80 ? 'Good performance, monitor load' :
               averageLoad < 95 ? 'High load detected, consider scaling' :
               'Critical load - immediate action required'
    }
  });
});

app.get('/api/rtp-capabilities', (req, res) => {
  try {
    // ✅ Return RTP capabilities from first worker (all workers have same capabilities)
    res.json({
      success: true,
      rtpCapabilities: mediasoupRouters[0].rtpCapabilities
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ UPDATED: Setup transports with WORKER SUPPORT
app.post('/api/setup-transports', async (req, res) => {
  try {
    const { peerId, role, examId, userId, userName, clientId } = req.body;
    
    const roleDisplay = role === 'client' ? `Client ${clientId}` : role;
    
    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const workerIndex = peer.getWorkerIndex();
    
    console.log(`🔧 Setting up transports for ${roleDisplay} ${userName} (${userId}) in exam ${examId} [Worker ${workerIndex}]`);
          // Proctor ka Data User 
const user =  await getAssignedStudents(userId, examId)
console.log("user123" ,user)
    // Store additional metadata
    if (userId) peer.setUserId(userId);
    if (userName) peer.setUserName(userName);
    if (clientId && role === 'client') peer.setClientId(clientId);
    
    const sendTransport = await peer.getOrCreateSendTransport();
    const recvTransport = await peer.getOrCreateRecvTransport();

    res.json({
      success: true,
      workerIndex: workerIndex, // ✅ Include worker info in response
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
    console.error('❌ Setup transports error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ UPDATED: Connect transports with WORKER SUPPORT
app.post('/api/connect-transports', async (req, res) => {
  try {
    const { 
      peerId, 
      sendDtlsParameters, 
      recvDtlsParameters,
      examId,
      userId,
      userName,
      clientId
    } = req.body;
    
    const peer = peers.get(peerId);
    if (!peer) {
      throw new Error('Peer not found');
    }

    const roleDisplay = peer && peer.role === 'client' ? `Client ${clientId || peer.getClientId()}` : 'User';
    const workerIndex = peer.getWorkerIndex();
    
    console.log(`🔗 Connecting transports for ${roleDisplay} ${userName} (${userId}) in exam ${examId} [Worker ${workerIndex}]`);

    if (sendDtlsParameters && peer.sendTransport) {
      await peer.sendTransport.connect({ dtlsParameters: sendDtlsParameters });
    }

    if (recvDtlsParameters && peer.recvTransport) {
      await peer.recvTransport.connect({ dtlsParameters: recvDtlsParameters });
    }

    res.json({ 
      success: true, 
      message: 'Transports connected successfully',
      workerIndex: workerIndex
    });
  } catch (error) {
    console.error('❌ Connect transports error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ UPDATED: Produce with WORKER SUPPORT
app.post('/api/produce', async (req, res) => {
  try {
    const { 
      peerId, 
      kind, 
      rtpParameters, 
      streamType = 'camera',
      examId,
      userId,
      userName,
      clientId
    } = req.body;
    
    if (kind === 'audio') {
      return res.status(400).json({ 
        success: false, 
        error: 'Audio streaming is disabled in this system' 
      });
    }

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const workerIndex = peer.getWorkerIndex();

    if (!peer.sendTransport) {
      throw new Error('Send transport not found for peer');
    }

    console.log(`📹 Creating producer for ${userName} (${userId}) - ${streamType} in exam ${examId} [Worker ${workerIndex}]`);

    const producer = await peer.sendTransport.produce({ kind, rtpParameters });
    peer.addProducer(producer, streamType);

    const roomId = peer.roomId;
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.addProducer(producer, peerId, streamType);

      // ✅ UPDATED: Notify ALL VIEWERS (proctors + clients)
      const viewers = room.getViewers();
      
      viewers.forEach(viewer => {
        // ✅ FIXED: Only notify if student belongs to viewer's current page
        const viewerCurrentPage = viewer.getCurrentPage() || 1;
        const studentPosition = room.getStudentPagePosition(peerId);
        
        if (studentPosition && studentPosition.belongsToPage(viewerCurrentPage)) {
          viewer.socket.emit('newProducer', {
            producerId: producer.id,
            peerId: peerId,
            kind: kind,
            streamType: streamType,
            userId: userId,
            userName: userName,
            examId: examId,
            workerIndex: workerIndex, // ✅ Include worker info
            studentPosition: studentPosition,
            shouldRefresh: true
          });
        }
      });
    }

    producer.on('close', () => {
      peer.removeProducer(producer.id);
      if (rooms.has(roomId)) {
        rooms.get(roomId).removeProducer(producer.id);
      }
    });

    res.json({ 
      success: true, 
      producerId: producer.id, 
      streamType: streamType,
      workerIndex: workerIndex
    });
  } catch (error) {
    console.error('❌ Produce error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ UPDATED: Batch consume with WORKER SUPPORT
app.post('/api/batch-consume-paginated', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities, page = 1 } = req.body;

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const workerIndex = peer.getWorkerIndex();

    if (!peer.recvTransport) {
      throw new Error('Recv transport not found for peer');
    }

    const roomId = peer.roomId;
    if (!rooms.has(roomId)) {
      throw new Error('Room not found');
    }

    const room = rooms.get(roomId);
    const router = mediasoupRouters[workerIndex]; // ✅ Use correct worker's router
    const consumers = [];

    // ✅ STRICT: Limit to max page size
    const maxConsumersPerPage = room.STUDENTS_PER_PAGE * 2; // 12 students × 2 streams = 24 max
    let consumersCreated = 0;

    for (const producerId of producerIds) {
      if (consumersCreated >= maxConsumersPerPage) {
        console.log(`⚠️ Page ${page} reached max consumers limit (${maxConsumersPerPage})`);
        break;
      }

      const producerData = room.producers.get(producerId);
      if (!producerData) {
        continue;
      }

      const { producer } = producerData;

      if (producer.kind === 'audio') {
        continue;
      }

      if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
        continue;
      }

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
      });

      peer.addConsumer(consumer);

      consumer.on('close', () => {
        peer.removeConsumer(consumer.id);
      });

      const producerPeer = room.peers.get(producerData.peerId);
      
      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters,
        userName: producerPeer ? producerPeer.getUserName() : producerData.peerId,
        userId: producerPeer ? producerPeer.getUserId() : producerData.peerId,
        workerIndex: workerIndex // ✅ Include worker info
      });

      consumersCreated++;
    }

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length,
      page: page,
      maxPerPage: maxConsumersPerPage,
      workerIndex: workerIndex,
      message: `Page ${page} loaded with ${consumers.length}/${maxConsumersPerPage} streams [Worker ${workerIndex}]`
    });
  } catch (error) {
    console.error('❌ Batch consume paginated error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Keep other endpoints with similar worker support additions...
app.post('/api/batch-consume', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities } = req.body;

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const workerIndex = peer.getWorkerIndex();

    if (!peer.recvTransport) {
      throw new Error('Recv transport not found for peer');
    }

    const roomId = peer.roomId;
    if (!rooms.has(roomId)) {
      throw new Error('Room not found');
    }

    const room = rooms.get(roomId);
    const router = mediasoupRouters[workerIndex];
    const consumers = [];

    for (const producerId of producerIds) {
      const producerData = room.producers.get(producerId);
      if (!producerData) {
        continue;
      }

      const { producer } = producerData;

      if (producer.kind === 'audio') {
        continue;
      }

      if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
        continue;
      }

      const consumer = await peer.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
      });

      peer.addConsumer(consumer);


      consumer.on('close', () => {
        peer.removeConsumer(consumer.id);
      });

      const producerPeer = room.peers.get(producerData.peerId);

      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters,
        userName: producerPeer ? producerPeer.getUserName() : producerData.peerId,
        workerIndex: workerIndex
      });
    }

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length,
      workerIndex: workerIndex
    });
  } catch (error) {
    console.error('❌ Batch consume error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/batch-resume-consumers', async (req, res) => {
  try {
    const { peerId, consumerIds } = req.body;

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const workerIndex = peer.getWorkerIndex();
    const resumedConsumers = [];

    for (const consumerId of consumerIds) {
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) {
        continue;
      }

      await consumer.resume();
      resumedConsumers.push(consumerId);
    }

    res.json({
      success: true,
      resumedConsumers: resumedConsumers,
      totalResumed: resumedConsumers.length,
      workerIndex: workerIndex
    });
  } catch (error) {
    console.error('❌ Batch resume consumers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Keep existing API endpoints with worker support
app.get('/api/exam/:examId/producers/page/:page', (req, res) => {
  const { examId, page } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({ success: false, error: 'Room not found' });
  }

  const pageNum = parseInt(page) || 1;
  const paginatedData = room.getPaginatedProducersData(pageNum);

  res.json({
    success: true,
    examId,
    page: pageNum,
    producers: paginatedData.producers,
    pagination: paginatedData.pagination,
    workerIndex: room.workerIndex,
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

  res.json({
    success: true,
    examId,
    producers: paginatedData.producers,
    pagination: paginatedData.pagination,
    workerIndex: room.workerIndex,
    totals: {
      camera: paginatedData.producers.camera.length,
      screen: paginatedData.producers.screen.length,
      total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
    }
  });
});

// ✅ UPDATED: Stats endpoint with MULTI-WORKER support
app.get('/api/exam/:examId/stats', (req, res) => {
  const { examId } = req.params;
  const roomId = `exam-${examId}`;
  const room = rooms.get(roomId);

  if (!room) {
    return res.json({
      examId,
      totalStudents: 0,
      connectedProctors: 0,
      connectedClients: 0,
      students: [],
      producers: 0,
      consumers: 0,
      workerIndex: null
    });
  }

  const actualStudents = room.getActualStudents();
  const students = actualStudents.map(peer => ({
    peerId: peer.id,
    userId: peer.getUserId(),
    userName: peer.getUserName(),
    hasProducers: peer.producers.size > 0,
    producerCount: peer.producers.size,
    consumerCount: peer.consumers.size,
    streamTypes: Array.from(peer.streamTypes).filter(type => type !== 'audio'),
    connectionStatus: peer.connected ? 'connected' : 'disconnected',
    workerIndex: peer.getWorkerIndex()
  }));

  const proctors = room.getProctors();
  const clients = room.getClients();
  const summary = room.getActiveStudentsSummary();

  res.json({
    examId,
    roomId,
    workerIndex: room.workerIndex,
    totalStudents: actualStudents.length,
    connectedProctors: proctors.length,
    connectedClients: clients.length,
    totalViewers: proctors.length + clients.length,
    students,
    totalProducers: room.producers.size,
    totalConsumers: actualStudents.reduce((sum, peer) => sum + peer.consumers.size, 0),
    streamTypes: ['camera', 'screen'],
    pagination: summary.pagination,
    workerInfo: summary.workerInfo,
    lastUpdate: new Date().toISOString(),
    portStats: config.portMonitor.getPortStats()
  });
});

// ✅ UPDATED: Socket connection handler with STRICT PAGINATION
io.on('connection', (socket) => {
socket.on('joinExam', ({ examId, role, userId, userName, clientId }) => {
  const roomId = `exam-${examId}`;
  
  // ✅ INTELLIGENT WORKER ASSIGNMENT
  const workerIndex = assignWorkerToRoom(roomId);
  
  // ✅ UPDATED: Include clientId in peerId for clients
  const peerId = role === 'client' && clientId 
    ? `${clientId}-${userId}-${socket.id}` 
    : `${userId}-${socket.id}`;

    try {
    const peer = new Peer(peerId, socket);
    peer.setRoom(roomId);
    peer.setRole(role);
    peer.setUserId(userId);
    peer.setUserName(userName);
    peer.setWorkerIndex(workerIndex);
    
    // ✅ NEW: Set clientId for client role
    if (role === 'client' && clientId) {
      peer.setClientId(clientId);
    }
    
    peers.set(peerId, peer);

    // ✅ Create room with worker assignment if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(roomId, workerIndex));
    }
    const room = rooms.get(roomId);
    room.addPeer(peer);

    socket.join(roomId);

    socket.emit('joinedExam', {
      examId,
      roomId,
      peerId,
      role,
      userId,
      userName,
      clientId: clientId || null,
      workerIndex: workerIndex,
      message: `Successfully joined exam room as ${role} [Worker ${workerIndex}]`
    });

    // ✅ UPDATED: Handle CLIENT role like PROCTOR
    if (role === 'proctor' || role === 'client') {
      const studentsSummary = room.getActiveStudentsSummary();
      const viewerType = role === 'client' ? `Client ${clientId}` : 'Proctor';

      console.log(`👁️ ${viewerType} ${userName} joined exam ${examId} [Worker ${workerIndex}]`);

      // Method 1: Immediate check - FIXED PAGINATED (Page 1 only)
      const paginatedData = room.getPaginatedProducersData(1);
      if (paginatedData.producers.camera.length > 0 || paginatedData.producers.screen.length > 0) {
        socket.emit('batchProducers', {
          producers: paginatedData.producers,
          pagination: paginatedData.pagination,
          workerIndex: workerIndex,
          totals: {
            camera: paginatedData.producers.camera.length,
            screen: paginatedData.producers.screen.length,
            total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
          }
        });
      }

      // Method 2: Delayed comprehensive check - FIXED PAGINATED
      setTimeout(() => {
        const delayedPaginatedData = room.getPaginatedProducersData(1);
        
        if (delayedPaginatedData.producers.camera.length > 0 || delayedPaginatedData.producers.screen.length > 0) {
          socket.emit('batchProducers', {
            producers: delayedPaginatedData.producers,
            pagination: delayedPaginatedData.pagination,
            workerIndex: workerIndex,
            totals: {
              camera: delayedPaginatedData.producers.camera.length,
              screen: delayedPaginatedData.producers.screen.length,
              total: delayedPaginatedData.producers.camera.length + delayedPaginatedData.producers.screen.length
            }
          });
        }
      }, 2000);
    }

 // ✅ CRITICAL FIX: Student join with smart auto-refresh logic
if (role === 'student') {
  console.log(`👨‍🎓 Student ${userName} joined exam ${examId} [Worker ${workerIndex}]`);
  
  // ✅ CRITICAL: Always send complete student info to ALL viewers
  const viewers = room.getViewers();
  const actualStudentsCount = room.getActualStudents().length;
  const allStudentsInfo = room.getActualStudents().map(student => ({
    peerId: student.id,
    userId: student.getUserId(),
    userName: student.getUserName(),
    role: student.role,
    isOnline: true
  }));
  
  viewers.forEach(viewer => {
    const viewerCurrentPage = viewer.getCurrentPage() || 1;
    const studentPosition = room.getStudentPagePosition(peerId);
    
    // ✅ CRITICAL: Calculate current page capacity
    const currentPageStartIndex = (viewerCurrentPage - 1) * room.STUDENTS_PER_PAGE;
    const currentPageEndIndex = currentPageStartIndex + room.STUDENTS_PER_PAGE;
    const studentsOnCurrentPage = room.getActualStudents()
      .slice(currentPageStartIndex, currentPageEndIndex).length;
    const currentPageFull = studentsOnCurrentPage >= room.STUDENTS_PER_PAGE;
    
    console.log(`📄 Page Status Check:`, {
      viewerCurrentPage,
      studentPosition: studentPosition?.pageNumber,
      studentsOnCurrentPage,
      maxPerPage: room.STUDENTS_PER_PAGE,
      currentPageFull,
      shouldAutoRefresh: studentPosition && studentPosition.belongsToPage(viewerCurrentPage) && !currentPageFull
    });
    
    // ✅ ALWAYS send complete pagination update
    viewer.socket.emit('completeStudentsUpdate', {
      totalStudents: actualStudentsCount,
      allStudents: allStudentsInfo,
      newStudent: {
        peerId,
        userId,
        userName,
        examId,
        workerIndex,
        studentPosition: studentPosition,
        isOnCurrentPage: studentPosition ? studentPosition.belongsToPage(viewerCurrentPage) : false
      }
    });
    
    // ✅ CRITICAL: Auto-refresh logic based on page capacity
    if (studentPosition && studentPosition.belongsToPage(viewerCurrentPage) && !currentPageFull) {
      // Student belongs to current page AND page has space (< 12)
      console.log(`🔄 AUTO-REFRESH: Student ${userName} joins page ${viewerCurrentPage} (${studentsOnCurrentPage}/12)`);
      viewer.socket.emit('studentJoined', {
        peerId,
        userId,
        userName,
        examId,
        workerIndex,
        studentPosition: studentPosition,
        shouldRefresh: true, // ✅ CRITICAL: Trigger auto-refresh
        refreshReason: 'page_has_space',
        totalStudents: actualStudentsCount,
        currentPageStudents: studentsOnCurrentPage,
        maxPageStudents: room.STUDENTS_PER_PAGE,
        message: `Student ${userName} joined page ${viewerCurrentPage} - auto-refreshing`
      });
    } else if (studentPosition && studentPosition.belongsToPage(viewerCurrentPage) && currentPageFull) {
      // Student belongs to current page BUT page is full (= 12)
      console.log(`✋ NO REFRESH: Page ${viewerCurrentPage} is FULL (${studentsOnCurrentPage}/12)`);
      viewer.socket.emit('studentJoined', {
        peerId,
        userId,
        userName,
        examId,
        workerIndex,
        studentPosition: studentPosition,
        shouldRefresh: false, // ✅ CRITICAL: NO auto-refresh
        refreshReason: 'page_full',
        totalStudents: actualStudentsCount,
        currentPageStudents: studentsOnCurrentPage,
        maxPageStudents: room.STUDENTS_PER_PAGE,
        message: `Student ${userName} joined page ${viewerCurrentPage} - page is full, use Next button`
      });
    } else {
      // Student belongs to different page
      const targetPage = studentPosition ? studentPosition.pageNumber : 'Unknown';
      console.log(`📊 SILENT UPDATE: Student ${userName} joined page ${targetPage}, viewer on page ${viewerCurrentPage}`);
      viewer.socket.emit('studentCountUpdated', {
        totalStudents: actualStudentsCount,
        newStudentPage: targetPage,
        newStudentName: userName,
        newStudentId: userId,
        viewerCurrentPage: viewerCurrentPage,
        message: `Student ${userName} joined page ${targetPage} - pagination updated`
      });
    }
  });
}

  } catch (joinError) {
    console.error(`❌ Join error [Worker ${workerIndex}]:`, joinError);
    socket.emit('joinError', {
      error: joinError.message,
      examId,
      role,
      userId,
      userName,
      clientId: clientId || null,
      workerIndex: workerIndex
    });
  }

    // ✅ UPDATED: disconnect handler with MULTI-WORKER support
  // ✅ FIXED: Disconnect handler without undefined variables
socket.on('disconnect', () => {
  try {
    if (peers.has(peerId)) {
      const peer = peers.get(peerId);
      const peerUserName = peer ? peer.getUserName() : 'Unknown';
      const peerClientId = peer ? peer.getClientId() : null;
      const peerWorkerIndex = peer ? peer.getWorkerIndex() : 0;
      
      console.log(`👋 Peer ${peerUserName} disconnected [Worker ${peerWorkerIndex}]`);
      
      if (peer) {
        peer.close();
      }
      peers.delete(peerId);

      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        room.removePeer(peerId);
        
        // ✅ CRITICAL: Notify all viewers about peer leaving
        const viewers = room.getViewers();
        viewers.forEach(viewer => {
          viewer.socket.emit('peerLeft', { 
            peerId, 
            role, 
            userId,
            userName: peerUserName,
            clientId: peerClientId,
            workerIndex: peerWorkerIndex
          });
        });
        
        const actualStudents = room.getActualStudents();
        console.log(`📊 Room ${roomId} [Worker ${peerWorkerIndex}]: ${actualStudents.length} students remaining`);
      }
    }
  } catch (disconnectError) {
    console.error('❌ Disconnect error:', disconnectError.message);
  }
});

  });

// ✅ FIXED: changePage handler
socket.on('changePage', ({ examId, peerId, page }) => {
  try {
    const roomId = `exam-${examId}`;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    console.log(`📄 Page change request: ${peerId} requesting page ${page}`);
    
    // ✅ CRITICAL: Update peer's current page
    const peer = peers.get(peerId);
    if (peer) {
      peer.setCurrentPage(page);
      console.log(`✅ Updated ${peerId} to page ${page}`);
    }
    
    // ✅ Get paginated data for the requested page
    const paginatedData = room.getPaginatedProducersData(page);
    
    console.log(`📊 Page ${page} data:`, {
      totalStudents: paginatedData.pagination.totalStudents,
      currentPageStudents: paginatedData.pagination.currentPageStudents,
      cameraProducers: paginatedData.producers.camera.length,
      screenProducers: paginatedData.producers.screen.length
    });
    
    // ✅ Send response with correct page info
    socket.emit('pageChanged', {
      examId,
      peerId,
      producers: paginatedData.producers,
      pagination: paginatedData.pagination,
      workerIndex: room.workerIndex,
      totals: {
        camera: paginatedData.producers.camera.length,
        screen: paginatedData.producers.screen.length,
        total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
      }
    });
    
  } catch (error) {
    console.error('❌ Change page error:', error.message);
    socket.emit('error', { message: error.message });
  }
});

  // ✅ ADD THIS TO SOCKET HANDLERS IN BACKEND
  socket.on('requestPageStreams', ({ examId, peerId, page, studentIds }) => {
    const roomId = `exam-${examId}`;
    
    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const streams = [];
        
        // ✅ Get streams only for requested students
        for (const [producerId, data] of room.producers) {
          if (studentIds.includes(data.peerId)) {
            const peer = room.peers.get(data.peerId);
            streams.push({
              producerId,
              peerId: data.peerId,
              kind: data.producer.kind,
              streamType: data.streamType,
              userName: peer ? peer.getUserName() : data.peerId
            });
          }
        }
        
        socket.emit('pageStreamsData', {
          page: page,
          streams: streams,
          examId: examId
        });
        
        console.log(`📄 Sent ${streams.length} streams for page ${page} to ${peerId}`);
      }
    } catch (error) {
      console.error(`❌ Page streams request error:`, error);
    }
  });

  // Keep existing socket handlers with worker support
socket.on('refreshProducers', ({ examId, peerId, page }) => {
  try {
    const roomId = `exam-${examId}`;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    console.log(`🔄 Refresh request: ${peerId} refreshing page ${page}`);
    
    // ✅ CRITICAL: Get data for the specified page
    const paginatedData = room.getPaginatedProducersData(page);
    
    console.log(`📊 Refresh page ${page} data:`, {
      totalStudents: paginatedData.pagination.totalStudents,
      currentPageStudents: paginatedData.pagination.currentPageStudents,
      cameraProducers: paginatedData.producers.camera.length,
      screenProducers: paginatedData.producers.screen.length
    });
    
    // ✅ Send batchProducers event with correct page data
    socket.emit('batchProducers', {
      examId,
      peerId,
      producers: paginatedData.producers,
      pagination: paginatedData.pagination,
      workerIndex: room.workerIndex,
      totals: {
        camera: paginatedData.producers.camera.length,
        screen: paginatedData.producers.screen.length,
        total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
      }
    });
    
  } catch (error) {
    console.error('❌ Refresh producers error:', error);
    socket.emit('error', { message: error.message });
  }
});

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

const startServer = async () => {
  try {
    // ✅ Initialize all workers before starting server
    await initializeMediasoup();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`🚀 MediaSoup SFU Server v3.0 with ${NUM_WORKERS}-Worker support running on port ${PORT}`);
      console.log(`📊 Server capacity: ~${NUM_WORKERS * 75} concurrent students`);
      console.log(`🎯 Load balancing: Intelligent room-to-worker assignment`);
      config.portMonitor.logPortUsage(`Multi-Worker server started with ${NUM_WORKERS} workers`);
    });
  } catch (error) {
    console.error('❌ Server startup error:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('🛑 Graceful shutdown initiated...');
  
  // ✅ Close all peers
  for (const peer of peers.values()) {
    peer.close();
  }
  peers.clear();
  rooms.clear();

  // ✅ Close all workers
  for (let i = 0; i < mediasoupWorkers.length; i++) {
    if (mediasoupWorkers[i]) {
      console.log(`🛑 Closing worker ${i}...`);
      mediasoupWorkers[i].close();
    }
  }

  server.close(() => {
    console.log('✅ Multi-Worker server closed gracefully');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('❌ Force shutdown after timeout');
    process.exit(1);
  }, 15000); // Increased timeout for multiple workers
}

startServer().catch(console.error);
