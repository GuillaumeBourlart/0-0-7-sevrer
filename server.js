import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';

// Initialisation d'Express et du serveur HTTP
const app = express();
app.use(cors({ origin: '*' }));  // Autoriser toutes les origines (CORS "*")
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' }
});

// Structures de données en mémoire pour les rooms et matchmaking
let waitingPlayer = null;  // Socket en attente pour auto-match (1v1)
const games = new Map();   // Stocke l'état des parties par room (clé: roomID ou code)

/**
 * Génère un code unique pour les parties privées (par ex. 6 caractères alphanumériques).
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (games.has(code));
  return code;
}

/**
 * Initialise l'état d'une nouvelle partie.
 * players: tableau d’objets { socket, id, ammo, alive, choice }.
 */
function createGameRoom(roomId, players) {
  games.set(roomId, {
    id: roomId,
    players: players.map(sock => ({
      socket: sock,
      id: sock.id,
      ammo: 0,
      alive: true,
      choice: null
    })),
    maxPlayers: players.length,        // 2 ou 3 selon le nombre de joueurs initial
    roundTimer: null,
    roundDuration: 10,                // 10 sec par tour
    rematchVotes: 0,
    gameStarted: false
  });
}

/**
 * Diffuse à tous les joueurs d'une room un événement via Socket.IO.
 */
