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

let mediasoupWorker;
let mediasoupRouter;
const rooms = new Map();
const peers = new Map();

// ✅ FIXED Room class - Only count ACTUAL STUDENTS
class Room {
  constructor(roomId) {
    this.id = roomId;
    this.peers = new Map();
    this.producers = new Map();
    this.STUDENTS_PER_PAGE = 12;
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    const actualStudents = this.getActualStudents();
    // Silent operation
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
    
    if (this.peers.size === 0) {
      rooms.delete(this.id);
    }
  }

  // ✅ FIXED: Get only ACTUAL STUDENTS (not proctors or disconnected peers)
  getActualStudents() {
    const actualStudents = Array.from(this.peers.values()).filter(peer => {
      return peer.role === 'student' && 
             peer.socket && 
             peer.socket.connected;
    });
    
    return actualStudents;
  }

  addProducer(producer, peerId, streamType) {
    this.producers.set(producer.id, { producer, peerId, streamType });
    const peer = this.peers.get(peerId);
    // Silent operation
  }

  removeProducer(producerId) {
    const producerData = this.producers.get(producerId);
    this.producers.delete(producerId);
    // Silent operation
  }

  // ✅ FIXED: Paginated data based on ACTUAL STUDENTS only
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
          hasPreviousPage: false
        }
      };
    }

    const totalPages = Math.ceil(totalActualStudents / this.STUDENTS_PER_PAGE);
    const startIndex = (page - 1) * this.STUDENTS_PER_PAGE;
    const endIndex = startIndex + this.STUDENTS_PER_PAGE;
    
    const currentPageStudents = actualStudents.slice(startIndex, endIndex);
    const currentPageStudentIds = currentPageStudents.map(student => student.id);

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

  // ✅ FIXED: Summary based on ACTUAL students
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

    return result;
  }

  getPeersByRole(role) {
    const peers = Array.from(this.peers.values()).filter(peer => {
      return peer.role === role && peer.socket && peer.socket.connected;
    });
    
    return peers;
  }

  getProctors() {
    return this.getPeersByRole('proctor');
  }

  getStudents() {
    return this.getPeersByRole('student');
  }
}

// ✅ ENHANCED Peer class with connection tracking
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
      });
    }
  }

  setRoom(roomId) { this.roomId = roomId; }
  setRole(role) { 
    this.role = role; 
  }

  async getOrCreateSendTransport() {
    if (!this.sendTransport || this.sendTransport.closed) {
      this.sendTransport = await createWebRtcTransport();
    }
    return this.sendTransport;
  }

  async getOrCreateRecvTransport() {
    if (!this.recvTransport || this.recvTransport.closed) {
      this.recvTransport = await createWebRtcTransport();
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
    
    // Clean up transport ports when peer closes
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

// Initialize MediaSoup
const initializeMediasoup = async () => {
  mediasoupWorker = await mediasoup.createWorker(config.workerSettings);
  mediasoupWorker.on('died', () => {
    process.exit(1);
  });

  mediasoupRouter = await mediasoupWorker.createRouter({
    mediaCodecs: config.routerOptions.mediaCodecs
  });
};

const createWebRtcTransport = async () => {
  const transport = await mediasoupRouter.createWebRtcTransport(config.webRtcTransportOptions);

  // Track ports when transport is created
  const transportId = transport.id;
  const estimatedPorts = []; // MediaSoup doesn't expose exact ports, so we estimate
  
  // Estimate 2 ports per transport (RTP + RTCP)
  const basePort = config.workerSettings.rtcMinPort + (Math.random() * 1000);
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

// Routes
app.get('/api/health', (req, res) => {
  const portStats = config.portMonitor.getPortStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activePeers: peers.size,
    server: 'MediaSoup SFU Server v2.3 - PORT MONITOR ONLY',
    portStats: portStats,
    pagination: {
      studentsPerPage: 12,
      description: 'Fixed: Only actual connected students counted'
    }
  });
});

app.get('/api/rtp-capabilities', (req, res) => {
  try {
    res.json({
      success: true,
      rtpCapabilities: mediasoupRouter.rtpCapabilities
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/setup-transports', async (req, res) => {
  try {
    const { peerId, role } = req.body;

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);
    const sendTransport = await peer.getOrCreateSendTransport();
    const recvTransport = await peer.getOrCreateRecvTransport();

    res.json({
      success: true,
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
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/connect-transports', async (req, res) => {
  try {
    const { peerId, sendDtlsParameters, recvDtlsParameters } = req.body;

    if (!peers.has(peerId)) {
      throw new Error('Peer not found');
    }

    const peer = peers.get(peerId);

    if (sendDtlsParameters && peer.sendTransport) {
      await peer.sendTransport.connect({ dtlsParameters: sendDtlsParameters });
    }

    if (recvDtlsParameters && peer.recvTransport) {
      await peer.recvTransport.connect({ dtlsParameters: recvDtlsParameters });
    }

    res.json({ success: true, message: 'Transports connected successfully' });
  } catch (error) {
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
      peer.removeProducer(producer.id);
      if (rooms.has(roomId)) {
        rooms.get(roomId).removeProducer(producer.id);
      }
    });

    res.json({ success: true, producerId: producer.id, streamType: streamType });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ FIXED PAGINATED BATCH CONSUME ENDPOINT
app.post('/api/batch-consume-paginated', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities, page = 1 } = req.body;

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

      if (!mediasoupRouter.canConsume({ producerId: producer.id, rtpCapabilities })) {
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

      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters
      });
    }

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length,
      page: page,
      message: `Page ${page} loaded with ${consumers.length} streams`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Original batch consume (for backward compatibility)
app.post('/api/batch-consume', async (req, res) => {
  try {
    const { peerId, producerIds, rtpCapabilities } = req.body;

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

      if (!mediasoupRouter.canConsume({ producerId: producer.id, rtpCapabilities })) {
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

      consumers.push({
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: producerData.peerId,
        kind: consumer.kind,
        streamType: producerData.streamType,
        rtpParameters: consumer.rtpParameters
      });
    }

    res.json({
      success: true,
      consumers: consumers,
      totalCreated: consumers.length
    });
  } catch (error) {
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
      totalResumed: resumedConsumers.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ FIXED PAGINATED PRODUCERS ENDPOINTS
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
    totals: {
      camera: paginatedData.producers.camera.length,
      screen: paginatedData.producers.screen.length,
      total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
    }
  });
});

// Original producers endpoint (defaults to page 1)
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
    totals: {
      camera: paginatedData.producers.camera.length,
      screen: paginatedData.producers.screen.length,
      total: paginatedData.producers.camera.length + paginatedData.producers.screen.length
    }
  });
});

