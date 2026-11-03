const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// เสิร์ฟไฟล์ HTML จากโฟลเดอร์หลักของโปรเจกต์
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let playersDB = {}; 
const THAI_CHARACTERS = ['ก', 'ข', 'ค', 'ง', 'จ', 'ฉ', 'ช', 'ซ', 'ด', 'ต', 'ถ', 'ท', 'น', 'บ', 'ป', 'ผ', 'ฝ', 'พ', 'ฟ', 'ม', 'ย', 'ร', 'ล', 'ว', 'ศ', 'ส', 'ห', 'อ'];
const QUESTIONS = [
  "หมวดของกินในชีวิตประจำวัน",
  "หมวดสิ่งของในบ้าน",
  "หมวดสถานที่หรือสิ่งก่อสร้าง",
  "หมวดชื่อสัตว์",
  "หมวดอาชีพ หรือ บุคคล",
  "หมวดเครื่องใช้ไฟฟ้า/ไอที"
];

let rooms = {};

function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {

  socket.on('register_user', (userData) => {
    socket.userData = userData;
    if (!playersDB[userData.username]) {
      playersDB[userData.username] = {
        rankPoints: 1000, 
        province: userData.province || 'กรุงเทพมหานคร',
        wins: 0
      };
    }
    socket.emit('user_registered', { ...userData, stats: playersDB[userData.username] });
  });

  socket.on('create_room', ({ roomName, password }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      id: roomId,
      name: roomName,
      password: password,
      hostId: socket.id,
      isRanked: false,
      players: [],
      maxPlayers: 5,
      gameState: 'LOBBY',
      currentRound: 0,
      totalRounds: 3,
      answers: {},
      votes: {}
    };
    joinRoomHelper(socket, roomId, password);
  });

  socket.on('join_room', ({ roomId, password }) => {
    joinRoomHelper(socket, roomId, password);
  });

  socket.on('matchmaking', () => {
    let targetRoom = Object.values(rooms).find(r => r.isRanked && r.gameState === 'LOBBY' && r.players.length < 5);
    if (!targetRoom) {
      const roomId = generateRoomId();
      rooms[roomId] = {
        id: roomId,
        name: "สุ่มแข่งขันแรร์ (Ranked)",
        password: "",
        hostId: socket.id,
        isRanked: true,
        players: [],
        maxPlayers: 5,
        gameState: 'LOBBY',
        currentRound: 0,
        totalRounds: 3,
        answers: {},
        votes: {}
      };
      targetRoom = rooms[roomId];
    }
    joinRoomHelper(socket, targetRoom.id, "");
  });

  function joinRoomHelper(socket, roomId, password) {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'ไม่พบรหัสห้องนี้');
    if (room.password && room.password !== password) return socket.emit('error_msg', 'รหัสผ่านห้องไม่ถูกต้อง');
    if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'ห้องเต็มแล้ว');
    if (room.gameState !== 'LOBBY') return socket.emit('error_msg', 'เกมในห้องนี้เริ่มไปแล้ว');

    socket.join(roomId);
    socket.currentRoomId = roomId;

    const playerObj = {
      id: socket.id,
      username: socket.userData ? socket.userData.username : 'Guest_' + socket.id.substring(0,4),
      province: socket.userData ? socket.userData.province : 'ไม่ระบุ',
      score: 0
    };

    room.players.push(playerObj);
    io.to(roomId).emit('room_updated', room);
  }

  socket.on('start_game', () => {
    const roomId = socket.currentRoomId;
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    startNextRound(roomId);
  });

  function startNextRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.currentRound += 1;
    if (room.currentRound > room.totalRounds) {
      finishGame(roomId);
      return;
    }

    room.gameState = 'PLAYING';
    room.answers = {};
    room.votes = {};

    const randomChar = THAI_CHARACTERS[Math.floor(Math.random() * THAI_CHARACTERS.length)];

    io.to(roomId).emit('round_start', {
      round: room.currentRound,
      char: randomChar,
      questions: QUESTIONS,
      thinkTime: 120,
      playTime: 60
    });
  }

  socket.on('submit_answers', (userAnswers) => {
    const room = rooms[socket.currentRoomId];
    if (!room) return;
    room.answers[socket.id] = userAnswers;

    if (Object.keys(room.answers).length >= room.players.length) {
      startVotePhase(socket.currentRoomId);
    }
  });

  function startVotePhase(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState === 'VOTING') return;

    room.gameState = 'VOTING';
    io.to(roomId).emit('start_voting', {
      answers: room.answers,
      players: room.players
    });
  }

  socket.on('cast_vote', ({ targetSocketId, isCorrect }) => {
    const room = rooms[socket.currentRoomId];
    if (!room) return;

    const targetPlayer = room.players.find(p => p.id === targetSocketId);
    if (targetPlayer) {
      if (isCorrect) {
        targetPlayer.score += 10;
      } else {
        targetPlayer.score -= 10;
      }
    }

    io.to(socket.currentRoomId).emit('update_scores', room.players);
  });

  socket.on('finish_vote_phase', () => {
    const room = rooms[socket.currentRoomId];
    if (!room || room.hostId !== socket.id) return;
    startNextRound(socket.currentRoomId);
  });

  function finishGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.gameState = 'FINISHED';
    room.players.sort((a, b) => b.score - a.score);
    const winner = room.players[0];

    if (room.isRanked && winner) {
      if (playersDB[winner.username]) {
        playersDB[winner.username].rankPoints += 50;
      }
    }

    io.to(roomId).emit('game_over', {
      winner: winner,
      players: room.players,
      isRanked: room.isRanked
    });
  }

  socket.on('get_leaderboard', () => {
    const allPlayers = Object.entries(playersDB).map(([name, data]) => ({
      username: name,
      ...data
    }));

    const nationalTop10 = [...allPlayers].sort((a, b) => b.rankPoints - a.rankPoints).slice(0, 10);
    const userProv = socket.userData ? socket.userData.province : 'กรุงเทพมหานคร';
    const provinceTop100 = [...allPlayers]
      .filter(p => p.province === userProv)
      .sort((a, b) => b.rankPoints - a.rankPoints)
      .slice(0, 100);

    socket.emit('leaderboard_data', {
      national: nationalTop10,
      province: provinceTop100,
      userProvince: userProv
    });
  });

  socket.on('disconnect', () => {
    if (socket.currentRoomId && rooms[socket.currentRoomId]) {
      const room = rooms[socket.currentRoomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[socket.currentRoomId];
      } else {
        io.to(socket.currentRoomId).emit('room_updated', room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