function broadcastToRoom(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

/**
 * Calcule le résultat d'un tour pour la room donnée et renvoie l'objet de résultat.
 */
function resolveRound(game) {
  const playersState = game.players;
  // Déterminer les effets des actions
  // On traite chaque joueur qui a fait "tir" en vérifiant ses munitions et si les cibles sont vulnérables.
  let deaths = [];  // IDs des joueurs éliminés ce tour
  // 1. Appliquer les tirs
  for (const p of playersState) {
    if (!p.alive) continue;
    if (p.choice === 'tir') {
      if (p.ammo > 0) {
        // Chercher une cible non protégée (bouclier) parmi les adversaires
        const targets = playersState.filter(t => t.alive && t.id !== p.id);
        for (const target of targets) {
          // Si la cible n'a pas utilisé "bouclier" ce tour, elle est touchée
          if (target.choice !== 'bouclier') {
            deaths.push(target.id);
            target.alive = false;
            // On considère qu'un tir ne touche qu'une cible (on sort après la première cible touchée)
            break;
          }
        }
      }
      // Si p.ammo == 0 et a tenté "tir", le coup est à blanc (aucun effet)
    }
  }
  // 2. Mettre à jour les munitions après les actions
  for (const p of playersState) {
    if (!p.alive) continue;
    if (p.choice === 'tir') {
      if (p.ammo > 0) {
        p.ammo -= 1;  // consomme une munition si un tir a été tenté (même si protégé ou manqué)
      }
    } else if (p.choice === 'recharge') {
      p.ammo += 1;   // recharge ajoute une munition
    }
    // "bouclier" n'affecte pas les munitions
  }
  // Préparer les résultats du tour pour chaque joueur (pour information du client)
  const roundResults = playersState.map(p => ({
    id: p.id,
    action: p.choice,
    ammo: p.ammo,
    survived: p.alive
  }));
  return { roundResults, deaths };
}

/**
 * Lance un nouveau tour de jeu (avec timer de 10s) pour la room spécifiée.
 */
function startRound(roomId) {
  const game = games.get(roomId);
  if (!game) return;
  game.gameStarted = true;
  // Réinitialiser les choix du tour précédent
  game.players.forEach(p => { p.choice = null; });
  // Informer les clients du début d’un nouveau tour et de la durée du timer
  broadcastToRoom(roomId, 'roundStart', { duration: game.roundDuration });
  // Démarrer un timer de fin de tour à 10s
  game.roundTimer = setTimeout(() => {
    // Si le timer expire et qu'il reste des joueurs n'ayant pas fait de choix, on considère qu'ils n'ont rien fait
    endRound(roomId);
  }, game.roundDuration * 1000);
}

/**
 * Termine le tour en cours soit quand tous les choix sont reçus, soit quand le timer expire.
 * Calcule le résultat du tour, envoie les résultats aux clients, et gère la fin de partie ou le passage au tour suivant.
 */
function endRound(roomId) {
  const game = games.get(roomId);
  if (!game) return;
  // Annuler le timer du tour en cours (pour éviter un double appel)
  if (game.roundTimer) {
    clearTimeout(game.roundTimer);
    game.roundTimer = null;
  }
  // Résoudre les résultats du tour
  const { roundResults, deaths } = resolveRound(game);
  // Envoyer les résultats de ce tour à tous les joueurs
  broadcastToRoom(roomId, 'roundEnd', { results: roundResults });
  // Vérifier l'état de la partie après ce tour
  const alivePlayers = game.players.filter(p => p.alive);
  if (alivePlayers.length <= 1) {
    // Partie terminée (un seul survivant ou aucun en cas d'élimination mutuelle)
    let winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
    broadcastToRoom(roomId, 'gameOver', { winner: winnerId });
    // À ce stade, on attend éventuellement des demandes de rematch des joueurs
  } else {
    // Continuer la partie au tour suivant après un court délai pour que les joueurs voient le résultat
    setTimeout(() => startRound(roomId), 1000);
  }
}

// Socket.IO: gestion des connexions
io.on('connection', (socket) => {
  console.log(`Client connecté : ${socket.id}`);

  // Le joueur souhaite jouer en ligne (auto-matchmaking 1v1)
  socket.on('playOnline', () => {
    if (waitingPlayer && waitingPlayer.connected) {
      // Un joueur est en attente : on crée une room 1v1 et on démarre la partie
      const roomId = generateRoomCode();  // on peut aussi générer un ID interne
      // Rejoindre la room Socket.IO
      socket.join(roomId);
      waitingPlayer.join(roomId);
      // Initialiser la room de jeu avec les deux joueurs
      createGameRoom(roomId, [waitingPlayer, socket]);
      console.log(`Match 1v1 trouvé : room ${roomId} avec ${waitingPlayer.id} vs ${socket.id}`);
      // Informer les deux joueurs que le match commence
      broadcastToRoom(roomId, 'matchFound', { room: roomId, players: [waitingPlayer.id, socket.id] });
      // Lancer le premier tour
      startRound(roomId);
      // Réinitialiser l'attente
      waitingPlayer = null;
    } else {
      // Pas de joueur en attente, ce joueur devient le joueur en attente
      waitingPlayer = socket;
      console.log(`Joueur ${socket.id} en attente d'un adversaire...`);
      // On pourrait informer ce joueur qu'il attend un match, par exemple:
      socket.emit('waiting', { message: 'En attente d\'un adversaire...' });
    }
  });

  // Le joueur crée une partie privée -> générer un code et rejoindre la room correspondante
  socket.on('createPrivate', () => {
    const code = generateRoomCode();
    socket.join(code);
    // Créer une entrée de room avec ce joueur (partie pas encore démarrée, en attente d'adversaire(s))
    games.set(code, {
      id: code,
      players: [{ socket: socket, id: socket.id, ammo: 0, alive: true, choice: null }],
      maxPlayers: 3,          // on autorise jusqu'à 3 joueurs pour une room privée
      roundTimer: null,
      roundDuration: 10,
      rematchVotes: 0,
      gameStarted: false
    });
    socket.emit('privateCreated', { code });
    console.log(`Room privée créée ${code} par ${socket.id}`);
  });

  // Le joueur rejoint une partie privée existante via un code
  socket.on('joinPrivate', ({ code }) => {
    const game = games.get(code);
    if (!game) {
      socket.emit('joinError', { message: 'Code de partie invalide.' });
      return;
    }
    if (game.players.length >= game.maxPlayers || game.gameStarted) {
      socket.emit('joinError', { message: 'Impossible de rejoindre cette partie.' });
      return;
    }
    // Rejoindre la room socket.io et ajouter le joueur dans l'état de la partie
    socket.join(code);
    game.players.push({ socket: socket, id: socket.id, ammo: 0, alive: true, choice: null });
    console.log(`Joueur ${socket.id} a rejoint la room privée ${code}`);
    // Si au moins 2 joueurs sont présents, on peut démarrer la partie
    if (game.players.length >= 2) {
      // Démarrer la partie après une courte attente pour permettre un 3e joueur éventuel
      setTimeout(() => {
        const currentGame = games.get(code);
        if (currentGame && !currentGame.gameStarted) {
          // Si toujours pas démarré, lancer le jeu avec les joueurs actuellement présents
          broadcastToRoom(code, 'matchFound', { room: code, players: currentGame.players.map(p => p.id) });
          startRound(code);
        }
      }, 3000);  // par ex. on attend 3 secondes avant de lancer pour laisser le temps à un éventuel 3e joueur
    }
  });

  // Réception du choix d'action d'un joueur pendant un tour ("tir", "bouclier" ou "recharge")
  socket.on('playerChoice', ({ roomId, action }) => {
    const game = games.get(roomId);
    if (!game) return;
    // Enregistrer le choix du joueur
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;
    player.choice = action;
    console.log(`Choix de ${socket.id} dans room ${roomId}: ${action}`);
    // Vérifier si tous les joueurs vivants ont fait un choix
    const allChosen = game.players.filter(p => p.alive).every(p => p.choice !== null);
    if (allChosen) {
      // Terminer le tour immédiatement car tous les joueurs ont joué
      endRound(roomId);
    }
  });

  // Gestion de la demande de rematch d'un joueur en fin de partie
  socket.on('requestRematch', ({ roomId }) => {
    const game = games.get(roomId);
    if (!game) return;
    game.rematchVotes += 1;
    const totalPlayers = game.players.length;
    if (game.rematchVotes === totalPlayers) {
      // Tous les joueurs restants veulent rejouer
      console.log(`Rematch accepté par tous dans la room ${roomId}`);
      // Réinitialiser l'état de jeu pour un nouveau départ
      game.players.forEach(p => {
        p.alive = true;
        p.ammo = 0;
        p.choice = null;
      });
      game.rematchVotes = 0;
      // Relancer la partie
      broadcastToRoom(roomId, 'rematchStart', { players: game.players.map(p => p.id) });
      startRound(roomId);
    } else {
      // En attente que les autres joueurs envoient aussi requestRematch
      console.log(`Joueur ${socket.id} prêt pour rematch (${game.rematchVotes}/${totalPlayers})`);
    }
  });

  // Gestion de la déconnexion d'un joueur
  socket.on('disconnect', () => {
    console.log(`Déconnexion du client ${socket.id}`);
    // Si ce joueur était en attente dans la queue auto, l'enlever
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    // Vérifier s'il faisait partie d'une game en cours
    for (const [roomId, game] of games.entries()) {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        // Retirer le joueur de la room
        game.players.splice(playerIndex, 1);
        socket.leave(roomId);
        // Si c'était en pleine partie, informer les autres que le joueur a quitté
        if (game.gameStarted) {
          broadcastToRoom(roomId, 'playerLeft', { player: socket.id });
        }
        // Finir la partie si plus assez de joueurs
        if (game.players.length < 2 || game.players.every(p => !p.alive)) {
          games.delete(roomId);
          broadcastToRoom(roomId, 'gameOver', { winner: null });
          console.log(`Partie ${roomId} terminée (joueur déconnecté)`);
        }
      }
    }
  });
});

// Démarrer le serveur HTTP + Socket.IO
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