// ✅ FIXED STATS ENDPOINT - Only count actual students
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

  res.json({
    examId,
    roomId,
    totalStudents: actualStudents.length,
    connectedProctors: proctors.length,
    students,
    totalProducers: room.producers.size,
    totalConsumers: actualStudents.reduce((sum, peer) => sum + peer.consumers.size, 0),
    streamTypes: ['camera', 'screen'],
    pagination: summary.pagination,
    lastUpdate: new Date().toISOString(),
    portStats: config.portMonitor.getPortStats()
  });
});

// ✅ Socket connection handler (silent operations)
io.on('connection', (socket) => {
  socket.on('joinExam', ({ examId, role, userId }) => {
    const roomId = `exam-${examId}`;
    const peerId = `${userId}-${socket.id}`;

    try {
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

      socket.emit('joinedExam', {
        examId,
        roomId,
        peerId,
        role,
        message: 'Successfully joined exam room'
      });

      // Proctor logic with FIXED PAGINATION
      if (role === 'proctor') {
        const studentsSummary = room.getActiveStudentsSummary();

        // Method 1: Immediate check - FIXED PAGINATED (Page 1 only)
        const paginatedData = room.getPaginatedProducersData(1);
        if (paginatedData.producers.camera.length > 0 || paginatedData.producers.screen.length > 0) {
          socket.emit('batchProducers', {
            producers: paginatedData.producers,
            pagination: paginatedData.pagination,
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
          const delayedSummary = room.getActiveStudentsSummary();
          
          if (delayedPaginatedData.producers.camera.length > 0 || delayedPaginatedData.producers.screen.length > 0) {
            socket.emit('batchProducers', {
              producers: delayedPaginatedData.producers,
              pagination: delayedPaginatedData.pagination,
              totals: {
                camera: delayedPaginatedData.producers.camera.length,
                screen: delayedPaginatedData.producers.screen.length,
                total: delayedPaginatedData.producers.camera.length + delayedPaginatedData.producers.screen.length
              }
            });
          } else {
            socket.emit('forceProducerCheck', {
              examId,
              roomId,
              message: 'Checking for existing students via API'
            });
          }
        }, 2000);

        socket.to(roomId).emit('proctorJoined', {
          proctorId: peerId,
          message: 'Proctor joined - please refresh your streams'
        });
      }

      if (role === 'student') {
        const proctors = room.getProctors();
        
        proctors.forEach(proctor => {
          proctor.socket.emit('studentJoined', {
            peerId,
            userId,
            examId,
            message: `Student ${userId} joined the exam`
          });
        });
      }

    } catch (joinError) {
      socket.emit('joinError', {
        error: joinError.message,
        examId,
        role
      });
    }

    // ✅ FIXED disconnect handler with proper cleanup
    socket.on('disconnect', () => {
      try {
        if (peers.has(peerId)) {
          const peer = peers.get(peerId);
          peer.close(); // This will handle port cleanup
          peers.delete(peerId);

          if (rooms.has(roomId)) {
            const room = rooms.get(roomId);
            room.removePeer(peerId);
            
            socket.to(roomId).emit('peerLeft', { peerId, role });
            
            const actualStudents = room.getActualStudents();
          }
        }
      } catch (disconnectError) {
        // Silent error handling
      }
    });
  });

  // ✅ FIXED PAGINATED REFRESH REQUEST
  socket.on('refreshProducers', ({ examId, peerId, page = 1 }) => {
    const roomId = `exam-${examId}`;

    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const paginatedData = room.getPaginatedProducersData(page);
        const summary = room.getActiveStudentsSummary();

        socket.emit('batchProducers', {
          producers: paginatedData.producers,
          pagination: paginatedData.pagination,
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
      socket.emit('refreshError', { error: refreshError.message, examId });
    }
  });

  // ✅ FIXED PAGE CHANGE REQUEST
  socket.on('changePage', ({ examId, peerId, page }) => {
    const roomId = `exam-${examId}`;

    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const paginatedData = room.getPaginatedProducersData(page);

        socket.emit('pageChanged', {
          producers: paginatedData.producers,
          pagination: paginatedData.pagination,
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
      socket.emit('pageChangeError', { error: pageError.message, examId, page });
    }
  });

  socket.on('error', (error) => {
    // Silent error handling
  });
});

const startServer = async () => {
  try {
    await initializeMediasoup();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      config.portMonitor.logPortUsage('Server started');
    });
  } catch (error) {
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  for (const peer of peers.values()) {
    peer.close();
  }
  peers.clear();
  rooms.clear();

  if (mediasoupWorker) {
    mediasoupWorker.close();
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000);
}

startServer().catch(console.error);
