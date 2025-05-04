import { Server } from 'socket.io';
import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import Cors from 'cors';

const cors = Cors({
  origin: '*',
  methods: ['GET', 'POST'],
});

function runMiddleware(req: NextApiRequest, res: NextApiResponse, fn: Function) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: any) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

type NextApiResponseWithSocket = NextApiResponse & {
  socket: {
    server: any;
  };
};

const SESSION_TIMEOUT = 300000; // 5 minutes
const MAX_FILE_SIZE = 1024 * 1024 * 1024 * 2; // 2GB
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

const uploadsDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponseWithSocket
) {
  await runMiddleware(req, res, cors);

  if (!res.socket.server.io) {
    console.log('Initializing Socket.io server...');

    const io = new Server(res.socket.server, {
      path: '/api/socket',
      addTrailingSlash: false,
    });

    const sessions = new Map<string, { socketId: string; timeout: NodeJS.Timeout }>();

    const cleanupSession = (sessionCode: string) => {
      const session = sessions.get(sessionCode);
      if (session) {
        clearTimeout(session.timeout);
        sessions.delete(sessionCode);
        console.log(`Cleaned up session: ${sessionCode}`);

        // Clean up uploaded files
        try {
          const files = fs.readdirSync(uploadsDir);
          files.forEach((file) => {
            if (file.startsWith(sessionCode)) {
              try {
                fs.unlinkSync(path.join(uploadsDir, file));
                console.log(`Deleted file: ${file}`);
              } catch (err) {
                console.error(`Error deleting file ${file}:`, err);
              }
            }
          });
        } catch (err) {
          console.error('Error reading uploads directory:', err);
        }
      }
    };

    io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);

      socket.on('create-session', (code: string) => {
        cleanupSession(code);

        sessions.set(code, {
          socketId: socket.id,
          timeout: setTimeout(() => {
            socket.to(code).emit('session-expired');
            cleanupSession(code);
          }, SESSION_TIMEOUT),
        });

        socket.join(code);
        socket.emit('session-created', code);
        console.log(`Session created: ${code}`);
      });

      socket.on('join-session', (sessionCode: string) => {
        if (!sessions.has(sessionCode)) {
          socket.emit('invalid-session');
          return;
        }

        socket.join(sessionCode);
        socket.to(sessionCode).emit('receiver-joined');
        console.log(`Receiver joined session: ${sessionCode}`);
      });

      socket.on('file-meta', ({ name, size, type }, sessionCode: string) => {
        if (!sessions.has(sessionCode)) {
          socket.emit('invalid-session');
          return;
        }

        if (size > MAX_FILE_SIZE) {
          socket.emit('error', 'File size exceeds 2GB limit');
          return;
        }

        socket.to(sessionCode).emit('file-meta', { name, size, type });
        console.log(`File metadata received: ${name}`);
      });

      socket.on('file-chunk', (chunk: Buffer, sessionCode: string, progress: number) => {
        if (!sessions.has(sessionCode)) {
          socket.emit('invalid-session');
          return;
        }

        socket.to(sessionCode).emit('file-chunk', chunk, progress);
      });

      socket.on('transfer-complete', (sessionCode: string) => {
        if (sessions.has(sessionCode)) {
          socket.to(sessionCode).emit('transfer-complete');
          cleanupSession(sessionCode);
        }
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        for (const [code, session] of sessions.entries()) {
          if (session.socketId === socket.id) {
            cleanupSession(code);
          }
        }
      });
    });

    res.socket.server.io = io;
  }
  res.end();
}